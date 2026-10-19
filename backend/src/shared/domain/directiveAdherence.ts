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
 * What one answer reported about the rules rendered into its prompt: a graded entry
 * per rule it graded, carrying the commitment it made for that rule before writing,
 * and the directive names of the rendered rules it returned no grade for.
 */
interface DirectiveAdherenceResolution {
  entries: DirectiveAdherenceAttestation[];
  ungraded: string[];
}

/** Per-verdict counts for one resolved answer: counts only, never directive names or notes. */
export interface DirectiveAdherenceTally {
  satisfied: number;
  unsatisfied: number;
  notApplicable: number;
  ungraded: number;
}

/**
 * Directive adherence is a steering-domain concern, not a retrieval one. Before it
 * writes, the model commits, per active directive rule, to what that rule requires
 * of this answer; after, it self-attests whether the reply satisfied the rule. This
 * probe owns the whole directive side of that mechanism — the schema fragment the
 * model must fill, and the resolution of its raw commitments and attestations back
 * to directive names — so any answer composer can carry it without learning
 * directive vocabulary. A composer only provides transport: it merges
 * {@link responseSchemaFragment} into its structured output schema and hands the
 * parsed side-channel back to {@link resolve}.
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
   * dropping any commitment or attestation whose rule id was not actually rendered
   * this turn, and names the rendered rules left ungraded. `undefined` when no
   * attestable rule was rendered, so there was nothing to grade.
   */
  resolve(
    sideChannel: Record<string, unknown> | undefined,
    logger?: DirectiveAdherenceLogger,
  ): DirectiveAdherenceResolution | undefined;
}

interface DirectiveAdherenceLogger {
  debug(payload: Record<string, unknown>, message: string): void;
}

/** The key the attestation array occupies in a composer's structured side-channel. */
const ADHERENCE_FIELD = "adherence";
/** The key the pre-answer commitment array occupies, written before `answer` (#1575). */
const PLAN_FIELD = "adherencePlan";

/**
 * The assistant-message metadata key naming the directives an answer graded
 * applicable and unsatisfied. Chat writes it; Quality's unmet-directives signal
 * reads it.
 */
export const UNMET_DIRECTIVES_METADATA_KEY = "unmetDirectives";

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

interface RawCommitment {
  rule: string;
  commitment: string;
}

const readCommitment = (entry: unknown): RawCommitment | null => {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const rule = typeof record.rule === "string" ? unbracketRuleId(record.rule) : "";
  const commitment = typeof record.commitment === "string" ? normalizeWhitespace(record.commitment) : "";
  return rule && commitment ? { rule, commitment } : null;
};

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
        // Written before `answer`, so the answer is written against it (#1575): a
        // grade written after the answer can only describe what was already written.
        beforeAnswer: {
          properties: {
            [PLAN_FIELD]: {
              type: "array",
              description: "Before you write the answer: one commitment for each active directive rule id, saying what that rule requires of this answer.",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["rule", "commitment"],
                properties: {
                  rule: {
                    type: "string",
                    description: "A rule id shown in brackets before a steering rule, written without the brackets, such as d1.",
                  },
                  commitment: {
                    type: "string",
                    description: "One short clause: what this rule makes the answer include, leave out, or do on this turn, or that its condition is not met.",
                  },
                },
              },
            },
          },
          required: [PLAN_FIELD],
        },
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
      if (directiveByRuleId.size === 0) {
        return undefined;
      }
      let dropped = 0;
      const commitments = new Map<string, string>();
      for (const entry of arrayField(sideChannel, PLAN_FIELD)) {
        const commitment = readCommitment(entry);
        if (!commitment || !directiveByRuleId.has(commitment.rule)) {
          dropped += 1;
        } else if (!commitments.has(commitment.rule)) {
          commitments.set(commitment.rule, commitment.commitment);
        }
      }
      const graded = new Map<string, DirectiveAdherenceAttestation>();
      for (const entry of arrayField(sideChannel, ADHERENCE_FIELD)) {
        const attestation = readAttestation(entry);
        const directive = attestation ? directiveByRuleId.get(attestation.rule) : undefined;
        if (!attestation || !directive) {
          dropped += 1;
          continue;
        }
        // One grade per rule: a second one for the same rule is ignored.
        if (graded.has(attestation.rule)) {
          continue;
        }
        const commitment = commitments.get(attestation.rule);
        graded.set(attestation.rule, {
          directive,
          ruleId: attestation.rule,
          ...(commitment ? { commitment } : {}),
          satisfied: attestation.satisfied,
          applicable: attestation.applicable,
          note: attestation.note,
        });
      }
      if (dropped > 0) {
        logger?.debug(
          { event: "directive_adherence_dropped", droppedCount: dropped },
          "Dropped invalid directive adherence attestations",
        );
      }
      return {
        entries: [...graded.values()],
        ungraded: [...new Set([...directiveByRuleId].flatMap(([ruleId, directive]) => (graded.has(ruleId) ? [] : [directive])))],
      };
    },
  };
};

