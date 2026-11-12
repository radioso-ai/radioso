import type { RoutineConsentCommitted, RoutineConsentWritten } from "../../../shared/domain/routineConsentTurn.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";

const ROUTINE_CONSENT_OUTCOMES_TOTAL = "routine_consent_outcomes_total";
const OUTCOMES_HELP = "Routine consents by outcome: asked, granted, declined, defaulted to declined, not asked, or withdrawn.";

/** What a committed withdrawal reports (#1544): ids, keys and a count, never the wording or a value. */
interface RoutineConsentWithdrawn {
  workspaceId: string;
  conversationId: string;
  channel: string | null;
  routineId: string;
  consentKey: string;
  wordingVersionId: string;
  recordId: string;
  withheldMessageCount: number;
}

/** The counter's outcome for one recorded event: asked, granted, declined, defaulted or skipped. */
const outcomeOf = (written: RoutineConsentWritten): string => {
  if (written.kind !== "decided") return written.kind;
  return written.defaulted ? "defaulted" : written.decision;
};

/** The log event and level for one recorded event, with its own fields. */
const logEntryOf = (written: RoutineConsentWritten): {
  event: string;
  level: "info" | "error";
  message: string;
  fields: Record<string, unknown>;
} => {
  switch (written.kind) {
    case "asked":
      return {
        event: "routine_consent_shown",
        level: "info",
        message: "Routine consent shown",
        fields: { wordingVersionId: written.wordingVersionId, reask: written.reask },
      };
    case "decided":
      return {
        event: written.defaulted ? "routine_consent_defaulted" : "routine_consent_decided",
        level: "info",
        message: written.defaulted ? "Routine consent declined after unclear replies" : "Routine consent decided",
        fields: {
          wordingVersionId: written.wordingVersionId,
          decision: written.decision,
          method: written.method,
          recorded: written.recorded,
        },
      };
    case "skipped":
      // Wording the conversation cannot show is an authoring or revision fault the operator must
      // fix; a channel that asks no consent is the rule working.
      return {
        event: "routine_consent_skipped",
        level: written.reason === "wording_unavailable" ? "error" : "info",
        message: "Routine consent not asked; the routine took its decline path",
        fields: { reason: written.reason },
      };
  }
};

/**
 * Reports what a committed turn recorded of its routine's consents (#1544): one structured log per
 * consent shown, decided, defaulted to declined, or not asked, and `routine_consent_outcomes_total`
 * by outcome, so a drift in the grant rate shows. A decision a retried turn had already recorded is
 * logged as not recorded and not counted again. An operator's committed withdrawal is logged and
 * counted the same way. Ids, keys and codes only: never the wording, the visitor's reply, or a
 * slot value.
 */
export const createRoutineConsentTelemetry = (input: {
  logger: Pick<AppLogger, "info" | "error">;
  metricsRegistry: Pick<MetricsRegistry, "incrementCounter"> | null;
}) => ({
  committed(committed: RoutineConsentCommitted): void {
    for (const written of committed.written) {
      if (written.kind !== "decided" || written.recorded) {
        input.metricsRegistry?.incrementCounter(ROUTINE_CONSENT_OUTCOMES_TOTAL, { help: OUTCOMES_HELP, labels: { outcome: outcomeOf(written) } });
      }
      const { event, level, message, fields } = logEntryOf(written);
      input.logger[level](
        {
          event,
          workspaceId: committed.workspaceId,
          agentId: committed.agentId,
          conversationId: committed.conversationId,
          channel: committed.channel,
          routineId: written.routineId,
          consentKey: written.consentKey,
          ...fields,
        },
        message,
      );
    }
  },
  withdrawn(withdrawn: RoutineConsentWithdrawn): void {
    input.metricsRegistry?.incrementCounter(ROUTINE_CONSENT_OUTCOMES_TOTAL, { help: OUTCOMES_HELP, labels: { outcome: "withdrawn" } });
    input.logger.info({ event: "routine_consent_withdrawn", ...withdrawn }, "Routine consent withdrawn by an operator");
  },
});
