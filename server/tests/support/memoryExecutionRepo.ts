import { randomUUID } from "node:crypto";
import type { StepType, WorkflowStep } from "../../src/domain/schemas.js";
import type {
  CreateInstanceRecord,
  ExecutionRepository,
  InstanceFilters,
  InstanceStatus,
  StepRun,
  StepRunStatus,
  WorkflowInstance,
} from "../../src/execution/types.js";

const now = (): string => new Date().toISOString();
const clone = <T>(value: T): T => structuredClone(value);

/** In-memory mirror of PostgresExecutionRepository for tests (no database). */
export class MemoryExecutionRepository implements ExecutionRepository {
  private readonly instances = new Map<string, WorkflowInstance>();
  private readonly runs = new Map<string, StepRun[]>();

  async create(record: CreateInstanceRecord): Promise<WorkflowInstance> {
    const instance: WorkflowInstance = {
      instanceId: randomUUID(),
      templateId: record.templateId,
      templateName: record.templateName,
      templateVersion: record.templateVersion,
      steps: clone(record.steps) as WorkflowStep[],
      status: record.status,
      currentStep: record.currentStep,
      cursorIndex: record.cursorIndex,
      createdBy: record.createdBy,
      createdAt: now(),
      updatedAt: now(),
    };
    this.instances.set(instance.instanceId, instance);
    this.runs.set(instance.instanceId, []);
    return clone(instance);
  }

  async list(filters: InstanceFilters): Promise<WorkflowInstance[]> {
    const all = [...this.instances.values()].filter((instance) => {
      if (filters.status && instance.status !== filters.status) return false;
      if (filters.templateId && instance.templateId !== filters.templateId) return false;
      return true;
    });
    all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return all.map(clone);
  }

  async getById(id: string): Promise<WorkflowInstance | null> {
    const instance = this.instances.get(id);
    return instance ? clone(instance) : null;
  }

  async getStepRuns(instanceId: string): Promise<StepRun[]> {
    return clone(this.runs.get(instanceId) ?? []);
  }

  async update(
    id: string,
    patch: { status: InstanceStatus; currentStep: string | null; cursorIndex: number },
  ): Promise<boolean> {
    const instance = this.instances.get(id);
    if (!instance) return false;
    instance.status = patch.status;
    instance.currentStep = patch.currentStep;
    instance.cursorIndex = patch.cursorIndex;
    instance.updatedAt = now();
    return true;
  }

  async recordStepRun(event: {
    instanceId: string;
    stepId: string;
    stepType: StepType;
    status: StepRunStatus;
    performedBy: string | null;
    result: Record<string, unknown>;
  }): Promise<void> {
    const list = this.runs.get(event.instanceId) ?? [];
    const existing = list.find((run) => run.stepId === event.stepId);
    if (existing) {
      existing.status = event.status;
      existing.performedBy = event.performedBy;
      existing.result = clone(event.result);
      existing.finishedAt = now();
      return;
    }
    list.push({
      runId: randomUUID(),
      instanceId: event.instanceId,
      stepId: event.stepId,
      stepType: event.stepType,
      status: event.status,
      performedBy: event.performedBy,
      result: clone(event.result),
      startedAt: now(),
      finishedAt: now(),
    });
    this.runs.set(event.instanceId, list);
  }

  async close(): Promise<void> {
    this.instances.clear();
    this.runs.clear();
  }
}
