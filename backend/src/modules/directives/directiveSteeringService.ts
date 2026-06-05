import type { DirectiveCatalogRegistry, DirectiveMatcherPort } from "@radioso/conversation-defaults";
import type { CapabilityPolicy } from "../../shared/domain/capabilityPolicy.js";
import { orderSteeringRules, type SteeringRule } from "../../shared/domain/steeringRule.js";

import {
  directiveToSteeringRule,
  resolveDirectiveRelationships,
  type Directive,
  type DirectiveMatch,
  type DirectiveOmission,
} from "./domain.js";

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
}

export interface DirectiveSteeringResult {
  /** Ordered steering for the composer (capability-filtered). */
  rules: SteeringRule[];
  /** Injected matches, for the activity trace. */
  matches: DirectiveMatch[];
  /** Capability-denied matches, for the activity trace. */
  omissions: DirectiveOmission[];
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
  private readonly registry: DirectiveCatalogRegistry;
  private readonly matcher: DirectiveMatcherPort;
  private readonly capabilityPolicy: CapabilityPolicy;

  constructor(deps: {
    registry: DirectiveCatalogRegistry;
    matcher: DirectiveMatcherPort;
    capabilityPolicy: CapabilityPolicy;
  }) {
    this.registry = deps.registry;
    this.matcher = deps.matcher;
    this.capabilityPolicy = deps.capabilityPolicy;
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

    return {
      rules: orderSteeringRules(kept.map(directiveToSteeringRule)),
      matches: kept,
      omissions: [...omissions, ...relationshipOmissions],
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
