import type { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import { notFound, unprocessable } from "../domain/errors.js";
import { formatIssues } from "../domain/schemas.js";

/** Accepts only well-formed UUIDs so malformed ids become 404, not a DB error. */
export const UuidParamSchema = z.string().uuid();

/** Parses a request fragment with a Zod schema, mapping failures to 422. */
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw unprocessable("Request failed validation.", {
      structural: formatIssues(result.error),
      businessRules: [],
    });
  }
  return result.data;
}

/** Reads a UUID route parameter; anything malformed is simply "not found". */
export function paramId(req: Request): string {
  const result = UuidParamSchema.safeParse(req.params.id);
  if (!result.success) throw notFound("Resource not found.");
  return result.data;
}

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<void> | void;

/** Express 5 forwards rejected promises, but this keeps intent explicit. */
export const wrap =
  (handler: Handler): RequestHandler =>
  (req, res, next) => {
    void Promise.resolve(handler(req, res, next)).catch(next);
  };
