import { promises as fs } from "node:fs";
import path from "node:path";
import { Command, type BaseCheckpointSaver } from "@langchain/langgraph";
import type { TemplateRepository } from "../repo/types.js";
import type { WorkflowStep } from "../domain/schemas.js";
import { conflict, notFound } from "../domain/errors.js";
import { createExecutionGraph } from "../execution/graph.js";
import type { DocumentPort } from "../execution/documents.js";
import type { NotificationPort } from "../execution/notifier.js";
import type {
  ApprovalDecision,
  ExecutionRepository,
  InstanceStatus,
  IntakeSubmission,
  PendingGate,
  StepEvent,
  WorkflowInstance,
} from "../execution/types.js";

export interface InstanceDetail {
  instance: WorkflowInstance;
  stepRuns: Awaited<ReturnType<ExecutionRepository["getStepRuns"]>>;
  /**
   * Gate payload while PAUSED, otherwise null. An `approval` gate needs a
   * decision; an `intake` gate needs a readable PDF/JPG upload.
   */
  pendingApproval: PendingGate | null;
}

/** A generated file resolved on disk and ready to stream to the client. */
export interface InstanceDocument {
  absolutePath: string;
  filename: string;
}

export interface InstanceServiceDeps {
  templates: TemplateRepository;
  instances: ExecutionRepository;
  checkpointer: BaseCheckpointSaver;
  notifier: NotificationPort;
  documents: DocumentPort;
  /**
   * Containment root for serving generated files. When set, a file recorded
   * outside this directory is refused rather than streamed.
   */
  documentOutputDir?: string;
}

const TERMINAL: InstanceStatus[] = ["COMPLETED", "REJECTED", "CANCELLED"];

/** Rebuilds the gate payload a paused run is waiting on, from the instance row. */
function buildPendingGate(instance: WorkflowInstance): PendingGate | null {
  if (instance.status !== "PAUSED" || !instance.currentStep) return null;
  const step = instance.steps.find((entry) => entry.id === instance.currentStep);
  if (!step) return null;

  if (step.type === "intake") {
    return {
      kind: "intake",
      instanceId: instance.instanceId,
      stepNumber: instance.cursorIndex + 1,
      totalSteps: instance.steps.length,
      step,
      acceptedFileTypes: step.acceptedFileTypes ?? ["pdf", "jpg", "jpeg", "png"],
      instruction: step.instruction ?? null,
    };
  }

  if (step.type !== "approval") return null;

  return {
    kind: "approval",
    instanceId: instance.instanceId,
    stepNumber: instance.cursorIndex + 1,
    totalSteps: instance.steps.length,
    step,
  };
}

/**
 * Runs approved templates.
 *
 * The LangGraph checkpointer owns *where execution is paused* (thread_id =
 * instance id, so a restart loses nothing); our tables own what is queryable:
 * instance status, the step snapshot and one row per step that ran.
 *
 * The AI model is not involved here at all — execution is a deterministic walk
 * over the approved steps.
 */
export class InstanceService {
  private readonly graph: ReturnType<ReturnType<typeof createExecutionGraph>["compile"]>;

  constructor(private readonly deps: InstanceServiceDeps) {
    this.graph = createExecutionGraph(deps.notifier, deps.documents).compile({
      checkpointer: deps.checkpointer,
    });
  }

  private config(instanceId: string) {
    return {
      configurable: { thread_id: instanceId },
      // One loop iteration per step, with headroom for retries.
      recursionLimit: 500,
    };
  }

  /** Reads the graph result defensively — LangGraph returns a plain state object. */
  private read(result: unknown): {
    cursor: number;
    outcome: string;
    steps: WorkflowStep[];
    events: StepEvent[];
    paused: boolean;
  } {
    const value = (result ?? {}) as Record<string, unknown>;
    const interruptPayload = value.__interrupt__;
    return {
      cursor: typeof value.cursor === "number" ? value.cursor : 0,
      outcome: typeof value.outcome === "string" ? value.outcome : "RUNNING",
      steps: Array.isArray(value.steps) ? (value.steps as WorkflowStep[]) : [],
      events: Array.isArray(value.events) ? (value.events as StepEvent[]) : [],
      paused: Array.isArray(interruptPayload) && interruptPayload.length > 0,
    };
  }

  /** Persists what the graph just did: step runs first, then the instance row. */
  private async sync(instanceId: string, result: unknown): Promise<void> {
    const state = this.read(result);

    for (const event of state.events) {
      await this.deps.instances.recordStepRun({ instanceId, ...event });
    }

    const status: InstanceStatus = state.paused
      ? "PAUSED"
      : state.outcome === "REJECTED"
        ? "REJECTED"
        : state.cursor >= state.steps.length
          ? "COMPLETED"
          : "RUNNING";

    const currentStep = state.paused ? (state.steps[state.cursor]?.id ?? null) : null;

    await this.deps.instances.update(instanceId, {
      status,
      currentStep,
      cursorIndex: state.cursor,
    });
  }

  async detail(instanceId: string): Promise<InstanceDetail> {
    const instance = await this.deps.instances.getById(instanceId);
    if (!instance) throw notFound(`Workflow instance ${instanceId} not found.`);
    const stepRuns = await this.deps.instances.getStepRuns(instanceId);
    return { instance, stepRuns, pendingApproval: buildPendingGate(instance) };
  }

