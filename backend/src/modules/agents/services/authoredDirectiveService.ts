import { GENERATION_SURFACE } from "../../../shared/domain/generationSurface.js";
import { addressesSurface, effectiveSurfaces } from "../../../shared/domain/steeringRule.js";
import type { DirectiveCoherenceChecker, DirectiveCoherenceVerdict } from "@radioso/conversation-contract";

import type { AgentDirectiveUpdateOptions, AgentRepositoryPort } from "../../../db/repositories/agentRepository.js";
import { AppError, badRequest, conflict, notFound } from "../../../shared/domain/errors.js";
import type { AgentSkillRepositoryPort } from "../../agentSkills/public.js";
import { defaultAnswerDirectives } from "../../directives/public.js";
import {
  authoredDirectiveInputSchema,
  DIRECTIVE_CREATE_FENCE,
  validateDirectiveReplacementNames,
  validateAuthoredDirectiveCapabilities,
  type AuthoredDirective,
  type AuthoredDirectiveInput,
  type NormalizedAuthoredDirectiveInput,
} from "../authoredDirectives.js";
import type { AnswerCoverageCriteria } from "../../answerCoverage/public.js";
import { authoredDirectiveToDirective } from "../authoredDirectiveMapper.js";
import type { AgentRecord } from "../domain.js";

interface AuthoredDirectiveSaveResult {
  directive: AuthoredDirective;
  coherence: DirectiveCoherenceVerdict;
}

type AuthoredDirectiveVersionOptions = AgentDirectiveUpdateOptions & {
  coherence?: "check" | "skip";
};

type AuthoredDirectivePreviewChange =
  | { kind: "save"; directiveId: string | null; input: AuthoredDirectiveInput; versionToken: string }
  | { kind: "set_enabled"; directiveId: string; enabled: boolean }
  | { kind: "remove"; directiveId: string };

interface AuthoredDirectivePreview {
  readonly before: AuthoredDirective | null;
  readonly after: NormalizedAuthoredDirectiveInput | null;
  readonly coherence: { readonly status: "coherent" | "conflicts" | "not_checked" | "unavailable"; readonly conflicts: ReadonlyArray<{ directiveName: string; reason: string }>; readonly rationale: string };
  readonly referencedBy: ReadonlyArray<{ directiveId: string; name: string; relation: "excludes" | "dependsOn" }>;
  readonly referencedByTotal: number;
  readonly drafting: "verbatim";
  readonly irreversible: boolean;
  readonly versionToken: string;
}

// Every key the input schema declares, read from the schema itself rather than hand-listed, so a
// field added to `authoredDirectiveInputSchema` is carried forward on update automatically instead
// of silently resetting to its schema default the next time someone edits an unrelated field.
const authoredDirectiveInputKeys = Object.keys(authoredDirectiveInputSchema.shape) as Array<keyof AuthoredDirectiveInput>;

/**
 * Carries every schema field forward from the stored directive unless the caller's patch names it
 * explicitly - `hasOwnProperty`, not `??`, is what tells "omitted" apart from "explicitly cleared
 * with `null` or `[]`". A PATCH body only ever contains the keys the operator actually touched, so
 * an absent key must mean "leave this alone." This matters most for a field the schema defaults to
 * empty on absence, such as `surfaces`: omitting it keeps the directive's stored scope, while an
 * explicit `[]` is the operator widening it back to the answering voice. Treating an omitted key as
 * `??`'s "value ?? default" would silently narrow or reset a field like that on every unrelated
 * edit.
 */
type AuthoredDirectivePatchInput = Omit<Partial<AuthoredDirectiveInput>, "coverageCriteria"> & {
  coverageCriteria?: AnswerCoverageCriteria | null;
};

