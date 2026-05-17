import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { requireSurfaceExtension } from "../shared/requireSurfaceExtension.js";
import { validateBody } from "../middleware/validate.js";
import { chunkingStrategyIds } from "../../../modules/retrieval/public.js";
import {
  metadataRuleCombinators,
  metadataRuleEffects,
  metadataRuleOperators,
  metadataRuleTriggerModes,
  metadataValueTypes,
} from "../../../modules/settings/contracts/retrieval.js";
import {
  websiteEmbedLauncherPositions,
} from "../../../modules/settings/contracts/websiteEmbed.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import { badRequest } from "../../../shared/domain/errors.js";
import {
  ASSISTANT_LOGO_MIME_TYPES,
  assistantThemeSchema,
  createAssistantLogoUploadHandler,
} from "../shared/assistantIdentity.js";

export const updateSettingsSchema = z.object({
  queryRewriteEnabled: z.boolean(),
  semanticRewriteInstructions: z.string().max(2000).optional(),
  lexicalRewriteInstructions: z.string().max(2000).optional(),
  suggestedQuestionsEnabled: z.boolean().optional(),
  rerankEnabled: z.boolean(),
  vectorTopK: z.number().int().min(1),
  similarityThreshold: z.number(),
  rerankTopK: z.number().int().max(RETRIEVAL_BEHAVIOR.rerank.candidateLimit),
  citationDisplayEnabled: z.boolean(),
  answerSupportValidationEnabled: z.boolean().optional(),
  metadataRules: z
    .array(
      z.object({
        id: z.string().min(1),
        field: z.string().min(1).optional(),
        valueType: z.enum(metadataValueTypes).optional(),
        operator: z.enum(metadataRuleOperators).optional(),
        value: z.string().optional(),
        combinator: z.enum(metadataRuleCombinators).optional(),
        conditions: z.array(
          z.object({
            id: z.string().min(1),
            field: z.string().min(1),
            valueType: z.enum(metadataValueTypes),
            operator: z.enum(metadataRuleOperators),
            value: z.string(),
          }),
        ).optional(),
        effect: z.enum(metadataRuleEffects),
        enabled: z.boolean(),
        triggerMode: z.enum(metadataRuleTriggerModes).optional(),
        triggerInstruction: z.string().max(500).optional(),
      }),
    )
    .optional(),
  customInstruction: z.string().max(2000).optional(),
});

export const updateGeneralSettingsSchema = z.object({
  anonymousChatEnabled: z.boolean().optional(),
  assistantName: z.string().max(200).optional(),
  greetingInstruction: z.string().max(200).optional(),
  assistantDefaultLocale: z.string().max(35).nullable().optional(),
  proactiveGreetingEnabled: z.boolean().optional(),
  websiteEmbedEnabled: z.boolean().optional(),
  websiteEmbedAllowedOrigins: z.array(z.string().max(200)).max(20).optional(),
  websiteEmbedLauncherLabel: z.string().max(80).optional(),
  websiteEmbedLauncherPosition: z.enum(websiteEmbedLauncherPositions).optional(),
  websiteEmbedTheme: assistantThemeSchema.optional(),
  websiteEmbedCopy: z.record(z.record(z.string().max(500))).optional(),
  websiteEmbedExpertOverrides: z.record(z.string().max(500)).optional(),
});

export const updatePlatformSettingsSchema = z.object({
  assistant: z.object({
    assistantName: z.string().max(200).optional(),
    greetingInstruction: z.string().max(200).optional(),
    assistantDefaultLocale: z.string().max(35).nullable().optional(),
    proactiveGreetingEnabled: z.boolean().optional(),
    suggestedQuestionsEnabled: z.boolean().optional(),
    customInstruction: z.string().max(2000).optional(),
  }).optional(),
  retrieval: z.object({
    queryRewriteEnabled: z.boolean().optional(),
    semanticRewriteInstructions: z.string().max(2000).optional(),
    lexicalRewriteInstructions: z.string().max(2000).optional(),
    rerankEnabled: z.boolean().optional(),
    vectorTopK: z.number().int().optional(),
    similarityThreshold: z.number().optional(),
    rerankTopK: z.number().int().optional(),
    citationDisplayEnabled: z.boolean().optional(),
    answerSupportValidationEnabled: z.boolean().optional(),
    metadataRules: updateSettingsSchema.shape.metadataRules,
  }).optional(),
  channels: z.object({
    anonymousChatEnabled: z.boolean().optional(),
    websiteEmbedEnabled: z.boolean().optional(),
    websiteEmbedAllowedOrigins: z.array(z.string().max(200)).max(20).optional(),
    websiteEmbedLauncherLabel: z.string().max(80).optional(),
    websiteEmbedLauncherPosition: z.enum(websiteEmbedLauncherPositions).optional(),
    websiteEmbedTheme: updateGeneralSettingsSchema.shape.websiteEmbedTheme,
    websiteEmbedCopy: updateGeneralSettingsSchema.shape.websiteEmbedCopy,
    websiteEmbedExpertOverrides: updateGeneralSettingsSchema.shape.websiteEmbedExpertOverrides,
  }).optional(),
});

