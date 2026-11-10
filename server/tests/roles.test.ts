import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MemorySaver } from "@langchain/langgraph";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { RuleConfig } from "../src/domain/businessRules.js";
import { NullDocumentPort } from "../src/execution/documents.js";
import { SimulatedNotificationPort } from "../src/execution/notifier.js";
import { MemoryExecutionRepository } from "./support/memoryExecutionRepo.js";
import { MemoryTemplateRepository } from "./support/memoryRepo.js";
import {
  ADMIN_ID,
  AUDITOR_ID,
  OPERATOR_ID,
  REVIEWER_ID,
  testOperatorDirectory,
} from "./support/operators.js";

const rules: RuleConfig = {
  maxSteps: 20,
  supportedRoles: ["officer", "approver", "coordinator"],
  supportedNotificationChannels: ["email"],
};

const steps = () => [
  { id: "step-1", name: "Review Complaint", type: "review", description: "Review it." },
  { id: "step-2", name: "Check Details", type: "validation", description: "Check it." },
  { id: "step-3", name: "Obtain Approval", type: "approval", description: "Approve it." },
  {
    id: "step-4",
    name: "Notify Requester",
    type: "notification",
    description: "Tell the requester.",
    channel: "email",
  },
];

let app: Express;
let server: Server;
let base: string;
let admin2Id: string;

