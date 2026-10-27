import type { Pool, PoolClient } from "pg";
import type { WorkflowStep } from "../domain/schemas.js";
import type {
  CreateTemplateRecord,
  ListFilters,
  LockedTemplate,
  Review,
  ReviewRecord,
  TemplateRepository,
  TemplateWithStatus,
} from "./types.js";

interface TemplateRow {
  template_id: string;
  name: string;
  version: number;
  steps: WorkflowStep[];
  origin: "MANUAL" | "AI_DRAFTED";
  is_active: boolean;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  review_id: string | null;
  review_status: "PENDING" | "APPROVED" | "REJECTED" | null;
  reviewed_by: string | null;
  review_comments: string | null;
  reviewed_at: Date | null;
}

interface ReviewRow {
  review_id: string;
  template_id: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  reviewed_by: string | null;
  comments: string | null;
  created_at: Date;
}

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

function toTemplate(row: TemplateRow): TemplateWithStatus {
  return {
    templateId: row.template_id,
    name: row.name,
    version: row.version,
    steps: row.steps,
    origin: row.origin,
    isActive: row.is_active,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    reviewStatus: row.review_status ?? "PENDING",
    reviewedBy: row.reviewed_by,
    reviewComments: row.review_comments,
    reviewedAt: iso(row.reviewed_at),
  };
}

function toReview(row: ReviewRow): Review {
  return {
    reviewId: row.review_id,
    templateId: row.template_id,
    status: row.status,
    reviewedBy: row.reviewed_by,
    comments: row.comments,
    createdAt: row.created_at.toISOString(),
  };
}

/** Template plus its latest review row (status, reviewer, comments, timestamp). */
const SELECT_TEMPLATE = `
  SELECT t.template_id, t.name, t.version, t.steps, t.origin, t.is_active,
         t.created_by, t.created_at, t.updated_at,
         r.review_id, r.review_status, r.reviewed_by,
         r.review_comments, r.reviewed_at
  FROM workflow_templates t
  LEFT JOIN LATERAL (
    SELECT tr.review_id, tr.status AS review_status, tr.reviewed_by,
           tr.comments AS review_comments, tr.created_at AS reviewed_at
    FROM template_reviews tr
    WHERE tr.template_id = t.template_id
    ORDER BY tr.created_at DESC, tr.review_id DESC
    LIMIT 1
  ) r ON true
`;

/**
 * PostgreSQL implementation. Every value flows through parameterised queries
 * ($1, $2, ...); no string interpolation of user data anywhere.
 */
export class PostgresTemplateRepository implements TemplateRepository {
  constructor(private readonly pool: Pool) {}

  async create(record: CreateTemplateRecord, initialReview: ReviewRecord): Promise<TemplateWithStatus> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<TemplateRow>(
        `INSERT INTO workflow_templates (name, version, steps, origin, is_active, created_by)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6)
         RETURNING template_id, name, version, steps, origin, is_active,
                   created_by, created_at, updated_at`,
        [
          record.name,
          record.version,
          JSON.stringify(record.steps),
          record.origin,
          record.isActive,
          record.createdBy,
        ],
      );
      const templateId = inserted.rows[0]!.template_id;
      await client.query(
        `INSERT INTO template_reviews (template_id, status, reviewed_by, comments)
         VALUES ($1, $2, $3, $4)`,
        [templateId, initialReview.status, initialReview.reviewedBy, initialReview.comments],
      );
      const final = await client.query<TemplateRow>(`${SELECT_TEMPLATE} WHERE t.template_id = $1`, [
        templateId,
      ]);
      await client.query("COMMIT");
      return toTemplate(final.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async list(filters: ListFilters): Promise<TemplateWithStatus[]> {
    const result = await this.pool.query<TemplateRow>(
      `${SELECT_TEMPLATE}
       WHERE ($1::text IS NULL OR t.origin = $1)
         AND ($2::text IS NULL OR r.review_status = $2)
         AND ($3::boolean IS NULL OR t.is_active = $3)
       ORDER BY t.created_at DESC`,
      [filters.origin ?? null, filters.status ?? null, filters.isActive ?? null],
    );
    return result.rows.map(toTemplate);
  }

  async getById(id: string): Promise<TemplateWithStatus | null> {
    const result = await this.pool.query<TemplateRow>(`${SELECT_TEMPLATE} WHERE t.template_id = $1`, [
      id,
    ]);
    return result.rows[0] ? toTemplate(result.rows[0]) : null;
  }

  async getReviews(id: string): Promise<Review[]> {
    const result = await this.pool.query<ReviewRow>(
      `SELECT review_id, template_id, status, reviewed_by, comments, created_at
       FROM template_reviews
       WHERE template_id = $1
       ORDER BY created_at DESC, review_id DESC`,
      [id],
    );
    return result.rows.map(toReview);
  }

  async update(id: string, patch: { name?: string; steps?: WorkflowStep[] }): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE workflow_templates
       SET name = COALESCE($1, name),
           steps = COALESCE($2::jsonb, steps),
           updated_at = now()
       WHERE template_id = $3`,
      [patch.name ?? null, patch.steps ? JSON.stringify(patch.steps) : null, id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async setActive(id: string, isActive: boolean): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE workflow_templates
       SET is_active = $1, updated_at = now()
       WHERE template_id = $2`,
      [isActive, id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async withLockedTemplate<T>(id: string, fn: (locked: LockedTemplate) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<TemplateRow>(
        `${SELECT_TEMPLATE} WHERE t.template_id = $1 FOR UPDATE OF t`,
        [id],
      );
      const current = result.rows[0] ? toTemplate(result.rows[0]) : null;

      const locked: LockedTemplate = {
        current,
        update: async (patch) => {
          await runLockedUpdate(client, id, patch);
        },
        setActive: async (isActive) => {
          await client.query(
            `UPDATE workflow_templates SET is_active = $1, updated_at = now() WHERE template_id = $2`,
            [isActive, id],
          );
        },
        insertReview: async (review) => {
          const inserted = await client.query<ReviewRow>(
            `INSERT INTO template_reviews (template_id, status, reviewed_by, comments)
             VALUES ($1, $2, $3, $4)
             RETURNING review_id, template_id, status, reviewed_by, comments, created_at`,
            [id, review.status, review.reviewedBy, review.comments],
          );
          return toReview(inserted.rows[0]!);
        },
      };

      const value = await fn(locked);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

async function runLockedUpdate(
  client: PoolClient,
  id: string,
  patch: { name?: string; steps?: WorkflowStep[] },
): Promise<void> {
  await client.query(
    `UPDATE workflow_templates
     SET name = COALESCE($1, name),
         steps = COALESCE($2::jsonb, steps),
         updated_at = now()
     WHERE template_id = $3`,
    [patch.name ?? null, patch.steps ? JSON.stringify(patch.steps) : null, id],
  );
}
