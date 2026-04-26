import type { RetrievalInfo } from "../../retrieval/services/retrievalInfoPresenter.js";
import type {
  AssistantRoute,
  AssistantRouteDiagnostics,
  AssistantRouteReason,
} from "../types/assistantApi.js";

export class AssistantRouteService {
  conversationStartRoute(): AssistantRoute {
    return {
      type: "direct",
      reason: "conversation_start",
    };
  }

  fromRetrievalInfo(retrievalInfo: RetrievalInfo): AssistantRoute {
    if (retrievalInfo.retrievalSkipped) {
      return {
        type: "direct",
        reason: this.normalizeReason(retrievalInfo.responseIntent),
      };
    }

    return {
      type: "retrieval",
      reason: "evidence_required",
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

  private normalizeReason(value: unknown): AssistantRouteReason {
    return value === "assistant_identity" ? "assistant_identity" : "social_only";
  }
}
