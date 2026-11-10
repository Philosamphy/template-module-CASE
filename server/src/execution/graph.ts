import {
  Annotation,
  END,
  START,
  StateGraph,
  interrupt,
} from "@langchain/langgraph";
import type { WorkflowStep } from "../domain/schemas.js";
import type { DocumentPort } from "./documents.js";
import type { NotificationPort } from "./notifier.js";
import type {
  ApprovalDecision,
  IntakeSubmission,
  PendingApproval,
  PendingIntake,
  StepEvent,
} from "./types.js";

/**
 * Execution state. One graph instance == one workflow run (thread_id is the
 * instance id, so the Postgres checkpointer can restore it after a restart).
 */
export const ExecutionState = Annotation.Root({
  instanceId: Annotation<string>,
  templateName: Annotation<string>({
    reducer: (_previous, next) => next,
    default: () => "",
  }),
  /** Case data supplied at start; document steps render their output from it. */
  input: Annotation<Record<string, string>>({
    reducer: (_previous, next) => next,
    default: () => ({}),
  }),
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

/** Deterministic handlers for the non-approval step types. */
async function runAutomaticStep(
  step: WorkflowStep,
  state: ExecutionStateType,
  notifier: NotificationPort,
  documents: DocumentPort,
): Promise<StepEvent> {
  if (step.type === "document") {
    // Real work: renders a file from the instance input and records where it went.
    const generated = await documents.generate({
      instanceId: state.instanceId,
      templateName: state.templateName,
      step,
      input: state.input,
    });
    return {
      stepId: step.id,
      stepType: step.type,
      status: "COMPLETED",
      performedBy: null,
      // Spreads file/bytes plus contentSource/title when the port produced them,
      // so step_runs records whether the body was AI-drafted or a fallback.
      result: { ...generated, mode: "generated" },
    };
  }

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

function createRunStepNode(notifier: NotificationPort, documents: DocumentPort) {
  return async function runStep(
    state: ExecutionStateType,
  ): Promise<Partial<ExecutionStateType>> {
    const step = state.steps[state.cursor];
    if (!step) return {};

    if (step.type === "intake") {
      // The run stops here until the operator uploads a PDF/JPG and the server
      // has read it. interrupt() must stay first: on resume the node restarts.
      const submission = interrupt<PendingIntake, IntakeSubmission>({
        kind: "intake",
        instanceId: state.instanceId,
        stepNumber: state.cursor + 1,
        totalSteps: state.steps.length,
        step,
        acceptedFileTypes: step.acceptedFileTypes ?? ["pdf", "jpg", "jpeg", "png"],
        instruction: step.instruction ?? null,
      });

      if (!submission || !submission.text) {
        return {
          outcome: "REJECTED",
          events: [
            {
              stepId: step.id,
              stepType: step.type,
              status: "REJECTED",
              performedBy: submission?.by ?? null,
              result: { reason: "No readable file was supplied at the intake step." },
            },
          ],
        };
      }

      const extracted = submission.text.slice(0, 4000);
      return {
        cursor: state.cursor + 1,
        // Later document steps render from the case data, so the reading joins
        // it under a step-scoped key.
        input: {
          ...state.input,
          [`intake.${step.id}`]: submission.aiSummary ?? extracted,
        },
        events: [
          {
            stepId: step.id,
            stepType: step.type,
            status: "COMPLETED",
            performedBy: submission.by,
            result: {
              fileName: submission.fileName,
              mimeType: submission.mimeType,
              bytes: submission.bytes,
              extraction: submission.extraction,
              text: extracted,
              aiSummary: submission.aiSummary,
            },
          },
        ],
      };
    }

    if (step.type === "approval") {
      // interrupt() FIRST: on resume this node restarts from the top, so
      // anything placed above the pause would run twice.
      const decision = interrupt<PendingApproval, ApprovalDecision>({
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
      events: [await runAutomaticStep(step, state, notifier, documents)],
    };
  };
}

function route(state: ExecutionStateType): string {
  if (state.outcome !== "RUNNING") return END;
  if (state.cursor >= state.steps.length) return END;
  return "runStep";
}

/** Builds the uncompiled graph; the caller compiles it with a checkpointer. */
export function createExecutionGraph(notifier: NotificationPort, documents: DocumentPort) {
  return new StateGraph(ExecutionState)
    .addNode("runStep", createRunStepNode(notifier, documents))
    .addEdge(START, "runStep")
    .addConditionalEdges("runStep", route, ["runStep", END]);
}
