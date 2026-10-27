import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { MemorySaver } from "@langchain/langgraph";
import { AiGenerationError, type TemplateGenerator } from "../src/ai/generator.js";
import { createApp } from "../src/app.js";
import type { RuleConfig } from "../src/domain/businessRules.js";
import { SimulatedNotificationPort } from "../src/execution/notifier.js";
import { MemoryExecutionRepository } from "./support/memoryExecutionRepo.js";
import { MemoryTemplateRepository } from "./support/memoryRepo.js";
import { APPROVER_ID, OPERATOR_ID, testOperatorDirectory } from "./support/operators.js";

const rules: RuleConfig = {
  maxSteps: 20,
  supportedRoles: ["officer", "approver", "coordinator"],
  supportedNotificationChannels: ["email", "telegram"],
};

const validSteps = () => [
  { id: "step-1", name: "Review Complaint", type: "review", description: "Review the complaint." },
  {
    id: "step-2",
    name: "Check Required Details",
    type: "validation",
    description: "Check required information.",
  },
  { id: "step-3", name: "Obtain Approval", type: "approval", description: "Approve if needed." },
  {
    id: "step-4",
    name: "Notify Requester",
    type: "notification",
    description: "Notify the requester.",
    channel: "email",
  },
];

class StubGenerator implements TemplateGenerator {
  mode: "ok" | "invalid-ai-output" | "unavailable" = "ok";

  async generate(): Promise<unknown> {
    if (this.mode === "unavailable") {
      throw new AiGenerationError("connection refused by http://127.0.0.1:11434");
    }
    if (this.mode === "invalid-ai-output") {
      // A model that both breaks the schema and tries to grant itself approval.
      return { name: "", steps: "not-an-array", is_active: true, review_status: "APPROVED" };
    }
    return { name: "AI Maintenance Complaint Workflow", steps: validSteps() };
  }
}

let app: Express;
let server: Server;
let base: string;
const generator = new StubGenerator();

