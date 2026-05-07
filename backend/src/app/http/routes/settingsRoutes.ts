import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { validateBody } from "../middleware/validate.js";
import { chunkingStrategyIds } from "../../../modules/retrieval/domain/chunking/chunkingStrategy.js";
import {
  MAX_SUGGESTED_QUESTIONS_COUNT,
  MIN_SUGGESTED_QUESTIONS_COUNT,
  conversationModes,
  metadataRuleCombinators,
  metadataRuleEffects,
  metadataRuleOperators,
  metadataRuleTriggerModes,
  metadataValueTypes,
} from "../../../modules/settings/domain/retrievalSettings.js";
import {
  websiteEmbedLauncherIcons,
  websiteEmbedLauncherPositions,
} from "../../../modules/settings/domain/websiteEmbedSettings.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";

export const updateSettingsSchema = z.object({
  queryRewriteEnabled: z.boolean(),
  semanticRewriteInstructions: z.string().max(2000).optional(),
  lexicalRewriteInstructions: z.string().max(2000).optional(),
  conversationMode: z.enum(conversationModes).optional(),
  suggestedQuestionsEnabled: z.boolean().optional(),
  suggestedQuestionsCount: z.number().int().min(MIN_SUGGESTED_QUESTIONS_COUNT).max(MAX_SUGGESTED_QUESTIONS_COUNT).optional(),
  rerankEnabled: z.boolean(),
  vectorTopK: z.number().int(),
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
  anonymousRateLimit: z.number().int().min(1).max(60).optional(),
  rotateAnonymousChatToken: z.boolean().optional(),
  assistantName: z.string().max(200).optional(),
  greetingInstruction: z.string().max(200).optional(),
  assistantDefaultLocale: z.string().max(35).nullable().optional(),
  proactiveGreetingEnabled: z.boolean().optional(),
  websiteEmbedEnabled: z.boolean().optional(),
  rotateWebsiteEmbedToken: z.boolean().optional(),
  websiteEmbedAllowedOrigins: z.array(z.string().max(200)).max(20).optional(),
  websiteEmbedLauncherLabel: z.string().max(80).optional(),
  websiteEmbedLauncherIcon: z.enum(websiteEmbedLauncherIcons).optional(),
  websiteEmbedLauncherPosition: z.enum(websiteEmbedLauncherPositions).optional(),
  mcpAssistantAccessEnabled: z.boolean().optional(),
});

