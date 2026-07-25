import type { DirectiveAdherenceEntry, SteeringRule } from "@radioso/conversation-contract";
import type { AnswerSchemaExtension, AnswerSideChannel } from "./answerSideChannel.js";

/**
 * Directive adherence is a steering-domain concern, not a retrieval one: the model
 * self-attests, per active directive rule, whether its reply satisfied that rule.
 * This probe owns the whole directive side of that mechanism — the schema fragment
 * the model must fill, and the resolution of its raw attestation back to directive
 * names — so any answer composer can carry it without learning directive vocabulary.
 * A composer only provides transport: it merges {@link responseSchemaFragment} into
 * its structured output schema and hands the parsed side-channel back to {@link resolve}.
 */
export interface DirectiveAdherenceProbe {
  /**
   * Schema fragment (strict-mode `properties` + `required`) to merge into a
   * composer's structured answer schema, or `null` when no directive rules are
   * active so the model is never asked to invent attestations.
   */
  responseSchemaFragment(): AnswerSchemaExtension | null;
  /**
   * Resolves a composer's structured side-channel into directive-named entries,
   * dropping any attestation whose rule id was not actually rendered this turn.
   */
  resolve(
    sideChannel: Record<string, unknown> | undefined,
    logger?: DirectiveAdherenceLogger,
  ): DirectiveAdherenceEntry[] | undefined;
}

export interface DirectiveAdherenceLogger {
  debug(payload: Record<string, unknown>, message: string): void;
}

/** The key the attestation array occupies in a composer's structured side-channel. */
export const ADHERENCE_FIELD = "adherence";

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

interface RawAttestation {
  rule: string;
  satisfied: boolean;
  note: string;
}

const readAttestation = (entry: unknown): RawAttestation | null => {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const rule = typeof record.rule === "string" ? record.rule.trim() : "";
  const note = typeof record.note === "string" ? normalizeWhitespace(record.note) : "";
  if (!rule || typeof record.satisfied !== "boolean" || !note) {
    return null;
  }
  return { rule, satisfied: record.satisfied, note };
};

/**
 * Builds a probe over the steering rules actually rendered into the prompt this
 * turn. Rules carry stable per-turn ids and their source directive name; ids that
 * are absent (a rule was rendered without one) simply cannot be attested.
 */
export const createDirectiveAdherenceProbe = (
  rules: readonly SteeringRule[] = [],
): DirectiveAdherenceProbe => {
  const ruleIds = rules.flatMap((rule) => (rule.id ? [rule.id] : []));
  const directiveByRuleId = new Map(
    rules.flatMap((rule) =>
      rule.id && rule.directiveName ? [[rule.id, rule.directiveName] as const] : [],
    ),
  );

  return {
    responseSchemaFragment() {
      if (ruleIds.length === 0) {
        return null;
      }
      return {
        properties: {
          [ADHERENCE_FIELD]: {
            type: "array",
            description: "One self-attestation for each active directive rule id.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["rule", "satisfied", "note"],
              properties: {
                rule: { type: "string", enum: [...ruleIds] },
                satisfied: { type: "boolean" },
                note: { type: "string" },
              },
            },
          },
        },
        required: [ADHERENCE_FIELD],
      };
    },
    resolve(sideChannel, logger) {
      const raw = sideChannel?.[ADHERENCE_FIELD];
      if (!Array.isArray(raw)) {
        return undefined;
      }
      let dropped = 0;
      const resolved = raw.flatMap((entry) => {
        const attestation = readAttestation(entry);
        const directive = attestation ? directiveByRuleId.get(attestation.rule) : undefined;
        if (!attestation || !directive) {
          dropped += 1;
          return [];
        }
        return [
          {
            directive,
            ruleId: attestation.rule,
            satisfied: attestation.satisfied,
            note: attestation.note,
          },
        ];
      });
      if (dropped > 0) {
        logger?.debug(
          { event: "directive_adherence_dropped", droppedCount: dropped },
          "Dropped invalid directive adherence attestations",
        );
      }
      return resolved.length > 0 ? resolved : undefined;
    },
  };
};

/**
 * Adapts the directive-adherence probe to the capability-neutral
 * {@link AnswerSideChannel} port, so a composer can carry attestation without
 * importing anything from the directive domain. Composition wires this as the
 * concrete side channel; the composer only ever sees the port. `resolve` yields
 * an opaque `{ directiveAdherence }` metadata patch the composer attaches verbatim.
 */
export const createDirectiveAdherenceSideChannel = (
  rules: readonly SteeringRule[],
  logger?: DirectiveAdherenceLogger,
): AnswerSideChannel => {
  const probe = createDirectiveAdherenceProbe(rules);
  return {
    schemaExtension: () => probe.responseSchemaFragment(),
    resolve: (extras) => {
      const entries = probe.resolve(extras, logger);
      return entries ? { directiveAdherence: entries } : undefined;
    },
  };
};
