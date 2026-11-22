import type {
  AgentContextVariableEnablementRecord,
  ApplyContextVariableProposalInput,
  ApplyContextVariableProposalOptions,
  ApplyContextVariableProposalResult,
  ContextVariableCreateRecord,
  ContextVariableDefinitionWrite,
  ContextVariableRepositoryPort,
  ContextVariableUpdateRecord,
} from "../repository.js";
import { badRequest, conflict, notFound } from "../../../shared/domain/errors.js";
import {
  RESERVED_CONTEXT_VARIABLE_PREFIX,
  classificationRefusal,
  isReservedContextVariableName,
  typeChangeWithValuesRefused,
  type ClassificationRefusal,
} from "../domain.js";
import { CONTEXT_VARIABLES_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import {
  validateOptions,
  validateValue,
  type OptionsValidationCode,
  type ValueValidationCode,
} from "../valueValidation.js";
import type {
  AgentContextVariableEnablement,
  ContextValueWriter,
  ContextVariableSource,
  ContextVariable,
  ContextVariableOption,
  ContextVariableScope,
  ContextVariableValue,
  ContextVariableValueType,
} from "../domain.js";

const MAX_CONTEXT_VARIABLE_VALUE_BYTES = 32 * 1024;

/** The only agent capability context-variable definitions require. */
interface ContextVariableAgentReaderPort {
  get(workspaceId: string, agentId: string): Promise<{ readonly id: string } | null>;
}

/** The only skill capability resolver-backed variables require. */
interface ContextVariableAgentSkillsReaderPort {
  list(workspaceId: string, agentId: string): Promise<ReadonlyArray<{ readonly id: string; readonly enabled: boolean }>>;
}

interface ContextVariableServiceOptions {
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

  // `async` so a rejected name arrives as a rejected promise rather than a synchronous throw from
  // a method whose signature says it returns one; a caller using `.catch()` would otherwise miss it.
  async create(input: ContextVariableCreateRecord): Promise<ContextVariable> {
    this.assertNameIsNotReserved(input.name);
    assertOptionsFit(input.valueType, input.options ?? null, null);
    return this.repository.create({ ...input, options: input.options ?? null });
  }

  /**
   * Called from all three write paths this service exposes — `create`, `update`, and
   * `applyProposal` — so the namespace is defended once rather than at each caller of the service.
   */
  private assertNameIsNotReserved(name: string | undefined): void {
    if (name !== undefined && isReservedContextVariableName(name)) {
      throw badRequest(`Context variable names starting with "${RESERVED_CONTEXT_VARIABLE_PREFIX}" are reserved for facts Radioso establishes about a turn`);
    }
  }

  async update(workspaceId: string, id: string, input: ContextVariableUpdateRecord): Promise<ContextVariable | null> {
    this.assertNameIsNotReserved(input.name);
    const typed = input.valueType !== undefined || input.options !== undefined;
    const changesClassifiability = input.valueType !== undefined || input.sensitivity !== undefined || input.trustTier !== undefined;
    if (!typed && !changesClassifiability) {
      return this.repository.update(workspaceId, id, input);
    }
    const current = await this.repository.get(workspaceId, id);
    if (!current) return null;
    const definition = typed ? await this.typedDefinitionAfterEdit(current, input.valueType, input.options) : {};
    if (changesClassifiability) {
      await this.assertDefinitionKeepsClassification(current, { ...current, ...input }, null);
    }
    return this.repository.update(workspaceId, id, { ...input, ...definition });
  }

  /**
   * The type and options a definition has after an edit. Options the edit leaves out stay as stored
   * while the type stays; the type of a variable that has values cannot change, since its values
   * would no longer be of it.
   */
  private async typedDefinitionAfterEdit(
    current: ContextVariable,
    valueType: ContextVariableValueType | undefined,
    options: readonly ContextVariableOption[] | null | undefined,
  ): Promise<{ valueType: ContextVariableValueType; options: readonly ContextVariableOption[] | null }> {
    const nextType = valueType ?? current.valueType;
    const typeChanges = nextType !== current.valueType;
    const nextOptions = options !== undefined ? options : typeChanges ? null : current.options;
    assertOptionsFit(nextType, nextOptions, typeChanges ? null : current.options);
    if (typeChanges && await this.repository.hasValues(current.id)) {
      throw typeChangeWithValuesRefused();
    }
    return { valueType: nextType, options: nextOptions };
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

  async upsertValue(
    workspaceId: string,
    variableId: string,
    scope: ContextVariableScope,
    data: unknown,
    writtenBy: ContextValueWriter,
  ): Promise<ContextVariableValue> {
    const variable = await this.requireVariable(workspaceId, variableId);
    const verdict = validateValue(variable, data);
    if (!verdict.ok) {
      throw badRequest(valueFaultMessages[verdict.code](variable));
    }
    const size = Buffer.byteLength(JSON.stringify(data), "utf8");
    if (size > MAX_CONTEXT_VARIABLE_VALUE_BYTES) {
      throw badRequest("Context variable value exceeds maximum serialized size", {
        maxBytes: MAX_CONTEXT_VARIABLE_VALUE_BYTES,
        actualBytes: size,
      });
    }
    const saved = await this.repository.upsertValue(variableId, scope, data, writtenBy);
    if (!saved) throw conflict("The stored context variable value was kept: it was set by a writer this one does not replace");
    return saved;
  }

  async readValue(workspaceId: string, variableId: string, scope: ContextVariableScope): Promise<ContextVariableValue | null> {
    await this.requireVariable(workspaceId, variableId);
    return this.repository.readValue(variableId, scope);
  }

  async deleteValue(workspaceId: string, variableId: string, scope: ContextVariableScope): Promise<boolean> {
    await this.requireVariable(workspaceId, variableId);
    return this.repository.deleteValue(variableId, scope);
  }

  async applyProposal(input: ApplyContextVariableProposalInput, options?: ApplyContextVariableProposalOptions): Promise<ApplyContextVariableProposalResult> {
    // A proposal with a null `variableId` inserts a brand-new variable, so this is a third write
    // path and not a variant of `update`. A Ray-proposed `radioso_`-prefixed name would otherwise be
    // created and then permanently shadowed by the reserved key, leaving a variable that never reads.
    this.assertNameIsNotReserved(input.definition?.name);
    await this.requireAgent(input.workspaceId, input.agentId);
    const current = input.variableId ? await this.requireVariable(input.workspaceId, input.variableId) : null;
    if (input.definition) {
      // A proposal restates the whole definition as it was drafted, so once the variable has moved
      // its options and type no longer say what the operator meant: it is stale, whatever they hold.
      if (current && !draftedAgainst(current, input.expectedVariableUpdatedAt)) {
        throw conflict("Context variable was updated by another writer; reload before saving again");
      }
      await this.assertDefinitionTypeFits(current, input.definition);
      if (current) {
        await this.assertDefinitionKeepsClassification(current, input.definition, { agentId: input.agentId, source: input.enablement?.source ?? null });
      }
    }
    if (input.enablement) {
      assertEnablementIsWellFormed(input.enablement);
      await this.assertClassificationFits(input.workspaceId, input.agentId, input.variableId, input.enablement, input.definition ?? current);
      await this.assertResolverSkillReference(
        input.workspaceId,
        input.agentId,
        input.enablement,
        (skillId, state) => state === "missing"
          ? conflict(`Resolver skill "${skillId}" no longer exists on this agent`)
          : conflict(`Resolver skill "${skillId}" is disabled on this agent`),
      );
    }
    return options ? this.repository.applyProposal(input, options) : this.repository.applyProposal(input);
  }

  /**
   * Refuses a full definition whose type and options do not fit, for a new variable when `current`
   * is null or as an edit of `current`. Ray checks a proposal with it when the proposal is drafted,
   * against the read it drafted from, and `applyProposal` again when it is applied.
   */
  async assertDefinitionTypeFits(
    current: ContextVariable | null,
    definition: Pick<ContextVariableDefinitionWrite, "valueType" | "options">,
  ): Promise<void> {
    if (!current) {
      assertOptionsFit(definition.valueType, definition.options, null);
      return;
    }
    await this.typedDefinitionAfterEdit(current, definition.valueType, definition.options);
  }

  /**
   * `definition` is the one the enablement will be paired with: a proposal's own, when it writes
   * one, else the stored definition is read.
   */
  async assertEnablementReferences(
    workspaceId: string,
    agentId: string,
    variableId: string | null,
    enablement: Pick<AgentContextVariableEnablementRecord, "source" | "resolverSkillId" | "maxAgeSeconds" | "resolverTimeoutMs" | "enabled">,
    definition?: ClassifiableDefinition | null,
  ): Promise<void> {
    await this.requireAgent(workspaceId, agentId);
    const stored = variableId ? await this.requireVariable(workspaceId, variableId) : null;
    assertEnablementIsWellFormed(enablement);
    await this.assertClassificationFits(workspaceId, agentId, variableId, enablement, definition ?? stored);
    await this.assertResolverSkillReference(
      workspaceId,
      agentId,
      enablement,
      (skillId, state) => state === "missing"
        ? badRequest(`resolverSkillId "${skillId}" does not name a skill on this agent`)
        : badRequest(`resolverSkillId "${skillId}" names a skill that is disabled on this agent`),
    );
  }

  /**
   * A `classified` enablement needs a definition the classifier may fill, and an agent fills at most
   * `maxClassifiedPerAgent`, since they all go in one model call. A disabled one is not counted.
   */
  private async assertClassificationFits(
    workspaceId: string,
    agentId: string,
    variableId: string | null,
    enablement: Pick<AgentContextVariableEnablementRecord, "source" | "enabled">,
    definition: ClassifiableDefinition | null,
  ): Promise<void> {
    if (enablement.source !== "classified") return;
    const refusal = definition ? classificationRefusal(definition) : "not_choice";
    if (refusal) throw badRequest(classificationRefusalMessages[refusal], { code: "context_variable_not_classifiable", reason: refusal });
    if (enablement.enabled === false) return;
    const others = (await this.repository.listByAgent(workspaceId, agentId))
      .filter((candidate) => candidate.enabled && candidate.source === "classified" && candidate.variableId !== variableId);
    if (others.length >= CONTEXT_VARIABLES_BEHAVIOR.maxClassifiedPerAgent) {
      throw badRequest(
        `An agent can classify at most ${CONTEXT_VARIABLES_BEHAVIOR.maxClassifiedPerAgent} attributes (source "classified")`,
        { code: "too_many_classified_context_variables" },
      );
    }
  }

  /**
   * Refuses an edit that leaves `current` a definition the classifier could no longer fill while an
   * agent's draft has it do so. A definition it could not fill before has no such agent.
   * `proposal` names the agent whose own enablement the same write replaces, by its new source, so a
   * proposal that moves its agent off `classified` and makes the variable private in one step applies.
   */
  async assertDefinitionKeepsClassification(
    current: ClassifiableDefinition & Pick<ContextVariable, "id">,
    definition: ClassifiableDefinition,
    proposal: { agentId: string; source: ContextVariableSource | null } | null,
  ): Promise<void> {
    if (classificationRefusal(current) || !classificationRefusal(definition)) return;
    const agentIds = await this.repository.classifiedEnablementAgentIds(current.id);
    const stillClassifying = agentIds.filter((agentId) => !(proposal && proposal.agentId === agentId && proposal.source !== null && proposal.source !== "classified"));
    if (stillClassifying.length > 0) {
      throw badRequest(
        'An agent fills this attribute with source "classified", so it must stay a Choice (enum) attribute that is neither Private (sensitive) nor treated as proof (signed)',
        { code: "context_variable_classified", agentIds: stillClassifying },
      );
    }
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

type ClassifiableDefinition = Pick<ContextVariable, "valueType" | "sensitivity" | "trustTier">;

const classificationRefusalMessages: Record<ClassificationRefusal, string> = {
  not_choice: 'Only a Choice (enum) attribute can use source "classified"',
  private: 'A Private (sensitive) attribute cannot use source "classified"',
  proof: 'An attribute treated as proof (signed) cannot use source "classified": the AI reads it from what the visitor typed',
};

/** Whether `current` is still the version a proposal was drafted against; no version names any. */
const draftedAgainst = (current: ContextVariable, expectedUpdatedAt: Date | null): boolean =>
  expectedUpdatedAt === null || current.updatedAt.getTime() === expectedUpdatedAt.getTime();

const valueFaultMessages: Record<ValueValidationCode, (variable: ContextVariable) => string> = {
  type_mismatch: (variable) => `Context variable value must match declared valueType '${variable.valueType}'`,
  unknown_option: () => "Context variable value must be the key of one of its options",
  archived_option: () => "Context variable value names an archived option",
};

const optionsFaultMessages: Record<OptionsValidationCode, string> = {
  options_required: "An enum context variable needs at least one option",
  options_not_allowed: "Only an enum context variable has options",
  too_many_options: "An enum context variable has too many options",
  invalid_option_key: "An option key starts with a letter and uses letters, digits and underscores",
  duplicate_option_key: "Each option key appears once, whatever its case",
  invalid_option_label: "Each option needs a label within the length limit",
  option_description_too_long: "An option description is too long",
  option_removed: "Options are archived, not removed: keep every existing option key",
  active_option_required: "An enum context variable needs at least one option that is not archived",
};

const assertOptionsFit = (
  valueType: ContextVariableValueType,
  options: readonly ContextVariableOption[] | null,
  previous: readonly ContextVariableOption[] | null,
): void => {
  const verdict = validateOptions(valueType, options, previous);
  if (!verdict.ok) throw badRequest(optionsFaultMessages[verdict.code], { code: verdict.code });
};

const assertEnablementIsWellFormed = (
  enablement: Pick<AgentContextVariableEnablementRecord, "source" | "resolverSkillId" | "maxAgeSeconds" | "resolverTimeoutMs">,
): void => {
  if (enablement.source === "browser") {
    throw badRequest("browser-sourced context variables are not yet supported");
  }
  // visitor_request (the only request-sourced built-in) resolves unconditionally from
  // the conversation, like page_context and visitor_identity — there is no per-agent
  // enablement row to create, whether through the HTTP route, a Ray proposal apply, or
  // an agent bundle import.
  if (enablement.source === "request") {
    throw badRequest("request-sourced context variables are not yet supported");
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