export const updatePlatformSettingsSchema = z.object({
  assistant: z.object({
    assistantName: z.string().max(200).optional(),
    greetingInstruction: z.string().max(200).optional(),
    assistantDefaultLocale: z.string().max(35).nullable().optional(),
    proactiveGreetingEnabled: z.boolean().optional(),
    conversationMode: z.enum(conversationModes).optional(),
    suggestedQuestionsEnabled: z.boolean().optional(),
    suggestedQuestionsCount: z.number().int().min(MIN_SUGGESTED_QUESTIONS_COUNT).max(MAX_SUGGESTED_QUESTIONS_COUNT).optional(),
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
    anonymousRateLimit: z.number().int().min(1).max(60).optional(),
    rotateAnonymousChatToken: z.boolean().optional(),
    websiteEmbedEnabled: z.boolean().optional(),
    rotateWebsiteEmbedToken: z.boolean().optional(),
    websiteEmbedAllowedOrigins: z.array(z.string().max(200)).max(20).optional(),
    websiteEmbedLauncherLabel: z.string().max(80).optional(),
    websiteEmbedLauncherIcon: z.enum(websiteEmbedLauncherIcons).optional(),
    websiteEmbedLauncherPosition: z.enum(websiteEmbedLauncherPositions).optional(),
    mcpAssistantAccessEnabled: z.boolean().optional(),
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
>;

export const createSettingsRoutes = (dependencies: SettingsRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);

  router.get("/", workspaceSession, async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const settings = await dependencies.platformSettingsService.getForWorkspace(workspaceId);
      res.status(200).json(settings);
    } catch (error) {
      next(error);
    }
  });

  router.put("/", workspaceSession, validateBody(updatePlatformSettingsSchema), async (req, res, next) => {
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
    conversationMode: settings.assistant.conversationMode,
    suggestedQuestionsEnabled: settings.assistant.suggestedQuestionsEnabled,
    suggestedQuestionsCount: settings.assistant.suggestedQuestionsCount,
    customInstruction: settings.assistant.customInstruction,
  });

  router.get("/retrieval", workspaceSession, async (_req, res, next) => {
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

  router.put("/retrieval", workspaceSession, validateBody(updateSettingsSchema), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const settings = await dependencies.platformSettingsService.updateForWorkspace(workspaceId, {
        assistant: {
          conversationMode: req.body.conversationMode,
          suggestedQuestionsEnabled: req.body.suggestedQuestionsEnabled,
          suggestedQuestionsCount: req.body.suggestedQuestionsCount,
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

  router.get("/ingestion", workspaceSession, async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const settings = await dependencies.ingestionSettingsService.getForWorkspace(workspaceId);
      res.status(200).json(settings);
    } catch (error) {
      next(error);
    }
  });

  router.put("/ingestion", workspaceSession, validateBody(updateIngestionSettingsSchema), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const settings = await dependencies.ingestionSettingsService.updateForWorkspace(workspaceId, req.body);
      res.status(200).json(settings);
    } catch (error) {
      next(error);
    }
  });

  router.post("/ingestion/reprocess", workspaceSession, async (_req, res, next) => {
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
    anonymousRateLimit: settings.channels.anonymousRateLimit,
    assistantName: settings.assistant.assistantName,
    greetingInstruction: settings.assistant.greetingInstruction,
    assistantDefaultLocale: settings.assistant.assistantDefaultLocale,
    proactiveGreetingEnabled: settings.assistant.proactiveGreetingEnabled,
    assistantBootstrapActive: settings.assistant.assistantBootstrapActive,
    websiteEmbedEnabled: settings.channels.websiteEmbedEnabled,
    websiteEmbedToken: settings.channels.websiteEmbedToken,
    websiteEmbedScriptUrl: settings.channels.websiteEmbedScriptUrl,
    websiteEmbedSnippet: settings.channels.websiteEmbedSnippet,
    websiteEmbedAllowedOrigins: settings.channels.websiteEmbedAllowedOrigins,
    websiteEmbedLauncherLabel: settings.channels.websiteEmbedLauncherLabel,
    websiteEmbedLauncherIcon: settings.channels.websiteEmbedLauncherIcon,
    websiteEmbedLauncherPosition: settings.channels.websiteEmbedLauncherPosition,
    mcpAssistantAccessEnabled: settings.channels.mcpAssistantAccessEnabled,
  });

  router.get("/general", workspaceSession, async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const settings = await dependencies.platformSettingsService.getForWorkspace(workspaceId);
      res.status(200).json(presentGeneralSettings(settings));
    } catch (error) {
      next(error);
    }
  });

  router.put("/general", workspaceSession, validateBody(updateGeneralSettingsSchema), async (req, res, next) => {
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
            anonymousRateLimit: req.body.anonymousRateLimit,
            rotateAnonymousChatToken: req.body.rotateAnonymousChatToken,
            websiteEmbedEnabled: req.body.websiteEmbedEnabled,
            rotateWebsiteEmbedToken: req.body.rotateWebsiteEmbedToken,
            websiteEmbedAllowedOrigins: req.body.websiteEmbedAllowedOrigins,
            websiteEmbedLauncherLabel: req.body.websiteEmbedLauncherLabel,
            websiteEmbedLauncherIcon: req.body.websiteEmbedLauncherIcon,
            websiteEmbedLauncherPosition: req.body.websiteEmbedLauncherPosition,
            mcpAssistantAccessEnabled: req.body.mcpAssistantAccessEnabled,
          },
        },
        { accountId },
      );

      res.status(200).json(presentGeneralSettings(settings));
    } catch (error) {
      next(error);
    }
  });

  return router;
};
