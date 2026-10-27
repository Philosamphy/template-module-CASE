import { describe, expect, it } from "vitest";
import { validateBusinessRules, type RuleConfig } from "../src/domain/businessRules.js";
import {
  CreateTemplateSchema,
  GeneratedTemplateSchema,
  UpdateTemplateSchema,
  WorkflowStepSchema,
  type WorkflowStep,
} from "../src/domain/schemas.js";

const rules: RuleConfig = {
  maxSteps: 20,
  supportedRoles: ["officer", "approver", "coordinator"],
  supportedNotificationChannels: ["email", "telegram"],
};

const step = (overrides: Partial<WorkflowStep> = {}): WorkflowStep => ({
  id: "step-1",
  name: "Review Complaint",
  type: "review",
  description: "Review the submitted complaint.",
  ...overrides,
});

const validSteps = () => [
  step(),
  step({ id: "step-2", name: "Check Required Details", type: "validation" }),
  step({ id: "step-3", name: "Obtain Approval", type: "approval" }),
  step({ id: "step-4", name: "Notify Requester", type: "notification", channel: "email" }),
];

describe("structural validation (Zod)", () => {
  it("accepts the reference maintenance-complaint template", () => {
    const result = CreateTemplateSchema.safeParse({
      name: "Maintenance Complaint Workflow",
      steps: validSteps(),
    });
    expect(result.success).toBe(true);
  });

  it("rejects a missing or empty name", () => {
    expect(CreateTemplateSchema.safeParse({ name: "", steps: validSteps() }).success).toBe(false);
    expect(CreateTemplateSchema.safeParse({ steps: validSteps() }).success).toBe(false);
  });

  it("rejects a non-array or empty steps field", () => {
    expect(CreateTemplateSchema.safeParse({ name: "x", steps: "nope" }).success).toBe(false);
    expect(CreateTemplateSchema.safeParse({ name: "x", steps: [] }).success).toBe(false);
  });

  it("rejects unsupported step types", () => {
    expect(WorkflowStepSchema.safeParse({ ...step(), type: "execute" }).success).toBe(false);
    expect(WorkflowStepSchema.safeParse({ ...step(), type: "payment" }).success).toBe(false);
  });

  it("rejects steps missing id/name/description", () => {
    expect(WorkflowStepSchema.safeParse({ ...step(), id: "" }).success).toBe(false);
    expect(WorkflowStepSchema.safeParse({ ...step(), name: "" }).success).toBe(false);
    expect(WorkflowStepSchema.safeParse({ ...step(), description: undefined }).success).toBe(false);
  });

  it("rejects protected fields sent through an edit request", () => {
    const result = UpdateTemplateSchema.safeParse({
      name: "Renamed",
      origin: "MANUAL",
      is_active: true,
      template_id: "123e4567-e89b-12d3-a456-426614174000",
      review_status: "APPROVED",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty edit payload", () => {
    expect(UpdateTemplateSchema.safeParse({}).success).toBe(false);
  });

  it("accepts only name + steps from the AI output", () => {
    const good = GeneratedTemplateSchema.safeParse({
      name: "AI Template",
      steps: validSteps(),
    });
    expect(good.success).toBe(true);

    // Even if the model emits activation/approval fields, they are not part of
    // the contract and must not survive validation.
    const sneaky = GeneratedTemplateSchema.safeParse({
      name: "AI Template",
      steps: validSteps(),
      origin: "MANUAL",
      is_active: true,
      review_status: "APPROVED",
    });
    expect(sneaky.success).toBe(false);
  });
});

describe("business-rule validation", () => {
  it("passes a compliant workflow", () => {
    expect(
      validateBusinessRules({ name: "Compliant", steps: validSteps() }, rules),
    ).toEqual([]);
  });

  it("requires the first step to be a review", () => {
    const steps = validSteps();
    steps[0] = step({ id: "step-1", type: "notification" });
    const violations = validateBusinessRules({ name: "x", steps }, rules);
    expect(violations.map((v) => v.rule)).toContain("first-step-review");
  });

  it("requires approval to follow validation", () => {
    const steps = [step(), step({ id: "step-3", type: "approval" })];
    const violations = validateBusinessRules({ name: "x", steps }, rules);
    expect(violations.map((v) => v.rule)).toContain("approval-requires-validation");
  });

  it("requires unique step ids", () => {
    const steps = [step(), step({ type: "validation" })];
    const violations = validateBusinessRules({ name: "x", steps }, rules);
    expect(violations.map((v) => v.rule)).toContain("unique-step-ids");
  });

  it("rejects roles that do not exist in the system", () => {
    const steps = validSteps();
    steps[1] = { ...steps[1]!, assignedRole: "ghost-role" };
    const violations = validateBusinessRules({ name: "x", steps }, rules);
    expect(violations.map((v) => v.rule)).toContain("role-supported");
  });

  it("rejects unsupported notification channels", () => {
    const steps = validSteps();
    steps[3] = { ...steps[3]!, channel: "carrier-pigeon" };
    const violations = validateBusinessRules({ name: "x", steps }, rules);
    expect(violations.map((v) => v.rule)).toContain("notification-channel-supported");
  });

  it("enforces the step ceiling", () => {
    const steps = Array.from({ length: 21 }, (_, index) =>
      index === 0
        ? step()
        : step({ id: `s-${index}`, name: `Step ${index}`, type: "validation" }),
    );
    const violations = validateBusinessRules({ name: "x", steps }, rules);
    expect(violations.map((v) => v.rule)).toContain("max-steps");
  });
});
