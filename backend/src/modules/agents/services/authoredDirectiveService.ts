import { GENERATION_SURFACE } from "../../../shared/domain/generationSurface.js";
import { addressesSurface, effectiveSurfaces } from "../../../shared/domain/steeringRule.js";
import type { DirectiveCoherenceChecker, DirectiveCoherenceVerdict } from "@radioso/conversation-contract";

import type { AgentDirectiveUpdateOptions, AgentRepositoryPort } from "../../../db/repositories/agentRepository.js";
import { badRequest, conflict, notFound } from "../../../shared/domain/errors.js";
import type { AgentSkillRepositoryPort } from "../../agentSkills/public.js";
import { defaultAnswerDirectives } from "../../directives/public.js";
import {
  authoredDirectiveInputSchema,
  validateAuthoredDirectiveCapabilities,
  type AuthoredDirective,
  type AuthoredDirectiveInput,
  type NormalizedAuthoredDirectiveInput,
} from "../authoredDirectives.js";
import { authoredDirectiveToDirective } from "../authoredDirectiveMapper.js";
import type { AgentRecord } from "../domain.js";

export interface AuthoredDirectiveSaveResult {
  directive: AuthoredDirective;
  coherence: DirectiveCoherenceVerdict;
}

export type AuthoredDirectiveVersionOptions = AgentDirectiveUpdateOptions;

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
    const coherence = await this.checkCoherence(workspaceId, agent, directive, existingDirectives);
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
    input: Partial<AuthoredDirectiveInput>,
    options?: AuthoredDirectiveVersionOptions,
  ): Promise<AuthoredDirectiveSaveResult> {
    const agent = await this.requireAgent(workspaceId, agentId);
    const existingDirectives = await this.options.repository.listDirectives(agentId, workspaceId);
    const existing = existingDirectives.find((directive) => directive.id === directiveId);
    if (!existing) {
      throw notFound("Directive not found");
    }
    const directive = this.validateInput({
      name: input.name ?? existing.name,
      condition: input.condition ?? existing.condition,
      action: input.action ?? existing.action,
      priority: Object.prototype.hasOwnProperty.call(input, "priority") ? input.priority : existing.priority,
      requiredCapabilities: input.requiredCapabilities ?? existing.requiredCapabilities,
      dependsOn: input.dependsOn ?? existing.dependsOn,
      excludes: input.excludes ?? existing.excludes,
      // Absent keeps the stored scope; an explicit empty array widens the directive
      // back to the answering voice. Omitting it here would silently reset the scope
      // on every unrelated edit, because the schema defaults it to empty.
      surfaces: input.surfaces ?? existing.surfaces,
      tags: input.tags ?? existing.tags,
      routes: [],
      description: Object.prototype.hasOwnProperty.call(input, "description") ? input.description : existing.description,
      binding: Object.prototype.hasOwnProperty.call(input, "binding") ? input.binding : existing.binding,
      enabled: Object.prototype.hasOwnProperty.call(input, "enabled") ? input.enabled : existing.enabled,
      metadata: input.metadata ?? existing.metadata,
    });
    await this.validateBinding(workspaceId, agentId, directive);
    const comparisonDirectives = existingDirectives.filter((directiveToCompare) => directiveToCompare.id !== directiveId);
    const coherence = await this.checkCoherence(workspaceId, agent, directive, comparisonDirectives);
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
    if (!candidate.enabled) {
      return disabledCandidateVerdict();
    }
    try {
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
      return await this.options.coherenceChecker.check({
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
    } catch {
      return coherenceUnavailableVerdict();
    }
  }

  private async requireAgent(workspaceId: string, agentId: string): Promise<AuthoredDirectiveAgentContext> {
    const agent = await this.options.repository.findByIdAndWorkspaceId(agentId, workspaceId);
    if (!agent) {
      throw notFound("Agent not found");
    }
    return agent;
  }
}
