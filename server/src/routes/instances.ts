import { Router } from "express";
import { authenticate, currentOperator, requirePermission } from "../auth/middleware.js";
import type { OperatorDirectory } from "../auth/operators.js";
import { notFound } from "../domain/errors.js";
import {
  ListInstancesQuerySchema,
  RespondInstanceSchema,
  StartInstanceSchema,
} from "../domain/schemas.js";
import type { InstanceService } from "../services/instanceService.js";
import { paramId, parse, wrap } from "./http.js";

export interface InstanceRouterDeps {
  service: InstanceService;
  operators: OperatorDirectory;
}

/**
 * /api/instances — running workflows.
 *
 * Starting requires an approved+active template; answering a gate requires the
 * approver permission. Both are enforced here on the server, never in the UI.
 */
export function createInstanceRouter({ service, operators }: InstanceRouterDeps): Router {
  const router = Router();

  router.use(authenticate(operators));

  // POST / — start one run of an approved, active template
  router.post(
    "/",
    requirePermission("workflow:start"),
    wrap(async (req, res) => {
      const { templateId } = parse(StartInstanceSchema, req.body);
      const operator = currentOperator(req);
      const detail = await service.start(templateId, operator.id);
      res.status(201).json(detail);
    }),
  );

  // GET / — list runs (filters: status, template_id)
  router.get(
    "/",
    wrap(async (req, res) => {
      const query = parse(ListInstancesQuerySchema, req.query);
      const instances = await service.list({
        status: query.status,
        templateId: query.template_id,
      });
      res.json({ instances, count: instances.length });
    }),
  );

  // GET /:id — one run plus every step that has executed
  router.get(
    "/:id",
    wrap(async (req, res) => {
      res.json(await service.detail(paramId(req)));
    }),
  );

  // POST /:id/respond — resume the paused approval gate
  router.post(
    "/:id/respond",
    requirePermission("workflow:respond"),
    wrap(async (req, res) => {
      const { approved, comments } = parse(RespondInstanceSchema, req.body ?? {});
      const operator = currentOperator(req);
      const detail = await service.respond(paramId(req), {
        approved,
        comments: comments ?? null,
        by: operator.id,
      });
      res.json(detail);
    }),
  );

  // POST /:id/cancel — stop a run, keeping its history
  router.post(
    "/:id/cancel",
    requirePermission("workflow:cancel"),
    wrap(async (req, res) => {
      res.json(await service.cancel(paramId(req)));
    }),
  );

  router.use((_req, _res, next) => next(notFound("Route not found.")));

  return router;
}
