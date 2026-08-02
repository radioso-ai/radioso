import type { GroundingDiagnosticSnapshot } from "../../../shared/domain/groundingDiagnostic.js";

import type {
  LowQualityTurnsPage,
  QualityResolutionReasonOrUnspecified,
  QualityTriageState,
  QualityVerification,
} from "./index.js";

export interface QualityContentPlanningWindow {
  /** Inclusive frozen boundary. */
  from: string;
  /** Exclusive frozen boundary. */
  to: string;
}

export interface QualityContentPlanningPopulationCursor {
  createdAt: string;
  assistantMessageId: string;
  windowFrom: string;
  windowTo: string;
}

export interface QualityContentPlanningPopulationTurn {
  assistantMessageId: string;
  userMessageId: string | null;
  conversationId: string;
  agentId: string | null;
  channel: string | null;
  createdAt: string;
}

export interface QualityContentPlanningPopulationPage {
  items: QualityContentPlanningPopulationTurn[];
  nextCursor: QualityContentPlanningPopulationCursor | null;
}

export type QualityContentPlanningRemediationInactivityReason =
  | "grounded_answer"
  | "not_evaluated"
  | "triage_resolved"
  | "triage_dismissed"
  | "passing_eval";

export interface QualityContentPlanningTurnEvidence {
  assistantMessageId: string;
  conversationId: string;
  agentId: string | null;
  channel: string | null;
  createdAt: string;
  grounding: GroundingDiagnosticSnapshot | null;
  triage: {
    state: QualityTriageState;
    resolutionReason: QualityResolutionReasonOrUnspecified | null;
    reopenedByNewerNegativeFeedback: boolean;
  };
  verification: QualityVerification | null;
  remediation: {
    active: boolean;
    inactiveReasons: QualityContentPlanningRemediationInactivityReason[];
  };
}

export interface QualityContentPlanningEvidenceSourcePort {
  countPopulation(
    workspaceId: string,
    input: { window: QualityContentPlanningWindow },
  ): Promise<number>;
  listPopulationPage(
    workspaceId: string,
    input: {
      window: QualityContentPlanningWindow;
      cursor?: QualityContentPlanningPopulationCursor;
      limit: number;
    },
  ): Promise<QualityContentPlanningPopulationPage>;
  getEvidenceByAssistantMessageIds(
    workspaceId: string,
    assistantMessageIds: string[],
  ): Promise<ReadonlyMap<string, QualityContentPlanningTurnEvidence>>;
  mapMemberTurnPage(
    workspaceId: string,
    input: {
      assistantMessageIds: string[];
      total: number;
      page: number;
      pageSize: number;
    },
  ): Promise<LowQualityTurnsPage>;
}
