import type {
  AgentContextVariableEnablementRecord,
  ApplyContextVariableProposalInput,
  ApplyContextVariableProposalResult,
  ContextVariableCreateRecord,
  ContextVariableRepositoryPort,
  ContextVariableUpdateRecord,
} from "../repository.js";
import { badRequest, conflict, notFound } from "../../../shared/domain/errors.js";
import { isValueCompatibleWithType } from "../valueCompatibility.js";
import type {
  AgentContextVariableEnablement,
  ContextVariable,
  ContextVariableScope,
  ContextVariableValue,
} from "../domain.js";

const MAX_CONTEXT_VARIABLE_VALUE_BYTES = 32 * 1024;

/** The only agent capability context-variable definitions require. */
export interface ContextVariableAgentReaderPort {
  get(workspaceId: string, agentId: string): Promise<{ readonly id: string } | null>;
}

/** The only skill capability resolver-backed variables require. */
export interface ContextVariableAgentSkillsReaderPort {
  list(workspaceId: string, agentId: string): Promise<ReadonlyArray<{ readonly id: string; readonly enabled: boolean }>>;
}

export interface ContextVariableServiceOptions {
  readonly repository: ContextVariableRepositoryPort;
  readonly agentReader: ContextVariableAgentReaderPort;
  readonly agentSkillsReader: ContextVariableAgentSkillsReaderPort;
}

/**
 * Module-owned definition and enablement boundary. HTTP and Ray both call this
 * service so persisted configuration has one ownership and validation path.
 */
export class ContextVariableService {
  private readonly repository: ContextVariableRepositoryPort;
  private readonly agentReader: ContextVariableAgentReaderPort;
  private readonly agentSkillsReader: ContextVariableAgentSkillsReaderPort;

  constructor(options: ContextVariableServiceOptions) {
    this.repository = options.repository;
    this.agentReader = options.agentReader;
    this.agentSkillsReader = options.agentSkillsReader;
  }

  create(input: ContextVariableCreateRecord): Promise<ContextVariable> {
    return this.repository.create(input);
  }

  update(workspaceId: string, id: string, input: ContextVariableUpdateRecord): Promise<ContextVariable | null> {
    return this.repository.update(workspaceId, id, input);
  }

  delete(workspaceId: string, id: string): Promise<boolean> {
    return this.repository.delete(workspaceId, id);
  }

  listByWorkspace(workspaceId: string): Promise<ContextVariable[]> {
    return this.repository.listByWorkspace(workspaceId);
  }

  get(workspaceId: string, id: string): Promise<ContextVariable | null> {
    return this.repository.get(workspaceId, id);
  }

  async requireAgent(workspaceId: string, agentId: string): Promise<void> {
    const agent = await this.agentReader.get(workspaceId, agentId);
    if (!agent) throw notFound("Agent not found");
  }

  async requireVariable(workspaceId: string, variableId: string): Promise<ContextVariable> {
    const variable = await this.repository.get(workspaceId, variableId);
    if (!variable) throw notFound("Context variable not found");
    return variable;
  }

  async listByAgent(workspaceId: string, agentId: string): Promise<AgentContextVariableEnablement[]> {
    await this.requireAgent(workspaceId, agentId);
    return this.repository.listByAgent(workspaceId, agentId);
  }

  async upsertEnablement(input: AgentContextVariableEnablementRecord & { readonly workspaceId: string }): Promise<AgentContextVariableEnablement> {
    await this.assertEnablementReferences(input.workspaceId, input.agentId, input.variableId, input);
    const { workspaceId: _workspaceId, ...record } = input;
    return this.repository.upsertEnablement(record);
  }

  async deleteEnablement(workspaceId: string, agentId: string, variableId: string): Promise<boolean> {
    await this.requireAgent(workspaceId, agentId);
    await this.requireVariable(workspaceId, variableId);
    return this.repository.deleteEnablement(agentId, variableId);
  }

