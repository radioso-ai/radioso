import {
  ITEM_SELECTION_REFUSAL_CODES,
  type AssistantClientContextCapabilities,
  type ChatAnswerPort,
  type ChatDoorPickTurnPort,
  type ChatDoorTurnReply,
  type ConversationIngestPort,
} from "../../chat/contracts/index.js";
import type { ConnectorChatPort, ConnectorPersonKey, ConnectorReplyBlocksCapability } from "@radioso/connector-api";
import { channelPersonKeyId, type ChannelPersonKey, type ChannelPersonKeyKind } from "../../../shared/domain/channelPersonKey.js";
import { AppError, badRequest, isStructuredAppError } from "../../../shared/domain/errors.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import { connectorChatOutcome, connectorTurnResult } from "./connectorTurnFacts.js";
import { CONNECTOR_IMAGES_UNUSABLE_CODE, type ConnectorImageTurns } from "./connectorImageTurns.js";

/**
 * The code of the refusal `ConnectorChatPort.answer` raises for a pick that names no card the
 * conversation can pick, as the web chat refuses one: nothing is stored and no turn runs, and the
 * connector treats the tap as a message it does not support.
 */
export const CONNECTOR_PICK_REFUSED_CODE = "connector_pick_refused";

type ConnectorAnswer = Awaited<ReturnType<ConnectorChatPort["answer"]>>;

/** Whether a reply's pictures are stored, for a connector whose provider fetches them by address. */
interface ConnectorReplyPictures {
  awaitStored(input: { workspaceId: string; messageId: string; withinMs: number }): Promise<boolean>;
}

/** The capabilities a connector turn declares: the channel's reply blocks, or none. */
const capabilitiesFor = (replyBlocks: ConnectorReplyBlocksCapability | undefined): AssistantClientContextCapabilities | undefined => {
  const itemList = replyBlocks?.item_list;
  return itemList
    ? { "reply.blocks": { item_list: { layouts: [...itemList.layouts], ...(itemList.buttonLabels ? { buttonLabels: true } : {}) } } }
    : undefined;
};

/**
 * The person-key kind composition binds to the connector a port serves, so only the connector whose
 * provider attests a kind (WhatsApp's number) can run a turn as one.
 */
interface ConnectorPersonKeyBinding {
  connectorId?: string;
  personKeyKind?: ChannelPersonKeyKind | null;
  metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
}

/** Why a turn ran without the key its connector sent: bounded, and never the key itself. */
type UnusedPersonKeyReason = "not_attested" | "unreadable";

/**
 * The person key a connector's turn runs as, in the form its channel stores it. A connector bound to
 * no kind, or a key the host cannot read, runs the turn with no person key, as a channel that attests
 * none does: the customer is still answered. Each is counted, without the key.
 */
const channelPersonKeyFor = (
  binding: ConnectorPersonKeyBinding,
  personKey: ConnectorPersonKey | undefined,
): { channelPersonKey?: ChannelPersonKey } => {
  if (!personKey) return {};
  const unused = (reason: UnusedPersonKeyReason) => {
    binding.metrics?.incrementCounter("connector_person_keys_unused_total", {
      help: "Person keys a connector sent that its turn ran without, by connector and why: a connector bound to no person-key kind, or a key the host cannot read",
      labels: { connector: binding.connectorId ?? "unknown", reason },
    });
    return {};
  };
  if (!binding.personKeyKind) return unused("not_attested");
  const id = channelPersonKeyId(binding.personKeyKind, personKey.id);
  return id ? { channelPersonKey: { kind: binding.personKeyKind, id } } : unused("unreadable");
};

/** A turn's reply as a connector receives it: the blocks only when the reply carries any. */
const connectorAnswer = (reply: ChatDoorTurnReply & { conversationId: string }): ConnectorAnswer => ({
  conversationId: reply.conversationId,
  answer: reply.answer,
  outcome: connectorChatOutcome(reply.skillOutcome),
  ...(reply.blocks?.length && reply.assistantMessageId
    ? { replyBlocks: { messageId: reply.assistantMessageId, blocks: reply.blocks } }
    : {}),
});

