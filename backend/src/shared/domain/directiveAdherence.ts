import type { DirectiveAdherenceEntry, SteeringRule } from "@radioso/conversation-contract";
import type { AnswerSchemaExtension, AnswerSideChannel } from "./answerSideChannel.js";

/**
 * Whether the rule's own criteria applied this turn (#1260): a conditional
 * rule (e.g. gated on a coverage verdict) that never met its criteria attests
 * `applicable: false` instead of `satisfied: false`, so it is not read as a
 * violation. `applicable` lives directly on `@radioso/conversation-contract`'s
 * `DirectiveAdherenceEntry`; this alias just names what `resolve` returns.
 */
type DirectiveAdherenceAttestation = DirectiveAdherenceEntry;

/**
 * Directive adherence is a steering-domain concern, not a retrieval one: the model
 * self-attests, per active directive rule, whether its reply satisfied that rule.
 * This probe owns the whole directive side of that mechanism — the schema fragment
 * the model must fill, and the resolution of its raw attestation back to directive
 * names — so any answer composer can carry it without learning directive vocabulary.
 * A composer only provides transport: it merges {@link responseSchemaFragment} into
 * its structured output schema and hands the parsed side-channel back to {@link resolve}.
 */
interface DirectiveAdherenceProbe {
  /**
   * Schema fragment (strict-mode `properties` + `required`) to merge into a
   * composer's structured answer schema. Identical whether or not any directive
   * rules are active this turn, so a composer's answer schema never changes
   * shape based on this turn's steering — a provider that caches the response
   * schema with the prompt would otherwise miss on every turn where the active
   * rule set changed. {@link resolve} drops every attestation when no rule ids
   * were rendered, so the model is never credited for inventing one.
   */
  responseSchemaFragment(): AnswerSchemaExtension;
  /**
   * Resolves a composer's structured side-channel into directive-named entries,
   * dropping any attestation whose rule id was not actually rendered this turn.
   */
  resolve(
    sideChannel: Record<string, unknown> | undefined,
    logger?: DirectiveAdherenceLogger,
  ): DirectiveAdherenceAttestation[] | undefined;
}

interface DirectiveAdherenceLogger {
  debug(payload: Record<string, unknown>, message: string): void;
}

/** The key the attestation array occupies in a composer's structured side-channel. */
const ADHERENCE_FIELD = "adherence";

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

// The steering block renders each id as `[d1]`; a model may copy the brackets.
const unbracketRuleId = (value: string): string => {
  const trimmed = value.trim();
  return trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1).trim() : trimmed;
};

interface RawAttestation {
  rule: string;
  satisfied: boolean;
  applicable: boolean;
  note: string;
}

const readAttestation = (entry: unknown): RawAttestation | null => {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const rule = typeof record.rule === "string" ? unbracketRuleId(record.rule) : "";
  const note = typeof record.note === "string" ? normalizeWhitespace(record.note) : "";
  if (!rule || typeof record.satisfied !== "boolean" || typeof record.applicable !== "boolean" || !note) {
    return null;
  }
  return { rule, satisfied: record.satisfied, applicable: record.applicable, note };
};

/**
 * Builds a probe over the steering rules actually rendered into the prompt this
 * turn. Rules carry stable per-turn ids and their source directive name; ids that
 * are absent (a rule was rendered without one) simply cannot be attested.
 */
export const createDirectiveAdherenceProbe = (
  rules: readonly SteeringRule[] = [],
): DirectiveAdherenceProbe => {
  const directiveByRuleId = new Map(
    rules.flatMap((rule) =>
      rule.id && rule.directiveName ? [[rule.id, rule.directiveName] as const] : [],
    ),
  );

  return {
    // Identical on every turn, including a turn with no attestable rule ids at
    // all: the rule count has no hard cap (unconditional directives always
    // render), so an id enum would change whenever the active rule set does, and
    // a turn with zero active rules would omit the field entirely, changing the
    // schema's shape instead of its enum. Either would miss a provider's
    // response-schema cache. `resolve` drops any id not rendered, which is every
    // id on a turn with none.
    responseSchemaFragment() {
      return {
        properties: {
          [ADHERENCE_FIELD]: {
            type: "array",
            description: "One self-attestation for each active directive rule id.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["rule", "satisfied", "applicable", "note"],
              properties: {
                rule: {
                  type: "string",
                  description: "A rule id shown in brackets before a steering rule, written without the brackets, such as d1.",
                },
                satisfied: { type: "boolean" },
                // A conditional rule (coverage-gated) whose criteria did not match
                // this turn's verdict attests false here, not false `satisfied`.
                applicable: { type: "boolean" },
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
            applicable: attestation.applicable,
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
