import {
  RESPONSE_INTENT,
  type ResponseIntent,
} from "../../retrieval/public.js";

export const CHAT_TURN_ROUTE = {
  RETRIEVAL: "retrieval",
  SOCIAL_ONLY: "social_only",
  ASSISTANT_IDENTITY: "assistant_identity",
} as const;

export type ChatTurnRoute = (typeof CHAT_TURN_ROUTE)[keyof typeof CHAT_TURN_ROUTE];

export class ChatTurnIntentService {
  resolve(input: { responseIntent?: ResponseIntent }): ChatTurnRoute {
    switch (input.responseIntent) {
      case RESPONSE_INTENT.SOCIAL_ONLY:
        return CHAT_TURN_ROUTE.SOCIAL_ONLY;
      case RESPONSE_INTENT.ASSISTANT_IDENTITY:
        return CHAT_TURN_ROUTE.ASSISTANT_IDENTITY;
      case RESPONSE_INTENT.RETRIEVAL:
      default:
        return CHAT_TURN_ROUTE.RETRIEVAL;
    }
  }
}