export const updateIngestionSettingsSchema = z.object({
  chunkingStrategy: z.enum(chunkingStrategyIds),
  fixedWindowChunkSize: z.number().int()
    .min(RETRIEVAL_BEHAVIOR.chunking.fixedWindowChunkSizeMin)
    .max(RETRIEVAL_BEHAVIOR.chunking.fixedWindowChunkSizeMax),
  fixedWindowChunkOverlap: z.number().int()
    .min(RETRIEVAL_BEHAVIOR.chunking.fixedWindowChunkOverlapMin)
    .max(RETRIEVAL_BEHAVIOR.chunking.fixedWindowChunkOverlapMax),
  structuredMinChunkSize: z.number().int()
    .min(RETRIEVAL_BEHAVIOR.chunking.structuredMinChunkSizeMin)
    .max(RETRIEVAL_BEHAVIOR.chunking.structuredMinChunkSizeMax),
  structuredMaxChunkSize: z.number().int()
    .min(RETRIEVAL_BEHAVIOR.chunking.structuredMaxChunkSizeMin)
    .max(RETRIEVAL_BEHAVIOR.chunking.structuredMaxChunkSizeMax),
});

type SettingsRouteDependencies = WorkspaceSessionDependencies & Pick<
  AppDependencies,
  | "ingestionSettingsService"
  | "platformSettingsService"
  | "retrievalSettingsService"
  | "workspaceIngestionReprocessService"
  | "agentService"
  | "agentSurfaceExtensions"
  | "documentStorage"
  | "logger"
>;