  /**
   * GET /api/instances/:id/documents/:stepId — serves the file a `document`
   * step produced. The path comes from our own step_runs row (never from the
   * client), and is re-checked against the output directory before streaming.
   */
  async document(instanceId: string, stepId: string): Promise<InstanceDocument> {
    const instance = await this.deps.instances.getById(instanceId);
    if (!instance) throw notFound(`Workflow instance ${instanceId} not found.`);

    const step = instance.steps.find((entry) => entry.id === stepId);
    if (!step || step.type !== "document") {
      throw notFound(`This instance has no document step '${stepId}'.`);
    }

    const runs = await this.deps.instances.getStepRuns(instanceId);
    const file = runs.find((run) => run.stepId === stepId)?.result.file;
    if (typeof file !== "string" || file.length === 0) {
      throw notFound("No document has been generated for this step yet.");
    }

    const absolutePath = path.resolve(file);
    const root = this.deps.documentOutputDir;
    if (root) {
      const resolvedRoot = path.resolve(root);
      if (!absolutePath.startsWith(resolvedRoot + path.sep)) {
        throw notFound("No document has been generated for this step yet.");
      }
    }

    try {
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile()) throw new Error("not a file");
    } catch {
      throw notFound("The generated document file no longer exists on disk.");
    }

    return { absolutePath, filename: path.basename(absolutePath) };
  }

  async list(filters: { status?: InstanceStatus; templateId?: string }): Promise<WorkflowInstance[]> {
    return this.deps.instances.list({
      status: filters.status,
      templateId: filters.templateId,
    });
  }

  /** POST /api/instances — only approved AND active templates may execute. */
  async start(
    templateId: string,
    actorId: string,
    input: Record<string, string> = {},
  ): Promise<InstanceDetail> {
    const template = await this.deps.templates.getById(templateId);
    if (!template) throw notFound(`Template ${templateId} not found.`);

    if (template.reviewStatus !== "APPROVED" || !template.isActive) {
      throw conflict(
        "Only templates that are APPROVED and active can be executed.",
        { reviewStatus: template.reviewStatus, isActive: template.isActive },
      );
    }

    const instance = await this.deps.instances.create({
      templateId: template.templateId,
      templateName: template.name,
      templateVersion: template.version,
      steps: template.steps,
      status: "RUNNING",
      currentStep: null,
      cursorIndex: 0,
      input,
      createdBy: actorId,
    });

    const result = await this.graph.invoke(
      {
        instanceId: instance.instanceId,
        templateName: template.name,
        input,
        steps: template.steps,
        cursor: 0,
        outcome: "RUNNING" as const,
        events: [],
      },
      this.config(instance.instanceId),
    );

    await this.sync(instance.instanceId, result);
    return this.detail(instance.instanceId);
  }

  /** POST /api/instances/:id/respond — resumes the paused graph. */
  async respond(
    instanceId: string,
    decision: ApprovalDecision,
  ): Promise<InstanceDetail> {
    const instance = await this.deps.instances.getById(instanceId);
    if (!instance) throw notFound(`Workflow instance ${instanceId} not found.`);

    if (instance.status !== "PAUSED") {
      throw conflict(
        `This workflow is ${instance.status}; only a PAUSED workflow is waiting for a decision.`,
        { instanceStatus: instance.status },
      );
    }

    const result = await this.graph.invoke(
      new Command({ resume: decision }),
      this.config(instanceId),
    );

    await this.sync(instanceId, result);
    return this.detail(instanceId);
  }

  /**
   * POST /api/instances/:id/intake — resumes a run paused at an `intake` step
   * with the file the server has just read.
   */
  async submitIntake(
    instanceId: string,
    submission: IntakeSubmission,
  ): Promise<InstanceDetail> {
    const instance = await this.deps.instances.getById(instanceId);
    if (!instance) throw notFound(`Workflow instance ${instanceId} not found.`);

    if (instance.status !== "PAUSED") {
      throw conflict(
        `This workflow is ${instance.status}; only a PAUSED workflow is waiting for a file.`,
        { instanceStatus: instance.status },
      );
    }

    const step = instance.steps.find((entry) => entry.id === instance.currentStep);
    if (!step || step.type !== "intake") {
      throw conflict("This workflow is not waiting for a file at this step.", {
        instanceStatus: instance.status,
      });
    }

    const result = await this.graph.invoke(
      new Command({ resume: submission }),
      this.config(instanceId),
    );

    await this.sync(instanceId, result);
    return this.detail(instanceId);
  }

  /** POST /api/instances/:id/cancel — stops the run without deleting history. */
  async cancel(instanceId: string): Promise<InstanceDetail> {
    const instance = await this.deps.instances.getById(instanceId);
    if (!instance) throw notFound(`Workflow instance ${instanceId} not found.`);

    if (TERMINAL.includes(instance.status)) {
      throw conflict(`This workflow already finished (${instance.status}).`, {
        instanceStatus: instance.status,
      });
    }

    await this.deps.instances.update(instanceId, {
      status: "CANCELLED",
      currentStep: null,
      cursorIndex: instance.cursorIndex,
    });
    return this.detail(instanceId);
  }
}