const arrayField = (sideChannel: Record<string, unknown> | undefined, field: string): unknown[] => {
  const value = sideChannel?.[field];
  return Array.isArray(value) ? value : [];
};

const tallyOf = (resolution: DirectiveAdherenceResolution): DirectiveAdherenceTally => ({
  satisfied: resolution.entries.filter((entry) => entry.applicable && entry.satisfied).length,
  unsatisfied: resolution.entries.filter((entry) => entry.applicable && !entry.satisfied).length,
  notApplicable: resolution.entries.filter((entry) => !entry.applicable).length,
  ungraded: resolution.ungraded.length,
});

/**
 * The directives an answer graded as applying to the turn and not satisfied, each
 * named once. A rule whose own condition did not hold is not unmet.
 */
export const unmetDirectiveNames = (entries: readonly DirectiveAdherenceEntry[]): string[] => [
  ...new Set(entries.filter((entry) => entry.applicable && !entry.satisfied).map((entry) => entry.directive)),
];

/** The adherence part of a turn's metadata, as the side channel's patch attached it. */
interface DirectiveAdherenceMetadata {
  directiveAdherence?: DirectiveAdherenceEntry[];
  ungradedDirectives?: string[];
}

/**
 * Picks the adherence keys the side channel attached out of a presentation's
 * metadata, so a host carries them onto its own turn shape without knowing the
 * keys. The patch is this module's own output, so the values are not re-validated.
 */
export const directiveAdherenceMetadataOf = (
  metadata: Record<string, unknown> | undefined,
): DirectiveAdherenceMetadata => ({
  ...(Array.isArray(metadata?.directiveAdherence)
    ? { directiveAdherence: metadata.directiveAdherence as DirectiveAdherenceEntry[] }
    : {}),
  ...(Array.isArray(metadata?.ungradedDirectives)
    ? { ungradedDirectives: metadata.ungradedDirectives as string[] }
    : {}),
});

/** What a resolved answer reports outward: a debug log for dropped entries, and its verdict tally. */
interface DirectiveAdherenceObservers {
  logger?: DirectiveAdherenceLogger;
  /** Called once per resolved answer that rendered at least one attestable rule. */
  onTally?(tally: DirectiveAdherenceTally): void;
}

/**
 * Adapts the directive-adherence probe to the capability-neutral
 * {@link AnswerSideChannel} port, so a composer can carry attestation without
 * importing anything from the directive domain. Composition wires this as the
 * concrete side channel; the composer only ever sees the port. `resolve` yields
 * an opaque `{ directiveAdherence, ungradedDirectives }` metadata patch the composer
 * attaches verbatim.
 */
export const createDirectiveAdherenceSideChannel = (
  rules: readonly SteeringRule[],
  observers: DirectiveAdherenceObservers = {},
): AnswerSideChannel => {
  const probe = createDirectiveAdherenceProbe(rules);
  return {
    schemaExtension: () => probe.responseSchemaFragment(),
    resolve: (extras) => {
      const resolution = probe.resolve(extras, observers.logger);
      if (!resolution) {
        return undefined;
      }
      observers.onTally?.(tallyOf(resolution));
      return {
        ...(resolution.entries.length > 0 ? { directiveAdherence: resolution.entries } : {}),
        ...(resolution.ungraded.length > 0 ? { ungradedDirectives: resolution.ungraded } : {}),
      };
    },
  };
};
