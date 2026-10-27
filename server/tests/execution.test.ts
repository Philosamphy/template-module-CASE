import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MemorySaver } from "@langchain/langgraph";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { RuleConfig } from "../src/domain/businessRules.js";
import { SimulatedNotificationPort } from "../src/execution/notifier.js";
import type { WorkflowInstance } from "../src/execution/types.js";
import { InstanceService } from "../src/services/instanceService.js";
import type { TemplateRepository } from "../src/repo/types.js";
import { MemoryExecutionRepository } from "./support/memoryExecutionRepo.js";
import { MemoryTemplateRepository } from "./support/memoryRepo.js";
import { APPROVER_ID, OPERATOR_ID, testOperatorDirectory } from "./support/operators.js";

const rules: RuleConfig = {
  maxSteps: 20,
  supportedRoles: ["officer", "approver", "coordinator"],
  supportedNotificationChannels: ["email", "telegram"],
};

const steps = () => [
  { id: "step-1", name: "Review Complaint", type: "review" as const, description: "Review it." },
  { id: "step-2", name: "Check Details", type: "validation" as const, description: "Check it." },
  { id: "step-3", name: "Obtain Approval", type: "approval" as const, description: "Approve it." },
  {
    id: "step-4",
    name: "Notify Requester",
    type: "notification" as const,
    description: "Tell the requester.",
    channel: "email",
  },
];

let app: Express;
let server: Server;
let base: string;
let templates: TemplateRepository;
let executions: MemoryExecutionRepository;
let notifier: SimulatedNotificationPort;
let checkpointer: MemorySaver;
let approvedTemplateId: string;
let pendingTemplateId: string;

