import type { StepType, WorkflowStep } from "../domain/schemas.js";

export type InstanceStatus =
  | "RUNNING"
  | "PAUSED"
  | "COMPLETED"
  | "REJECTED"
  | "CANCELLED";

export type StepRunStatus = "COMPLETED" | "APPROVED" | "REJECTED" | "SIMULATED" | "FAILED";

export interface WorkflowInstance {
  instanceId: string;
  templateId: string;
  templateName: string;
  templateVersion: number;
  steps: WorkflowStep[];
  status: InstanceStatus;
  /** Step the workflow is waiting on while PAUSED. */
  currentStep: string | null;
  cursorIndex: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StepRun {
  runId: string;
  instanceId: string;
  stepId: string;
  stepType: StepType;
  status: StepRunStatus;
  performedBy: string | null;
  result: Record<string, unknown>;
  startedAt: string;
  finishedAt: string;
}

export interface CreateInstanceRecord {
  templateId: string;
  templateName: string;
  templateVersion: number;
  steps: WorkflowStep[];
  status: InstanceStatus;
  currentStep: string | null;
  cursorIndex: number;
  createdBy: string | null;
}

export interface InstanceFilters {
  status?: InstanceStatus;
  templateId?: string;
}

/** Approval answer handed back to the graph when it resumes. */
export interface ApprovalDecision {
  approved: boolean;
  comments: string | null;
  by: string;
}

/** One entry per step that executed; persisted idempotently by (instance_id, step_id). */
export interface StepEvent {
  stepId: string;
  stepType: StepType;
  status: StepRunStatus;
  performedBy: string | null;
  result: Record<string, unknown>;
}

export interface ExecutionRepository {
  create(record: CreateInstanceRecord): Promise<WorkflowInstance>;
  list(filters: InstanceFilters): Promise<WorkflowInstance[]>;
  getById(id: string): Promise<WorkflowInstance | null>;
  getStepRuns(instanceId: string): Promise<StepRun[]>;
  update(
    id: string,
    patch: { status: InstanceStatus; currentStep: string | null; cursorIndex: number },
  ): Promise<boolean>;
  /** Upsert keyed on (instance_id, step_id) so a resumed node cannot duplicate rows. */
  recordStepRun(event: {
    instanceId: string;
    stepId: string;
    stepType: StepType;
    status: StepRunStatus;
    performedBy: string | null;
    result: Record<string, unknown>;
  }): Promise<void>;
  close(): Promise<void>;
}
