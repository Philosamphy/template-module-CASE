import type { Pool } from "pg";

/**
 * Three roles, one matrix:
 *
 *  - admin    — everything an operator can do, plus inviting (whitelisting)
 *               members by email, switching roles, and removing access.
 *  - operator — create, edit, deactivate and approve templates, and run,
 *               answer and cancel workflows.
 *  - auditor  — read-only: templates, runs and generated documents.
 *
 * Access is revocable but membership rows are never deleted: a revoked member
 * can no longer authenticate, while every template, review, run and step they
 * touched keeps their identity for auditing.
 */
export type Role = "admin" | "operator" | "auditor";

export interface Operator {
  id: string;
  displayName: string;
  /** Whitelisted email; the member may sign in with it in place of their id. */
  email: string;
  role: Role;
  /** ISO timestamp when access was revoked, or null while the member is active. */
  revokedAt: string | null;
}

/** True while the member may still access the workspace. */
export const isActive = (operator: Operator): boolean => operator.revokedAt === null;

export const ROLES = ["admin", "operator", "auditor"] as const;

/** Roles an admin may hand out. Admin itself is provisioned outside this module. */
export const INVITABLE_ROLES = ["operator", "auditor"] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export const PERMISSIONS = [
  "template:read",
  "template:create",
  "template:generate",
  "template:edit",
  "template:deactivate",
  "template:approve",
  "workflow:read",
  "workflow:start",
  "workflow:respond",
  "workflow:cancel",
  "users:manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const READ_ONLY: readonly Permission[] = ["template:read", "workflow:read"];

/**
 * Authorisation matrix. The server checks this on every mutating route; the UI
 * merely mirrors it. Auditors are the only role that cannot mutate anything.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  auditor: READ_ONLY,
  operator: [
    ...READ_ONLY,
    "template:create",
    "template:generate",
    "template:edit",
    "template:deactivate",
    "template:approve",
    "workflow:start",
    "workflow:respond",
    "workflow:cancel",
  ],
  // Admin is a superset: every operator permission plus member management.
  admin: PERMISSIONS,
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return (ROLE_PERMISSIONS[role] ?? []).includes(permission);
}

export function permissionsFor(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

/** Read side of the operator table — all the auth middleware needs. */
export interface OperatorDirectory {
  /**
   * Resolves the identity header: an exact operator id first, then the
   * whitelisted email (case-insensitive), so an invited person can sign in
   * with the address the admin whitelisted.
   */
  resolve(identifier: string): Promise<Operator | null>;
  findById(id: string): Promise<Operator | null>;
}

/**
 * Read/write side: the admin member routes list, invite (whitelist), re-role,
 * revoke and restore people. There is deliberately no delete: revoking keeps
 * the row so history keeps a real name.
 */
export interface OperatorStore extends OperatorDirectory {
  list(): Promise<Operator[]>;
  create(input: {
    id: string;
    displayName: string;
    email: string;
    role: Role;
  }): Promise<Operator>;
  setRole(id: string, role: Role): Promise<Operator | null>;
  revoke(id: string): Promise<Operator | null>;
  reactivate(
    id: string,
    input: { displayName: string; email: string; role: Role },
  ): Promise<Operator | null>;
}

interface OperatorRow {
  operator_id: string;
  display_name: string;
  email: string;
  role: Role;
  revoked_at: Date | null;
}

const COLUMNS = "operator_id, display_name, email, role, revoked_at";

const toOperator = (row: OperatorRow): Operator => ({
  id: row.operator_id,
  displayName: row.display_name,
  email: row.email,
  role: row.role,
  revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
});

/** Resolves operators from the `operators` table (seeded by the migrations). */
export class PostgresOperatorDirectory implements OperatorStore {
  constructor(private readonly pool: Pool) {}

  async resolve(identifier: string): Promise<Operator | null> {
    const result = await this.pool.query<OperatorRow>(
      `SELECT ${COLUMNS} FROM operators
        WHERE operator_id = $1 OR lower(email) = lower($1)
        LIMIT 1`,
      [identifier],
    );
    const row = result.rows[0];
    return row ? toOperator(row) : null;
  }

  async findById(id: string): Promise<Operator | null> {
    const result = await this.pool.query<OperatorRow>(
      `SELECT ${COLUMNS} FROM operators WHERE operator_id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? toOperator(row) : null;
  }

  async list(): Promise<Operator[]> {
    const result = await this.pool.query<OperatorRow>(
      `SELECT ${COLUMNS} FROM operators ORDER BY revoked_at NULLS FIRST, display_name`,
    );
    return result.rows.map(toOperator);
  }

  async create(input: {
    id: string;
    displayName: string;
    email: string;
    role: Role;
  }): Promise<Operator> {
    const result = await this.pool.query<OperatorRow>(
      `INSERT INTO operators (operator_id, display_name, email, role)
       VALUES ($1, $2, $3, $4)
       RETURNING ${COLUMNS}`,
      [input.id, input.displayName, input.email, input.role],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Operator insert returned no row.");
    return toOperator(row);
  }

  async setRole(id: string, role: Role): Promise<Operator | null> {
    const result = await this.pool.query<OperatorRow>(
      `UPDATE operators SET role = $2 WHERE operator_id = $1
       RETURNING ${COLUMNS}`,
      [id, role],
    );
    const row = result.rows[0];
    return row ? toOperator(row) : null;
  }

  /** Soft delete: access ends, the row (and every reference to it) survives. */
  async revoke(id: string): Promise<Operator | null> {
    const result = await this.pool.query<OperatorRow>(
      `UPDATE operators SET revoked_at = now()
        WHERE operator_id = $1 AND revoked_at IS NULL
       RETURNING ${COLUMNS}`,
      [id],
    );
    const row = result.rows[0];
    return row ? toOperator(row) : null;
  }

  /** Re-whitelists a revoked member: same id, so their history stays attached. */
  async reactivate(
    id: string,
    input: { displayName: string; email: string; role: Role },
  ): Promise<Operator | null> {
    const result = await this.pool.query<OperatorRow>(
      `UPDATE operators
          SET revoked_at = NULL, display_name = $2, email = $3, role = $4
        WHERE operator_id = $1
       RETURNING ${COLUMNS}`,
      [id, input.displayName, input.email, input.role],
    );
    const row = result.rows[0];
    return row ? toOperator(row) : null;
  }
}