const carryForwardAuthoredDirectiveInput = (
  input: AuthoredDirectivePatchInput,
  existing: AuthoredDirective,
): AuthoredDirectiveInput =>
  Object.fromEntries(
    authoredDirectiveInputKeys.map((key) => [
      key,
      key === "coverageCriteria" && input.coverageCriteria === null
        ? undefined
        : Object.prototype.hasOwnProperty.call(input, key) ? input[key] : existing[key],
    ]),
    // `existing` is a prior successful parse of this same schema, so every value read from it here
    // is already valid raw input for the field it came from; the cast just restates that as the
    // input type Object.fromEntries' generic widens away.
  ) as AuthoredDirectiveInput;

type AuthoredDirectiveAgentContext = Pick<
  AgentRecord,
  "id" | "name" | "customInstruction" | "greetingInstruction" | "assistantDefaultLocale" | "chatModelOverride"
>;

export interface AuthoredDirectiveServiceOptions {
  repository: Pick<AgentRepositoryPort, "listDirectives" | "createDirective" | "updateDirective" | "deleteDirective"> & {
    findByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<AuthoredDirectiveAgentContext | null>;
  };
  coherenceChecker: DirectiveCoherenceChecker;
  registeredCapabilityNames: ReadonlySet<string>;
  agentSkills?: Pick<AgentSkillRepositoryPort, "findByName">;
}

const coherenceUnavailableVerdict = (): DirectiveCoherenceVerdict => ({
  coherent: true,
  conflicts: [],
  rationale: "Coherence check unavailable.",
});

const disabledCandidateVerdict = (): DirectiveCoherenceVerdict => ({
  coherent: true,
  conflicts: [],
  rationale: "Directive is disabled and cannot fire, so it cannot conflict with other directives; coherence was not checked.",
});

const coherenceSkippedVerdict = (): DirectiveCoherenceVerdict => ({
  coherent: true,
  conflicts: [],
  rationale: "Coherence check skipped for deterministic reviewed execution.",
});

/**
 * Whether `create`/`update` refused a write because the target name collides with another
 * directive on the agent, as opposed to the optimistic-concurrency fence losing. Both throw an
 * AppError coded `"conflict"` from the repository, so a caller distinguishing "the world moved"
 * (stale) from "this name is taken" (a durable refusal) needs this dedicated signal rather than
 * the shared error code.
 */
export const isDirectiveNameConflict = (error: unknown): error is AppError =>
  error instanceof AppError
  && error.code === "conflict"
  && (error.details as { reason?: string } | undefined)?.reason === "duplicate_name";

export class AuthoredDirectiveService {
  constructor(private readonly options: AuthoredDirectiveServiceOptions) {}

  async list(workspaceId: string, agentId: string): Promise<AuthoredDirective[]> {
    await this.requireAgent(workspaceId, agentId);
    return this.options.repository.listDirectives(agentId, workspaceId);
  }

  async create(workspaceId: string, agentId: string, input: AuthoredDirectiveInput, options?: AuthoredDirectiveVersionOptions): Promise<AuthoredDirectiveSaveResult> {
    const agent = await this.requireAgent(workspaceId, agentId);
    const directive = this.validateInput(input);
    await this.validateBinding(workspaceId, agentId, directive);
    const existingDirectives = await this.options.repository.listDirectives(agentId, workspaceId);
    this.validateReplacementNames(directive.excludes, existingDirectives);
    const coherence = options?.coherence === "skip" ? coherenceSkippedVerdict() : await this.checkCoherence(workspaceId, agent, directive, existingDirectives);
    const saved = await this.options.repository.createDirective(agentId, workspaceId, {
      ...directive,
      routes: [],
    }, options);
    return { directive: saved, coherence };
  }

