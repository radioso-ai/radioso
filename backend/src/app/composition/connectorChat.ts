import type { ConnectorChatPort } from "@radioso/connector-api";

import { ReplyPictureReadiness } from "../../modules/chat/composition.js";
import { WHATSAPP_CONNECTOR_ID } from "../../modules/connectors/plugins/index.js";
import { createConnectorChatPort, createConnectorImageTurns } from "../../modules/connectors/services/public.js";
import { DOCUMENT_IMAGE_RENDITION_WIDTHS } from "../../modules/documents/contracts/index.js";
import type { ChannelPersonKeyKind } from "../../shared/domain/channelPersonKey.js";
import type { AppDependencies } from "../server/types.js";

/**
 * The person-key kind each connector's provider attests, by connector id: only the WhatsApp
 * connector, whose webhook Meta signs, may run a turn as a WhatsApp number.
 */
const ATTESTED_PERSON_KEY_KINDS: Readonly<Partial<Record<string, ChannelPersonKeyKind>>> = {
  [WHATSAPP_CONNECTOR_ID]: "whatsapp_contact",
};

/**
 * The chat port the connector registry hands the plugin `connectorId`. A turn with photos and a
 * picked card go through the chat door, which claims, renders and binds photos and reads a pick from
 * its stored reply; a reply's pictures are checked through the lookup the image route serves by, at
 * the width the presented cards show. A person key the plugin sends is read as the kind bound to it.
 */
export const composeConnectorChatPort = (
  dependencies: Pick<
    AppDependencies,
    | "chatService"
    | "conversationIngestService"
    | "agentService"
    | "conversationRepository"
    | "visitorImageAvailability"
    | "visitorImages"
    | "assistantChatService"
    | "messageRepository"
    | "replyImageObjectLookup"
    | "metricsRegistry"
  >,
  connectorId: string,
): ConnectorChatPort =>
  createConnectorChatPort(dependencies.chatService, dependencies.conversationIngestService, {
    connectorId,
    personKeyKind: ATTESTED_PERSON_KEY_KINDS[connectorId] ?? null,
    metrics: dependencies.metricsRegistry,
    imageTurns: createConnectorImageTurns({
      agents: dependencies.agentService,
      conversations: dependencies.conversationRepository,
      availability: dependencies.visitorImageAvailability,
      images: dependencies.visitorImages,
      door: dependencies.assistantChatService,
    }),
    picks: dependencies.assistantChatService,
    replyPictures: new ReplyPictureReadiness({
      messages: dependencies.messageRepository,
      pictures: dependencies.replyImageObjectLookup,
      width: Math.max(...DOCUMENT_IMAGE_RENDITION_WIDTHS),
    }),
  });
