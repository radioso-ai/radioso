import { randomUUID } from "node:crypto";
import { Router } from "express";

import type { AppDependencies } from "../../server/types.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { requireSurfaceExtension } from "../shared/requireSurfaceExtension.js";
import { validateBody } from "../middleware/validate.js";
import { embeddingModelIds } from "../../../modules/settings/contracts/ingestion.js";
import { badRequest } from "../../../shared/domain/errors.js";
import {
  ASSISTANT_LOGO_MIME_TYPES,
  createAssistantLogoUploadHandler,
} from "../shared/assistantIdentity.js";
import {
  reprocessIngestionBodySchema,
  updateDocumentTypeCatalogSchema,
  updateGeneralSettingsSchema,
  updateIngestionSettingsSchema,
  updatePlatformSettingsSchema,
} from "./settingsRouteSchemas.js";
import {
  anonymousChatTokenRotationPatch,
  toGeneralSettingsPatch,
  websiteEmbedTokenRotationPatch,
} from "./settingsRouteMappers.js";
import {
  presentDocumentTypeCatalog,
  presentEmbeddingCoverage,
  presentGeneralSettings,
  presentIngestionSettings,
  presentRetrievalDefaults,
} from "../presenters/settingsPresenter.js";

type SettingsRouteDependencies = WorkspaceSessionDependencies & Pick<
  AppDependencies,
  | "ingestionSettingsService"
  | "documentTypeCatalogService"
  | "metadataFieldSuggestionProvider"
  | "metadataRuleFieldReferenceProvider"
  | "embeddingCoverageReport"
  | "platformSettingsService"
  | "workspaceIngestionReprocessService"
  | "agentService"
  | "agentSurfaceExtensions"
  | "documentStorage"
  | "retrievalDefaultsProvider"
  | "logger"
>;

