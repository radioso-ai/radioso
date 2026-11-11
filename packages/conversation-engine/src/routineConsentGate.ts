// A routine's consents within one turn (#1544): which covered slots stay closed, which the routine
// runs without, and what a `consent` step does when the walk reaches it — pass on, park on the
// consent's wording, or end the run with a hand-off. Wording, channels and records stay with the
// host behind `ConversationRoutineConsentPort`.
import type {
  ConversationRoutineConsentPort,
  PendingRenderableTurn,
  Routine,
  RoutineConsent,
  RoutineConsentDecision,
  RoutineConsentEvent,
  RoutineConsentMethod,
  RoutineConsentSkipReason,
  RoutineStep,
  RoutineTraceConsent,
  RoutineTraceStepEntry,
  TurnContext,
} from "@radioso/conversation-contract";

/**
 * Times a consent is shown before a reply that still neither agrees nor declines counts as
 * declined (FR-006): the first ask, and one more after an unclear reply.
 */
const CONSENT_ASKS = 2;

/** What landing on a `consent` step does with the walk. */
type RoutineConsentGateOutcome =
  /** On to the step the consent step leads to. */
  | { kind: "pass" }
  /** The turn replies with the consent's wording and the run waits on the consent step. */
  | { kind: "park"; reply: PendingRenderableTurn; reaskCount: number }
  /** The run ends `consent_declined`, and a person takes the conversation over. */
  | { kind: "handoff" };

/** What a landing did, with the consent step's entry on the routine trace. */
interface RoutineConsentLanding {
  outcome: RoutineConsentGateOutcome;
  entry: RoutineTraceStepEntry;
}

/** The consent step's trace entry for `event`; keys only. */
type ConsentEntry = (event: RoutineTraceStepEntry["event"], detail?: Omit<RoutineTraceConsent, "key">) => RoutineTraceStepEntry;

const coveredKeys = (consents: readonly RoutineConsent[]): string[] => consents.flatMap((consent) => consent.slotKeys);

export class RoutineConsentGate {
  private readonly decidedThisTurn = new Map<string, RoutineConsentDecision>();
  private readonly waivedKeys: Set<string>;
  private readonly turnEvents: RoutineConsentEvent[] = [];

  private constructor(
    private readonly routine: Routine,
    private readonly port: ConversationRoutineConsentPort | undefined,
    private readonly turn: TurnContext,
    private readonly asks: boolean,
    private readonly standing: Readonly<Record<string, RoutineConsentDecision>>,
    /**
     * Covered slots the conversation had not granted when the turn started. No value enters the
     * run's state for one, whoever states it, so a grant decided this turn opens nothing until
     * the next turn: the message that grants a consent never fills its slots (FR-007).
     */
    readonly blocked: ReadonlySet<string>,
  ) {
    // Declined earlier, or on a conversation where no consent can be asked: the routine runs
    // without these slots, so a step that collects only them has nothing left to ask.
    const runsWithout = (consent: RoutineConsent): boolean =>
      asks ? standing[consent.key] === "declined" : standing[consent.key] !== "granted";
    this.waivedKeys = new Set(coveredKeys((routine.consents ?? []).filter(runsWithout)));
  }

  /** Reads what the conversation already decided, once per turn and only for a routine with consents. */
  static async open(
    routine: Routine,
    port: ConversationRoutineConsentPort | undefined,
    turn: TurnContext,
  ): Promise<RoutineConsentGate> {
    const consents = routine.consents ?? [];
    const standing = consents.length > 0 && port ? await port.standing({ routine, turn }) : null;
    const decisions = standing?.decisions ?? {};
    const blocked = new Set(coveredKeys(consents.filter((consent) => decisions[consent.key] !== "granted")));
    return new RoutineConsentGate(routine, port, turn, standing?.asks ?? false, decisions, blocked);
  }

  /** Covered slots the routine runs without: a step that collects only these is satisfied. */
  get waived(): ReadonlySet<string> {
    return this.waivedKeys;
  }

  /** `variables` without a value for any blocked slot; the same object when it holds none. */
  withoutBlocked(variables: Record<string, unknown>): Record<string, unknown> {
    return Object.keys(variables).some((key) => this.blocked.has(key))
      ? Object.fromEntries(Object.entries(variables).filter(([key]) => !this.blocked.has(key)))
      : variables;
  }

