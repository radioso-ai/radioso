import { randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { requireWorkspaceSession } from "../middleware/requireWorkspaceSession.js";
import { validateBody } from "../middleware/validate.js";
import { chunkingStrategyIds } from "../../../modules/retrieval/domain/chunking/chunkingStrategy.js";
import {
  answerSupportPolicies,
  metadataRuleEffects,
  metadataRuleOperators,
  metadataValueTypes,
} from "../../../modules/settings/domain/retrievalSettings.js";
import {
  FIXED_WINDOW_CHUNK_OVERLAP_MAX,
  FIXED_WINDOW_CHUNK_OVERLAP_MIN,
  FIXED_WINDOW_CHUNK_SIZE_MAX,
  FIXED_WINDOW_CHUNK_SIZE_MIN,
  STRUCTURED_MAX_CHUNK_SIZE_MAX,
  STRUCTURED_MAX_CHUNK_SIZE_MIN,
  STRUCTURED_MIN_CHUNK_SIZE_MAX,
  STRUCTURED_MIN_CHUNK_SIZE_MIN,
} from "../../../modules/settings/domain/ingestionSettings.js";

export const updateSettingsSchema = z.object({
  queryRewriteEnabled: z.boolean(),
  semanticRewriteInstructions: z.string().max(2000).optional(),
  lexicalRewriteInstructions: z.string().max(2000).optional(),
  answerSupportPolicy: z.enum(answerSupportPolicies).optional(),
  rerankEnabled: z.boolean(),
  vectorTopK: z.number().int(),
  similarityThreshold: z.number(),
  rerankTopK: z.number().int(),
  citationDisplayEnabled: z.boolean(),
  metadataRules: z
    .array(
      z.object({
        id: z.string().min(1),
        field: z.string().min(1),
        valueType: z.enum(metadataValueTypes),
        operator: z.enum(metadataRuleOperators),
        value: z.string(),
        effect: z.enum(metadataRuleEffects),
        enabled: z.boolean(),
      }),
    )
    .optional(),
  customInstruction: z.string().max(2000).optional(),
});

export const updateGeneralSettingsSchema = z.object({
  anonymousChatEnabled: z.boolean().optional(),
  anonymousRateLimit: z.number().int().min(1).max(60).optional(),
});

export const updateIngestionSettingsSchema = z.object({
  chunkingStrategy: z.enum(chunkingStrategyIds),
  fixedWindowChunkSize: z.number().int().min(FIXED_WINDOW_CHUNK_SIZE_MIN).max(FIXED_WINDOW_CHUNK_SIZE_MAX),
  fixedWindowChunkOverlap: z.number().int().min(FIXED_WINDOW_CHUNK_OVERLAP_MIN).max(FIXED_WINDOW_CHUNK_OVERLAP_MAX),
  structuredMinChunkSize: z.number().int().min(STRUCTURED_MIN_CHUNK_SIZE_MIN).max(STRUCTURED_MIN_CHUNK_SIZE_MAX),
  structuredMaxChunkSize: z.number().int().min(STRUCTURED_MAX_CHUNK_SIZE_MIN).max(STRUCTURED_MAX_CHUNK_SIZE_MAX),
});

export const createSettingsRoutes = (dependencies: AppDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);

  router.get("/retrieval", workspaceSession, async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const [settings, metadataFieldSuggestions] = await Promise.all([
        dependencies.retrievalSettingsService.getForWorkspace(workspaceId),
        dependencies.retrievalSettingsService.listMetadataFieldSuggestions(workspaceId),
      ]);
      res.status(200).json({
        ...settings,
        metadataFieldSuggestions,
      });
    } catch (error) {
      next(error);
    }
  });

  router.put("/retrieval", workspaceSession, validateBody(updateSettingsSchema), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const existing = await dependencies.retrievalSettingsService.getForWorkspace(workspaceId);
      const settings = await dependencies.retrievalSettingsService.updateForWorkspace(workspaceId, {
        ...req.body,
        semanticRewriteInstructions: req.body.semanticRewriteInstructions ?? existing.semanticRewriteInstructions,
        lexicalRewriteInstructions: req.body.lexicalRewriteInstructions ?? existing.lexicalRewriteInstructions,
        answerSupportPolicy: req.body.answerSupportPolicy ?? existing.answerSupportPolicy,
        metadataRules: req.body.metadataRules ?? existing.metadataRules,
        customInstruction: req.body.customInstruction ?? existing.customInstruction,
      });
      const metadataFieldSuggestions = await dependencies.retrievalSettingsService.listMetadataFieldSuggestions(workspaceId);
      res.status(200).json({
        ...settings,
        metadataFieldSuggestions,
      });
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

  router.get("/general", workspaceSession, async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const workspace = await dependencies.workspaceRepository.findById(workspaceId);
      if (!workspace) {
        res.status(404).json({ code: "not_found", message: "Workspace not found" });
        return;
      }
      res.status(200).json({
        anonymousChatEnabled: workspace.anonymousChatEnabled,
        anonymousChatUrl: buildAnonymousChatUrl(workspace.anonymousChatToken, workspace.anonymousChatEnabled),
        anonymousRateLimit: workspace.anonymousRateLimit,
      });
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

      // Generate token on first enable (preserve across toggles)
      let token = workspace.anonymousChatToken;
      if (enabled && !token) {
        token = randomBytes(16).toString("base64url");
      }

      const updated = await dependencies.workspaceRepository.updateAnonymousChatSettings(
        workspaceId,
        enabled,
        token,
        rateLimit,
      );

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

      res.status(200).json({
        anonymousChatEnabled: updated.anonymousChatEnabled,
        anonymousChatUrl: buildAnonymousChatUrl(updated.anonymousChatToken, updated.anonymousChatEnabled),
        anonymousRateLimit: updated.anonymousRateLimit,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
