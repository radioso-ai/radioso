import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { sendChatJson, sendChatSse } from "../presenters/chatPresenter.js";
import { requireWorkspaceSession } from "../middleware/requireWorkspaceSession.js";
import { validateBody } from "../middleware/validate.js";
import { badRequest } from "../../../shared/domain/errors.js";
import { assertInteractiveAssistantWorkflow } from "../../../modules/chat/services/chatExecutionPolicy.js";

const MAX_COLLECTION_PAGE_LIMIT = 100;
const DEFAULT_COLLECTION_PAGE_LIMIT = 50;
const DEFAULT_MESSAGE_WINDOW_LIMIT = 50;
const SOURCE_CHANNEL_HEADER = "x-radioso-source-channel";
const SOURCE_ORIGIN_HEADER = "x-radioso-source-origin";

const localeHintSchema = z.string().trim().max(35);
const trustedSourceChannelSchema = z.enum(["mcp"]);
const trustedSourceOriginSchema = z.string().trim().min(1).max(120);
const userInputMetadataSchema = z.object({
  method: z.enum(["typed", "suggestion_click"]),
  suggestionSourceMessageId: z.string().uuid().optional(),
}).superRefine((value, ctx) => {
  if (value.method === "suggestion_click" && !value.suggestionSourceMessageId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "suggestionSourceMessageId is required for suggestion_click",
      path: ["suggestionSourceMessageId"],
    });
  }
});

export const chatSchema = z.object({
  query: z.string().min(1).optional(),
  stream: z.boolean(),
  conversationId: z.string().uuid().optional(),
  bootstrapGreeting: z.boolean().optional(),
  userExpectedLocale: localeHintSchema.optional(),
  inputMetadata: userInputMetadataSchema.optional(),
  metadataFilter: z.record(z.unknown()).optional().refine(
    (val) => !val || Buffer.byteLength(JSON.stringify(val), "utf8") <= 16384,
    { message: "Metadata filter must be 16 KB or less" },
  ),
}).superRefine((value, ctx) => {
  if (!value.query && !value.bootstrapGreeting) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "query is required unless bootstrapGreeting is true",
      path: ["query"],
    });
  }
  if (value.bootstrapGreeting && value.conversationId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "bootstrapGreeting may only be used for brand-new conversations",
      path: ["conversationId"],
    });
  }
});

export const conversationParamsSchema = z.object({
  conversationId: z.string().uuid(),
});

export const collectionPageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_COLLECTION_PAGE_LIMIT).default(DEFAULT_COLLECTION_PAGE_LIMIT),
  offset: z.coerce.number().int().min(0).optional(),
  cursor: z.string().min(1).optional(),
});

export const conversationWindowQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_COLLECTION_PAGE_LIMIT).default(DEFAULT_MESSAGE_WINDOW_LIMIT),
  offset: z.coerce.number().int().min(0).optional(),
  cursor: z.string().min(1).optional(),
});

const resolveTrustedChatSource = (
  req: Request,
  res: Response,
): {
  sourceChannel?: "mcp";
  sourceOrigin?: string | null;
} => {
  const authMode = (res.locals as { authMode?: string }).authMode;
  const rawChannel = req.header(SOURCE_CHANNEL_HEADER)?.trim();
  const rawOrigin = req.header(SOURCE_ORIGIN_HEADER)?.trim();

  if ((!rawChannel || rawChannel.length === 0) && (!rawOrigin || rawOrigin.length === 0)) {
    return {};
  }

  if (authMode !== "bearer") {
    return {};
  }

  if (!rawChannel) {
    throw badRequest(`${SOURCE_CHANNEL_HEADER} is required when ${SOURCE_ORIGIN_HEADER} is set.`);
  }

  const sourceChannel = trustedSourceChannelSchema.parse(rawChannel);
  const sourceOrigin = rawOrigin ? trustedSourceOriginSchema.parse(rawOrigin) : null;

  return {
    sourceChannel,
    sourceOrigin,
  };
};

export const createChatRoutes = (dependencies: AppDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);

  router.get("/history", workspaceSession, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsedQuery = collectionPageQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        next(badRequest("Invalid request query", parsedQuery.error.flatten()));
        return;
      }
      const page = await dependencies.chatHistoryService.listConversations(workspaceId, parsedQuery.data);
      res.status(200).json(page);
    } catch (error) {
      next(error);
    }
  });

  router.get("/history/:conversationId", workspaceSession, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsedParams = conversationParamsSchema.safeParse(req.params);
      if (!parsedParams.success) {
        next(badRequest("Invalid request params", parsedParams.error.flatten()));
        return;
      }
      const parsedQuery = conversationWindowQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        next(badRequest("Invalid request query", parsedQuery.error.flatten()));
        return;
      }
      const { conversationId } = parsedParams.data;
      const conversation = await dependencies.chatHistoryService.getConversation(
        workspaceId,
        conversationId,
        parsedQuery.data,
      );
      res.status(200).json(conversation);
    } catch (error) {
      next(error);
    }
  });

  router.post("/", workspaceSession, validateBody(chatSchema), async (req, res, next) => {
    try {
      const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId: string };
      const { sourceChannel, sourceOrigin } = resolveTrustedChatSource(req, res);
      if (req.body.bootstrapGreeting) {
        assertInteractiveAssistantWorkflow("chat.bootstrap");
        const bootstrap = await dependencies.chatBootstrapService.startConversation({
          workspaceId,
          accountId,
          sourceChannel,
          sourceOrigin,
          userExpectedLocale: req.body.userExpectedLocale,
        });
        if (!bootstrap) {
          res.status(204).end();
          return;
        }
        sendChatJson(res, bootstrap);
        return;
      }
      if (req.body.stream) {
        assertInteractiveAssistantWorkflow("chat.turn");
        await sendChatSse(
          res,
          dependencies.chatService.streamAnswer({
            workspaceId,
            accountId,
            query: req.body.query!,
            stream: req.body.stream,
            conversationId: req.body.conversationId,
            inputMetadata: req.body.inputMetadata,
            metadataFilter: req.body.metadataFilter,
            sourceChannel,
            sourceOrigin,
          }),
        );
        return;
      }

      assertInteractiveAssistantWorkflow("chat.turn");
      const result = await dependencies.chatService.answer({
        workspaceId,
        accountId,
        query: req.body.query!,
        stream: req.body.stream,
        conversationId: req.body.conversationId,
        inputMetadata: req.body.inputMetadata,
        metadataFilter: req.body.metadataFilter,
        sourceChannel,
        sourceOrigin,
      });
      sendChatJson(res, result);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
