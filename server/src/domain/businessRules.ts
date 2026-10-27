import type { WorkflowStep } from "./schemas.js";

/**
 * Layer B: business-rule validation. Structural validation only proves the
 * payload has the right shape; these rules decide whether the workflow makes
 * sense for this system.
 *
 * Rules are deliberately explicit and enumerable so the operator UI can render
 * them, and so an AI-generated draft can never skip them.
 */
export interface RuleConfig {
  maxSteps: number;
  supportedRoles: string[];
  supportedNotificationChannels: string[];
}

export interface Violation {
  rule: string;
  message: string;
  stepId?: string;
}

export interface ValidatableTemplate {
  name: string;
  steps: WorkflowStep[];
}

export function validateBusinessRules(
  template: ValidatableTemplate,
  config: RuleConfig,
): Violation[] {
  const violations: Violation[] = [];
  const { steps } = template;

  // 1. A workflow must be bounded in size so a generated draft cannot run away.
  if (steps.length > config.maxSteps) {
    violations.push({
      rule: "max-steps",
      message: `A workflow may not contain more than ${config.maxSteps} steps (found ${steps.length}).`,
    });
  }

  // 2. Step ids must be unique so execution can address each step unambiguously.
  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.id)) {
      violations.push({
        rule: "unique-step-ids",
        stepId: step.id,
        message: `Duplicate step id "${step.id}".`,
      });
    }
    seen.add(step.id);
  }

  // 3. Every workflow starts with human review.
  const first = steps[0];
  if (first && first.type !== "review") {
    violations.push({
      rule: "first-step-review",
      stepId: first.id,
      message: "The first step of a workflow must be a review step.",
    });
  }

  // 4. An approval step may only follow a validation step.
  let validationSeen = false;
  for (const step of steps) {
    if (step.type === "validation") validationSeen = true;
    if (step.type === "approval" && !validationSeen) {
      violations.push({
        rule: "approval-requires-validation",
        stepId: step.id,
        message:
          'An "approval" step must come after a "validation" step: nothing is approved before it has been checked.',
      });
    }
  }

  // 5. Referenced roles must exist in the system.
  for (const step of steps) {
    if (step.assignedRole && !config.supportedRoles.includes(step.assignedRole)) {
      violations.push({
        rule: "role-supported",
        stepId: step.id,
        message: `Role "${step.assignedRole}" is not available. Supported roles: ${config.supportedRoles.join(", ")}.`,
      });
    }
  }

  // 6. Notification steps must target an integration we actually have.
  for (const step of steps) {
    if (
      step.type === "notification" &&
      step.channel &&
      !config.supportedNotificationChannels.includes(step.channel)
    ) {
      violations.push({
        rule: "notification-channel-supported",
        stepId: step.id,
        message: `Notification channel "${step.channel}" is not supported. Supported channels: ${config.supportedNotificationChannels.join(", ")}.`,
      });
    }
  }

  // 7. Nothing is notified before the workflow has been reviewed.
  const firstReviewIndex = steps.findIndex((step) => step.type === "review");
  const firstNotifyIndex = steps.findIndex((step) => step.type === "notification");
  if (firstReviewIndex !== -1 && firstNotifyIndex !== -1 && firstNotifyIndex < firstReviewIndex) {
    violations.push({
      rule: "notification-after-review",
      stepId: steps[firstNotifyIndex]?.id,
      message: "A notification step must not run before the review step.",
    });
  }

  return violations;
}
