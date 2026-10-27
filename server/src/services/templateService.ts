import { AiGenerationError, type TemplateGenerator } from "../ai/generator.js";
import { validateBusinessRules, type RuleConfig } from "../domain/businessRules.js";
import { conflict, notFound, unprocessable, upstream } from "../domain/errors.js";
import {
  CreateTemplateSchema,
  GeneratedTemplateSchema,
  formatIssues,
  type CreateTemplateInput,
  type ReviewStatus,
  type UpdateTemplateInput,
} from "../domain/schemas.js";
import type { Review, TemplateRepository, TemplateWithStatus } from "../repo/types.js";

const DRAFT_REVIEW_COMMENT = "Awaiting operator review.";

export interface GeneratedTemplate extends TemplateWithStatus {
  /** Full review history, returned when a single template is fetched. */
  reviews: Review[];
}

/**
 * Business logic for the template lifecycle:
 *
 *   create/generate -> PENDING + inactive -> approve -> APPROVED + active
 *                                      \----> reject -> REJECTED (inactive)
 *
 * `origin` (MANUAL | AI_DRAFTED) records how a template was made and is never
 * interchangeable with the review status, which only humans can set.
 */
export class TemplateService {
  constructor(
    private readonly repo: TemplateRepository,
    private readonly generator: TemplateGenerator,
    private readonly rules: RuleConfig,
  ) {}

  /** Structural validation (Zod) followed by business-rule validation. */
  private assertValid(template: { name: string; steps: CreateTemplateInput["steps"] }): void {
    const structural = CreateTemplateSchema.safeParse(template);
    if (!structural.success) {
      throw unprocessable("Template failed structural validation.", {
        structural: formatIssues(structural.error),
        businessRules: [],
      });
    }
    const businessRules = validateBusinessRules(structural.data, this.rules);
    if (businessRules.length > 0) {
      throw unprocessable("Template failed business-rule validation.", {
        structural: [],
        businessRules,
      });
    }
  }

  private parseBody<T>(result: { success: true; data: T } | { success: false; error: unknown }): T {
    if (result.success) return result.data;
    throw unprocessable("Request body failed validation.", {
      structural: formatIssues(result.error as never),
      businessRules: [],
    });
  }

  /** POST /api/templates */
  async createManual(input: CreateTemplateInput, actorId: string): Promise<TemplateWithStatus> {
    this.assertValid(input);
    return this.repo.create(
      {
        name: input.name,
        version: 1,
        steps: input.steps,
        origin: "MANUAL",
        isActive: false,
        createdBy: actorId,
      },
      { status: "PENDING", reviewedBy: null, comments: DRAFT_REVIEW_COMMENT },
    );
  }

  /** POST /api/templates/generate — AI drafts are saved inactive, always PENDING. */
  async generate(request: string, actorId: string): Promise<TemplateWithStatus> {
    let raw: unknown;
    try {
      raw = await this.generator.generate(request);
    } catch (error) {
      if (error instanceof AiGenerationError) {
        throw upstream("AI template generation failed.", { reason: error.message });
      }
      throw error;
    }

    // Untrusted model output: validate structure, then business rules.
    const parsed = GeneratedTemplateSchema.safeParse(raw);
    if (!parsed.success) {
      throw unprocessable("The AI response did not match the required template structure.", {
        structural: formatIssues(parsed.error),
        businessRules: [],
      });
    }
    this.assertValid(parsed.data);

    return this.repo.create(
      {
        name: parsed.data.name,
        version: 1,
        steps: parsed.data.steps,
        origin: "AI_DRAFTED",
        isActive: false,
        createdBy: actorId,
      },
      { status: "PENDING", reviewedBy: null, comments: "AI draft awaiting operator review." },
    );
  }

  /** GET /api/templates */
  async list(filters: {
    origin?: "MANUAL" | "AI_DRAFTED";
    status?: ReviewStatus;
    isActive?: boolean;
  }): Promise<TemplateWithStatus[]> {
    return this.repo.list(filters);
  }

  /** GET /api/templates/:id */
  async get(id: string): Promise<GeneratedTemplate> {
    const template = await this.repo.getById(id);
    if (!template) throw notFound(`Template ${id} not found.`);
    const reviews = await this.repo.getReviews(id);
    return { ...template, reviews };
  }

  /**
   * PUT /api/templates/:id
   * Editable only while PENDING or REJECTED; approved templates must go
   * through a new version instead. Editing a REJECTED template re-submits it
   * as PENDING. Protected fields cannot be sent at all (strict schema).
   */
  async update(id: string, patch: UpdateTemplateInput): Promise<TemplateWithStatus> {
    await this.repo.withLockedTemplate(id, async (locked) => {
      const existing = locked.current;
      if (!existing) throw notFound(`Template ${id} not found.`);

      if (existing.reviewStatus === "APPROVED") {
        throw conflict(
          "Approved templates cannot be edited directly. Create a new version instead.",
          { reviewStatus: existing.reviewStatus, templateId: id },
        );
      }

      const merged = {
        name: patch.name ?? existing.name,
        steps: patch.steps ?? existing.steps,
      };
      this.assertValid(merged);

      await locked.update({ name: merged.name, steps: merged.steps });

      // Editing a rejected template re-submits it for review.
      if (existing.reviewStatus === "REJECTED") {
        await locked.insertReview({
          status: "PENDING",
          reviewedBy: null,
          comments: "Re-submitted for review after edits.",
        });
      }
    });

    const updated = await this.repo.getById(id);
    if (!updated) throw notFound(`Template ${id} not found.`);
    return updated;
  }

  /** DELETE /api/templates/:id — soft deactivation, never a physical delete. */
  async deactivate(id: string): Promise<TemplateWithStatus> {
    const updated = await this.repo.setActive(id, false);
    if (!updated) throw notFound(`Template ${id} not found.`);
    const template = await this.repo.getById(id);
    if (!template) throw notFound(`Template ${id} not found.`);
    return template;
  }

  /** POST /api/templates/:id/approve — status check, re-validation, decision, activation in one transaction. */
  async approve(id: string, actorId: string, comments?: string): Promise<GeneratedTemplate> {
    await this.repo.withLockedTemplate(id, async (locked) => {
      const template = locked.current;
      if (!template) throw notFound(`Template ${id} not found.`);
      this.assertPending(template.reviewStatus, "approve");
      // Re-validate the stored template: validity is a precondition of approval.
      this.assertValid({ name: template.name, steps: template.steps });
      await locked.insertReview({
        status: "APPROVED",
        reviewedBy: actorId,
        comments: comments ?? null,
      });
      await locked.setActive(true);
    });
    return this.get(id);
  }

  /** POST /api/templates/:id/reject — requires a reason; template stays inactive. */
  async reject(id: string, actorId: string, comments: string): Promise<GeneratedTemplate> {
    await this.repo.withLockedTemplate(id, async (locked) => {
      const template = locked.current;
      if (!template) throw notFound(`Template ${id} not found.`);
      this.assertPending(template.reviewStatus, "reject");
      this.assertValid({ name: template.name, steps: template.steps });
      await locked.insertReview({ status: "REJECTED", reviewedBy: actorId, comments });
      await locked.setActive(false);
    });
    return this.get(id);
  }

  private assertPending(status: ReviewStatus, action: string): void {
    if (status !== "PENDING") {
      throw conflict(
        `Only PENDING templates can be ${action === "approve" ? "approved" : "rejected"}; this template is ${status}.`,
        { reviewStatus: status },
      );
    }
  }
}
