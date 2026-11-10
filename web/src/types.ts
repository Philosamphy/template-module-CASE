export type StepType = "review" | "validation" | "approval" | "document" | "notification";
export type Origin = "MANUAL" | "AI_DRAFTED";
export type ReviewStatus = "PENDING" | "APPROVED" | "REJECTED";

/** admin manages members; operator creates/edits/approves and runs; auditor reads. */
export type Role = "admin" | "operator" | "auditor";

export interface Member {
  id: string;
  displayName: string;
  /** Whitelisted address; also accepted as the identity when signing in. */
  email: string;
  role: Role;
  /** ISO timestamp once an admin removed access; the record itself is kept. */
  revokedAt: string | null;
}

/** GET /api/operators/me — identity plus the permissions the UI may honour. */
export interface Me {
  operator: Member;
  permissions: string[];
}

export interface WorkflowStep {
  id: string;
  name: string;
  type: StepType;
  description: string;
  assignedRole?: string;
  channel?: string;
}

export interface Review {
  reviewId: string;
  templateId: string;
  status: ReviewStatus;
  reviewedBy: string | null;
  comments: string | null;
  createdAt: string;
}

export interface Template {
  templateId: string;
  name: string;
  version: number;
  steps: WorkflowStep[];
  origin: Origin;
  isActive: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  reviewStatus: ReviewStatus;
  reviewedBy: string | null;
  reviewComments: string | null;
  reviewedAt: string | null;
  reviews?: Review[];
}

export interface StructuralIssue {
  path: string;
  message: string;
  code: string;
}

export interface BusinessRuleViolation {
  rule: string;
  message: string;
  stepId?: string;
}

/* ---------------- workflow runs (execution) ---------------- */

export type InstanceStatus = "RUNNING" | "PAUSED" | "COMPLETED" | "REJECTED" | "CANCELLED";
export type StepRunStatus = "COMPLETED" | "APPROVED" | "REJECTED" | "SIMULATED" | "FAILED";

export interface WorkflowInstance {
  instanceId: string;
  templateId: string;
  templateName: string;
  templateVersion: number;
  steps: WorkflowStep[];
  status: InstanceStatus;
  currentStep: string | null;
  cursorIndex: number;
  input: Record<string, string>;
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

/** Gate payload the server returns while a run is PAUSED at an approval step. */
export interface PendingApproval {
  kind: "approval";
  instanceId: string;
  stepNumber: number;
  totalSteps: number;
  step: WorkflowStep;
}

export interface InstanceDetail {
  instance: WorkflowInstance;
  stepRuns: StepRun[];
  pendingApproval: PendingApproval | null;
}

export interface ErrorDetails {
  structural?: StructuralIssue[];
  businessRules?: BusinessRuleViolation[];
  reviewStatus?: ReviewStatus;
  requiredPermission?: string;
  reason?: string;
}
