import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { AuditRecorder } from "../audit/auditLog.js";
import { recordAudit } from "../audit/record.js";
import { authenticate, currentOperator, requirePermission } from "../auth/middleware.js";
import {
  INVITABLE_ROLES,
  permissionsFor,
  type OperatorStore,
} from "../auth/operators.js";
import { conflict, notFound } from "../domain/errors.js";
import { parse, wrap } from "./http.js";

const MemberIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._-]{1,64}$/, "Invalid member id.");

const CreateMemberSchema = z
  .object({
    email: z.string().trim().email().max(200),
    /** Optional: when omitted, a readable name is derived from the email. */
    displayName: z.string().trim().min(2).max(120).optional(),
    role: z.enum(INVITABLE_ROLES),
  })
  .strict();

const SetRoleSchema = z.object({ role: z.enum(INVITABLE_ROLES) }).strict();

/** "farid.hakim@agency.gov.my" → "Farid Hakim". */
function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  return (
    local
      .split(/[._-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ") || email
  );
}

/**
 * /api/operators — the membership list, and (admin only) the whitelist.
 *
 * Access model: an admin whitelists an email address with a role. That person
 * can then authenticate with either the address or their member id. Removing
 * access sets `revoked_at` — the row, and every template, review, run and step
 * that references it, is kept for auditing. Inviting a revoked email again
 * restores the same member (same id), so their history reattaches.
 *
 * There is no email round-trip here: identity is header-based plumbing, so the
 * "invitation" is the whitelist entry itself. Point OperatorStore at your
 * identity provider to send real invitation mail.
 */
export function createOperatorRouter({
  store,
  audit,
}: {
  store: OperatorStore;
  audit?: AuditRecorder;
}): Router {
  const router = Router();

  router.use(authenticate(store));

  // GET /me — identity plus the exact permission list the UI should honour.
  // Every mutating route re-checks these on the server, so this is a
  // convenience, never the enforcement.
  router.get(
    "/me",
    wrap(async (req, res) => {
      const operator = currentOperator(req);
      res.json({ operator, permissions: permissionsFor(operator.role) });
    }),
  );

  // GET / — every member, active or revoked. Active ones power the identity
  // switcher; the admin view also needs revoked rows to show who lost access.
  router.get(
    "/",
    wrap(async (_req, res) => {
      const operators = await store.list();
      res.json({ operators, count: operators.length });
    }),
  );

  // POST / — admin whitelists an email as operator or auditor.
  router.post(
    "/",
    requirePermission("users:manage"),
    wrap(async (req, res) => {
      const input = parse(CreateMemberSchema, req.body);
      const email = input.email.toLowerCase();

      const existing = (await store.list()).find(
        (member) => member.email.toLowerCase() === email,
      );

      if (existing && existing.revokedAt === null) {
        throw conflict(`${email} already has access to this workspace.`);
      }

      // Keep a restored member's recorded name unless the admin supplies a new
      // one — a restore must not rename them after the fact.
      const displayName =
        input.displayName ?? existing?.displayName ?? nameFromEmail(email);

      if (existing) {
        // Restore: same id, so their past work stays attributed to them.
        const restored = await store.reactivate(existing.id, {
          displayName,
          email,
          role: input.role,
        });
        if (!restored) throw notFound(`Member '${existing.id}' not found.`);
        recordAudit(audit, currentOperator(req), {
          action: "MEMBER_ACCESS_RESTORED",
          targetType: "operator",
          targetId: restored.id,
          details: { email, role: restored.role, displayName: restored.displayName },
        });
        res.status(201).json({ operator: restored, reactivated: true });
        return;
      }

      const operator = await store.create({
        id: `op-${randomUUID()}`,
        displayName,
        email,
        role: input.role,
      });
      recordAudit(audit, currentOperator(req), {
        action: "MEMBER_WHITELISTED",
        targetType: "operator",
        targetId: operator.id,
        details: { email, role: operator.role, displayName: operator.displayName },
      });
      res.status(201).json({ operator, reactivated: false });
    }),
  );

  // PATCH /:id/role — admin switches a member between operator and auditor.
  router.patch(
    "/:id/role",
    requirePermission("users:manage"),
    wrap(async (req, res) => {
      const parsedId = MemberIdSchema.safeParse(req.params.id);
      if (!parsedId.success) throw notFound("Member not found.");

      const target = await store.findById(parsedId.data);
      if (!target) throw notFound(`Member '${parsedId.data}' not found.`);

      const actor = currentOperator(req);
      if (target.id === actor.id) {
        throw conflict("You cannot change your own role — ask another admin.");
      }
      if (target.role === "admin") {
        throw conflict(
          "Admin roles are provisioned outside this module; here a member is switched between operator and auditor only.",
        );
      }

      const { role } = parse(SetRoleSchema, req.body ?? {});
      if (role === target.role) {
        throw conflict(`This member is already ${role}.`);
      }

      const updated = await store.setRole(target.id, role);
      if (!updated) throw notFound(`Member '${target.id}' not found.`);
      recordAudit(audit, actor, {
        action: "MEMBER_ROLE_CHANGED",
        targetType: "operator",
        targetId: updated.id,
        details: { from: target.role, to: updated.role, displayName: updated.displayName },
      });
      res.json({ operator: updated });
    }),
  );

  // DELETE /:id — remove access (soft delete). Nothing is deleted: the member
  // row stays so `created_by` / `reviewed_by` / `performed_by` keep a real name.
  router.delete(
    "/:id",
    requirePermission("users:manage"),
    wrap(async (req, res) => {
      const parsedId = MemberIdSchema.safeParse(req.params.id);
      if (!parsedId.success) throw notFound("Member not found.");

      const target = await store.findById(parsedId.data);
      if (!target) throw notFound(`Member '${parsedId.data}' not found.`);

      const actor = currentOperator(req);
      if (target.id === actor.id) {
        throw conflict("You cannot remove your own access — ask another admin.");
      }
      if (target.role === "admin") {
        throw conflict("Admin access is not revoked through this module.");
      }
      if (target.revokedAt !== null) {
        throw conflict(`${target.displayName} already has no access.`);
      }

      const revoked = await store.revoke(target.id);
      if (!revoked) throw notFound(`Member '${target.id}' not found.`);
      recordAudit(audit, actor, {
        action: "MEMBER_ACCESS_REVOKED",
        targetType: "operator",
        targetId: revoked.id,
        details: { displayName: revoked.displayName, email: revoked.email },
      });
      res.json({ operator: revoked, revoked: true });
    }),
  );

  router.use((_req, _res, next) => next(notFound("Route not found.")));

  return router;
}
