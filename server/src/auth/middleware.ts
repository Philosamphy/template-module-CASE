import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ApiError } from "../domain/errors.js";
import type { OperatorDirectory, Permission } from "./operators.js";
import { hasPermission, isActive } from "./operators.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      operator?: import("./operators.js").Operator;
    }
  }
}

const HEADER = "x-operator-id";

/**
 * Resolves the caller's identity. IMPORTANT: this header lookup is the
 * *authorisation* plumbing for the module, not a complete authentication
 * scheme — swap the lookup for your session/JWT/OIDC verification before
 * production. The important property already holds: every mutating route runs
 * this middleware plus requirePermission() on the server, so hiding buttons in
 * the UI is never what protects the data.
 */
export function authenticate(directory: OperatorDirectory): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const raw = req.header(HEADER) ?? "";
      const id = raw.trim();
      if (!id) {
        throw new ApiError(401, "UNAUTHENTICATED", `Missing ${HEADER} header.`);
      }
      // An exact operator id or the email an admin whitelisted.
      const operator = await directory.resolve(id);
      if (!operator) {
        throw new ApiError(401, "UNAUTHENTICATED", "Unknown operator.");
      }
      // Revoked members are not deleted — their history stays — but they can no
      // longer authenticate. The check is here, once, for every route.
      if (!isActive(operator)) {
        throw new ApiError(
          403,
          "ACCESS_REVOKED",
          "This member's access to the workspace has been revoked by an administrator.",
        );
      }
      req.operator = operator;
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Server-side authorisation check — 403 regardless of what the UI shows. */
export function requirePermission(permission: Permission): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const operator = req.operator;
    if (!operator) {
      next(new ApiError(401, "UNAUTHENTICATED", "Authentication required."));
      return;
    }
    if (!hasPermission(operator.role, permission)) {
      next(
        new ApiError(
          403,
          "FORBIDDEN",
          `Operator "${operator.id}" (${operator.role}) is not allowed to perform this action.`,
          { requiredPermission: permission },
        ),
      );
      return;
    }
    next();
  };
}

export function currentOperator(req: Request) {
  const operator = req.operator;
  if (!operator) {
    throw new ApiError(401, "UNAUTHENTICATED", "Authentication required.");
  }
  return operator;
}
