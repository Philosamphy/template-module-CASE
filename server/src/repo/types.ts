import type { ReviewStatus, TemplateOrigin, WorkflowStep } from "../domain/schemas.js";

export interface Template {
  templateId: string;
  name: string;
  version: number;
  steps: WorkflowStep[];
  origin: TemplateOrigin;
  isActive: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A template joined with its most recent review row (its current status). */
export interface TemplateWithStatus extends Template {
  reviewStatus: ReviewStatus;
  reviewedBy: string | null;
  reviewComments: string | null;
  reviewedAt: string | null;
}

export interface Review {
  reviewId: string;
  templateId: string;
  status: ReviewStatus;
  reviewedBy: string | null;
  comments: string | null;
  createdAt: string;
}

export interface CreateTemplateRecord {
  name: string;
  version: number;
  steps: WorkflowStep[];
  origin: TemplateOrigin;
  isActive: boolean;
  createdBy: string | null;
}

export interface ReviewRecord {
  status: ReviewStatus;
  reviewedBy: string | null;
  comments: string | null;
}

export interface ListFilters {
  origin?: TemplateOrigin;
  status?: ReviewStatus;
  isActive?: boolean;
}

/** Handle on a template row locked inside an open transaction. */
export interface LockedTemplate {
  /** Snapshot taken at lock time; null when the id does not exist. */
  readonly current: TemplateWithStatus | null;
  update(patch: { name?: string; steps?: WorkflowStep[] }): Promise<void>;
  setActive(isActive: boolean): Promise<void>;
  insertReview(review: ReviewRecord): Promise<Review>;
}

export interface TemplateRepository {
  /**
   * Inserts the template and its initial review row atomically — a template can
   * never exist without its review record.
   */
  create(record: CreateTemplateRecord, initialReview: ReviewRecord): Promise<TemplateWithStatus>;
  list(filters: ListFilters): Promise<TemplateWithStatus[]>;
  getById(id: string): Promise<TemplateWithStatus | null>;
  getReviews(id: string): Promise<Review[]>;
  update(id: string, patch: { name?: string; steps?: WorkflowStep[] }): Promise<boolean>;
  setActive(id: string, isActive: boolean): Promise<boolean>;
  /**
   * Runs `fn` inside a database transaction with the template row locked
   * (SELECT ... FOR UPDATE). Commits on success, rolls back on any error.
   */
  withLockedTemplate<T>(id: string, fn: (locked: LockedTemplate) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
