import { createHmac, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { sendChatJson, sendChatSse } from "../presenters/chatPresenter.js";
import { requireWorkspaceSession } from "../middleware/requireWorkspaceSession.js";
import { validateBody } from "../middleware/validate.js";
import { badRequest, forbidden, serviceUnavailable } from "../../../shared/domain/errors.js";
import { assertInteractiveAssistantWorkflow } from "../../../modules/chat/services/chatExecutionPolicy.js";

const MAX_COLLECTION_PAGE_LIMIT = 100;
const DEFAULT_COLLECTION_PAGE_LIMIT = 50;
const DEFAULT_MESSAGE_WINDOW_LIMIT = 50;
const SOURCE_CHANNEL_HEADER = "x-radioso-source-channel";
const SOURCE_ORIGIN_HEADER = "x-radioso-source-origin";
const SOURCE_SIGNATURE_HEADER = "x-radioso-source-signature";
const SOURCE_TIMESTAMP_HEADER = "x-radioso-source-timestamp";
const MCP_SOURCE_MAX_SKEW_MS = 5 * 60 * 1000;

const localeHintSchema = z.string().trim().max(35);
const trustedSourceChannelSchema = z.enum(["mcp"]);
const trustedSourceOriginSchema = z.string().trim().min(1).max(120);
const trustedSourceSignatureSchema = z.string().trim().regex(/^[0-9a-f]{64}$/i);
const trustedSourceTimestampSchema = z.string().trim().regex(/^\d{13}$/);
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

const safeCompare = (provided: string, expected: string): boolean => {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
};

const signTrustedSource = (secret: string, input: {
  bearerToken: string;
  channel: "mcp";
  origin: string | null;
  timestamp: string;
}): string =>
  createHmac("sha256", secret)
    .update(`${input.channel}\n${input.origin ?? ""}\n${input.timestamp}\n${input.bearerToken}`)
    .digest("hex");

const resolveTrustedChatSource = (
  req: Request,
  res: Response,
  dependencies: Pick<AppDependencies, "env">,
): {
  sourceChannel?: "mcp";
  sourceOrigin?: string | null;
} => {
  const authMode = (res.locals as { authMode?: string }).authMode;
  const bearerToken = (res.locals as { bearerToken?: string }).bearerToken;
  const rawChannel = req.header(SOURCE_CHANNEL_HEADER)?.trim();
  const rawOrigin = req.header(SOURCE_ORIGIN_HEADER)?.trim();
  const rawSignature = req.header(SOURCE_SIGNATURE_HEADER)?.trim();
  const rawTimestamp = req.header(SOURCE_TIMESTAMP_HEADER)?.trim();

  if (
    (!rawChannel || rawChannel.length === 0) &&
    (!rawOrigin || rawOrigin.length === 0) &&
    (!rawSignature || rawSignature.length === 0) &&
    (!rawTimestamp || rawTimestamp.length === 0)
  ) {
    return {};
  }

  if (authMode !== "bearer") {
    throw badRequest("Trusted source headers are only supported for bearer-authenticated chat requests.");
  }

  if (!bearerToken) {
    throw badRequest("Trusted source headers require a bearer-authenticated workspace token.");
  }

  if (!rawChannel) {
    throw badRequest(`${SOURCE_CHANNEL_HEADER} is required when trusted source headers are provided.`);
  }

  const sourceChannelResult = trustedSourceChannelSchema.safeParse(rawChannel);
  if (!sourceChannelResult.success) {
    throw badRequest(`${SOURCE_CHANNEL_HEADER} is invalid.`, sourceChannelResult.error.flatten());
  }

  const sourceOriginResult = rawOrigin ? trustedSourceOriginSchema.safeParse(rawOrigin) : { success: true, data: null } as const;
  if (!sourceOriginResult.success) {
    throw badRequest(`${SOURCE_ORIGIN_HEADER} is invalid.`, sourceOriginResult.error.flatten());
  }

  const sourceChannel = sourceChannelResult.data;
  const sourceOrigin = sourceOriginResult.data;

  if (sourceChannel === "mcp") {
    if (!rawTimestamp) {
      throw badRequest(`${SOURCE_TIMESTAMP_HEADER} is required when ${SOURCE_CHANNEL_HEADER} is ${sourceChannel}.`);
    }

    if (!rawSignature) {
      throw badRequest(`${SOURCE_SIGNATURE_HEADER} is required when ${SOURCE_CHANNEL_HEADER} is ${sourceChannel}.`);
    }

    const sourceTimestampResult = trustedSourceTimestampSchema.safeParse(rawTimestamp);
    if (!sourceTimestampResult.success) {
      throw badRequest(`${SOURCE_TIMESTAMP_HEADER} is invalid.`, sourceTimestampResult.error.flatten());
    }

    const sourceSignatureResult = trustedSourceSignatureSchema.safeParse(rawSignature);
    if (!sourceSignatureResult.success) {
      throw badRequest(`${SOURCE_SIGNATURE_HEADER} is invalid.`, sourceSignatureResult.error.flatten());
    }

    const mcpSigningSecret = dependencies.env.RADIOSO_MCP_SIGNING_SECRET;
    if (!mcpSigningSecret) {
      throw serviceUnavailable("MCP source verification is not configured.", {
        missingEnv: "RADIOSO_MCP_SIGNING_SECRET",
      });
    }

    const requestTimestamp = Number(sourceTimestampResult.data);
    if (!Number.isSafeInteger(requestTimestamp) || Math.abs(Date.now() - requestTimestamp) > MCP_SOURCE_MAX_SKEW_MS) {
      throw forbidden("This MCP source claim has expired.");
    }

    const expectedSignature = signTrustedSource(mcpSigningSecret, {
      bearerToken,
      channel: sourceChannel,
      origin: sourceOrigin,
      timestamp: sourceTimestampResult.data,
    });
    if (!safeCompare(sourceSignatureResult.data, expectedSignature)) {
      throw forbidden("This MCP source claim could not be verified.");
    }
  }

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
      const { sourceChannel, sourceOrigin } = resolveTrustedChatSource(req, res, dependencies);
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
