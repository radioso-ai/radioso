import type {
  AssistantRoute,
  AssistantRouteDiagnostics,
} from "../types/assistantApi.js";

export class AssistantRouteService {
  conversationStartRoute(): AssistantRoute {
    return {
      type: "direct",
      reason: "conversation_start",
    };
  }

  toDiagnostics(route: AssistantRoute): AssistantRouteDiagnostics {
    return {
      generator: "assistant",
      routeType: route.type,
      routeReason: route.reason,
      retrievalInvoked: route.type === "retrieval",
    };
  }
}