export const createSettingsRoutes = (dependencies: SettingsRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const settingsRead = requireWorkspacePermission(dependencies, "workspace.settings.read");
  const runUploadSingle = createAssistantLogoUploadHandler();

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

  const presentRetrievalSettings = (
    settings: Awaited<ReturnType<typeof dependencies.platformSettingsService.getForWorkspace>>,
    record: Awaited<ReturnType<typeof dependencies.retrievalSettingsService.getForWorkspace>>,
  ) => ({
    ...settings.retrieval,
    workspaceId: record.workspaceId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    suggestedQuestionsEnabled: settings.assistant.suggestedQuestionsEnabled,
    customInstruction: settings.assistant.customInstruction,
  });

  router.get("/retrieval", workspaceSession, settingsRead, async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const [settings, record] = await Promise.all([
        dependencies.platformSettingsService.getForWorkspace(workspaceId),
        dependencies.retrievalSettingsService.getForWorkspace(workspaceId),
      ]);
      res.status(200).json(presentRetrievalSettings(settings, record));
    } catch (error) {
      next(error);
    }
  });

  router.put("/retrieval", workspaceSession, requireWorkspacePermission(dependencies, "workspace.settings.manage"), validateBody(updateSettingsSchema), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const settings = await dependencies.platformSettingsService.updateForWorkspace(workspaceId, {
        assistant: {
          suggestedQuestionsEnabled: req.body.suggestedQuestionsEnabled,
          customInstruction: req.body.customInstruction,
        },
        retrieval: {
          queryRewriteEnabled: req.body.queryRewriteEnabled,
          semanticRewriteInstructions: req.body.semanticRewriteInstructions,
          lexicalRewriteInstructions: req.body.lexicalRewriteInstructions,
          rerankEnabled: req.body.rerankEnabled,
          vectorTopK: req.body.vectorTopK,
          similarityThreshold: req.body.similarityThreshold,
          rerankTopK: req.body.rerankTopK,
          citationDisplayEnabled: req.body.citationDisplayEnabled,
          answerSupportValidationEnabled: req.body.answerSupportValidationEnabled,
          metadataRules: req.body.metadataRules,
        },
      });
      const record = await dependencies.retrievalSettingsService.getForWorkspace(workspaceId);
      res.status(200).json(presentRetrievalSettings(settings, record));
    } catch (error) {
      next(error);
    }
  });

  router.get("/ingestion", workspaceSession, settingsRead, async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const settings = await dependencies.ingestionSettingsService.getForWorkspace(workspaceId);
      res.status(200).json(settings);
    } catch (error) {
      next(error);
    }
  });

  router.put("/ingestion", workspaceSession, requireWorkspacePermission(dependencies, "workspace.settings.manage"), validateBody(updateIngestionSettingsSchema), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const settings = await dependencies.ingestionSettingsService.updateForWorkspace(workspaceId, req.body);
      res.status(200).json(settings);
    } catch (error) {
      next(error);
    }
  });

  router.post("/ingestion/reprocess", workspaceSession, requireWorkspacePermission(dependencies, "workspace.documents.manage"), async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const result = await dependencies.workspaceIngestionReprocessService.reprocessWorkspace(workspaceId);
      res.status(202).json(result);
    } catch (error) {
      next(error);
    }
  });

  // --- General settings (anonymous chat) ---

  const presentGeneralSettings = (
    settings: Awaited<ReturnType<typeof dependencies.platformSettingsService.getForWorkspace>>,
  ) => ({
    anonymousChatEnabled: settings.channels.anonymousChatEnabled,
    anonymousChatUrl: settings.channels.anonymousChatUrl,
    assistantName: settings.assistant.assistantName,
    greetingInstruction: settings.assistant.greetingInstruction,
    assistantDefaultLocale: settings.assistant.assistantDefaultLocale,
    proactiveGreetingEnabled: settings.assistant.proactiveGreetingEnabled,
    assistantBootstrapActive: settings.assistant.assistantBootstrapActive,
    assistantLogoUrl: settings.assistant.assistantLogoUrl,
    websiteEmbedEnabled: settings.channels.websiteEmbedEnabled,
    websiteEmbedToken: settings.channels.websiteEmbedToken,
    websiteEmbedScriptUrl: settings.channels.websiteEmbedScriptUrl,
    websiteEmbedSnippet: settings.channels.websiteEmbedSnippet,
    websiteEmbedAllowedOrigins: settings.channels.websiteEmbedAllowedOrigins,
    websiteEmbedLauncherLabel: settings.channels.websiteEmbedLauncherLabel,
    websiteEmbedLauncherPosition: settings.channels.websiteEmbedLauncherPosition,
    websiteEmbedTheme: settings.channels.websiteEmbedTheme,
    websiteEmbedCopy: settings.channels.websiteEmbedCopy,
    websiteEmbedExpertOverrides: settings.channels.websiteEmbedExpertOverrides,
  });

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
        {
          assistant: {
            assistantName: req.body.assistantName,
            greetingInstruction: req.body.greetingInstruction,
            assistantDefaultLocale: req.body.assistantDefaultLocale,
            proactiveGreetingEnabled: req.body.proactiveGreetingEnabled,
          },
          channels: {
            anonymousChatEnabled: req.body.anonymousChatEnabled,
            websiteEmbedEnabled: req.body.websiteEmbedEnabled,
            websiteEmbedAllowedOrigins: req.body.websiteEmbedAllowedOrigins,
            websiteEmbedLauncherLabel: req.body.websiteEmbedLauncherLabel,
            websiteEmbedLauncherPosition: req.body.websiteEmbedLauncherPosition,
            websiteEmbedTheme: req.body.websiteEmbedTheme,
            websiteEmbedCopy: req.body.websiteEmbedCopy,
            websiteEmbedExpertOverrides: req.body.websiteEmbedExpertOverrides,
          },
        },
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
        {
          channels: {
            rotateAnonymousChatToken: true,
          },
        },
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
        {
          channels: {
            rotateWebsiteEmbedToken: true,
          },
        },
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