beforeAll(async () => {
  templates = new MemoryTemplateRepository();
  executions = new MemoryExecutionRepository();
  notifier = new SimulatedNotificationPort();
  checkpointer = new MemorySaver();

  approvedTemplateId = (
    await templates.create(
      {
        name: "Maintenance Complaint Workflow",
        version: 1,
        steps: steps(),
        origin: "MANUAL",
        isActive: true,
        createdBy: OPERATOR_ID,
      },
      { status: "APPROVED", reviewedBy: APPROVER_ID, comments: "Approved." },
    )
  ).templateId;

  pendingTemplateId = (
    await templates.create(
      {
        name: "Not Approved Yet",
        version: 1,
        steps: steps(),
        origin: "AI_DRAFTED",
        isActive: false,
        createdBy: OPERATOR_ID,
      },
      { status: "PENDING", reviewedBy: null, comments: "Awaiting review." },
    )
  ).templateId;

  app = createApp({
    repo: templates,
    executions,
    checkpointer,
    notifier,
    operators: testOperatorDirectory(),
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

async function api(
  path: string,
  options: { method?: string; body?: unknown; operator?: string | null } = {},
): Promise<{ status: number; body: any }> {
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

const start = (templateId = approvedTemplateId) =>
  api("/api/instances", { method: "POST", body: { templateId } });

describe("POST /api/instances (starting execution)", () => {
  it("rejects unauthenticated starts", async () => {
    const response = await api("/api/instances", {
      method: "POST",
      body: { templateId: approvedTemplateId },
      operator: null,
    });
    expect(response.status).toBe(401);
  });

  it("refuses to execute a template that is not approved and active", async () => {
    const response = await start(pendingTemplateId);
    expect(response.status).toBe(409);
    expect(response.body.error.details.reviewStatus).toBe("PENDING");
  });

  it("runs the automatic steps and pauses at the approval gate", async () => {
    const response = await start();
    expect(response.status).toBe(201);

    const { instance, stepRuns } = response.body;
    expect(instance.status).toBe("PAUSED");
    expect(instance.currentStep).toBe("step-3");
    expect(instance.cursorIndex).toBe(2);
    expect(instance.templateName).toBe("Maintenance Complaint Workflow");

    expect(stepRuns.map((run: any) => `${run.stepId}:${run.status}`)).toEqual([
      "step-1:COMPLETED",
      "step-2:COMPLETED",
    ]);
    // No notification may fire while the workflow is waiting for approval.
    expect(notifier.sent).toHaveLength(0);
  });

  it("returns 404 for a template that does not exist", async () => {
    const response = await start("00000000-0000-4000-8000-000000000000");
    expect(response.status).toBe(404);
  });
});

describe("POST /api/instances/:id/respond (the approval gate)", () => {
  it("forbids a non-approver from answering the gate", async () => {
    const { body } = await start();
    const response = await api(`/api/instances/${body.instance.instanceId}/respond`, {
      method: "POST",
      body: { approved: true },
      operator: OPERATOR_ID,
    });
    expect(response.status).toBe(403);
  });

  it("records a rejection without ever notifying", async () => {
    const { body } = await start();
    const instanceId: string = body.instance.instanceId;

    const response = await api(`/api/instances/${instanceId}/respond`, {
      method: "POST",
      body: { approved: false, comments: "Missing escalation step." },
      operator: APPROVER_ID,
    });
    expect(response.status).toBe(200);
    expect(response.body.instance.status).toBe("REJECTED");

    const approvalRun = response.body.stepRuns.find((run: any) => run.stepId === "step-3");
    expect(approvalRun.status).toBe("REJECTED");
    expect(approvalRun.performedBy).toBe(APPROVER_ID);
    expect(notifier.sent).toHaveLength(0);
  });

  it("completes the workflow on approval and only then notifies", async () => {
    const { body } = await start();
    const instanceId: string = body.instance.instanceId;

    const response = await api(`/api/instances/${instanceId}/respond`, {
      method: "POST",
      body: { approved: true, comments: "Looks good." },
      operator: APPROVER_ID,
    });
    expect(response.status).toBe(200);
    expect(response.body.instance.status).toBe("COMPLETED");
    expect(response.body.instance.currentStep).toBeNull();

    const statuses = response.body.stepRuns.map((run: any) => `${run.stepId}:${run.status}`);
    expect(statuses).toEqual([
      "step-1:COMPLETED",
      "step-2:COMPLETED",
      "step-3:APPROVED",
      "step-4:SIMULATED",
    ]);
    expect(response.body.stepRuns[2].performedBy).toBe(APPROVER_ID);

    // Exactly one notification, and it is simulated rather than delivered.
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]?.step.id).toBe("step-4");

    const twice = await api(`/api/instances/${instanceId}/respond`, {
      method: "POST",
      body: { approved: true },
      operator: APPROVER_ID,
    });
    expect(twice.status).toBe(409);
    expect(twice.body.error.details.instanceStatus).toBe("COMPLETED");
  });
});

describe("cancelling and listing", () => {
  it("cancels a paused workflow once, and keeps history", async () => {
    const { body } = await start();
    const instanceId: string = body.instance.instanceId;

    const cancelled = await api(`/api/instances/${instanceId}/cancel`, { method: "POST" });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.instance.status).toBe("CANCELLED");

    // Completed step history is still there after cancelling.
    expect(cancelled.body.stepRuns).toHaveLength(2);

    const again = await api(`/api/instances/${instanceId}/cancel`, { method: "POST" });
    expect(again.status).toBe(409);
  });

  it("lists runs with status filters", async () => {
    const all = await api("/api/instances");
    expect(all.status).toBe(200);
    expect(all.body.count).toBeGreaterThanOrEqual(3);

    const paused = await api("/api/instances?status=PAUSED");
    expect(paused.body.instances.every((i: WorkflowInstance) => i.status === "PAUSED")).toBe(true);

    const byTemplate = await api(`/api/instances?template_id=${approvedTemplateId}`);
    expect(
      byTemplate.body.instances.every((i: WorkflowInstance) => i.templateId === approvedTemplateId),
    ).toBe(true);
  });

  it("returns 404 for malformed instance ids", async () => {
    expect((await api("/api/instances/not-a-uuid")).status).toBe(404);
  });
});

describe("checkpoint persistence", () => {
  it("resumes a paused workflow from a second service instance sharing the checkpointer", async () => {
    const { body } = await start();
    const instanceId: string = body.instance.instanceId;

    // Simulates a server restart: new service object, same checkpointer + tables.
    const restarted = new InstanceService({
      templates,
      instances: executions,
      checkpointer,
      notifier,
    });

    const notificationsBefore = notifier.sent.length;

    const detail = await restarted.respond(instanceId, {
      approved: true,
      comments: "Approved after restart.",
      by: APPROVER_ID,
    });

    expect(detail.instance.status).toBe("COMPLETED");
    expect(detail.stepRuns).toHaveLength(4);
    // One more simulated notification than before this approval — no duplicates.
    expect(notifier.sent).toHaveLength(notificationsBefore + 1);
  });
});
