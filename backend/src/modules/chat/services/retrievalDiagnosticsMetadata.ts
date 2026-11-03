import type { RetrievalExecutionDiagnostics } from "../../retrieval/public.js";
import type { PreparedSession } from "./chatSessionPreparer.js";

/** The prepared turn's retrieval outcome as the routing trace stage records it: counts and statuses only. */
export const retrievalDiagnosticsMetadata = (
  session: PreparedSession,
): {
  route: PreparedSession["turnRoute"];
  contextCount: number;
  rewriteStatus?: RetrievalExecutionDiagnostics["rewriteStatus"];
  triggerStatus?: NonNullable<RetrievalExecutionDiagnostics["triggerAnalysis"]>["status"];
} => ({
  route: session.turnRoute,
  contextCount: session.retrieval.contexts.length,
  rewriteStatus: session.retrieval.diagnostics.rewriteStatus,
  triggerStatus: session.retrieval.diagnostics.triggerAnalysis?.status,
});
