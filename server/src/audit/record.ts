import type { Operator } from "../auth/operators.js";
import type { AuditEventInput, AuditRecorder } from "./auditLog.js";

/**
 * Records an audit event for a route that has already succeeded.
 *
 * Auditing is best-effort at the call site: the action has already been
 * committed, so a recording problem is logged and never turned into a failed
 * response. Chain integrity itself is enforced inside PostgresAuditLog.
 */
export function recordAudit(
  audit: AuditRecorder | undefined,
  operator: Operator,
  input: Omit<AuditEventInput, "actorId" | "actorRole">,
): void {
  if (!audit) return;
  void audit
    .record({ ...input, actorId: operator.id, actorRole: operator.role })
    .catch((error: unknown) => {
      console.error(
        "[audit] could not record",
        input.action,
        error instanceof Error ? error.message : error,
      );
    });
}
