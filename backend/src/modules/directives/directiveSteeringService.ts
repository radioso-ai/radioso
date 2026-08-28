import type { GenerationSurface } from "../../shared/domain/generationSurface.js";
import type { DirectiveCatalogRegistryPort, DirectiveMatcherPort } from "@radioso/conversation-contract";
import { DIRECTIVES_BEHAVIOR } from "../../shared/domain/behaviorConfig.js";
import type { CapabilityPolicy } from "../../shared/domain/capabilityPolicy.js";
import type { ModelCallUsageContext } from "../../shared/domain/modelCallUsageContext.js";
import { effectiveSurfaces, orderSteeringRules, type SteeringRule } from "../../shared/domain/steeringRule.js";

import {
  directiveToSteeringRule,
  type Directive,
  type DirectiveMatch,
  type DirectiveOmission,
} from "./domain.js";
import { boundSteeringPerSurface, resolveRelationshipsPerSurface } from "./surfaceScopedResolution.js";
import {
  boundSteeringMatches,
  type SteeringBoundConfig,
  type SteeringBoundDrop,
} from "./steeringBound.js";
import type { DirectiveLifecycleSuppression } from "./directiveLifecycle.js";

/** Structural log sink; a Pino logger satisfies it without an import. */
export interface DirectiveSteeringLogger {
  debug(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
}

export interface DirectiveSteerInput {
  workspaceId: string;
  accountId?: string;
  subjectId?: string;
  /**
   * Caller-owned standing directives to evaluate together with this service's
   * registered catalog for the current turn.
   */
  additionalDirectives?: Directive[];
  /** Turn signals passed through to the matcher. */
  turnContext?: Record<string, unknown>;
  /** Usage-accounting context for contextual directive match model calls. */
  usageContext?: ModelCallUsageContext;
}

export interface DirectiveSteeringResult {
  /** Ordered steering for the composer; only its contextual portion is bounded. */
  rules: SteeringRule[];
  /**
   * Matched, relationship-resolved directives, for the activity trace and turn
   * skill binding. Stays the full matched set even when the steering bound holds
   * some back from rendering — a bound directive can still claim the turn via its
   * skill binding; the bound governs prompt rendering, not activation.
   */
  matches: DirectiveMatch[];
  /** Capability-denied and relationship-resolved omissions, for the activity trace. */
  omissions: DirectiveOmission[];
  /** Matches held back from rendering by the steering bound, for the trace. */
  bounded?: SteeringBoundDrop[];
  /**
   * Directives suppressed before matching by their cross-turn lifecycle policy
   * (once/cooldown already fired). Populated by the host directive wiring, not the
   * service — the service is stateless across turns. For the trace only.
   */
  lifecycleSuppressed?: DirectiveLifecycleSuppression[];
  /**
   * Lifecycle-tracked directives addressed only to a generator that renders later in
   * the turn, keyed by that generator. They have matched but not yet fired: the host
   * captures them into the firing memory when the generator's block actually renders,
   * so a `once_per_conversation` rule is never consumed by a turn that never showed
   * it. Populated by the host directive wiring, not the service.
   */
  pendingSurfaceFirings?: Partial<Record<GenerationSurface, string[]>>;
  /**
   * Generators that actually produced output this turn. Distinct from
   * {@link pendingSurfaceFirings}, which is a lifecycle mechanism and therefore only
   * ever covers once/cooldown directives: this covers every matched rule, so the
   * trace can say whether a repeatable suggestion-only directive reached the visitor
   * or its generator never ran. The answer always renders; the follow-up question
   * generator renders only when a suggestion survives to the final presentation.
   */
  renderedSurfaces?: GenerationSurface[];
  /**
   * Whether the follow-up question generator's steering block went into the prompt
   * this turn. Set by the host that composes the answer. Distinct from that generator
   * having produced anything: a rule that suppresses suggestions leaves none, and
   * still ran.
   */
  suggestionBlockRendered?: boolean;
}

/**
 * Narrow port the chat turn consumes: resolve the agent's standing directive
 * set into a steering result for a turn. The chat module depends on this port,
 * never on Directive internals — it receives a `SteeringRule[]` plus trace
 * diagnostics, not Directives.
 */
export interface DirectiveSteeringPort {
  steer(input: DirectiveSteerInput): Promise<DirectiveSteeringResult>;
}

/**
 * Matches the standing directive set, drops directives the agent lacks the
 * capabilities for (recording the omission), and maps the survivors to an
 * ordered `SteeringRule[]`. Holds the catalog, the matcher, and the capability
 * policy so the chat module stays ignorant of all three.
 */
export class DirectiveSteeringService implements DirectiveSteeringPort {
  private readonly registry: DirectiveCatalogRegistryPort;
  private readonly matcher: DirectiveMatcherPort;
  private readonly capabilityPolicy: CapabilityPolicy;
  private readonly steeringBound: SteeringBoundConfig;
  private readonly logger?: DirectiveSteeringLogger;

