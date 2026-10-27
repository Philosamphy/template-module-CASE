import type { Pool } from "pg";

export type Role = "operator" | "approver";

export interface Operator {
  id: string;
  displayName: string;
  role: Role;
}

export const PERMISSIONS = [
  "template:create",
  "template:generate",
  "template:edit",
  "template:deactivate",
  "template:approve",
  "workflow:start",
  "workflow:respond",
  "workflow:cancel",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Authorisation matrix. The approver role also holds every operator
 * permission; approval/rejection — of templates and of paused workflow gates —
 * is restricted to approvers.
 */
const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  operator: [
    "template:create",
    "template:generate",
    "template:edit",
    "template:deactivate",
    "workflow:start",
    "workflow:cancel",
  ],
  approver: PERMISSIONS,
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export interface OperatorDirectory {
  findById(id: string): Promise<Operator | null>;
}

/** Resolves operators from the `operators` table (seeded by the migration). */
export class PostgresOperatorDirectory implements OperatorDirectory {
  constructor(private readonly pool: Pool) {}

  async findById(id: string): Promise<Operator | null> {
    const result = await this.pool.query<{ operator_id: string; display_name: string; role: Role }>(
      `SELECT operator_id, display_name, role FROM operators WHERE operator_id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { id: row.operator_id, displayName: row.display_name, role: row.role };
  }
}
