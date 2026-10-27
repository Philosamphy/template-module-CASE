export type StepType = "review" | "validation" | "approval" | "notification";
export type Origin = "MANUAL" | "AI_DRAFTED";
export type ReviewStatus = "PENDING" | "APPROVED" | "REJECTED";

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

export interface ErrorDetails {
  structural?: StructuralIssue[];
  businessRules?: BusinessRuleViolation[];
  reviewStatus?: ReviewStatus;
  requiredPermission?: string;
  reason?: string;
}
