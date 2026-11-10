import { z } from "zod";

/** Vocabulary shared by the API, the database CHECK constraints and the AI prompt. */
export const STEP_TYPES = [
  "review",
  "validation",
  "approval",
  "intake",
  "notification",
  "document",
] as const;

/** File kinds an `intake` step may accept. */
export const FILE_TYPES = ["pdf", "jpg", "jpeg", "png"] as const;
export const ORIGINS = ["MANUAL", "AI_DRAFTED"] as const;
export const REVIEW_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;

export type StepType = (typeof STEP_TYPES)[number];
export type TemplateOrigin = (typeof ORIGINS)[number];
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/**
 * Structural validation (Zod layer A). This proves the payload has the right
 * shape — it says nothing about whether the workflow makes business sense.
 * Business-rule validation lives in businessRules.ts.
 */
export const WorkflowStepSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(120),
    type: z.enum(STEP_TYPES),
    description: z.string().trim().min(1).max(1000),
    /** Optional: which role executes the step. Checked against SUPPORTED_ROLES. */
    assignedRole: z.string().trim().min(1).max(64).optional(),
    /** Optional: notification channel. Checked against SUPPORTED_NOTIFICATION_CHANNELS. */
    channel: z.string().trim().min(1).max(64).optional(),
    /** Optional: intake only — which file kinds the operator may upload. */
    acceptedFileTypes: z.array(z.enum(FILE_TYPES)).min(1).max(FILE_TYPES.length).optional(),
    /** Optional: intake only — what the AI should read from the upload. */
    instruction: z.string().trim().min(1).max(500).optional(),
    /**
     * Optional: where the editor canvas lays this step out. Presentation only —
     * execution order is the array order. Stored with the template so a dragged
     * arrangement survives reloads and is shared by everyone who opens it.
     */
    position: z
      .object({ x: z.number().finite(), y: z.number().finite() })
      .strict()
      .optional(),
  })
  .strict();

export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

export const TemplateNameSchema = z.string().trim().min(1).max(200);

/** POST /api/templates — manual creation. */
export const CreateTemplateSchema = z
  .object({
    name: TemplateNameSchema,
    steps: z.array(WorkflowStepSchema).min(1),
  })
  .strict();

export type CreateTemplateInput = z.infer<typeof CreateTemplateSchema>;

/**
 * PUT /api/templates/:id — deliberately accepts only `name` and `steps`.
 * Protected fields (template_id, origin, version, is_active, review status)
 * are rejected with 422 because the schema is strict.
 */
export const UpdateTemplateSchema = z
  .object({
    name: TemplateNameSchema.optional(),
    steps: z.array(WorkflowStepSchema).min(1).optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.steps !== undefined, {
    message: "Provide at least one of 'name' or 'steps'.",
  });

export type UpdateTemplateInput = z.infer<typeof UpdateTemplateSchema>;

/**
 * POST /api/templates/generate — the operator's natural-language request.
 * A very short request is accepted but answered with a clarification question,
 * not a template.
 */
export const GenerateTemplateSchema = z
  .object({
    prompt: z.string().trim().min(1).max(4000),
  })
  .strict();

/**
 * The shape the language model is instructed to return. It is still treated as
 * untrusted input: every generated payload is re-validated with this schema and
 * with the business rules before anything touches the database.
 *
 * Note what is NOT here: origin, is_active, status, version, template_id.
 * The AI cannot express — let alone set — those fields.
 */
export const GeneratedTemplateSchema = z
  .object({
    name: TemplateNameSchema,
    steps: z.array(WorkflowStepSchema).min(1),
  })
  .strict();

export type GeneratedTemplate = z.infer<typeof GeneratedTemplateSchema>;

/**
 * Generation is a conversation, not a one-shot command: when the request is
 * too vague to design from, the model asks a focused question instead of
 * inventing requirements.
 */
export const ClarificationSchema = z
  .object({
    needsClarification: z.literal(true),
    question: z.string().trim().min(1).max(600),
  })
  .strict();

export type Clarification = z.infer<typeof ClarificationSchema>;

/** POST /api/templates/:id/approve */
export const ApproveSchema = z
  .object({
    comments: z.string().trim().max(1000).optional(),
  })
  .strict();

/** POST /api/templates/:id/reject — a rejection must carry a reason. */
export const RejectSchema = z
  .object({
    comments: z.string().trim().min(1).max(1000),
  })
  .strict();

/** GET /api/templates — filtering is supported, unknown params are dropped. */
export const ListQuerySchema = z.object({
  origin: z.enum(ORIGINS).optional(),
  status: z.enum(REVIEW_STATUSES).optional(),
  is_active: z.enum(["true", "false"]).optional(),
});

export type ListQuery = z.infer<typeof ListQuerySchema>;

/* ---------------- workflow execution ---------------- */

export const INSTANCE_STATUSES = [
  "RUNNING",
  "PAUSED",
  "COMPLETED",
  "REJECTED",
  "CANCELLED",
] as const;

export type InstanceStatus = (typeof INSTANCE_STATUSES)[number];

/**
 * POST /api/instances — start one run of an approved, active template.
 *
 * `input` is the case data the run operates on: document steps render their
 * output from it. Bounded so an instance cannot become a payload dump.
 */
export const StartInstanceSchema = z
  .object({
    templateId: z.string().uuid(),
    input: z
      .record(
        z.string().trim().min(1).max(100),
        z.string().trim().max(4000),
      )
      .refine((value) => Object.keys(value).length <= 50, {
        message: "At most 50 input fields are allowed.",
      })
      .optional(),
  })
  .strict();

/** POST /api/instances/:id/respond — answer the paused approval gate. */
export const RespondInstanceSchema = z
  .object({
    approved: z.boolean(),
    comments: z.string().trim().max(1000).optional(),
  })
  .strict();

/** GET /api/instances */
export const ListInstancesQuerySchema = z.object({
  status: z.enum(INSTANCE_STATUSES).optional(),
  template_id: z.string().uuid().optional(),
});

export type ListInstancesQuery = z.infer<typeof ListInstancesQuerySchema>;

export interface Issue {
  path: string;
  message: string;
  code: string;
}

export function formatIssues(error: z.ZodError): Issue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    message: issue.message,
    code: issue.code,
  }));
}