  async update(
    workspaceId: string,
    agentId: string,
    directiveId: string,
    input: AuthoredDirectivePatchInput,
    options?: AuthoredDirectiveVersionOptions,
  ): Promise<AuthoredDirectiveSaveResult> {
    const agent = await this.requireAgent(workspaceId, agentId);
    const existingDirectives = await this.options.repository.listDirectives(agentId, workspaceId);
    const existing = existingDirectives.find((directive) => directive.id === directiveId);
    if (!existing) {
      throw notFound("Directive not found");
    }
    const directive = this.validateInput(carryForwardAuthoredDirectiveInput(input, existing));
    await this.validateBinding(workspaceId, agentId, directive);
    this.validateReplacementNames(directive.excludes, existingDirectives);
    const comparisonDirectives = existingDirectives.filter((directiveToCompare) => directiveToCompare.id !== directiveId);
    const coherence = options?.coherence === "skip" ? coherenceSkippedVerdict() : await this.checkCoherence(workspaceId, agent, directive, comparisonDirectives);
    const saved = await this.options.repository.updateDirective(agentId, workspaceId, directiveId, {
      ...directive,
      routes: [],
    }, options);
    return { directive: saved, coherence };
  }

  /**
   * `options.expectedUpdatedAt`, when supplied, is enforced inside the repository's DELETE
   * predicate (not read-then-compared here): a concurrent edit changes the directive's
   * `updated_at` between when a caller read it and when it calls delete, and the WHERE clause
   * must see that change atomically or the delete could destroy a directive the caller never saw.
   */
  async delete(workspaceId: string, agentId: string, directiveId: string, options?: AuthoredDirectiveVersionOptions): Promise<void> {
    await this.requireAgent(workspaceId, agentId);
    const deleted = await this.options.repository.deleteDirective(agentId, workspaceId, directiveId, options);
    if (!deleted) {
      throw options?.expectedUpdatedAt ? conflict("Directive was updated by another writer; reload before saving again") : notFound("Directive not found");
    }
  }

  /** Computes the reviewed change from owner state; callers never reconstruct directive rules. */
  async previewChange(workspaceId: string, agentId: string, change: AuthoredDirectivePreviewChange): Promise<AuthoredDirectivePreview> {
    const agent = await this.requireAgent(workspaceId, agentId);
    const directives = await this.options.repository.listDirectives(agentId, workspaceId);
    const existing = change.kind === "save" && change.directiveId
      ? directives.find((directive) => directive.id === change.directiveId) ?? null
      : change.kind === "set_enabled" || change.kind === "remove"
        ? directives.find((directive) => directive.id === change.directiveId) ?? null
        : null;
    if ((change.kind !== "save" || change.directiveId) && !existing) throw notFound("Directive not found");
    const versionToken = existing ? existing.updatedAt.toISOString() : DIRECTIVE_CREATE_FENCE;
    if (change.kind === "save" && change.versionToken !== versionToken) {
      throw conflict("Directive changed while it was being prepared; prepare it again before review.");
    }
    if (change.kind === "remove") {
      const referencedBy = this.referencedBy(existing!.name, directives, existing!.id);
      return { before: existing, after: null, coherence: { status: "not_checked", conflicts: [], rationale: "Coherence is not checked for a removal." }, referencedBy, referencedByTotal: referencedBy.length, drafting: "verbatim", irreversible: true, versionToken };
    }
    const raw = change.kind === "set_enabled"
      ? carryForwardAuthoredDirectiveInput({ enabled: change.enabled }, existing!)
      : change.directiveId
        ? carryForwardAuthoredDirectiveInput(change.input, existing!)
        : change.input;
    const after = this.validateInput(raw);
    await this.validateBinding(workspaceId, agentId, after);
    this.validateReplacementNames(after.excludes, directives);
    if (change.kind === "set_enabled" && existing!.enabled === change.enabled) {
      throw badRequest(`The directive "${existing!.name}" is already ${change.enabled ? "enabled" : "disabled"}.`);
    }
    const comparisons = existing ? directives.filter((directive) => directive.id !== existing.id) : directives;
    const referencedBy = this.referencedBy(after.name, directives, existing?.id);
    return {
      before: existing,
      after,
      coherence: await this.reviewedCoherence(workspaceId, agent, after, comparisons),
      referencedBy,
      referencedByTotal: referencedBy.length,
      drafting: "verbatim",
      irreversible: false,
      versionToken,
    };
  }

