import { createHash } from "node:crypto";
import type { Pool } from "pg";

/**
 * Append-only audit trail with a SHA-256 hash chain.
 *
 * Each event's hash covers its own canonical payload *and* the previous
 * event's hash, so changing or deleting a row breaks verification from that
 * point on. Writers serialise on a Postgres advisory lock to guarantee a
 * single, unbroken chain even with concurrent requests.
 *
 * Audit writes must never fail the action they describe (the action has
 * already happened), so callers log recording errors and move on.
 */

export type AuditOutcome = "SUCCESS" | "FAILURE" | "PENDING";

export const AUDIT_ROLES = ["admin", "operator", "auditor", "system"] as const;
export type AuditRole = (typeof AUDIT_ROLES)[number];

export interface AuditEventInput {
  actorId: string;
  actorRole: AuditRole;
  /** Stable SCREAMING_SNAKE action, e.g. TEMPLATE_APPROVED. */
  action: string;
  targetType?: string;
  targetId?: string;
  outcome?: AuditOutcome;
  details?: Record<string, unknown>;
}

export interface AuditEvent {
  id: string;
  sequence: number;
  recordedAt: string;
  actorId: string;
  actorRole: AuditRole;
  action: string;
  targetType: string;
  targetId: string;
  outcome: AuditOutcome;
  details: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface AuditListOptions {
  limit?: number;
  offset?: number;
  action?: string;
  outcome?: AuditOutcome;
  actorId?: string;
}

export interface AuditVerification {
  verified: boolean;
  checked: number;
  /** Sequence of the first event that failed verification, or null. */
  brokenAt: number | null;
  checkedAt: string;
  headHash: string;
}

/** Records one event. Kept separate so routes can treat auditing as a port. */
export interface AuditRecorder {
  record(input: AuditEventInput): Promise<AuditEvent>;
}

export interface AuditStore extends AuditRecorder {
  list(options?: AuditListOptions): Promise<{ events: AuditEvent[]; total: number }>;
  get(id: string): Promise<AuditEvent | null>;
  verify(): Promise<AuditVerification>;
}

export const GENESIS_HASH = "0".repeat(64);

/** Deterministic JSON: object keys sorted at every level, arrays in order. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((sorted, key) => {
        sorted[key] = canonicalize(record[key]);
        return sorted;
      }, {});
  }
  return value;
}

/**
 * The exact digest formula. Kept in one place so verification can never drift
 * from writing — the JSON tuple order is part of the contract.
 */
export function computeAuditHash(
  payload: {
    sequence: number;
    recordedAt: string;
    actorId: string;
    actorRole: string;
    action: string;
    targetType: string;
    targetId: string;
    outcome: string;
    details: Record<string, unknown>;
  },
  prevHash: string,
): string {
  const body = JSON.stringify([
    payload.sequence,
    payload.recordedAt,
    payload.actorId,
    payload.actorRole,
    payload.action,
    payload.targetType,
    payload.targetId,
    payload.outcome,
    canonicalize(payload.details),
  ]);
  return createHash("sha256").update(`${body}|${prevHash}`).digest("hex");
}

interface AuditRow {
  audit_id: string;
  event_seq: string | number;
  recorded_at: Date;
  actor_id: string;
  actor_role: AuditRole;
  action: string;
  target_type: string;
  target_id: string;
  outcome: AuditOutcome;
  details: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

const COLUMNS =
  "audit_id, event_seq, recorded_at, actor_id, actor_role, action, target_type, target_id, outcome, details, prev_hash, hash";

function toEvent(row: AuditRow): AuditEvent {
  return {
    id: row.audit_id,
    sequence: Number(row.event_seq),
    recordedAt: row.recorded_at.toISOString(),
    actorId: row.actor_id,
    actorRole: row.actor_role,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    outcome: row.outcome,
    details: row.details ?? {},
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}

const chainLockKey = 728_931_401;

export class PostgresAuditLog implements AuditStore {
  constructor(private readonly pool: Pool) {}

  async record(input: AuditEventInput): Promise<AuditEvent> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // One writer at a time: the chain must be linear.
      await client.query("SELECT pg_advisory_xact_lock($1)", [chainLockKey]);

      const tail = await client.query<{ event_seq: string | null; hash: string | null }>(
        "SELECT event_seq, hash FROM audit_events ORDER BY event_seq DESC LIMIT 1",
      );
      const sequence = Number(tail.rows[0]?.event_seq ?? 0) + 1;
      const prevHash = tail.rows[0]?.hash ?? GENESIS_HASH;
      const recordedAt = new Date().toISOString();
      const details = canonicalize(input.details ?? {}) as Record<string, unknown>;

      const hash = computeAuditHash(
        {
          sequence,
          recordedAt,
          actorId: input.actorId,
          actorRole: input.actorRole,
          action: input.action,
          targetType: input.targetType ?? "",
          targetId: input.targetId ?? "",
          outcome: input.outcome ?? "SUCCESS",
          details,
        },
        prevHash,
      );

      const inserted = await client.query<AuditRow>(
        `INSERT INTO audit_events
           (event_seq, recorded_at, actor_id, actor_role, action, target_type, target_id, outcome, details, prev_hash, hash)
         VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
         RETURNING ${COLUMNS}`,
        [
          sequence,
          recordedAt,
          input.actorId,
          input.actorRole,
          input.action,
          input.targetType ?? "",
          input.targetId ?? "",
          input.outcome ?? "SUCCESS",
          JSON.stringify(details),
          prevHash,
          hash,
        ],
      );

      await client.query("COMMIT");
      const row = inserted.rows[0];
      if (!row) throw new Error("Audit insert returned no row.");
      return toEvent(row);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async list(options: AuditListOptions = {}): Promise<{ events: AuditEvent[]; total: number }> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);

    const where: string[] = [];
    const params: unknown[] = [];
    if (options.action) {
      params.push(options.action);
      where.push(`action = $${params.length}`);
    }
    if (options.outcome) {
      params.push(options.outcome);
      where.push(`outcome = $${params.length}`);
    }
    if (options.actorId) {
      params.push(options.actorId);
      where.push(`actor_id = $${params.length}`);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const totalResult = await this.pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM audit_events ${clause}`,
      params,
    );

    const rows = await this.pool.query<AuditRow>(
      `SELECT ${COLUMNS} FROM audit_events ${clause}
        ORDER BY event_seq DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );

    return {
      events: rows.rows.map(toEvent),
      total: Number(totalResult.rows[0]?.count ?? 0),
    };
  }