  /** What the turn did with the routine's consents, for the host to record. */
  get events(): readonly RoutineConsentEvent[] {
    return this.turnEvents;
  }

  /**
   * The walk reached consent step `step`. `answering` is set when the turn's message replies to
   * this consent's wording (the run was parked on the step), with the times it was shown again.
   */
  async land(step: RoutineStep, answering: { reaskCount: number } | null): Promise<RoutineConsentLanding> {
    const consent = (this.routine.consents ?? []).find((candidate) => candidate.key === step.consentKey);
    if (!consent) {
      throw new Error(`routine_consent_not_found:${this.routine.id}:${step.id}`);
    }
    const entry: ConsentEntry = (event, detail = {}) =>
      ({ stepId: step.id, kind: step.kind, event, consent: { key: consent.key, ...detail } });

    const decided = this.decidedThisTurn.get(consent.key) ??
      (Object.hasOwn(this.standing, consent.key) ? this.standing[consent.key] : undefined);
    if (decided) {
      return { outcome: this.apply(consent, decided), entry: entry("consent_reused", { decision: decided }) };
    }
    const port = this.port;
    if (!port) {
      return this.skip(consent, "no_port", entry);
    }
    if (!this.asks) {
      return this.skip(consent, "channel", entry);
    }
    if (!answering) {
      return this.ask(port, consent, 0, entry);
    }
    const reply = await port.read({ routine: this.routine, consent, turn: this.turn });
    if (!reply) {
      return this.skip(consent, "wording_unavailable", entry);
    }
    if (reply.decision !== "unclear") {
      return this.decide(consent, reply.decision, reply.method, false, reply.wording, entry);
    }
    if (1 + answering.reaskCount < CONSENT_ASKS) {
      return this.ask(port, consent, answering.reaskCount + 1, entry);
    }
    return this.decide(consent, "declined", reply.method, true, reply.wording, entry);
  }

  private async ask(
    port: ConversationRoutineConsentPort,
    consent: RoutineConsent,
    reaskCount: number,
    entry: ConsentEntry,
  ): Promise<RoutineConsentLanding> {
    const reask = reaskCount > 0;
    const prompt = await port.prompt({ routine: this.routine, consent, turn: this.turn, reask });
    if (!prompt) {
      return this.skip(consent, "wording_unavailable", entry);
    }
    this.turnEvents.push({ kind: "asked", routineId: this.routine.id, consentKey: consent.key, reask, wording: prompt.wording });
    return {
      outcome: { kind: "park", reply: prompt.reply, reaskCount },
      entry: entry("consent_asked", reask ? { reask: true } : {}),
    };
  }

  private decide(
    consent: RoutineConsent,
    decision: RoutineConsentDecision,
    method: RoutineConsentMethod,
    defaulted: boolean,
    wording: unknown,
    entry: ConsentEntry,
  ): RoutineConsentLanding {
    this.turnEvents.push({
      kind: "decided",
      routineId: this.routine.id,
      consentKey: consent.key,
      slotKeys: [...consent.slotKeys],
      decision,
      method,
      defaulted,
      wording,
    });
    this.decidedThisTurn.set(consent.key, decision);
    return {
      outcome: this.apply(consent, decision),
      entry: entry("consent_decided", { decision, ...(defaulted ? { defaulted: true as const } : {}) }),
    };
  }

  /** Not asked, so nothing is recorded; the routine takes the consent's decline path. */
  private skip(
    consent: RoutineConsent,
    reason: RoutineConsentSkipReason,
    entry: ConsentEntry,
  ): RoutineConsentLanding {
    this.turnEvents.push({ kind: "skipped", routineId: this.routine.id, consentKey: consent.key, reason });
    this.decidedThisTurn.set(consent.key, "declined");
    return { outcome: this.apply(consent, "declined"), entry: entry("consent_skipped", { reason }) };
  }

  private apply(consent: RoutineConsent, decision: RoutineConsentDecision): RoutineConsentGateOutcome {
    if (decision === "granted") {
      return { kind: "pass" };
    }
    if (consent.onDecline === "handoff") {
      return { kind: "handoff" };
    }
    for (const key of consent.slotKeys) {
      this.waivedKeys.add(key);
    }
    return { kind: "pass" };
  }
}
