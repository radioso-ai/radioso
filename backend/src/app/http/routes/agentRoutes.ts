import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { validateBody } from "../middleware/validate.js";
import { badRequest } from "../../../shared/domain/errors.js";
import {
  agentSurfacePositions,
} from "../../../modules/agents/public.js";
import {
  ASSISTANT_LOGO_MAX_BYTES,
  ASSISTANT_LOGO_MIME_TYPES,
  assistantThemeSchema,
} from "../shared/assistantIdentity.js";

const agentParamsSchema = z.object({
  agentId: z.string().uuid(),
});

const surfaceSettingsSchema = z.object({
  authenticatedChat: z.object({
    enabled: z.boolean().optional(),
  }).optional(),
  anonymousChat: z.object({
    enabled: z.boolean().optional(),
  }).optional(),
  websiteEmbed: z.object({
    enabled: z.boolean().optional(),
    allowedOrigins: z.array(z.string().max(200)).max(20).optional(),
    launcherLabel: z.string().max(80).optional(),
    launcherPosition: z.enum(agentSurfacePositions).optional(),
    theme: assistantThemeSchema.optional(),
    copy: z.record(z.record(z.string().max(500))).optional(),
    expertOverrides: z.record(z.string().max(500)).optional(),
  }).optional(),
}).optional();

const agentBodySchema = z.object({
  name: z.string().max(200).optional(),
  customInstruction: z.string().max(2000).optional(),
  suggestedQuestionsEnabled: z.boolean().optional(),
  theme: assistantThemeSchema.optional(),
  retrievalEnabled: z.boolean().optional(),
  greetingInstruction: z.string().max(200).optional(),
  assistantDefaultLocale: z.string().max(35).nullable().optional(),
  proactiveGreetingEnabled: z.boolean().optional(),
  surfaceSettings: surfaceSettingsSchema,
});

type AgentRouteDependencies = WorkspaceSessionDependencies & Pick<AppDependencies, "agentService" | "documentStorage" | "logger">;

export const createAgentRoutes = (dependencies: AgentRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: ASSISTANT_LOGO_MAX_BYTES,
    },
  });

  const runUploadSingle = (req: Request, res: Response) =>
    new Promise<void>((resolve, reject) => {
      upload.single("logo")(req, res, (error) => {
        if (!error) {
          resolve();
          return;
        }
        if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
          reject(badRequest("Uploaded assistant logo exceeds maximum size"));
          return;
        }
        reject(error);
      });
    });

  router.get("/", workspaceSession, async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      res.status(200).json({ agents: await dependencies.agentService.list(workspaceId) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", workspaceSession, validateBody(agentBodySchema), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const agent = await dependencies.agentService.create(workspaceId, req.body);
      res.status(201).json(agent);
    } catch (error) {
      next(error);
    }
  });

  router.get("/:agentId", workspaceSession, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsed = agentParamsSchema.parse(req.params);
      const agent = await dependencies.agentService.get(workspaceId, parsed.agentId);
      res.status(200).json(agent);
    } catch (error) {
      next(error);
    }
  });

  router.put("/:agentId", workspaceSession, validateBody(agentBodySchema), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsed = agentParamsSchema.parse(req.params);
      const current = await dependencies.agentService.resolve(workspaceId, parsed.agentId);
      const agent = await dependencies.agentService.update(
        workspaceId,
        parsed.agentId,
        dependencies.agentService.withRotatedTokens(current, req.body),
      );
      res.status(200).json(agent);
    } catch (error) {
      next(error);
    }
  });

  router.post("/:agentId/assistant-logo", workspaceSession, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsed = agentParamsSchema.parse(req.params);
      const current = await dependencies.agentService.resolve(workspaceId, parsed.agentId);
      await runUploadSingle(req, res);
      if (!req.file) {
        throw badRequest("Logo file is required");
      }
      if (!ASSISTANT_LOGO_MIME_TYPES.has(req.file.mimetype)) {
        throw badRequest("Assistant logo must be a PNG, JPEG, WebP, or GIF image");
      }

      const stored = await dependencies.documentStorage.upload({
        workspaceId,
        documentId: `assistant-logo-${parsed.agentId}-${randomUUID()}`,
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
      const agent = await dependencies.agentService.update(workspaceId, parsed.agentId, {
        logo: uploadedLogo,
      }).catch(async (error: unknown) => {
        await dependencies.documentStorage.delete({
          bucket: uploadedLogo.bucket,
          objectPath: uploadedLogo.objectPath,
          generation: uploadedLogo.generation,
        }).catch((cleanupError: unknown) => {
          dependencies.logger.warn({ err: cleanupError, workspaceId, agentId: parsed.agentId }, "Failed to clean up orphaned assistant logo upload");
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
          dependencies.logger.warn({ err: error, workspaceId, agentId: parsed.agentId }, "Failed to delete replaced assistant logo");
        });
      }
      res.status(200).json(agent);
    } catch (error) {
      next(error);
    }
  });

  router.delete("/:agentId/assistant-logo", workspaceSession, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsed = agentParamsSchema.parse(req.params);
      const current = await dependencies.agentService.resolve(workspaceId, parsed.agentId);
      const agent = await dependencies.agentService.update(workspaceId, parsed.agentId, {
        logo: null,
      });
      const previousLogo = current.logo;
      if (previousLogo) {
        await dependencies.documentStorage.delete({
          bucket: previousLogo.bucket,
          objectPath: previousLogo.objectPath,
          generation: previousLogo.generation ?? null,
        }).catch((error: unknown) => {
          dependencies.logger.warn({ err: error, workspaceId, agentId: parsed.agentId }, "Failed to delete removed assistant logo");
        });
      }
      res.status(200).json(agent);
    } catch (error) {
      next(error);
    }
  });

  router.post("/:agentId/anonymous-chat-token/rotate", workspaceSession, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsed = agentParamsSchema.parse(req.params);
      const current = await dependencies.agentService.resolve(workspaceId, parsed.agentId);
      const agent = await dependencies.agentService.update(
        workspaceId,
        parsed.agentId,
        dependencies.agentService.withRotatedTokens(current, { rotateAnonymousChatToken: true }),
      );
      res.status(200).json(agent);
    } catch (error) {
      next(error);
    }
  });

  router.post("/:agentId/website-embed-token/rotate", workspaceSession, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsed = agentParamsSchema.parse(req.params);
      const current = await dependencies.agentService.resolve(workspaceId, parsed.agentId);
      const agent = await dependencies.agentService.update(
        workspaceId,
        parsed.agentId,
        dependencies.agentService.withRotatedTokens(current, { rotateWebsiteEmbedToken: true }),
      );
      res.status(200).json(agent);
    } catch (error) {
      next(error);
    }
  });

  router.post("/:agentId/default", workspaceSession, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsed = agentParamsSchema.parse(req.params);
      const agent = await dependencies.agentService.setDefault(workspaceId, parsed.agentId);
      res.status(200).json(agent);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
