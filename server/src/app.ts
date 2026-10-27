import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { OperatorDirectory } from "./auth/operators.js";
import type { TemplateGenerator } from "./ai/generator.js";
import type { RuleConfig } from "./domain/businessRules.js";
import type { NotificationPort } from "./execution/notifier.js";
import { ApiError } from "./domain/errors.js";
import { createInstanceRouter } from "./routes/instances.js";
import { createTemplateRouter } from "./routes/templates.js";
import type { TemplateRepository } from "./repo/types.js";
import type { ExecutionRepository } from "./execution/types.js";
import { InstanceService } from "./services/instanceService.js";
import { TemplateService } from "./services/templateService.js";

export interface AppDependencies {
  repo: TemplateRepository;
  executions: ExecutionRepository;
  checkpointer: BaseCheckpointSaver;
  notifier: NotificationPort;
  operators: OperatorDirectory;
  generator: TemplateGenerator;
  rules: RuleConfig;
  corsOrigins: string[];
}

export function createApp(deps: AppDependencies): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(cors({ origin: deps.corsOrigins, methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"] }));
  app.use(express.json({ limit: "128kb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  const service = new TemplateService(deps.repo, deps.generator, deps.rules);
  app.use("/api/templates", createTemplateRouter({ service, operators: deps.operators }));

  const instances = new InstanceService({
    templates: deps.repo,
    instances: deps.executions,
    checkpointer: deps.checkpointer,
    notifier: deps.notifier,
  });
  app.use("/api/instances", createInstanceRouter({ service: instances, operators: deps.operators }));

  app.use((_req, _res, next) => next(new ApiError(404, "NOT_FOUND", "Route not found.")));

  app.use(errorHandler);
  return app;
}

/**
 * Central error handler. Clients get a stable { error: { code, message, details } }
 * envelope; stack traces, SQL and credentials are logged server-side only.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ApiError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details ?? null },
    });
    return;
  }

  const body = err as { type?: string; status?: number } | null;
  if (body?.type === "entity.parse.failed") {
    res.status(400).json({
      error: { code: "BAD_REQUEST", message: "Request body is not valid JSON.", details: null },
    });
    return;
  }
  if (body?.type === "entity.too.large") {
    res.status(413).json({
      error: { code: "PAYLOAD_TOO_LARGE", message: "Request body is too large.", details: null },
    });
    return;
  }

  console.error("[unhandled]", err instanceof Error ? err.stack ?? err.message : err);
  res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "Unexpected server error.", details: null },
  });
}
