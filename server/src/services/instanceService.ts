import { Command, type BaseCheckpointSaver } from "@langchain/langgraph";
import type { TemplateRepository } from "../repo/types.js";
import type { WorkflowStep } from "../domain/schemas.js";
import { conflict, notFound } from "../domain/errors.js";
import { createExecutionGraph } from "../execution/graph.js";
import type { NotificationPort } from "../execution/notifier.js";
import type {
  ApprovalDecision,
  ExecutionRepository,
  InstanceStatus,
  StepEvent,
  WorkflowInstance,
} from "../execution/types.js";

export interface InstanceDetail {
  instance: WorkflowInstance;
  stepRuns: Awaited<ReturnType<ExecutionRepository["getStepRuns"]>>;
}

export interface InstanceServiceDeps {
  templates: TemplateRepository;
  instances: ExecutionRepository;
  checkpointer: BaseCheckpointSaver;
  notifier: NotificationPort;
}

const TERMINAL: InstanceStatus[] = ["COMPLETED", "REJECTED", "CANCELLED"];

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
    this.graph = createExecutionGraph(deps.notifier).compile({
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
    return { instance, stepRuns };
  }

  async list(filters: { status?: InstanceStatus; templateId?: string }): Promise<WorkflowInstance[]> {
    return this.deps.instances.list({
      status: filters.status,
      templateId: filters.templateId,
    });
  }

  /** POST /api/instances — only approved AND active templates may execute. */
  async start(templateId: string, actorId: string): Promise<InstanceDetail> {
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
      createdBy: actorId,
    });

    const result = await this.graph.invoke(
      {
        instanceId: instance.instanceId,
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
