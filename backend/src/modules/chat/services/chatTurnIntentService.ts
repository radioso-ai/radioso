import {
  RESPONSE_INTENT,
  type ResponseIntent,
} from "../../retrieval/domain/retrievalPipelineTypes.js";

export const CHAT_TURN_ROUTE = {
  RETRIEVAL: "retrieval",
  SOCIAL_ONLY: "social_only",
  ASSISTANT_IDENTITY: "assistant_identity",
} as const;

export type ChatTurnRoute = (typeof CHAT_TURN_ROUTE)[keyof typeof CHAT_TURN_ROUTE];

export interface ChatTurnIntentDecision {
  route: ChatTurnRoute;
  retrievalRequired: boolean;
}

export class ChatTurnIntentService {
  resolve(input: { responseIntent?: ResponseIntent }): ChatTurnIntentDecision {
    switch (input.responseIntent) {
      case RESPONSE_INTENT.SOCIAL_ONLY:
        return {
          route: CHAT_TURN_ROUTE.SOCIAL_ONLY,
          retrievalRequired: false,
        };
      case RESPONSE_INTENT.ASSISTANT_IDENTITY:
        return {
          route: CHAT_TURN_ROUTE.ASSISTANT_IDENTITY,
          retrievalRequired: false,
        };
      case RESPONSE_INTENT.RETRIEVAL:
      default:
        return {
          route: CHAT_TURN_ROUTE.RETRIEVAL,
          retrievalRequired: true,
        };
    }
  }
}
