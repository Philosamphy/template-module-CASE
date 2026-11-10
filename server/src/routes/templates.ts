import { Router } from "express";
import type { AuditRecorder } from "../audit/auditLog.js";
import { recordAudit } from "../audit/record.js";
import { authenticate, currentOperator, requirePermission } from "../auth/middleware.js";
import type { OperatorDirectory } from "../auth/operators.js";
import { notFound } from "../domain/errors.js";
import {
  ApproveSchema,
  CreateTemplateSchema,
  GenerateTemplateSchema,
  ListQuerySchema,
  RejectSchema,
  UpdateTemplateSchema,
} from "../domain/schemas.js";
import type { TemplateService } from "../services/templateService.js";
import { paramId, parse, wrap } from "./http.js";

export interface TemplateRouterDeps {
  service: TemplateService;
  operators: OperatorDirectory;
  audit?: AuditRecorder;
}

export function createTemplateRouter({
  service,
  operators,
  audit,
}: TemplateRouterDeps): Router {
  const router = Router();

  // Every route under /api/templates requires an identified operator.
  router.use(authenticate(operators));

  // POST /generate must stay registered before any generic /:id route.
  router.post(
    "/generate",
    requirePermission("template:generate"),
    wrap(async (req, res) => {
      const { prompt } = parse(GenerateTemplateSchema, req.body);
      const operator = currentOperator(req);
      const outcome = await service.generate(prompt, operator.id);
      if (outcome.kind === "clarification") {
        // A question, not a draft: nothing is persisted and no audit row is written.
        res.status(200).json({ needsClarification: true, question: outcome.question });
        return;
      }
      const template = outcome.template;
      recordAudit(audit, operator, {
        action: "TEMPLATE_GENERATED",
        targetType: "template",
        targetId: template.templateId,
        details: { name: template.name, prompt, steps: template.steps.length },
      });
      res.status(201).json({ template });
    }),
  );

  // POST / — manual creation
  router.post(
    "/",
    requirePermission("template:create"),
    wrap(async (req, res) => {
      const input = parse(CreateTemplateSchema, req.body);
      const operator = currentOperator(req);
      const template = await service.createManual(input, operator.id);
      recordAudit(audit, operator, {
        action: "TEMPLATE_CREATED",
        targetType: "template",
        targetId: template.templateId,
        details: { name: template.name, steps: template.steps.length },
      });
      res.status(201).json({ template });
    }),
  );

  // GET / — list (filters: origin, status, is_active)
  router.get(
    "/",
    wrap(async (req, res) => {
      const query = parse(ListQuerySchema, req.query);
      const templates = await service.list({
        origin: query.origin,
        status: query.status,
        isActive: query.is_active === undefined ? undefined : query.is_active === "true",
      });
      res.json({ templates, count: templates.length });
    }),
  );

  // GET /:id — one template plus its review history
  router.get(
    "/:id",
    wrap(async (req, res) => {
      res.json({ template: await service.get(paramId(req)) });
    }),
  );

  // PUT /:id — edit name/steps (protected fields are rejected by the strict schema)
  router.put(
    "/:id",
    requirePermission("template:edit"),
    wrap(async (req, res) => {
      const patch = parse(UpdateTemplateSchema, req.body);
      const template = await service.update(paramId(req), patch);
      recordAudit(audit, currentOperator(req), {
        action: "TEMPLATE_UPDATED",
        targetType: "template",
        targetId: template.templateId,
        details: { name: template.name, steps: template.steps.length, version: template.version },
      });
      res.json({ template });
    }),
  );

  // POST /:id/activate — re-enable a deactivated but still APPROVED template
  router.post(
    "/:id/activate",
    requirePermission("template:deactivate"),
    wrap(async (req, res) => {
      const template = await service.activate(paramId(req));
      recordAudit(audit, currentOperator(req), {
        action: "TEMPLATE_ACTIVATED",
        targetType: "template",
        targetId: template.templateId,
        details: { name: template.name },
      });
      res.json({ template, activated: true });
    }),
  );

  // DELETE /:id — deactivate (is_active = false), never a physical delete
  router.delete(
    "/:id",
    requirePermission("template:deactivate"),
    wrap(async (req, res) => {
      const template = await service.deactivate(paramId(req));
      recordAudit(audit, currentOperator(req), {
        action: "TEMPLATE_DEACTIVATED",
        targetType: "template",
        targetId: template.templateId,
        details: { name: template.name },
      });
      res.json({ template, deactivated: true });
    }),
  );

  // POST /:id/approve
  router.post(
    "/:id/approve",
    requirePermission("template:approve"),
    wrap(async (req, res) => {
      const { comments } = parse(ApproveSchema, req.body ?? {});
      const operator = currentOperator(req);
      const template = await service.approve(paramId(req), operator.id, comments);
      recordAudit(audit, operator, {
        action: "TEMPLATE_APPROVED",
        targetType: "template",
        targetId: template.templateId,
        details: { name: template.name, version: template.version, comments: comments ?? null },
      });
      res.json({ template });
    }),
  );

  // POST /:id/reject
  router.post(
    "/:id/reject",
    requirePermission("template:approve"),
    wrap(async (req, res) => {
      const { comments } = parse(RejectSchema, req.body ?? {});
      const operator = currentOperator(req);
      const template = await service.reject(paramId(req), operator.id, comments);
      recordAudit(audit, operator, {
        action: "TEMPLATE_REJECTED",
        targetType: "template",
        targetId: template.templateId,
        details: { name: template.name, comments },
      });
      res.json({ template });
    }),
  );

  router.use((_req, _res, next) => next(notFound("Route not found.")));

  return router;
}

