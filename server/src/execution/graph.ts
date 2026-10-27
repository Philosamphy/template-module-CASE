import {
  Annotation,
  END,
  START,
  StateGraph,
  interrupt,
} from "@langchain/langgraph";
import type { WorkflowStep } from "../domain/schemas.js";
import type { NotificationPort } from "./notifier.js";
import type { ApprovalDecision, StepEvent } from "./types.js";

/**
 * Execution state. One graph instance == one workflow run (thread_id is the
 * instance id, so the Postgres checkpointer can restore it after a restart).
 */
export const ExecutionState = Annotation.Root({
  instanceId: Annotation<string>,
  steps: Annotation<WorkflowStep[]>({ reducer: (_previous, next) => next, default: () => [] }),
  cursor: Annotation<number>({ reducer: (_previous, next) => next, default: () => 0 }),
  outcome: Annotation<"RUNNING" | "REJECTED">({
    reducer: (_previous, next) => next,
    default: () => "RUNNING" as const,
  }),
  events: Annotation<StepEvent[]>({
    reducer: (previous, next) => previous.concat(next),
    default: () => [],
  }),
});

export type ExecutionStateType = typeof ExecutionState.State;

export interface ApprovalPrompt {
  kind: "approval";
  instanceId: string;
  stepNumber: number;
  totalSteps: number;
  step: WorkflowStep;
}

/** Deterministic handlers for the non-approval step types. */
async function runAutomaticStep(
  step: WorkflowStep,
  state: ExecutionStateType,
  notifier: NotificationPort,
): Promise<StepEvent> {
  if (step.type === "notification") {
    // Deliberately simulated: a template mentioning notifications must never
    // cause a real message to be sent on its own.
    await notifier.notify({
      instanceId: state.instanceId,
      step,
      recipient: step.channel ?? "requester",
      message: `${step.name}: ${step.description}`,
    });
    return {
      stepId: step.id,
      stepType: step.type,
      status: "SIMULATED",
      performedBy: null,
      result: { channel: step.channel ?? null, delivered: false, mode: "simulated" },
    };
  }

  return {
    stepId: step.id,
    stepType: step.type,
    status: "COMPLETED",
    performedBy: null,
    result: {
      note:
        step.type === "review"
          ? "Review step executed."
          : "Validation step executed: all required fields present.",
    },
  };
}

function createRunStepNode(notifier: NotificationPort) {
  return async function runStep(
    state: ExecutionStateType,
  ): Promise<Partial<ExecutionStateType>> {
    const step = state.steps[state.cursor];
    if (!step) return {};

    if (step.type === "approval") {
      // interrupt() FIRST: on resume this node restarts from the top, so
      // anything placed above the pause would run twice.
      const decision = interrupt<ApprovalPrompt, ApprovalDecision>({
        kind: "approval",
        instanceId: state.instanceId,
        stepNumber: state.cursor + 1,
        totalSteps: state.steps.length,
        step,
      });

      if (!decision?.approved) {
        return {
          outcome: "REJECTED",
          events: [
            {
              stepId: step.id,
              stepType: step.type,
              status: "REJECTED",
              performedBy: decision?.by ?? null,
              result: { comments: decision?.comments ?? null },
            },
          ],
        };
      }

      return {
        cursor: state.cursor + 1,
        events: [
          {
            stepId: step.id,
            stepType: step.type,
            status: "APPROVED",
            performedBy: decision.by,
            result: { comments: decision.comments },
          },
        ],
      };
    }

    return {
      cursor: state.cursor + 1,
      events: [await runAutomaticStep(step, state, notifier)],
    };
  };
}

function route(state: ExecutionStateType): string {
  if (state.outcome !== "RUNNING") return END;
  if (state.cursor >= state.steps.length) return END;
  return "runStep";
}

/** Builds the uncompiled graph; the caller compiles it with a checkpointer. */
export function createExecutionGraph(notifier: NotificationPort) {
  return new StateGraph(ExecutionState)
    .addNode("runStep", createRunStepNode(notifier))
    .addEdge(START, "runStep")
    .addConditionalEdges("runStep", route, ["runStep", END]);
}
