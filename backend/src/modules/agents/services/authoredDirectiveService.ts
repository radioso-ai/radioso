import type { DirectiveCoherenceChecker, DirectiveCoherenceVerdict } from "@radioso/conversation-contract";

import type { AgentRepositoryPort } from "../../../db/repositories/agentRepository.js";
import { badRequest, notFound } from "../../../shared/domain/errors.js";
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
}

const coherenceUnavailableVerdict = (): DirectiveCoherenceVerdict => ({
  coherent: true,
  conflicts: [],
  rationale: "Coherence check unavailable.",
});

export class AuthoredDirectiveService {
  constructor(private readonly options: AuthoredDirectiveServiceOptions) {}

  async list(workspaceId: string, agentId: string): Promise<AuthoredDirective[]> {
    await this.requireAgent(workspaceId, agentId);
    return this.options.repository.listDirectives(agentId, workspaceId);
  }

  async create(workspaceId: string, agentId: string, input: AuthoredDirectiveInput): Promise<AuthoredDirectiveSaveResult> {
    const agent = await this.requireAgent(workspaceId, agentId);
    const directive = this.validateInput(input);
    const existingDirectives = await this.options.repository.listDirectives(agentId, workspaceId);
    const coherence = await this.checkCoherence(agent, directive, existingDirectives);
    const saved = await this.options.repository.createDirective(agentId, workspaceId, {
      ...directive,
      routes: [],
    });
    return { directive: saved, coherence };
  }

  async update(
    workspaceId: string,
    agentId: string,
    directiveId: string,
    input: Partial<AuthoredDirectiveInput>,
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
      tags: input.tags ?? existing.tags,
      routes: [],
      description: Object.prototype.hasOwnProperty.call(input, "description") ? input.description : existing.description,
      metadata: input.metadata ?? existing.metadata,
    });
    const comparisonDirectives = existingDirectives.filter((directiveToCompare) => directiveToCompare.id !== directiveId);
    const coherence = await this.checkCoherence(agent, directive, comparisonDirectives);
    const saved = await this.options.repository.updateDirective(agentId, workspaceId, directiveId, {
      ...directive,
      routes: [],
    });
    return { directive: saved, coherence };
  }

  async delete(workspaceId: string, agentId: string, directiveId: string): Promise<void> {
    await this.requireAgent(workspaceId, agentId);
    const deleted = await this.options.repository.deleteDirective(agentId, workspaceId, directiveId);
    if (!deleted) {
      throw notFound("Directive not found");
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
    const capabilityValidation = validateAuthoredDirectiveCapabilities(
      directive.requiredCapabilities,
      this.options.registeredCapabilityNames,
    );
    if (!capabilityValidation.ok) {
      throw badRequest("Directive references unknown capabilities", { unknown: capabilityValidation.unknown });
    }
    return directive;
  }

  private async checkCoherence(
    agent: AuthoredDirectiveAgentContext,
    candidate: NormalizedAuthoredDirectiveInput,
    existingDirectives: AuthoredDirective[],
  ): Promise<DirectiveCoherenceVerdict> {
    try {
      return await this.options.coherenceChecker.check({
        agent: {
          id: agent.id,
          name: agent.name,
          instructions: [agent.customInstruction, agent.greetingInstruction].filter((instruction) => instruction.trim().length > 0),
          defaultLocale: agent.assistantDefaultLocale,
          model: agent.chatModelOverride,
        },
        candidate: authoredDirectiveToDirective(candidate),
        existingDirectives: [
          ...existingDirectives.map((directive) => authoredDirectiveToDirective(directive)),
          ...defaultAnswerDirectives,
        ],
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
