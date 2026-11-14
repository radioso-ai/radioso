import { randomUUID } from "node:crypto";

import type { ConnectorImageAllowance, ConnectorInboundImage, ConnectorStoredImage } from "@radioso/connector-api";
import type { ConversationChannelContext } from "@radioso/conversation-contract";

import { AppError, badRequest, isStructuredAppError } from "../../../shared/domain/errors.js";
import type { AssistantClientContextCapabilities, ChatDoorPhotoTurnPort, ReplyBlock } from "../../chat/contracts/index.js";
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

/**
 * The code of the refusal `ConnectorChatPort.answer` raises when the agent no longer takes
 * photos, so a connector can treat the photos as messages it does not support, as it does when
 * `imageAllowance` is null.
 */
export const CONNECTOR_IMAGES_UNAVAILABLE_CODE = "visitor_images_unavailable";

const agentStoppedTakingImages = (): AppError =>
  new AppError(409, CONNECTOR_IMAGES_UNAVAILABLE_CODE, "This agent does not read images.");

/**
 * The code of the refusal `ConnectorChatPort.answer` raises when a receipt from an earlier attempt
 * can no longer be used: the host did not issue it, its photos belong to different owners, or a
 * message already carries a photo. The connector sends the photos' bytes instead.
 */
export const CONNECTOR_IMAGES_STALE_CODE = "visitor_images_stale";

const staleReceipts = (): AppError =>
  new AppError(409, CONNECTOR_IMAGES_STALE_CODE, "A stored image can no longer be used. Send the image again.");

/** The upload's own refusal when the module is decoding other photos; the same one the routes answer with. */
const moduleBusy = (): AppError =>
  new AppError(503, "visitor_image_busy", "Too many images are being processed right now. Try again in a moment.", undefined, { isExpectedOutcome: true });

/**
 * A receipt names a stored photo and the owner it was stored for, so a retry claims it as the
 * attempt that stored it would have. It is opaque to a connector, and never a credential: the door
 * still checks the photo is this workspace's, this agent's, this owner's and unclaimed.
 */
const RECEIPT_SHAPE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(.{1,200})$/i;
const encodeReceipt = (imageId: string, ownerId: string): string => `${imageId}:${ownerId}`;
const decodeReceipt = (receipt: string): { imageId: string; ownerId: string } | null => {
  const match = RECEIPT_SHAPE.exec(receipt);
  return match?.[1] && match[2] ? { imageId: match[1], ownerId: match[2] } : null;
};

/** The door's refusal of a claim: the id is unknown, already sent, or the agent takes no images now. */
const isDoorClaimRefusal = (error: unknown): boolean =>
  isStructuredAppError(error) && error.statusCode === 409 && error.code === "visitor_image_unavailable";

/**
 * What a turn with photos answered: the conversation it ran in, the host's reply outcome, and the
 * reply's blocks with the message that stored them, when the channel declared blocks.
 */
export interface ConnectorImageAnswer {
  readonly conversationId: string;
  readonly answer: string;
  readonly skillOutcome: string | undefined;
  readonly assistantMessageId?: string;
  readonly blocks?: ReplyBlock[];
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
   * reads photos, whether that shows before the upload or when the door claims the photos, and
   * `visitor_images_stale` (409) when a receipt can no longer be used. The upload's own refusals
   * pass as they are: `429 usage_limit_exceeded` over plan, and `503 visitor_image_busy` when the
   * module is decoding other photos, which a connector retries as it retries any failed turn.
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
    /** The reply blocks the channel draws, passed to the turn as it declares them. */
    clientContextCapabilities?: AssistantClientContextCapabilities;
    /** The photos stored just now, handed back before the turn runs, so a retry can reuse them. */
    onImagesStored?: (stored: readonly ConnectorStoredImage[]) => Promise<void>;
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
      // Receipts of an earlier attempt: each must be one the host issued, all for one owner.
      const receipts = input.images.map((image) => (image.receipt === undefined ? undefined : decodeReceipt(image.receipt)));
      const reused = receipts.filter((receipt) => receipt !== undefined);
      if (reused.some((receipt) => receipt === null) || new Set(reused.map((receipt) => receipt?.ownerId)).size > 1) {
        throw staleReceipts();
      }

      const agentId = await agentIdFor(input);
      if (await deps.availability.forAgent({ workspaceId: input.workspaceId, agentId }) !== "available") {
        throw agentStoppedTakingImages();
      }

      const owner: VisitorImageOwner = { kind: "connector_conversation", id: reused[0]?.ownerId ?? input.conversationId ?? randomUUID() };
      const settled = await Promise.allSettled(input.images.map(async (image) => (image.receipt === undefined
        ? deps.images.upload({
          workspaceId: input.workspaceId,
          agentId,
          owner,
          bytes: Buffer.from(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength),
          locale: null,
          surface: input.sourceChannel ?? "connector",
        })
        : undefined)));

      // Every upload has ended, so none runs on unobserved. The photos stored are kept and handed
      // back as receipts, whether or not another upload failed, so a retry does not pay for them again.
      const imageIds: string[] = [];
      const stored: ConnectorStoredImage[] = [];
      const failures: Error[] = [];
      let busy = false;
      settled.forEach((result, index) => {
        if (result.status === "rejected") {
          failures.push(result.reason instanceof Error ? result.reason : new Error("A photo could not be stored"));
        } else if (result.value === undefined) {
          imageIds.push(receipts[index]!.imageId);
        } else if (result.value.kind === "accepted") {
          imageIds.push(result.value.id);
          stored.push({ key: input.images[index].key, receipt: encodeReceipt(result.value.id, owner.id) });
        } else if (result.value.reason === "busy") {
          busy = true;
        }
      });
      if (stored.length > 0) {
        await input.onImagesStored?.(stored);
      }
      if (failures[0]) {
        throw failures[0];
      }
      if (busy) {
        throw moduleBusy();
      }
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
        ...(input.clientContextCapabilities ? { clientContextCapabilities: input.clientContextCapabilities } : {}),
        imageIds,
        imageOwner: owner,
      }).catch(async (error: unknown) => {
        if (!isDoorClaimRefusal(error)) {
          throw error;
        }
        // The door checks the agent takes photos again when it claims them, so a flag turned off
        // after the upload ends here. Otherwise a photo of an earlier attempt can no longer be
        // claimed (a message already carries it, or it was swept), and the connector sends it again.
        const stillTaken = await deps.availability.forAgent({ workspaceId: input.workspaceId, agentId }) === "available";
        throw reused.length > 0 && stillTaken ? staleReceipts() : agentStoppedTakingImages();
      });
      if (!response?.conversationId) {
        throw new Error("Chat turn returned no conversation");
      }
      return {
        conversationId: response.conversationId,
        answer: response.answer,
        skillOutcome: response.skillOutcome,
        ...(response.blocks?.length && response.assistantMessageId
          ? { assistantMessageId: response.assistantMessageId, blocks: response.blocks }
          : {}),
      };
    },
  };
};
