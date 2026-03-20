import { randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { requireApiToken } from "../middleware/requireApiToken.js";
import { validateBody } from "../middleware/validate.js";
import { chunkingStrategyIds } from "../../../modules/retrieval/domain/chunking/chunkingStrategy.js";
import {
  attributeControlModes,
  attributeFamilyIds,
} from "../../../modules/settings/domain/retrievalSettings.js";

const updateSettingsSchema = z.object({
  queryRewriteEnabled: z.boolean(),
  rerankEnabled: z.boolean(),
  vectorTopK: z.number().int(),
  similarityThreshold: z.number(),
  rerankTopK: z.number().int(),
  warmthLevel: z.number().int(),
  citationDisplayEnabled: z.boolean(),
  chunkingStrategy: z.enum(chunkingStrategyIds),
  attributeControls: z
    .array(
      z.object({
        family: z.enum(attributeFamilyIds),
        enabled: z.boolean(),
        mode: z.enum(attributeControlModes),
      }),
    )
    .optional(),
  customInstruction: z.string().max(2000).optional(),
  inferenceAnswerEnabled: z.boolean(),
});

export const createSettingsRoutes = (dependencies: AppDependencies): Router => {
  const router = Router();

  router.get("/retrieval", requireApiToken(dependencies), async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const settings = await dependencies.retrievalSettingsService.getForWorkspace(workspaceId);
      res.status(200).json(settings);
    } catch (error) {
      next(error);
    }
  });

  router.put("/retrieval", requireApiToken(dependencies), validateBody(updateSettingsSchema), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const existing = await dependencies.retrievalSettingsService.getForWorkspace(workspaceId);
      const settings = await dependencies.retrievalSettingsService.updateForWorkspace(workspaceId, {
        ...req.body,
        attributeControls: req.body.attributeControls ?? existing.attributeControls,
        customInstruction: req.body.customInstruction ?? existing.customInstruction,
      });
      res.status(200).json(settings);
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

  const updateGeneralSettingsSchema = z.object({
    anonymousChatEnabled: z.boolean().optional(),
    anonymousRateLimit: z.number().int().min(1).max(60).optional(),
  });

  router.get("/general", requireApiToken(dependencies), async (_req, res, next) => {
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

  router.put("/general", requireApiToken(dependencies), validateBody(updateGeneralSettingsSchema), async (req, res, next) => {
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
