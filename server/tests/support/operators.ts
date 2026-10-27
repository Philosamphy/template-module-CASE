import type { Operator, OperatorDirectory } from "../../src/auth/operators.js";

/** Test double for the operators table. */
export class MapOperatorDirectory implements OperatorDirectory {
  private readonly operators = new Map<string, Operator>();

  add(operator: Operator): this {
    this.operators.set(operator.id, operator);
    return this;
  }

  async findById(id: string): Promise<Operator | null> {
    return this.operators.get(id) ?? null;
  }
}

export const OPERATOR_ID = "ops-operator";
export const APPROVER_ID = "ops-approver";

export function testOperatorDirectory(): MapOperatorDirectory {
  return new MapOperatorDirectory()
    .add({ id: OPERATOR_ID, displayName: "Aiman (Operator)", role: "operator" })
    .add({ id: APPROVER_ID, displayName: "Bagus (Approver)", role: "approver" });
}
