import type { Operator, OperatorStore, Role } from "../../src/auth/operators.js";

/** Test double for the operators table, including the admin write operations. */
export class MapOperatorDirectory implements OperatorStore {
  private readonly operators = new Map<string, Operator>();

  add(operator: Operator): this {
    this.operators.set(operator.id, operator);
    return this;
  }

  async resolve(identifier: string): Promise<Operator | null> {
    return (
      this.operators.get(identifier) ??
      [...this.operators.values()].find(
        (operator) => operator.email.toLowerCase() === identifier.toLowerCase(),
      ) ??
      null
    );
  }

  async findById(id: string): Promise<Operator | null> {
    return this.operators.get(id) ?? null;
  }

  async list(): Promise<Operator[]> {
    return [...this.operators.values()];
  }

  async create(input: {
    id: string;
    displayName: string;
    email: string;
    role: Role;
  }): Promise<Operator> {
    const operator: Operator = {
      id: input.id,
      displayName: input.displayName,
      email: input.email,
      role: input.role,
      revokedAt: null,
    };
    this.operators.set(operator.id, operator);
    return operator;
  }

  async setRole(id: string, role: Role): Promise<Operator | null> {
    const existing = this.operators.get(id);
    if (!existing) return null;
    const updated: Operator = { ...existing, role };
    this.operators.set(id, updated);
    return updated;
  }

  async revoke(id: string): Promise<Operator | null> {
    const existing = this.operators.get(id);
    if (!existing || existing.revokedAt !== null) return null;
    const updated: Operator = { ...existing, revokedAt: new Date().toISOString() };
    this.operators.set(id, updated);
    return updated;
  }

  async reactivate(
    id: string,
    input: { displayName: string; email: string; role: Role },
  ): Promise<Operator | null> {
    const existing = this.operators.get(id);
    if (!existing) return null;
    const updated: Operator = {
      ...existing,
      displayName: input.displayName,
      email: input.email,
      role: input.role,
      revokedAt: null,
    };
    this.operators.set(id, updated);
    return updated;
  }
}

export const ADMIN_ID = "ops-admin";
export const OPERATOR_ID = "ops-operator";
/** A second operator: decides on templates and gates other operators started. */
export const REVIEWER_ID = "ops-operator-2";
export const AUDITOR_ID = "ops-auditor";

export function testOperatorDirectory(): MapOperatorDirectory {
  return new MapOperatorDirectory()
    .add({
      id: ADMIN_ID,
      displayName: "Aisyah (Admin)",
      email: "aisyah@workspace.local",
      role: "admin",
      revokedAt: null,
    })
    .add({
      id: OPERATOR_ID,
      displayName: "Aiman (Operator)",
      email: "aiman@workspace.local",
      role: "operator",
      revokedAt: null,
    })
    .add({
      id: REVIEWER_ID,
      displayName: "Bagus (Operator)",
      email: "bagus@workspace.local",
      role: "operator",
      revokedAt: null,
    })
    .add({
      id: AUDITOR_ID,
      displayName: "Chong (Auditor)",
      email: "chong@workspace.local",
      role: "auditor",
      revokedAt: null,
    });
}