beforeAll(async () => {
  app = createApp({
    repo: new MemoryTemplateRepository(),
    executions: new MemoryExecutionRepository(),
    checkpointer: new MemorySaver(),
    notifier: new SimulatedNotificationPort(),
    operators: testOperatorDirectory(),
    generator,
    rules,
    corsOrigins: ["http://localhost:5173"],
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
  options: {
    method?: string;
    body?: unknown;
    operator?: string | null;
  } = {},
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

const createTemplate = async () => {
  const response = await api("/api/templates", {
    method: "POST",
    body: { name: "Maintenance Complaint Workflow", steps: validSteps() },
  });
  expect(response.status).toBe(201);
  return response.body.template;
};

describe("authentication and authorisation", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const response = await api("/api/templates", { operator: null });
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects unknown operators with 401", async () => {
    const response = await api("/api/templates", { operator: "ops-intruder" });
    expect(response.status).toBe(401);
  });

  it("forbids a non-approver from approving, even with a valid identity", async () => {
    const template = await createTemplate();
    const response = await api(`/api/templates/${template.templateId}/approve`, {
      method: "POST",
      body: {},
      operator: OPERATOR_ID,
    });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });
});

describe("POST /api/templates (manual creation)", () => {
  it("creates an inactive PENDING template with origin MANUAL", async () => {
    const template = await createTemplate();
    expect(template.origin).toBe("MANUAL");
    expect(template.isActive).toBe(false);
    expect(template.reviewStatus).toBe("PENDING");
    expect(template.version).toBe(1);
    expect(template.templateId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns 422 for structurally invalid input", async () => {
    const response = await api("/api/templates", {
      method: "POST",
      body: { name: "Broken", steps: [{ id: "step-1", type: "execute" }] },
    });
    expect(response.status).toBe(422);
    expect(response.body.error.details.structural.length).toBeGreaterThan(0);
  });

  it("returns 422 when business rules are violated", async () => {
    const response = await api("/api/templates", {
      method: "POST",
      body: {
        name: "Rule Breaker",
        steps: [{ id: "s1", name: "Notify", type: "notification", description: "notify early" }],
      },
    });
    expect(response.status).toBe(422);
    expect(response.body.error.details.businessRules.map((v: any) => v.rule)).toContain(
      "first-step-review",
    );
  });
});

describe("POST /api/templates/generate", () => {
  it("saves AI drafts as inactive PENDING AI_DRAFTED templates", async () => {
    generator.mode = "ok";
    const response = await api("/api/templates/generate", {
      method: "POST",
      body: { prompt: "Create a workflow for a maintenance complaint submitted in Malay." },
    });
    expect(response.status).toBe(201);
    expect(response.body.template.origin).toBe("AI_DRAFTED");
    expect(response.body.template.isActive).toBe(false);
    expect(response.body.template.reviewStatus).toBe("PENDING");
  });

  it("treats model output as untrusted and refuses to persist invalid JSON", async () => {
    generator.mode = "invalid-ai-output";
    const before = await api("/api/templates");
    const response = await api("/api/templates/generate", {
      method: "POST",
      body: { prompt: "Create a workflow for a maintenance complaint submitted in Malay." },
    });
    expect(response.status).toBe(422);
    const after = await api("/api/templates");
    expect(after.body.count).toBe(before.body.count);
    generator.mode = "ok";
  });

  it("surfaces Ollama failures as 502 without creating anything", async () => {
    generator.mode = "unavailable";
    const response = await api("/api/templates/generate", {
      method: "POST",
      body: { prompt: "Create a workflow for a maintenance complaint submitted in Malay." },
    });
    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe("AI_GENERATION_FAILED");
    generator.mode = "ok";
  });
});

describe("PUT /api/templates/:id (editing)", () => {
  it("edits a pending template and re-validates the result", async () => {
    const template = await createTemplate();
    const response = await api(`/api/templates/${template.templateId}`, {
      method: "PUT",
      body: { name: "Renamed Workflow" },
    });
    expect(response.status).toBe(200);
    expect(response.body.template.name).toBe("Renamed Workflow");
    expect(response.body.template.reviewStatus).toBe("PENDING");
  });

  it("cannot change protected fields such as origin, status or activation", async () => {
    const template = await createTemplate();
    const response = await api(`/api/templates/${template.templateId}`, {
      method: "PUT",
      body: { name: "Sneaky", origin: "MANUAL", is_active: true, review_status: "APPROVED" },
    });
    expect(response.status).toBe(422);

    const stored = await api(`/api/templates/${template.templateId}`);
    expect(stored.body.template.origin).toBe("MANUAL");
    expect(stored.body.template.isActive).toBe(false);
    expect(stored.body.template.reviewStatus).toBe("PENDING");
  });

  it("refuses to edit an approved template", async () => {
    const template = await createTemplate();
    await api(`/api/templates/${template.templateId}/approve`, {
      method: "POST",
      body: {},
      operator: APPROVER_ID,
    });
    const response = await api(`/api/templates/${template.templateId}`, {
      method: "PUT",
      body: { name: "Late edit" },
    });
    expect(response.status).toBe(409);
    expect(response.body.error.message).toMatch(/new version/i);
  });

  it("returns 404 for unknown or malformed ids", async () => {
    expect((await api("/api/templates/00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await api("/api/templates/not-a-uuid")).status).toBe(404);
  });
});

describe("approve / reject lifecycle", () => {
  it("approves, activates and records the reviewer in one transaction", async () => {
    const template = await createTemplate();
    const response = await api(`/api/templates/${template.templateId}/approve`, {
      method: "POST",
      body: { comments: "Checked against the maintenance policy." },
      operator: APPROVER_ID,
    });
    expect(response.status).toBe(200);
    expect(response.body.template.reviewStatus).toBe("APPROVED");
    expect(response.body.template.isActive).toBe(true);
    expect(response.body.template.reviewedBy).toBe(APPROVER_ID);

    const detail = await api(`/api/templates/${template.templateId}`);
    expect(detail.body.template.reviews.map((r: any) => r.status)).toEqual(["APPROVED", "PENDING"]);
  });

  it("cannot approve the same template twice", async () => {
    const template = await createTemplate();
    const first = await api(`/api/templates/${template.templateId}/approve`, {
      method: "POST",
      body: {},
      operator: APPROVER_ID,
    });
    expect(first.status).toBe(200);
    const second = await api(`/api/templates/${template.templateId}/approve`, {
      method: "POST",
      body: {},
      operator: APPROVER_ID,
    });
    expect(second.status).toBe(409);
    expect(second.body.error.details.reviewStatus).toBe("APPROVED");
  });

  it("rejects a pending template, requires a reason, and keeps it inactive", async () => {
    const template = await createTemplate();

    const noReason = await api(`/api/templates/${template.templateId}/reject`, {
      method: "POST",
      body: {},
      operator: APPROVER_ID,
    });
    expect(noReason.status).toBe(422);

    const response = await api(`/api/templates/${template.templateId}/reject`, {
      method: "POST",
      body: { comments: "Missing escalation step." },
      operator: APPROVER_ID,
    });
    expect(response.status).toBe(200);
    expect(response.body.template.reviewStatus).toBe("REJECTED");
    expect(response.body.template.isActive).toBe(false);
  });

  it("re-submits a rejected template as PENDING when it is edited", async () => {
    const template = await createTemplate();
    await api(`/api/templates/${template.templateId}/reject`, {
      method: "POST",
      body: { comments: "Missing escalation step." },
      operator: APPROVER_ID,
    });

    const edited = await api(`/api/templates/${template.templateId}`, {
      method: "PUT",
      body: { name: "Fixed Workflow" },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.template.reviewStatus).toBe("PENDING");

    const approved = await api(`/api/templates/${template.templateId}/approve`, {
      method: "POST",
      body: {},
      operator: APPROVER_ID,
    });
    expect(approved.status).toBe(200);
    expect(approved.body.template.isActive).toBe(true);
  });
});

describe("listing, retrieval and deactivation", () => {
  it("lists and filters templates", async () => {
    generator.mode = "ok";
    await createTemplate();
    await api("/api/templates/generate", {
      method: "POST",
      body: { prompt: "Create a workflow for a maintenance complaint submitted in Malay." },
    });

    const all = await api("/api/templates");
    expect(all.status).toBe(200);
    expect(all.body.count).toBeGreaterThanOrEqual(2);

    const aiDrafts = await api("/api/templates?origin=AI_DRAFTED");
    expect(aiDrafts.body.templates.every((t: any) => t.origin === "AI_DRAFTED")).toBe(true);

    const pending = await api("/api/templates?status=PENDING");
    expect(pending.body.templates.every((t: any) => t.reviewStatus === "PENDING")).toBe(true);

    const active = await api("/api/templates?is_active=true");
    expect(active.body.templates.every((t: any) => t.isActive === true)).toBe(true);
  });

  it("deactivates without deleting the record", async () => {
    const template = await createTemplate();
    await api(`/api/templates/${template.templateId}/approve`, {
      method: "POST",
      body: {},
      operator: APPROVER_ID,
    });

    const response = await api(`/api/templates/${template.templateId}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(response.body.template.isActive).toBe(false);

    const stored = await api(`/api/templates/${template.templateId}`);
    expect(stored.status).toBe(200);
    expect(stored.body.template.reviewStatus).toBe("APPROVED");
  });
});
