import { randomUUID } from "node:crypto";
import type { WorkflowStep } from "../../src/domain/schemas.js";
import type {
  CreateTemplateRecord,
  ListFilters,
  LockedTemplate,
  Review,
  ReviewRecord,
  TemplateRepository,
  TemplateWithStatus,
} from "../../src/repo/types.js";

const clone = <T>(value: T): T => structuredClone(value);
const now = (): string => new Date().toISOString();

/**
 * In-memory stand-in for PostgreSQL so the lifecycle can be exercised without a
 * database. Mirrors the semantics of PostgresTemplateRepository, including
 * "template + initial review inserted atomically" and the locked-transaction
 * callback used by approve/reject/edit.
 */
export class MemoryTemplateRepository implements TemplateRepository {
  private readonly templates = new Map<string, TemplateWithStatus>();
  private readonly reviews = new Map<string, Review[]>();

  async create(record: CreateTemplateRecord, initialReview: ReviewRecord): Promise<TemplateWithStatus> {
    const templateId = randomUUID();
    const timestamp = now();
    const template: TemplateWithStatus = {
      templateId,
      name: record.name,
      version: record.version,
      steps: clone(record.steps),
      origin: record.origin,
      isActive: record.isActive,
      createdBy: record.createdBy,
      createdAt: timestamp,
      updatedAt: timestamp,
      reviewStatus: initialReview.status,
      reviewedBy: initialReview.reviewedBy,
      reviewComments: initialReview.comments,
      reviewedAt: timestamp,
    };
    this.templates.set(templateId, template);
    this.reviews.set(templateId, [
      {
        reviewId: randomUUID(),
        templateId,
        status: initialReview.status,
        reviewedBy: initialReview.reviewedBy,
        comments: initialReview.comments,
        createdAt: timestamp,
      },
    ]);
    return clone(template);
  }

  async list(filters: ListFilters): Promise<TemplateWithStatus[]> {
    const all = [...this.templates.values()].filter((template) => {
      if (filters.origin && template.origin !== filters.origin) return false;
      if (filters.status && template.reviewStatus !== filters.status) return false;
      if (filters.isActive !== undefined && template.isActive !== filters.isActive) return false;
      return true;
    });
    all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return all.map(clone);
  }

  async getById(id: string): Promise<TemplateWithStatus | null> {
    const template = this.templates.get(id);
    return template ? clone(template) : null;
  }

  async getReviews(id: string): Promise<Review[]> {
    return clone(this.reviews.get(id) ?? []);
  }

  async update(id: string, patch: { name?: string; steps?: WorkflowStep[] }): Promise<boolean> {
    const template = this.templates.get(id);
    if (!template) return false;
    if (patch.name !== undefined) template.name = patch.name;
    if (patch.steps !== undefined) template.steps = clone(patch.steps);
    template.updatedAt = now();
    return true;
  }

  async setActive(id: string, isActive: boolean): Promise<boolean> {
    const template = this.templates.get(id);
    if (!template) return false;
    template.isActive = isActive;
    template.updatedAt = now();
    return true;
  }

  async withLockedTemplate<T>(id: string, fn: (locked: LockedTemplate) => Promise<T>): Promise<T> {
    const stored = this.templates.get(id) ?? null;
    const locked: LockedTemplate = {
      current: stored ? clone(stored) : null,
      update: async (patch) => {
        if (stored) await this.update(stored.templateId, patch);
      },
      setActive: async (isActive) => {
        if (stored) await this.setActive(stored.templateId, isActive);
      },
      insertReview: async (review) => {
        const record: Review = {
          reviewId: randomUUID(),
          templateId: id,
          status: review.status,
          reviewedBy: review.reviewedBy,
          comments: review.comments,
          createdAt: now(),
        };
        this.reviews.set(id, [record, ...(this.reviews.get(id) ?? [])]);
        if (stored) {
          stored.reviewStatus = review.status;
          stored.reviewedBy = review.reviewedBy;
          stored.reviewComments = review.comments;
          stored.reviewedAt = record.createdAt;
        }
        return record;
      },
    };
    return fn(locked);
  }

  async close(): Promise<void> {
    this.templates.clear();
    this.reviews.clear();
  }
}
