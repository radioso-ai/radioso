import type { DirectiveCatalogRegistryPort, DirectiveMatcherPort } from "@radioso/conversation-contract";
import { DIRECTIVES_BEHAVIOR } from "../../shared/domain/behaviorConfig.js";
import type { CapabilityPolicy } from "../../shared/domain/capabilityPolicy.js";
import type { ModelCallUsageContext } from "../../shared/domain/modelCallUsageContext.js";
import { orderSteeringRules, type SteeringRule } from "../../shared/domain/steeringRule.js";

import {
  directiveToSteeringRule,
  resolveDirectiveRelationships,
  type Directive,
  type DirectiveMatch,
  type DirectiveOmission,
} from "./domain.js";
import {
  boundSteeringMatches,
  type SteeringBoundConfig,
  type SteeringBoundDrop,
} from "./steeringBound.js";
import type { DirectiveLifecycleSuppression } from "./directiveLifecycle.js";

/** Structural debug sink; a Pino logger satisfies it without an import. */
export interface DirectiveSteeringLogger {
  debug(payload: Record<string, unknown>, message: string): void;
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
  /** Ordered, bounded steering for the composer (capability-filtered). */
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
    // directive never applied, so it can neither exclude nor satisfy others.
    const { kept, omissions: relationshipOmissions } = resolveDirectiveRelationships(allowed);

    // Bound the rendered steering set: rank the survivors by confidence × priority
    // and keep only what fits the top-k cap and token budget. `matches` stays the
    // full set (skill binding and the trace still see every match); only `rules`
    // narrows, and every held-back directive is recorded in `bounded`.
    const { kept: rendered, dropped } = boundSteeringMatches(kept, this.steeringBound);
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
    return {
      rules: orderedRules.map((rule, index) => ({
        ...rule,
        id: `d${index + 1}`,
      })),
      matches: kept,
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