  async get(id: string): Promise<AuditEvent | null> {
    const result = await this.pool.query<AuditRow>(
      `SELECT ${COLUMNS} FROM audit_events WHERE audit_id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? toEvent(row) : null;
  }

  /** Re-computes the entire chain in sequence order. */
  async verify(): Promise<AuditVerification> {
    const rows = await this.pool.query<AuditRow>(
      `SELECT ${COLUMNS} FROM audit_events ORDER BY event_seq ASC`,
    );

    let previousHash = GENESIS_HASH;
    let brokenAt: number | null = null;
    for (const row of rows.rows) {
      const event = toEvent(row);
      const expected = computeAuditHash(
        {
          sequence: event.sequence,
          recordedAt: event.recordedAt,
          actorId: event.actorId,
          actorRole: event.actorRole,
          action: event.action,
          targetType: event.targetType,
          targetId: event.targetId,
          outcome: event.outcome,
          details: event.details,
        },
        previousHash,
      );
      if (event.prevHash !== previousHash || expected !== event.hash) {
        brokenAt = event.sequence;
        break;
      }
      previousHash = event.hash;
    }

    const head = rows.rows[rows.rows.length - 1];
    return {
      verified: brokenAt === null,
      checked: rows.rows.length,
      brokenAt,
      checkedAt: new Date().toISOString(),
      headHash: head ? head.hash : GENESIS_HASH,
    };
  }
}

/** No-op recorder used by tests and by deployments with auditing disabled. */
export const silentAudit: AuditRecorder = {
  async record(input) {
    return {
      id: "audit-disabled",
      sequence: 0,
      recordedAt: new Date().toISOString(),
      actorId: input.actorId,
      actorRole: input.actorRole,
      action: input.action,
      targetType: input.targetType ?? "",
      targetId: input.targetId ?? "",
      outcome: input.outcome ?? "SUCCESS",
      details: input.details ?? {},
      prevHash: GENESIS_HASH,
      hash: GENESIS_HASH,
    };
  },
};