  private referencedBy(name: string, directives: ReadonlyArray<AuthoredDirective>, selfId?: string): ReadonlyArray<{ directiveId: string; name: string; relation: "excludes" | "dependsOn" }> {
    return directives.flatMap((directive) => directive.id === selfId ? [] : [
      ...(directive.excludes.includes(name) ? [{ directiveId: directive.id, name: directive.name, relation: "excludes" as const }] : []),
      ...(directive.dependsOn.includes(name) ? [{ directiveId: directive.id, name: directive.name, relation: "dependsOn" as const }] : []),
    ]);
  }

  private async reviewedCoherence(workspaceId: string, agent: AuthoredDirectiveAgentContext, candidate: NormalizedAuthoredDirectiveInput, existingDirectives: AuthoredDirective[]): Promise<AuthoredDirectivePreview["coherence"]> {
    if (!candidate.enabled) return { status: "not_checked", conflicts: [], rationale: "Coherence is not checked for a disabled directive." };
    try {
      const verdict = await this.checkCoherenceStrict(workspaceId, agent, candidate, existingDirectives);
      return { status: verdict.coherent ? "coherent" : "conflicts", conflicts: verdict.conflicts, rationale: verdict.rationale };
    } catch {
      return { status: "unavailable", conflicts: [], rationale: "Coherence check unavailable." };
    }
  }

  private validateInput(input: AuthoredDirectiveInput): NormalizedAuthoredDirectiveInput {
    const parsed = authoredDirectiveInputSchema.safeParse({
      ...input,
      routes: [],
    });
    if (!parsed.success) {
      throw badRequest("Invalid directive input", parsed.error.flatten());
    }
    const directive = parsed.data;
    // A disabled directive is out of play, so a capability that has since been removed or renamed
    // cannot reach a turn through it. Rejecting the save here would make the off switch unusable
    // in one of the cases it exists for, since an update carries the stored capabilities forward
    // untouched. Re-enabling validates in full, like the binding and coherence gates.
    if (directive.enabled) {
      const capabilityValidation = validateAuthoredDirectiveCapabilities(
        directive.requiredCapabilities,
        this.options.registeredCapabilityNames,
      );
      if (!capabilityValidation.ok) {
        throw badRequest("Directive references unknown capabilities", { unknown: capabilityValidation.unknown });
      }
    }
    return directive;
  }

  private validateReplacementNames(excludes: string[], existingDirectives: ReadonlyArray<AuthoredDirective>): void {
    const validation = validateDirectiveReplacementNames(excludes, existingDirectives);
    if (validation.unknown.length > 0) {
      throw badRequest(`Unknown directive replacement ${validation.unknown.join(", ")}. Valid names: ${validation.validNames.slice(0, 20).join(", ")}.`);
    }
  }