beforeAll(async () => {
  const directory = testOperatorDirectory();
  admin2Id = "ops-admin-2";
  directory.add({
    id: admin2Id,
    displayName: "Dewi (Admin)",
    email: "dewi@workspace.local",
    role: "admin",
    revokedAt: null,
  });

  app = createApp({
    repo: new MemoryTemplateRepository(),
    executions: new MemoryExecutionRepository(),
    checkpointer: new MemorySaver(),
    notifier: new SimulatedNotificationPort(),
    documents: new NullDocumentPort(),
    operators: directory,
    generator: { generate: async () => ({ name: "unused", steps: steps() }) },
    rules,
    corsOrigins: [],
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface ApiResponse {
  status: number;
  body: any;
}

async function api(
  path: string,
  options: { method?: string; body?: unknown; operator?: string | null } = {},
): Promise<ApiResponse> {
  const { method = "GET", body, operator = OPERATOR_ID } = options;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (operator) headers["x-operator-id"] = operator;

  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** Creates a PENDING template and returns it already approved + active. */
async function approvedTemplate(): Promise<any> {
  const created = await api("/api/templates", {
    method: "POST",
    body: { name: "Maintenance Complaint Workflow", steps: steps() },
  });
  expect(created.status).toBe(201);
  const approved = await api(`/api/templates/${created.body.template.templateId}/approve`, {
    method: "POST",
    body: {},
    operator: OPERATOR_ID,
  });
  expect(approved.status).toBe(200);
  return approved.body.template;
}

describe("GET /api/operators/me", () => {
  it("reports the caller's role and the exact permissions the UI should honour", async () => {
    const auditor = await api("/api/operators/me", { operator: AUDITOR_ID });
    expect(auditor.status).toBe(200);
    expect(auditor.body.operator.role).toBe("auditor");
    expect(auditor.body.permissions).toEqual(["template:read", "workflow:read"]);

    const operator = await api("/api/operators/me", { operator: OPERATOR_ID });
    expect(operator.body.permissions).toContain("template:approve");
    expect(operator.body.permissions).toContain("workflow:start");
    expect(operator.body.permissions).not.toContain("users:manage");

    const admin = await api("/api/operators/me", { operator: ADMIN_ID });
    expect(admin.body.operator.role).toBe("admin");
    expect(admin.body.permissions).toContain("users:manage");
    // Admin is a superset of operator.
    for (const permission of operator.body.permissions) {
      expect(admin.body.permissions).toContain(permission);
    }
  });

  it("requires an identity", async () => {
    expect((await api("/api/operators/me", { operator: null })).status).toBe(401);
  });
});

describe("auditor — read-only", () => {
  it("can view templates, run history and individual runs", async () => {
    const template = await approvedTemplate();
    const started = await api("/api/instances", {
      method: "POST",
      body: { templateId: template.templateId, input: { complainant: "Nurul" } },
    });
    expect(started.status).toBe(201);
    const instanceId: string = started.body.instance.instanceId;

    const list = await api("/api/templates", { operator: AUDITOR_ID });
    expect(list.status).toBe(200);
    expect(list.body.count).toBeGreaterThan(0);

    const detail = await api(`/api/templates/${template.templateId}`, { operator: AUDITOR_ID });
    expect(detail.status).toBe(200);

    expect((await api("/api/instances", { operator: AUDITOR_ID })).status).toBe(200);
    const run = await api(`/api/instances/${instanceId}`, { operator: AUDITOR_ID });
    expect(run.status).toBe(200);
    expect(run.body.stepRuns.length).toBeGreaterThan(0);
  });

  it("cannot create, generate, edit, deactivate or approve templates", async () => {
    const template = await approvedTemplate();
    const pending = await api("/api/templates", {
      method: "POST",
      body: { name: "Auditor Attempt", steps: steps() },
    });
    expect(pending.status).toBe(201);

    const attempts: Array<[string, () => Promise<ApiResponse>]> = [
      [
        "create",
        () =>
          api("/api/templates", {
            method: "POST",
            body: { name: "x", steps: steps() },
            operator: AUDITOR_ID,
          }),
      ],
      [
        "generate",
        () =>
          api("/api/templates/generate", {
            method: "POST",
            body: { prompt: "a workflow please" },
            operator: AUDITOR_ID,
          }),
      ],
      [
        "edit",
        () =>
          api(`/api/templates/${pending.body.template.templateId}`, {
            method: "PUT",
            body: { name: "Renamed" },
            operator: AUDITOR_ID,
          }),
      ],
      [
        "deactivate",
        () => api(`/api/templates/${template.templateId}`, { method: "DELETE", operator: AUDITOR_ID }),
      ],
      [
        "approve",
        () =>
          api(`/api/templates/${pending.body.template.templateId}/approve`, {
            method: "POST",
            body: {},
            operator: AUDITOR_ID,
          }),
      ],
      [
        "reject",
        () =>
          api(`/api/templates/${pending.body.template.templateId}/reject`, {
            method: "POST",
            body: { comments: "no" },
            operator: AUDITOR_ID,
          }),
      ],
    ];

    for (const [label, attempt] of attempts) {
      const response = await attempt();
      expect(response.status, `${label} must be forbidden for an auditor`).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");
    }
  });

  it("cannot start a run, answer a gate or cancel a run", async () => {
    const template = await approvedTemplate();
    const start = await api("/api/instances", {
      method: "POST",
      body: { templateId: template.templateId },
      operator: AUDITOR_ID,
    });
    expect(start.status).toBe(403);

    const run = await api("/api/instances", {
      method: "POST",
      body: { templateId: template.templateId },
      operator: OPERATOR_ID,
    });
    const instanceId: string = run.body.instance.instanceId;

    const respond = await api(`/api/instances/${instanceId}/respond`, {
      method: "POST",
      body: { approved: true },
      operator: AUDITOR_ID,
    });
    expect(respond.status).toBe(403);

    const cancel = await api(`/api/instances/${instanceId}/cancel`, {
      method: "POST",
      operator: AUDITOR_ID,
    });
    expect(cancel.status).toBe(403);
  });

  it("cannot invite members or change roles", async () => {
    const invite = await api("/api/operators", {
      method: "POST",
      body: { email: "sneaky@workspace.local", role: "operator" },
      operator: AUDITOR_ID,
    });
    expect(invite.status).toBe(403);

    const change = await api(`/api/operators/${OPERATOR_ID}/role`, {
      method: "PATCH",
      body: { role: "auditor" },
      operator: AUDITOR_ID,
    });
    expect(change.status).toBe(403);
  });
});

describe("operator — create, edit, approve, run", () => {
  it("creates and approves templates and starts runs", async () => {
    const template = await approvedTemplate();
    expect(template.reviewStatus).toBe("APPROVED");
    expect(template.isActive).toBe(true);

    const run = await api("/api/instances", {
      method: "POST",
      body: { templateId: template.templateId },
    });
    expect(run.status).toBe(201);

    const gate = await api(`/api/instances/${run.body.instance.instanceId}/respond`, {
      method: "POST",
      body: { approved: true },
      operator: REVIEWER_ID,
    });
    expect(gate.status).toBe(200);
    expect(gate.body.instance.status).toBe("COMPLETED");
  });

  it("cannot invite members or change roles", async () => {
    const invite = await api("/api/operators", {
      method: "POST",
      body: { email: "another@workspace.local", role: "operator" },
    });
    expect(invite.status).toBe(403);
    expect(invite.body.error.details.requiredPermission).toBe("users:manage");

    const change = await api(`/api/operators/${AUDITOR_ID}/role`, {
      method: "PATCH",
      body: { role: "operator" },
    });
    expect(change.status).toBe(403);
  });
});

describe("admin — member management", () => {
  it("lists the directory to any signed-in member", async () => {
    const response = await api("/api/operators", { operator: AUDITOR_ID });
    expect(response.status).toBe(200);
    const roles = response.body.operators.map((member: any) => member.role);
    expect(roles).toContain("admin");
    expect(roles).toContain("operator");
    expect(roles).toContain("auditor");
  });

  it("whitelists an email as an auditor, who can sign in by id or email", async () => {
    const created = await api("/api/operators", {
      method: "POST",
      body: { email: "farid.hakim@agency.gov.my", role: "auditor" },
      operator: ADMIN_ID,
    });
    expect(created.status).toBe(201);
    expect(created.body.operator.role).toBe("auditor");
    expect(created.body.operator.email).toBe("farid.hakim@agency.gov.my");
    // A readable name is derived when the admin only supplies the address.
    expect(created.body.operator.displayName).toBe("Farid Hakim");
    expect(created.body.operator.revokedAt).toBeNull();

    const id = created.body.operator.id;
    const me = await api("/api/operators/me", { operator: id });
    expect(me.status).toBe(200);
    expect(me.body.permissions).toEqual(["template:read", "workflow:read"]);

    // The whitelisted address itself is a valid identity.
    const byEmail = await api("/api/operators/me", { operator: "FARID.HAKIM@agency.gov.my" });
    expect(byEmail.status).toBe(200);
    expect(byEmail.body.operator.id).toBe(id);

    const write = await api("/api/templates", {
      method: "POST",
      body: { name: "Invited Attempt", steps: steps() },
      operator: id,
    });
    expect(write.status).toBe(403);

    // The new member appears in the directory the switcher reads.
    const directory = await api("/api/operators");
    expect(directory.body.operators.some((member: any) => member.id === id)).toBe(true);
  });

  it("switches a member from operator to auditor and back", async () => {
    const created = await api("/api/operators", {
      method: "POST",
      body: { email: "mei@workspace.local", displayName: "Mei (Operator)", role: "operator" },
      operator: ADMIN_ID,
    });
    const id = created.body.operator.id;

    const demoted = await api(`/api/operators/${id}/role`, {
      method: "PATCH",
      body: { role: "auditor" },
      operator: ADMIN_ID,
    });
    expect(demoted.status).toBe(200);
    expect(demoted.body.operator.role).toBe("auditor");

    // The demotion takes effect immediately on the next request.
    const write = await api("/api/templates", {
      method: "POST",
      body: { name: "Demoted Attempt", steps: steps() },
      operator: id,
    });
    expect(write.status).toBe(403);

    const promoted = await api(`/api/operators/${id}/role`, {
      method: "PATCH",
      body: { role: "operator" },
      operator: ADMIN_ID,
    });
    expect(promoted.status).toBe(200);
    expect((await api("/api/operators/me", { operator: id })).body.permissions).toContain(
      "template:create",
    );
  });

  it("refuses admin as an invitable or assignable role", async () => {
    const invite = await api("/api/operators", {
      method: "POST",
      body: { email: "wouldbe.admin@workspace.local", role: "admin" },
      operator: ADMIN_ID,
    });
    expect(invite.status).toBe(422);

    const change = await api(`/api/operators/${OPERATOR_ID}/role`, {
      method: "PATCH",
      body: { role: "admin" },
      operator: ADMIN_ID,
    });
    expect(change.status).toBe(422);
  });

  it("protects admins: no self-demotion and no re-roling another admin", async () => {
    const self = await api(`/api/operators/${ADMIN_ID}/role`, {
      method: "PATCH",
      body: { role: "auditor" },
      operator: ADMIN_ID,
    });
    expect(self.status).toBe(409);

    const other = await api(`/api/operators/${admin2Id}/role`, {
      method: "PATCH",
      body: { role: "operator" },
      operator: ADMIN_ID,
    });
    expect(other.status).toBe(409);
  });

  it("rejects duplicate emails, malformed addresses, unknown members and no-op changes", async () => {
    const duplicate = await api("/api/operators", {
      method: "POST",
      body: { email: "chong@workspace.local", role: "auditor" },
      operator: ADMIN_ID,
    });
    expect(duplicate.status).toBe(409);

    const malformed = await api("/api/operators", {
      method: "POST",
      body: { email: "not-an-email", role: "auditor" },
      operator: ADMIN_ID,
    });
    expect(malformed.status).toBe(422);

    const unknown = await api("/api/operators/ops-ghost/role", {
      method: "PATCH",
      body: { role: "operator" },
      operator: ADMIN_ID,
    });
    expect(unknown.status).toBe(404);

    const noop = await api(`/api/operators/${AUDITOR_ID}/role`, {
      method: "PATCH",
      body: { role: "auditor" },
      operator: ADMIN_ID,
    });
    expect(noop.status).toBe(409);
  });
});

describe("admin — removing access (soft delete)", () => {
  it("revokes access but keeps the member and everything they touched", async () => {
    const invited = await api("/api/operators", {
      method: "POST",
      body: {
        email: "zainal@workspace.local",
        displayName: "Zainal (Operator)",
        role: "operator",
      },
      operator: ADMIN_ID,
    });
    expect(invited.status).toBe(201);
    const id = invited.body.operator.id;

    const created = await api("/api/templates", {
      method: "POST",
      body: { name: "Zainal Workflow", steps: steps() },
      operator: id,
    });
    expect(created.status).toBe(201);
    const templateId = created.body.template.templateId;

    const revoked = await api(`/api/operators/${id}`, {
      method: "DELETE",
      operator: ADMIN_ID,
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body.operator.revokedAt).not.toBeNull();

    // The identity is refused from the very next request, with a clear code —
    // whether they present their id or their whitelisted email.
    const byId = await api("/api/templates", { operator: id });
    expect(byId.status).toBe(403);
    expect(byId.body.error.code).toBe("ACCESS_REVOKED");
    expect((await api("/api/templates", { operator: "zainal@workspace.local" })).status).toBe(403);

    // Nothing was deleted: the template is still there and still attributed to
    // them, which is the point of a soft delete.
    const detail = await api(`/api/templates/${templateId}`, { operator: ADMIN_ID });
    expect(detail.status).toBe(200);
    expect(detail.body.template.createdBy).toBe(id);

    // ...and the directory still names them, marked revoked.
    const directory = await api("/api/operators", { operator: ADMIN_ID });
    const row = directory.body.operators.find((member: any) => member.id === id);
    expect(row.displayName).toBe("Zainal (Operator)");
    expect(row.revokedAt).not.toBeNull();
  });

  it("restores the same member when their email is invited again", async () => {
    const first = await api("/api/operators", {
      method: "POST",
      body: {
        email: "restore.me@workspace.local",
        displayName: "Mei Ling",
        role: "auditor",
      },
      operator: ADMIN_ID,
    });
    expect(first.status).toBe(201);
    const id = first.body.operator.id;

    expect(
      (await api(`/api/operators/${id}`, { method: "DELETE", operator: ADMIN_ID })).status,
    ).toBe(200);

    const again = await api("/api/operators", {
      method: "POST",
      body: { email: "restore.me@workspace.local", role: "operator" },
      operator: ADMIN_ID,
    });
    expect(again.status).toBe(201);
    expect(again.body.reactivated).toBe(true);
    expect(again.body.operator.id).toBe(id);
    expect(again.body.operator.revokedAt).toBeNull();
    // A restore keeps the name the member was invited under.
    expect(again.body.operator.displayName).toBe("Mei Ling");

    // Access really is back, with the newly assigned role.
    const me = await api("/api/operators/me", { operator: "restore.me@workspace.local" });
    expect(me.status).toBe(200);
    expect(me.body.permissions).toContain("template:create");
  });

  it("protects the caller, other admins and repeat revocations", async () => {
    const self = await api(`/api/operators/${ADMIN_ID}`, {
      method: "DELETE",
      operator: ADMIN_ID,
    });
    expect(self.status).toBe(409);

    const otherAdmin = await api(`/api/operators/${admin2Id}`, {
      method: "DELETE",
      operator: ADMIN_ID,
    });
    expect(otherAdmin.status).toBe(409);

    const created = await api("/api/operators", {
      method: "POST",
      body: { email: "temp.member@workspace.local", role: "auditor" },
      operator: ADMIN_ID,
    });
    const id = created.body.operator.id;
    expect((await api(`/api/operators/${id}`, { method: "DELETE", operator: ADMIN_ID })).status).toBe(
      200,
    );
    const twice = await api(`/api/operators/${id}`, { method: "DELETE", operator: ADMIN_ID });
    expect(twice.status).toBe(409);

    const unknown = await api("/api/operators/ops-ghost", {
      method: "DELETE",
      operator: ADMIN_ID,
    });
    expect(unknown.status).toBe(404);
  });

  it("is admin-only", async () => {
    const response = await api(`/api/operators/${AUDITOR_ID}`, {
      method: "DELETE",
      operator: OPERATOR_ID,
    });
    expect(response.status).toBe(403);
    expect(response.body.error.details.requiredPermission).toBe("users:manage");
  });
});