  constructor(deps: {
    registry: DirectiveCatalogRegistryPort;
    matcher: DirectiveMatcherPort;
    capabilityPolicy: CapabilityPolicy;
    steeringBound?: SteeringBoundConfig;
    logger?: DirectiveSteeringLogger;
  }) {
    this.registry = deps.registry;
    this.matcher = deps.matcher;
    this.capabilityPolicy = deps.capabilityPolicy;
    this.steeringBound = deps.steeringBound ?? DIRECTIVES_BEHAVIOR.steeringBound;
    this.logger = deps.logger;
  }

  async steer(input: DirectiveSteerInput): Promise<DirectiveSteeringResult> {
    const turnContext = input.turnContext ?? {};
    const directives = [...this.listDirectives(), ...(input.additionalDirectives ?? [])];
    const candidates = await this.matcher.match({
      turnContext,
      directives,
    });
    return this.resolveMatches(input, candidates);
  }

  listDirectives(): Directive[] {
    return this.registry.list();
  }

  async resolveMatches(
    input: DirectiveSteerInput,
    candidates: DirectiveMatch[],
  ): Promise<DirectiveSteeringResult> {
    const allowed: DirectiveMatch[] = [];
    const omissions: DirectiveOmission[] = [];
    for (const candidate of candidates) {
      const denialReason = await this.firstDeniedCapability(candidate.directive.requiredCapabilities ?? [], input);
      if (denialReason) {
        omissions.push({ directiveName: candidate.directive.name, reason: denialReason });
      } else {
        allowed.push(candidate);
      }
    }

    // Resolve excludes/dependsOn over the capability-allowed set: a denied
    // directive never applied, so it can neither exclude nor satisfy others. Resolved
    // per generator, because a directive can only cancel one it actually competes
    // with — see resolveRelationshipsPerSurface.
    const { kept, omissions: relationshipOmissions } = resolveRelationshipsPerSurface(allowed);

    // Bound contextual steering: unconditional directives and their dependencies
    // always render, while the contextual remainder is ranked by confidence ×
    // priority and fitted to the top-k and token caps — per generator, since each
    // renders its own block. `matches` stays the full set
    // (skill binding and the trace still see every match); only `rules` narrows,
    // and every held-back contextual directive is recorded in `bounded`.
    const { rendered, dropped } = boundSteeringPerSurface(kept, this.steeringBound);
    if (dropped.length > 0) {
      this.logger?.debug(
        {
          event: "directive_steering_bounded",
          workspaceId: input.workspaceId,
          rendered: rendered.length,
          dropped,
        },
        "Directive steering bounded",
      );
    }

    // Order the steering rules by priority first (orderSteeringRules sorts
    // SteeringRule[] by priority; the raw matches carry priority nested under
    // `directive`, so they must be mapped before ordering), then assign stable
    // per-turn ids over that final ordering. Ids intentionally cover only the
    // rendered set: held-back and lifecycle-suppressed directives are never
    // prompted, so they get no attestation id.
    const orderedRules = orderSteeringRules(rendered.map(directiveToSteeringRule));
    // `matches` keeps every directive that survived relationships — skill binding and
    // the trace need the full set — but it carries the *post-bound* rendering state.
    // Hosts that rebuild steering from matches (the engine does, for routine replies
    // and clarifying questions) must not restore a surface the bound dropped, nor
    // turn a directive that lost every surface back into prompt steering.
    // Effective, never raw: an unscoped directive's `surfaces` is undefined, and a map
    // storing that is indistinguishable from a missing key — which would read every
    // default-scoped directive as fully bounded and drop it from engine-rebuilt
    // steering, taking the built-in answer directives with it.
    const boundSurfaces = new Map(
      rendered.map((match) => [match.directive.name, effectiveSurfaces(match.directive.surfaces)]),
    );
    const matches = kept.map((match) => {
      const boundScope = boundSurfaces.get(match.directive.name);
      if (!boundScope) {
        return { ...match, renderInSteering: false };
      }
      // Narrower than authored: the directive lost one generator's budget but not
      // another's. Recorded beside the directive, never written into it — overwriting
      // the authored scope would cost the directive its skill binding, and a bound
      // governs prompt rendering, not activation.
      const authored = effectiveSurfaces(match.directive.surfaces);
      const unchanged = boundScope.length === authored.length
        && boundScope.every((surface) => authored.includes(surface));
      return unchanged ? match : { ...match, renderSurfaces: [...boundScope] };
    });
    return {
      rules: orderedRules.map((rule, index) => ({
        ...rule,
        id: `d${index + 1}`,
      })),
      matches,
      omissions: [...omissions, ...relationshipOmissions],
      bounded: dropped,
    };
  }

  private async firstDeniedCapability(
    capabilities: string[],
    input: DirectiveSteerInput,
  ): Promise<string | null> {
    for (const capability of capabilities) {
      const decision = await this.capabilityPolicy.can({
        capability,
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        subjectId: input.subjectId,
      });
      if (!decision.allowed) {
        return decision.reason ?? "capability_denied";
      }
    }
    return null;
  }
}

/** Behavior-preserving default for call sites with no standing directives. */
export const noopDirectiveSteering: DirectiveSteeringPort = {
  async steer(): Promise<DirectiveSteeringResult> {
    return { rules: [], matches: [], omissions: [] };
  },
};