export const createSettingsRoutes = (dependencies: SettingsRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const settingsRead = requireWorkspacePermission(dependencies, "workspace.settings.read");
  const runUploadSingle = createAssistantLogoUploadHandler();
  const supportedEmbeddingModels = () =>
    dependencies.ingestionSettingsService.listSupportedEmbeddingModels?.() ?? embeddingModelIds;

  router.get("/", workspaceSession, settingsRead, async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const settings = await dependencies.platformSettingsService.getForWorkspace(workspaceId);
      res.status(200).json(settings);
    } catch (error) {
      next(error);
    }
  });

  router.put("/", workspaceSession, requireWorkspacePermission(dependencies, "workspace.settings.manage"), validateBody(updatePlatformSettingsSchema), async (req, res, next) => {
    try {
      const { accountId, workspaceId } = res.locals as { accountId: string; workspaceId: string };
      const settings = await dependencies.platformSettingsService.updateForWorkspace(workspaceId, req.body, { accountId });
      res.status(200).json(settings);
    } catch (error) {
      next(error);
    }
  });

  router.get("/retrieval-defaults", workspaceSession, settingsRead, async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const defaults = dependencies.retrievalDefaultsProvider.getDefaults(workspaceId);
      const metadataFieldSuggestions =
        await dependencies.metadataFieldSuggestionProvider.listMetadataFieldSuggestions(workspaceId);
      res.status(200).json(presentRetrievalDefaults(defaults, metadataFieldSuggestions));
    } catch (error) {
      next(error);
    }
  });

  router.get("/ingestion", workspaceSession, settingsRead, async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const settings = await dependencies.ingestionSettingsService.getForWorkspace(workspaceId);
      res.status(200).json(presentIngestionSettings(settings, supportedEmbeddingModels()));
    } catch (error) {
      next(error);
    }
  });

  // Read-only progress of the canonical embedding projection. Kept off GET /ingestion
  // so reading settings does not pay for a count over every chunk in the workspace,
  // and because coverage is runtime state rather than a setting anyone can change.
  router.get("/ingestion/embedding-coverage", workspaceSession, settingsRead, async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const coverage = await dependencies.embeddingCoverageReport
        .getWorkspaceCanonicalEmbeddingCoverage(workspaceId);
      res.status(200).json(presentEmbeddingCoverage(coverage));
    } catch (error) {
      next(error);
    }
  });

  router.put("/ingestion", workspaceSession, requireWorkspacePermission(dependencies, "workspace.settings.manage"), validateBody(updateIngestionSettingsSchema), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const settings = await dependencies.ingestionSettingsService.updateForWorkspace(workspaceId, req.body);
      res.status(200).json(presentIngestionSettings(settings, supportedEmbeddingModels()));
    } catch (error) {
      next(error);
    }
  });

  router.get("/document-types", workspaceSession, settingsRead, async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const [catalog, referencedFieldKeys] = await Promise.all([
        dependencies.documentTypeCatalogService.getCatalog(workspaceId),
        dependencies.metadataRuleFieldReferenceProvider.listReferencedFieldKeys(workspaceId),
      ]);
      res.status(200).json(presentDocumentTypeCatalog(catalog, referencedFieldKeys));
    } catch (error) {
      next(error);
    }
  });

  router.put("/document-types", workspaceSession, requireWorkspacePermission(dependencies, "workspace.settings.manage"), validateBody(updateDocumentTypeCatalogSchema), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const catalog = await dependencies.documentTypeCatalogService.replaceCatalog(workspaceId, req.body);
      const referencedFieldKeys =
        await dependencies.metadataRuleFieldReferenceProvider.listReferencedFieldKeys(workspaceId);
      res.status(200).json(presentDocumentTypeCatalog(catalog, referencedFieldKeys));
    } catch (error) {
      next(error);
    }
  });

  router.post("/ingestion/embedding-model/cancel", workspaceSession, requireWorkspacePermission(dependencies, "workspace.settings.manage"), async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const settings = await dependencies.ingestionSettingsService.cancelPendingEmbeddingModel?.(workspaceId);
      if (!settings) {
        res.status(405).json({ error: "pending embedding model cancellation is unavailable" });
        return;
      }
      res.status(200).json(presentIngestionSettings(settings, supportedEmbeddingModels()));
    } catch (error) {
      next(error);
    }
  });

  router.post("/ingestion/reprocess", workspaceSession, requireWorkspacePermission(dependencies, "workspace.documents.manage"), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const body = reprocessIngestionBodySchema.parse(req.body ?? {});
      const result = await dependencies.workspaceIngestionReprocessService.reprocessWorkspace(
        workspaceId,
        body.documentEnrichmentOverride ? { documentEnrichmentOverride: body.documentEnrichmentOverride } : null,
      );
      res.status(202).json(result);
    } catch (error) {
      next(error);
    }
  });

  // --- General settings (anonymous chat) ---

  router.get("/general", workspaceSession, settingsRead, async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const settings = await dependencies.platformSettingsService.getForWorkspace(workspaceId);
      res.status(200).json(presentGeneralSettings(settings));
    } catch (error) {
      next(error);
    }
  });

  router.put("/general", workspaceSession, requireWorkspacePermission(dependencies, "workspace.settings.manage"), validateBody(updateGeneralSettingsSchema), async (req, res, next) => {
    try {
      const { accountId, workspaceId } = res.locals as { accountId: string; workspaceId: string };
      const settings = await dependencies.platformSettingsService.updateForWorkspace(
        workspaceId,
        toGeneralSettingsPatch(req.body),
        { accountId },
      );

      res.status(200).json(presentGeneralSettings(settings));
    } catch (error) {
      next(error);
    }
  });

  router.post("/general/anonymous-chat-token/rotate", workspaceSession, requireWorkspacePermission(dependencies, "workspace.settings.manage"), async (_req, res, next) => {
    try {
      const { accountId, workspaceId } = res.locals as { accountId: string; workspaceId: string };
      const settings = await dependencies.platformSettingsService.updateForWorkspace(
        workspaceId,
        anonymousChatTokenRotationPatch(),
        { accountId },
      );
      res.status(200).json(presentGeneralSettings(settings));
    } catch (error) {
      next(error);
    }
  });

  router.post("/general/website-embed-token/rotate", requireSurfaceExtension(dependencies.agentSurfaceExtensions, "websiteEmbed"), workspaceSession, requireWorkspacePermission(dependencies, "workspace.settings.manage"), async (_req, res, next) => {
    try {
      const { accountId, workspaceId } = res.locals as { accountId: string; workspaceId: string };
      const settings = await dependencies.platformSettingsService.updateForWorkspace(
        workspaceId,
        websiteEmbedTokenRotationPatch(),
        { accountId },
      );
      res.status(200).json(presentGeneralSettings(settings));
    } catch (error) {
      next(error);
    }
  });

  router.post("/general/assistant-logo", workspaceSession, requireWorkspacePermission(dependencies, "workspace.settings.manage"), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const current = await dependencies.agentService.resolve(workspaceId);
      await runUploadSingle(req, res);
      if (!req.file) {
        throw badRequest("Logo file is required");
      }
      if (!ASSISTANT_LOGO_MIME_TYPES.has(req.file.mimetype)) {
        throw badRequest("Assistant logo must be a PNG, JPEG, WebP, or GIF image");
      }

      const stored = await dependencies.documentStorage.upload({
        workspaceId,
        documentId: `assistant-logo-${current.id}-${randomUUID()}`,
        filename: req.file.originalname || "assistant-logo",
        mimeType: req.file.mimetype,
        buffer: req.file.buffer,
      });
      const uploadedLogo = {
        bucket: stored.bucket,
        objectPath: stored.objectPath,
        generation: stored.generation ?? null,
        mimeType: req.file.mimetype,
        filename: req.file.originalname || "assistant-logo",
        sizeBytes: stored.sizeBytes,
      };
      await dependencies.agentService.update(workspaceId, current.id, {
        logo: uploadedLogo,
      }).catch(async (error: unknown) => {
        await dependencies.documentStorage.delete({
          bucket: uploadedLogo.bucket,
          objectPath: uploadedLogo.objectPath,
          generation: uploadedLogo.generation,
        }).catch((cleanupError: unknown) => {
          dependencies.logger.warn({ err: cleanupError, workspaceId, agentId: current.id }, "Failed to clean up orphaned assistant logo upload");
        });
        throw error;
      });
      const previousLogo = current.logo;
      if (previousLogo) {
        await dependencies.documentStorage.delete({
          bucket: previousLogo.bucket,
          objectPath: previousLogo.objectPath,
          generation: previousLogo.generation ?? null,
        }).catch((error: unknown) => {
          dependencies.logger.warn({ err: error, workspaceId, agentId: current.id }, "Failed to delete replaced assistant logo");
        });
      }

      res.status(200).json(presentGeneralSettings(await dependencies.platformSettingsService.getForWorkspace(workspaceId)));
    } catch (error) {
      next(error);
    }
  });

  router.delete("/general/assistant-logo", workspaceSession, requireWorkspacePermission(dependencies, "workspace.settings.manage"), async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const current = await dependencies.agentService.resolve(workspaceId);
      await dependencies.agentService.update(workspaceId, current.id, {
        logo: null,
      });
      const previousLogo = current.logo;
      if (previousLogo) {
        await dependencies.documentStorage.delete({
          bucket: previousLogo.bucket,
          objectPath: previousLogo.objectPath,
          generation: previousLogo.generation ?? null,
        }).catch((error: unknown) => {
          dependencies.logger.warn({ err: error, workspaceId, agentId: current.id }, "Failed to delete removed assistant logo");
        });
      }

      res.status(200).json(presentGeneralSettings(await dependencies.platformSettingsService.getForWorkspace(workspaceId)));
    } catch (error) {
      next(error);
    }
  });

  return router;
};