  async upsertValue(workspaceId: string, variableId: string, scope: ContextVariableScope, data: unknown): Promise<ContextVariableValue> {
    const variable = await this.requireVariable(workspaceId, variableId);
    if (!isValueCompatibleWithType(variable.valueType, data)) {
      throw badRequest(`Context variable value must match declared valueType '${variable.valueType}'`);
    }
    const size = Buffer.byteLength(JSON.stringify(data), "utf8");
    if (size > MAX_CONTEXT_VARIABLE_VALUE_BYTES) {
      throw badRequest("Context variable value exceeds maximum serialized size", {
        maxBytes: MAX_CONTEXT_VARIABLE_VALUE_BYTES,
        actualBytes: size,
      });
    }
    return this.repository.upsertValue(variableId, scope, data);
  }

  async readValue(workspaceId: string, variableId: string, scope: ContextVariableScope): Promise<ContextVariableValue | null> {
    await this.requireVariable(workspaceId, variableId);
    return this.repository.readValue(variableId, scope);
  }

  async deleteValue(workspaceId: string, variableId: string, scope: ContextVariableScope): Promise<boolean> {
    await this.requireVariable(workspaceId, variableId);
    return this.repository.deleteValue(variableId, scope);
  }

  async applyProposal(input: ApplyContextVariableProposalInput): Promise<ApplyContextVariableProposalResult> {
    await this.requireAgent(input.workspaceId, input.agentId);
    if (input.variableId) await this.requireVariable(input.workspaceId, input.variableId);
    if (input.enablement) {
      assertEnablementIsWellFormed(input.enablement);
      await this.assertResolverSkillReference(
        input.workspaceId,
        input.agentId,
        input.enablement,
        (skillId, state) => state === "missing"
          ? conflict(`Resolver skill "${skillId}" no longer exists on this agent`)
          : conflict(`Resolver skill "${skillId}" is disabled on this agent`),
      );
    }
    return this.repository.applyProposal(input);
  }

  async assertEnablementReferences(
    workspaceId: string,
    agentId: string,
    variableId: string | null,
    enablement: Pick<AgentContextVariableEnablementRecord, "source" | "resolverSkillId" | "maxAgeSeconds" | "resolverTimeoutMs">,
  ): Promise<void> {
    await this.requireAgent(workspaceId, agentId);
    if (variableId) await this.requireVariable(workspaceId, variableId);
    assertEnablementIsWellFormed(enablement);
    await this.assertResolverSkillReference(
      workspaceId,
      agentId,
      enablement,
      (skillId, state) => state === "missing"
        ? badRequest(`resolverSkillId "${skillId}" does not name a skill on this agent`)
        : badRequest(`resolverSkillId "${skillId}" names a skill that is disabled on this agent`),
    );
  }

  private async assertResolverSkillReference(
    workspaceId: string,
    agentId: string,
    enablement: Pick<AgentContextVariableEnablementRecord, "source" | "resolverSkillId">,
    errorFor: (skillId: string, state: "missing" | "disabled") => Error,
  ): Promise<void> {
    if (enablement.source !== "resolver" || !enablement.resolverSkillId) return;
    const skills = await this.agentSkillsReader.list(workspaceId, agentId);
    const skill = skills.find((candidate) => candidate.id === enablement.resolverSkillId);
    if (!skill) {
      throw errorFor(enablement.resolverSkillId, "missing");
    }
    if (!skill.enabled) {
      throw errorFor(enablement.resolverSkillId, "disabled");
    }
  }
}

export const assertEnablementIsWellFormed = (
  enablement: Pick<AgentContextVariableEnablementRecord, "source" | "resolverSkillId" | "maxAgeSeconds" | "resolverTimeoutMs">,
): void => {
  if (enablement.source === "browser") {
    throw badRequest("browser-sourced context variables are not yet supported");
  }
  if (enablement.source === "resolver") {
    if (!enablement.resolverSkillId) throw badRequest("resolverSkillId is required when source is resolver");
    return;
  }
  if (enablement.resolverSkillId !== undefined && enablement.resolverSkillId !== null) {
    throw badRequest("resolverSkillId is only allowed when source is resolver");
  }
  if (enablement.maxAgeSeconds !== undefined && enablement.maxAgeSeconds !== null) {
    throw badRequest("maxAgeSeconds is only allowed when source is resolver");
  }
  if (enablement.resolverTimeoutMs !== undefined && enablement.resolverTimeoutMs !== null) {
    throw badRequest("resolverTimeoutMs is only allowed when source is resolver");
  }
};
