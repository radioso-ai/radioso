import { randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { badRequest } from "../../../shared/domain/errors.js";
import { requireWorkspaceSession } from "../middleware/requireWorkspaceSession.js";
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
  isAssistantBootstrapActive,
  resolveAssistantDisplayName,
  validateAssistantBootstrapSettings,
} from "../../../modules/settings/domain/assistantBootstrapSettings.js";
import {
  DEFAULT_WEBSITE_EMBED_SCRIPT_PATH,
  validateWebsiteEmbedSettings,
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
  assistantRole: z.string().max(200).optional(),
  greetingInstruction: z.string().max(200).optional(),
  assistantDefaultLocale: z.string().max(35).nullable().optional(),
  proactiveGreetingEnabled: z.boolean().optional(),
  websiteEmbedEnabled: z.boolean().optional(),
  rotateWebsiteEmbedToken: z.boolean().optional(),
  websiteEmbedAllowedOrigins: z.array(z.string().max(200)).max(20).optional(),
  websiteEmbedLauncherLabel: z.string().max(80).optional(),
  websiteEmbedLauncherIcon: z.enum(websiteEmbedLauncherIcons).optional(),
  websiteEmbedLauncherPosition: z.enum(websiteEmbedLauncherPositions).optional(),
});

export const updatePlatformSettingsSchema = z.object({
  assistant: z.object({
    assistantName: z.string().max(200).optional(),
    assistantRole: z.string().max(200).optional(),
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

export const createSettingsRoutes = (dependencies: AppDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);

  const escapeHtmlAttribute = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");

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

  const presentLegacyRetrievalSettings = (
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
      res.status(200).json(presentLegacyRetrievalSettings(settings, record));
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
      res.status(200).json(presentLegacyRetrievalSettings(settings, record));
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

  const buildAnonymousChatUrl = (token: string | null, enabled: boolean): string | null => {
    const baseUrl = dependencies.env.PUBLIC_CHAT_BASE_URL;
    if (!baseUrl || !enabled || !token) return null;
    return `${baseUrl}/${token}`;
  };

  const buildWebsiteEmbedScriptUrl = (): string | null => {
    const baseUrl = dependencies.env.PUBLIC_CHAT_BASE_URL;
    if (!baseUrl) return null;

    try {
      return new URL(DEFAULT_WEBSITE_EMBED_SCRIPT_PATH, new URL(baseUrl).origin).toString();
    } catch {
      return null;
    }
  };

  const buildWebsiteEmbedSnippet = (
    workspace: NonNullable<Awaited<ReturnType<typeof dependencies.workspaceRepository.findById>>>,
  ): string | null => {
    if (!workspace.websiteEmbedEnabled || !workspace.websiteEmbedToken) {
      return null;
    }

    const scriptUrl = buildWebsiteEmbedScriptUrl();
    if (!scriptUrl) {
      return null;
    }

    const originAttribute =
      workspace.websiteEmbedAllowedOrigins.length > 0
        ? ` data-radioso-allowed-origins="${escapeHtmlAttribute(workspace.websiteEmbedAllowedOrigins.join(","))}"`
        : "";
    const displayName = resolveAssistantDisplayName({
      assistantName: workspace.assistantName,
      workspaceName: workspace.name,
    });
    const titleOverride = displayName
      ? ` data-radioso-copy="${escapeHtmlAttribute(JSON.stringify({ embeddedChatTitle: displayName }))}"`
      : "";

    return [
      `<script`,
      `  async`,
      `  src="${escapeHtmlAttribute(scriptUrl)}"`,
      `  data-radioso-token="${escapeHtmlAttribute(workspace.websiteEmbedToken)}"`,
      `  data-radioso-launcher-label="${escapeHtmlAttribute(workspace.websiteEmbedLauncherLabel)}"`,
      `  data-radioso-launcher-icon="${escapeHtmlAttribute(workspace.websiteEmbedLauncherIcon)}"`,
      `  data-radioso-launcher-position="${escapeHtmlAttribute(workspace.websiteEmbedLauncherPosition)}"${originAttribute}${titleOverride}`,
      `></script>`,
    ].join("\n");
  };

  const buildGeneralSettingsResponse = (workspace: Awaited<ReturnType<typeof dependencies.workspaceRepository.findById>>) => {
    if (!workspace) {
      return null;
    }

    return {
      anonymousChatEnabled: workspace.anonymousChatEnabled,
      anonymousChatUrl: buildAnonymousChatUrl(workspace.anonymousChatToken, workspace.anonymousChatEnabled),
      anonymousRateLimit: workspace.anonymousRateLimit,
      assistantName: workspace.assistantName,
      assistantRole: workspace.assistantRole,
      greetingInstruction: workspace.greetingInstruction,
      assistantDefaultLocale: workspace.assistantDefaultLocale,
      proactiveGreetingEnabled: workspace.proactiveGreetingEnabled,
      assistantBootstrapActive: isAssistantBootstrapActive(workspace),
      websiteEmbedEnabled: workspace.websiteEmbedEnabled,
      websiteEmbedToken: workspace.websiteEmbedToken,
      websiteEmbedScriptUrl: buildWebsiteEmbedScriptUrl(),
      websiteEmbedSnippet: buildWebsiteEmbedSnippet(workspace),
      websiteEmbedAllowedOrigins: workspace.websiteEmbedAllowedOrigins,
      websiteEmbedLauncherLabel: workspace.websiteEmbedLauncherLabel,
      websiteEmbedLauncherIcon: workspace.websiteEmbedLauncherIcon,
      websiteEmbedLauncherPosition: workspace.websiteEmbedLauncherPosition,
    };
  };

  router.get("/general", workspaceSession, async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const workspace = await dependencies.workspaceRepository.findById(workspaceId);
      if (!workspace) {
        res.status(404).json({ code: "not_found", message: "Workspace not found" });
        return;
      }
      res.status(200).json(buildGeneralSettingsResponse(workspace));
    } catch (error) {
      next(error);
    }
  });

  router.put("/general", workspaceSession, validateBody(updateGeneralSettingsSchema), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const workspace = await dependencies.workspaceRepository.findById(workspaceId);
      if (!workspace) {
        res.status(404).json({ code: "not_found", message: "Workspace not found" });
        return;
      }

      const enabled = req.body.anonymousChatEnabled ?? workspace.anonymousChatEnabled;
      const rateLimit = req.body.anonymousRateLimit ?? workspace.anonymousRateLimit;
      const rotateAnonymousChatToken = req.body.rotateAnonymousChatToken ?? false;
      const rotateWebsiteEmbedToken = req.body.rotateWebsiteEmbedToken ?? false;

      // Generate token on first enable (preserve across toggles)
      let token = workspace.anonymousChatToken;
      if (rotateAnonymousChatToken) {
        token = randomBytes(16).toString("base64url");
      } else if (enabled && !token) {
        token = randomBytes(16).toString("base64url");
      }
      let websiteEmbedToken = workspace.websiteEmbedToken;
      if (rotateWebsiteEmbedToken) {
        websiteEmbedToken = randomBytes(16).toString("base64url");
      }
      let normalizedWebsiteEmbed;
      try {
        normalizedWebsiteEmbed = validateWebsiteEmbedSettings({
          websiteEmbedEnabled: req.body.websiteEmbedEnabled ?? workspace.websiteEmbedEnabled,
          websiteEmbedToken,
          websiteEmbedAllowedOrigins: req.body.websiteEmbedAllowedOrigins ?? workspace.websiteEmbedAllowedOrigins,
          websiteEmbedLauncherLabel: req.body.websiteEmbedLauncherLabel ?? workspace.websiteEmbedLauncherLabel,
          websiteEmbedLauncherIcon: req.body.websiteEmbedLauncherIcon ?? workspace.websiteEmbedLauncherIcon,
          websiteEmbedLauncherPosition: req.body.websiteEmbedLauncherPosition ?? workspace.websiteEmbedLauncherPosition,
        });
      } catch (error) {
        if (error instanceof Error) {
          throw badRequest(error.message);
        }
        throw error;
      }
      if (normalizedWebsiteEmbed.websiteEmbedEnabled && !websiteEmbedToken) {
        websiteEmbedToken = randomBytes(16).toString("base64url");
      }
      if (normalizedWebsiteEmbed.websiteEmbedEnabled && !token) {
        token = randomBytes(16).toString("base64url");
      }

      const normalizedBootstrap = validateAssistantBootstrapSettings({
        assistantName: req.body.assistantName ?? workspace.assistantName,
        assistantRole: req.body.assistantRole ?? workspace.assistantRole,
        greetingInstruction: req.body.greetingInstruction ?? workspace.greetingInstruction,
        assistantDefaultLocale:
          req.body.assistantDefaultLocale === undefined
            ? workspace.assistantDefaultLocale
            : req.body.assistantDefaultLocale,
        proactiveGreetingEnabled: req.body.proactiveGreetingEnabled ?? workspace.proactiveGreetingEnabled,
      });

      const updated = await dependencies.workspaceRepository.updateGeneralSettings(workspaceId, {
        anonymousChatEnabled: enabled,
        anonymousChatToken: token,
        anonymousRateLimit: rateLimit,
        ...normalizedBootstrap,
        websiteEmbedEnabled: normalizedWebsiteEmbed.websiteEmbedEnabled,
        websiteEmbedToken,
        websiteEmbedAllowedOrigins: normalizedWebsiteEmbed.websiteEmbedAllowedOrigins,
        websiteEmbedLauncherLabel: normalizedWebsiteEmbed.websiteEmbedLauncherLabel,
        websiteEmbedLauncherIcon: normalizedWebsiteEmbed.websiteEmbedLauncherIcon,
        websiteEmbedLauncherPosition: normalizedWebsiteEmbed.websiteEmbedLauncherPosition,
      });

      if (enabled !== workspace.anonymousChatEnabled) {
        const { accountId } = res.locals as { accountId: string };
        await dependencies.auditService.record({
          accountId,
          workspaceId,
          eventType: enabled ? "anonymous_chat.enabled" : "anonymous_chat.disabled",
          eventStatus: "success",
          metadata: { anonymousRateLimit: rateLimit },
        });
      }
      if (rotateAnonymousChatToken) {
        const { accountId } = res.locals as { accountId: string };
        await dependencies.auditService.record({
          accountId,
          workspaceId,
          eventType: "anonymous_chat.token_rotated",
          eventStatus: "success",
          metadata: { enabled },
        });
      }
      if (normalizedWebsiteEmbed.websiteEmbedEnabled !== workspace.websiteEmbedEnabled) {
        const { accountId } = res.locals as { accountId: string };
        await dependencies.auditService.record({
          accountId,
          workspaceId,
          eventType: normalizedWebsiteEmbed.websiteEmbedEnabled ? "website_embed.enabled" : "website_embed.disabled",
          eventStatus: "success",
          metadata: {
            allowedOrigins: normalizedWebsiteEmbed.websiteEmbedAllowedOrigins,
            launcherPosition: normalizedWebsiteEmbed.websiteEmbedLauncherPosition,
          },
        });
      }
      if (rotateWebsiteEmbedToken) {
        const { accountId } = res.locals as { accountId: string };
        await dependencies.auditService.record({
          accountId,
          workspaceId,
          eventType: "website_embed.token_rotated",
          eventStatus: "success",
          metadata: {
            enabled: normalizedWebsiteEmbed.websiteEmbedEnabled,
            allowedOrigins: normalizedWebsiteEmbed.websiteEmbedAllowedOrigins,
          },
        });
      }

      res.status(200).json(buildGeneralSettingsResponse(updated));
    } catch (error) {
      next(error);
    }
  });

  return router;
};
