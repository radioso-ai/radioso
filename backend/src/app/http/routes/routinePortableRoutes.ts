import { Router, type Response } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { validateBody } from "../middleware/validate.js";
import {
  canonicalizePortableRoutineDocument,
  type PortableRoutineDocumentEnvelope,
} from "../../../modules/routines/portableDocument.js";
import type { ParseDiagnostic } from "@radioso/routine-markdown";

export const portableRoutineDocumentEnvelopeSchema = z.object({
  grammarVersion: z.number().int(),
  content: z.string(),
}).strict();

export type PortableRoutineOperation = "read" | "create" | "update" | "canonicalize";

type PortableRoutineRouteDependencies = WorkspaceSessionDependencies & Pick<
  AppDependencies,
  "accountAccessService" | "logger" | "metricsRegistry"
>;

export const recordPortableRoutineFailure = (
  dependencies: Pick<AppDependencies, "logger" | "metricsRegistry">,
  operation: PortableRoutineOperation,
  diagnostics: readonly Pick<ParseDiagnostic, "code">[],
): void => {
  const diagnosticCodes = [...new Set(diagnostics.map((diagnostic) => diagnostic.code))];
  dependencies.logger.warn({ operation, diagnosticCodes }, "routine_portable_document_failed");
  for (const code of diagnosticCodes) {
    dependencies.metricsRegistry?.incrementCounter("routine_portable_failures_total", {
      help: "Portable routine authoring failures by operation and diagnostic code.",
      labels: { operation, code },
    });
  }
};

export const sendPortableDiagnostics = (
  res: Response,
  diagnostics: ParseDiagnostic[],
  status = 400,
): void => {
  res.status(status).json({ diagnostics });
};

export const portableValidationRejectedResponse = (validation: unknown) => ({
  error: "Routine definition is invalid",
  validation,
});

export const createRoutinePortableRoutes = (dependencies: PortableRoutineRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const agentManage = requireWorkspacePermission(dependencies, "workspace.agents.manage");

  router.post(
    "/routines/portable/canonicalize",
    workspaceSession,
    agentManage,
    validateBody(portableRoutineDocumentEnvelopeSchema),
    async (req, res, next) => {
      try {
        const result = canonicalizePortableRoutineDocument(req.body as PortableRoutineDocumentEnvelope);
        if (!result.ok) {
          recordPortableRoutineFailure(dependencies, "canonicalize", result.diagnostics);
          sendPortableDiagnostics(res, result.diagnostics);
          return;
        }
        res.status(200).json(result.envelope);
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
};
