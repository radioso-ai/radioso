import type { ConnectorChatPort } from "@radioso/connector-api";

import { ReplyPictureReadiness } from "../../modules/chat/composition.js";
import { createConnectorChatPort, createConnectorImageTurns } from "../../modules/connectors/services/public.js";
import { DOCUMENT_IMAGE_RENDITION_WIDTHS } from "../../modules/documents/contracts/index.js";
import type { AppDependencies } from "../server/types.js";

/**
 * The chat port the connector registry hands every plugin. A turn with photos and a picked card go
 * through the chat door, which claims, renders and binds photos and reads a pick from its stored
 * reply; a reply's pictures are checked through the lookup the image route serves by, at the width
 * the presented cards show.
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
  >,
): ConnectorChatPort =>
  createConnectorChatPort(dependencies.chatService, dependencies.conversationIngestService, {
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