const isPickRefusal = (error: unknown): boolean =>
  isStructuredAppError(error)
  && (error.code === ITEM_SELECTION_REFUSAL_CODES.invalid || error.code === ITEM_SELECTION_REFUSAL_CODES.alreadySelected);

const pickRefused = (): AppError =>
  new AppError(409, CONNECTOR_PICK_REFUSED_CODE, "The pick names no card this conversation can pick.", undefined, { isExpectedOutcome: true });

/**
 * The host side of a connector's chat port. `imageTurns` is where a turn with photos is stored,
 * read and run; a port built without it takes no photos, and refuses a turn that carries them.
 * `picks` is the chat door a card the customer picked runs through, and `replyPictures` tells
 * whether a reply's pictures are stored; a port built without them refuses every pick and answers
 * that pictures are ready. `personKeyKind` is the kind of person key the connector may attest; a port
 * bound to none runs every turn without one.
 */
export const createConnectorChatPort = (
  chatService: ChatAnswerPort,
  conversationIngest: ConversationIngestPort,
  options: ConnectorPersonKeyBinding & {
    imageTurns?: ConnectorImageTurns | null;
    picks?: ChatDoorPickTurnPort | null;
    replyPictures?: ConnectorReplyPictures | null;
  } = {},
): ConnectorChatPort => ({
  imageAllowance: async (input) => (options.imageTurns ? options.imageTurns.imageAllowance(input) : null),
  ingest: (input) => conversationIngest.ingest(input),
  awaitReplyPictures: async (input) => (options.replyPictures ? options.replyPictures.awaitStored(input) : true),
  answer: async (input) => {
    const clientContextCapabilities = capabilitiesFor(input.replyBlocks);
    const capabilities = clientContextCapabilities ? { clientContextCapabilities } : {};
    const person = channelPersonKeyFor(options, input.personKey);

    // A pick runs on the card the stored reply holds, through the same claim as the web chat's,
    // and is refused where the web chat's is: the card's words never run as typed text.
    if (input.selection) {
      if (!options.picks || !input.conversationId) {
        throw pickRefused();
      }
      try {
        const picked = await options.picks.answer({
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          conversationId: input.conversationId,
          message: input.query,
          stream: false,
          inputMetadata: { method: "item_select", selection: input.selection },
          sourceChannel: input.sourceChannel,
          channelContext: input.channelContext,
          ...person,
          ...capabilities,
        });
        if (!picked?.conversationId) {
          throw new Error("Chat turn returned no conversation");
        }
        return connectorAnswer({ ...picked, conversationId: picked.conversationId });
      } catch (error) {
        throw isPickRefusal(error) ? pickRefused() : error;
      }
    }

    const photos = input.images ?? [];
    if (photos.length > 0) {
      const { imageTurns } = options;
      if (!imageTurns) {
        throw badRequest("This connector does not take images");
      }
      const answered = await imageTurns.answer({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        conversationId: input.conversationId,
        query: input.query,
        images: photos,
        sourceChannel: input.sourceChannel,
        channelContext: input.channelContext,
        onImagesStored: input.onImagesStored,
        ...person,
        ...capabilities,
      });
      if (answered) {
        return connectorAnswer(answered);
      }
      // Every photo was refused: the turn is its text, or there is nothing to answer.
      if (input.query.trim().length === 0) {
        throw new AppError(422, CONNECTOR_IMAGES_UNUSABLE_CODE, "None of the images could be used and there is no text to answer");
      }
    }

    const response = await chatService.answer({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      conversationId: input.conversationId,
      query: input.query,
      stream: false,
      sourceChannel: input.sourceChannel,
      channelContext: input.channelContext,
      ...person,
      ...capabilities,
    });

    return connectorAnswer(response);
  },
  // `review` is the only mode a connector may ask for, so the turn always runs as a review.
  respond: async (input) => connectorTurnResult(await chatService.review({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    conversationId: input.conversationId,
    existingUserMessageId: input.respondToMessageId,
    historyWindow: input.historyWindow,
  })),
});
