import {
  RESPONSE_INTENT,
  type ResponseIntent,
} from "../../retrieval/public.js";
import { CHAT_TURN_ROUTE, type ChatTurnRoute } from "../../../shared/domain/chatTurnRoute.js";

export { CHAT_TURN_ROUTE, type ChatTurnRoute };

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
