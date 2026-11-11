import { randomUUID } from "node:crypto";

import type { ConnectorImageAllowance, ConnectorInboundImage } from "@radioso/connector-api";
import type { ConversationChannelContext } from "@radioso/conversation-contract";

import { AppError, badRequest } from "../../../shared/domain/errors.js";
import type { ChatDoorPhotoTurnPort } from "../../chat/contracts/index.js";
import {
  VISITOR_IMAGE_LIMITS,
  type VisitorImageAvailability,
  type VisitorImageOwner,
  type VisitorImageService,
} from "../../visitorImages/public.js";

/**
 * The code of the refusal `ConnectorChatPort.answer` raises when every photo of a turn was
 * refused and the sender typed nothing, so a connector can treat the message as one it does not
 * support rather than as a failure.
 */
export const CONNECTOR_IMAGES_UNUSABLE_CODE = "visitor_images_unusable";

/** What a turn with photos answered: the conversation it ran in and the host's reply outcome. */
export interface ConnectorImageAnswer {
  readonly conversationId: string;
  readonly answer: string;
  readonly skillOutcome: string | undefined;
}

/**
 * What a connector turn with photos needs from the host, in the shape `createConnectorChatPort`
 * consumes. The photos are the visitor-image module's and the turn runs through the chat door, so
 * a connector's photos are read, put into the turn, stored with the message and erased exactly as
 * the web chat's are.
 */
export interface ConnectorImageTurns {
  imageAllowance(input: { workspaceId: string; agentId?: string; conversationId?: string }): Promise<ConnectorImageAllowance | null>;
  /**
   * Stores and reads each photo, then runs the turn on the text and the photos. Null, with no turn
   * run, when the module refused every photo (not an image, too many pixels), so the caller can
   * answer the text alone. Throws `visitor_images_unavailable` (409) when the agent no longer
   * reads photos.
   */
  answer(input: {
    workspaceId: string;
    agentId?: string;
    conversationId?: string;
    /** What the sender typed with the photos; may be empty. */
    query: string;
    images: readonly ConnectorInboundImage[];
    /** The channel the photos came through (`whatsapp`), for usage attribution and the turn's source. */
    sourceChannel?: string | null;
    channelContext?: ConversationChannelContext | null;
  }): Promise<ConnectorImageAnswer | null>;
}

type AgentResolver = { resolve(workspaceId: string, agentId?: string | null): Promise<{ id: string }> };
type ConversationAgentLookup = {
  findByIdAndWorkspaceId(conversationId: string, workspaceId: string): Promise<{ agentId: string | null } | null>;
};

/**
 * Photos on a connector's turns. The agent a turn runs on is the one its chat session resolves:
 * the caller's, else the conversation's, else the workspace's default. Photos are taken when that
 * agent has them on and its chat model reads them, the same test the web chat applies.
 *
 * The owner is the connector's conversation. A first turn has no conversation yet, so its photos
 * are owned by an id of their own, and the door binds them to the conversation the turn creates;
 * the owner is a check that an upload and its send agree, never a credential.
 */
export const createConnectorImageTurns = (deps: {
  agents: AgentResolver;
  conversations: ConversationAgentLookup;
  availability: VisitorImageAvailability;
  images: Pick<VisitorImageService, "upload">;
  door: ChatDoorPhotoTurnPort;
}): ConnectorImageTurns => {
  const agentIdFor = async (input: { workspaceId: string; agentId?: string; conversationId?: string }): Promise<string> => {
    const conversationAgentId = !input.agentId && input.conversationId
      ? (await deps.conversations.findByIdAndWorkspaceId(input.conversationId, input.workspaceId))?.agentId ?? null
      : null;
    return (await deps.agents.resolve(input.workspaceId, input.agentId ?? conversationAgentId)).id;
  };

  return {
    imageAllowance: async (input) => {
      const agentId = await agentIdFor(input);
      const availability = await deps.availability.forAgent({ workspaceId: input.workspaceId, agentId });
      return availability === "available" ? { maxImages: VISITOR_IMAGE_LIMITS.maxImagesPerMessage } : null;
    },

    answer: async (input) => {
      if (input.images.length > VISITOR_IMAGE_LIMITS.maxImagesPerMessage) {
        throw badRequest(`A message carries at most ${VISITOR_IMAGE_LIMITS.maxImagesPerMessage} images`);
      }
      const agentId = await agentIdFor(input);
      if (await deps.availability.forAgent({ workspaceId: input.workspaceId, agentId }) !== "available") {
        throw new AppError(409, "visitor_images_unavailable", "This agent does not read images.");
      }

      const owner: VisitorImageOwner = { kind: "connector_conversation", id: input.conversationId ?? randomUUID() };
      const uploads = await Promise.all(input.images.map((image) => deps.images.upload({
        workspaceId: input.workspaceId,
        agentId,
        owner,
        bytes: Buffer.from(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength),
        locale: null,
        surface: input.sourceChannel ?? "connector",
      })));
      const imageIds = uploads.flatMap((upload) => (upload.kind === "accepted" ? [upload.id] : []));
      if (imageIds.length === 0) {
        return null;
      }

      const response = await deps.door.answer({
        workspaceId: input.workspaceId,
        agentId,
        conversationId: input.conversationId,
        message: input.query,
        stream: false,
        sourceChannel: input.sourceChannel,
        channelContext: input.channelContext,
        imageIds,
        imageOwner: owner,
      });
      if (!response?.conversationId) {
        throw new Error("Chat turn returned no conversation");
      }
      return { conversationId: response.conversationId, answer: response.answer, skillOutcome: response.skillOutcome };
    },
  };
};
