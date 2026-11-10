import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../auth/middleware.js";
import type { OperatorDirectory } from "../auth/operators.js";
import type { AuditStore } from "../audit/auditLog.js";
import { notFound } from "../domain/errors.js";
import { parse, wrap } from "./http.js";

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  action: z.string().trim().min(1).max(80).optional(),
  outcome: z.enum(["SUCCESS", "FAILURE", "PENDING"]).optional(),
  actor: z.string().trim().min(1).max(80).optional(),
});

const EventIdSchema = z.string().uuid();

/**
 * /api/audit — read-only access to the hash-chained audit trail.
 *
 * Every member (auditors included) can read and verify the chain; nothing in
 * this router mutates it. Events are append-only by construction: there is no
 * write endpoint, only the service layer records actions as they happen.
 */
export function createAuditRouter({
  store,
  operators,
}: {
  store: AuditStore;
  operators: OperatorDirectory;
}): Router {
  const router = Router();

  router.use(authenticate(operators));

  router.get(
    "/",
    wrap(async (req, res) => {
      const query = parse(ListQuerySchema, req.query);
      const result = await store.list({
        limit: query.limit,
        offset: query.offset,
        action: query.action,
        outcome: query.outcome,
        actorId: query.actor,
      });
      res.json({
        events: result.events,
        total: result.total,
        limit: query.limit ?? 50,
        offset: query.offset ?? 0,
      });
    }),
  );

  router.get(
    "/events/:id",
    wrap(async (req, res) => {
      const parsed = EventIdSchema.safeParse(req.params.id);
      if (!parsed.success) throw notFound("Audit event not found.");
      const event = await store.get(parsed.data);
      if (!event) throw notFound("Audit event not found.");
      res.json({ event });
    }),
  );

  // Re-computes the whole chain and reports the first broken sequence, if any.
  router.post(
    "/verify",
    wrap(async (_req, res) => {
      res.json(await store.verify());
    }),
  );

  router.use((_req, _res, next) => next(notFound("Route not found.")));

  return router;
}
