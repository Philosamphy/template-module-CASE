import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import type { AuditRecorder } from "../audit/auditLog.js";
import { recordAudit } from "../audit/record.js";
import { authenticate, currentOperator, requirePermission } from "../auth/middleware.js";
import type { OperatorDirectory } from "../auth/operators.js";
import { ApiError, conflict, notFound, unprocessable } from "../domain/errors.js";
import type { FileReader } from "../execution/intake.js";
import { UnavailableFileReader } from "../execution/intake.js";
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
 * Starting requires an approved+active template and `workflow:start`; answering a
 * gate requires `workflow:respond` (operators and admins, never auditors). Both
 * are enforced here on the server, never in the UI.
 */
export interface InstanceRouterDeps {
  service: InstanceService;
  operators: OperatorDirectory;
  audit?: AuditRecorder;
  /** Reads uploaded intake files (PDF text / image OCR + model summary). */
  files?: FileReader;
}

/** 10 MB is plenty for a case document and keeps memory bounded. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

/** Maps multer's limit errors to our error envelope instead of a 500. */
function singleFile(req: Request, res: Response, next: NextFunction): void {
  upload.single("file")(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }
    if (error instanceof multer.MulterError) {
      next(
        new ApiError(
          error.code === "LIMIT_FILE_SIZE" ? 413 : 400,
          error.code === "LIMIT_FILE_SIZE" ? "FILE_TOO_LARGE" : "BAD_UPLOAD",
          error.code === "LIMIT_FILE_SIZE"
            ? "The file is larger than 10 MB."
            : "The upload could not be read.",
        ),
      );
      return;
    }
    next(new ApiError(400, "BAD_UPLOAD", "The upload could not be read."));
  });
}

export function createInstanceRouter({
  service,
  operators,
  audit,
  files = new UnavailableFileReader(),
}: InstanceRouterDeps): Router {
  const router = Router();

  router.use(authenticate(operators));

  // POST / — start one run of an approved, active template
  router.post(
    "/",
    requirePermission("workflow:start"),
    wrap(async (req, res) => {
      const { templateId, input } = parse(StartInstanceSchema, req.body);
      const operator = currentOperator(req);
      const detail = await service.start(templateId, operator.id, input ?? {});
      recordAudit(audit, operator, {
        action: "WORKFLOW_STARTED",
        targetType: "instance",
        targetId: detail.instance.instanceId,
        details: {
          templateId,
          templateName: detail.instance.templateName,
          templateVersion: detail.instance.templateVersion,
          inputFields: Object.keys(input ?? {}),
          status: detail.instance.status,
        },
      });
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

  // GET /:id — one run plus every step that has executed, and the gate payload
  // (pendingApproval) while it is PAUSED.
  router.get(
    "/:id",
    wrap(async (req, res) => {
      res.json(await service.detail(paramId(req)));
    }),
  );

  // GET /:id/documents/:stepId — stream the file a `document` step produced.
  // The path is looked up from our own step_runs rows, never taken from the client.
  router.get(
    "/:id/documents/:stepId",
    wrap(async (req, res) => {
      const raw = req.params.stepId;
      const stepId = typeof raw === "string" ? raw : "";
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(stepId)) {
        throw notFound("Document not found.");
      }
      const doc = await service.document(paramId(req), stepId);
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("content-disposition", `inline; filename="${doc.filename}"`);
      res.sendFile(doc.absolutePath);
    }),
  );

  // POST /:id/intake — upload the PDF/JPG an intake step is waiting for. The
  // server reads it (PDF text layer or OCR, then the model), and only then
  // resumes the run; nothing is executed on an unreadable file.
  router.post(
    "/:id/intake",
    requirePermission("workflow:respond"),
    singleFile,
    wrap(async (req, res) => {
      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file || file.size === 0) {
        throw unprocessable("Attach the file in the 'file' form field.");
      }

      const detail = await service.detail(paramId(req));
      const gate = detail.pendingApproval;
      if (!gate || gate.kind !== "intake") {
        throw conflict("This workflow is not waiting for a file.", {
          instanceStatus: detail.instance.status,
        });
      }

      const read = await files.read({
        buffer: file.buffer,
        fileName: file.originalname,
        mimeType: file.mimetype,
        accepted: gate.acceptedFileTypes,
        instruction: gate.instruction ?? undefined,
      });

      const operator = currentOperator(req);
      const updated = await service.submitIntake(detail.instance.instanceId, {
        kind: "intake",
        fileName: file.originalname,
        mimeType: file.mimetype,
        bytes: file.size,
        text: read.text,
        aiSummary: read.aiSummary,
        extraction: read.extraction,
        by: operator.id,
      });

      recordAudit(audit, operator, {
        action: "WORKFLOW_INPUT_READ",
        targetType: "instance",
        targetId: detail.instance.instanceId,
        details: {
          stepId: gate.step.id,
          fileName: file.originalname,
          bytes: file.size,
          extraction: read.extraction,
          aiSummary: read.aiSummary !== null,
          status: updated.instance.status,
        },
      });

      res.json(updated);
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
      recordAudit(audit, operator, {
        action: approved ? "APPROVAL_GRANTED" : "APPROVAL_REJECTED",
        targetType: "instance",
        targetId: detail.instance.instanceId,
        details: {
          templateName: detail.instance.templateName,
          step: detail.instance.currentStep,
          comments: comments ?? null,
          status: detail.instance.status,
        },
      });
      res.json(detail);
    }),
  );

  // POST /:id/cancel — stop a run, keeping its history
  router.post(
    "/:id/cancel",
    requirePermission("workflow:cancel"),
    wrap(async (req, res) => {
      const detail = await service.cancel(paramId(req));
      recordAudit(audit, currentOperator(req), {
        action: "WORKFLOW_CANCELLED",
        targetType: "instance",
        targetId: detail.instance.instanceId,
        details: {
          templateName: detail.instance.templateName,
          status: detail.instance.status,
        },
      });
      res.json(detail);
    }),
  );

  router.use((_req, _res, next) => next(notFound("Route not found.")));

  return router;
}