  private async validateBinding(workspaceId: string, agentId: string, directive: NormalizedAuthoredDirectiveInput): Promise<void> {
    // A disabled directive is out of play and cannot fire, so a binding that would fail at
    // runtime is not rejected here - the authored text and its binding are preserved as
    // written, and the validation gate moves to the moment the directive comes back into
    // play. This is the same rule checkCoherence applies to disabled candidates, and it is
    // the point of the off switch: an operator must be able to disable a directive whose
    // binding broke (skill disabled or deleted) rather than being blocked from saving the
    // very action meant to stop it. Re-enabling runs this validation again in full.
    if (!directive.enabled) {
      return;
    }
    const binding = directive.binding;
    if (!binding) {
      return;
    }
    // Binding names the skill that answers the turn, and only a directive addressed
    // to the answer can claim it. Storing one on a directive scoped away from the
    // answer would look configured and do nothing, so it is rejected at authoring
    // rather than ignored at runtime.
    if (!addressesSurface(directive.surfaces, GENERATION_SURFACE.ANSWER)) {
      throw badRequest(
        `Directive binding requires the directive to apply to the agent's reply, but "${directive.name}" is scoped away from it`,
      );
    }
    const skill = await this.options.agentSkills?.findByName(workspaceId, agentId, binding.skillName);
    if (!skill) {
      throw badRequest(`Directive binding references unknown skill "${binding.skillName}"`);
    }
    if (!skill.enabled) {
      throw badRequest(`Directive binding skill "${binding.skillName}" is disabled`);
    }
    if (skill.invocationMode !== "agent_selectable") {
      throw badRequest(`Directive binding skill "${binding.skillName}" is not turn-selectable`);
    }
    // External MCP skills still claim the terminal turn; retrieve skills are
    // staged into the agentic answer loop as lookup tools. Action kinds settle
    // with outputs only, so they remain unsafe for directive binding.
    if (skill.kind !== "external_mcp" && skill.kind !== "retrieve") {
      throw badRequest(
        `Directive binding skill "${binding.skillName}" (kind "${skill.kind}") cannot answer chat turns or be staged as lookup; only external MCP and retrieve skills can be bound`,
      );
    }
  }

  private async checkCoherence(
    workspaceId: string,
    agent: AuthoredDirectiveAgentContext,
    candidate: NormalizedAuthoredDirectiveInput,
    existingDirectives: AuthoredDirective[],
  ): Promise<DirectiveCoherenceVerdict> {
    // A disabled candidate is out of play and cannot fire, so it cannot conflict with
    // anything - skip the LLM round-trip entirely. This matters because disabling is the
    // emergency action an operator takes when a rule misfires; it must not cost a provider
    // call whose verdict the UI would discard. Re-enabling, in contrast, brings the
    // directive back into play and must still be checked, since that is exactly when a
    // reintroduced conflict would matter.
    if (!candidate.enabled) return disabledCandidateVerdict();
    try {
      return await this.checkCoherenceStrict(workspaceId, agent, candidate, existingDirectives);
    } catch {
      return coherenceUnavailableVerdict();
    }
  }

  private async checkCoherenceStrict(
    workspaceId: string,
    agent: AuthoredDirectiveAgentContext,
    candidate: NormalizedAuthoredDirectiveInput,
    existingDirectives: AuthoredDirective[],
  ): Promise<DirectiveCoherenceVerdict> {
      const candidateDirective = authoredDirectiveToDirective(candidate);
      const comparisonDirectives = [
        // A disabled directive cannot fire, so it cannot conflict with the candidate;
        // including it would flag noise the operator can't act on.
        ...existingDirectives.filter((directive) => directive.enabled).map((directive) => authoredDirectiveToDirective(directive)),
        ...defaultAnswerDirectives,
      ].filter((directive) =>
        effectiveSurfaces(candidateDirective.surfaces).some((surface) =>
          addressesSurface(directive.surfaces, surface),
        ),
      );
      return this.options.coherenceChecker.check({
        invocationContext: { workspaceId, agentId: agent.id },
        agent: {
          id: agent.id,
          name: agent.name,
          instructions: [agent.customInstruction, agent.greetingInstruction].filter((instruction) => instruction.trim().length > 0),
          defaultLocale: agent.assistantDefaultLocale,
          model: agent.chatModelOverride,
        },
        candidate: candidateDirective,
        existingDirectives: comparisonDirectives,
      });
  }

  private async requireAgent(workspaceId: string, agentId: string): Promise<AuthoredDirectiveAgentContext> {
    const agent = await this.options.repository.findByIdAndWorkspaceId(agentId, workspaceId);
    if (!agent) {
      throw notFound("Agent not found");
    }
    return agent;
  }
}
