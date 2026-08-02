import type {
  ConversationAgentConfig,
  DecisionOption,
  Directive,
  DirectiveBinding,
  DirectiveLifecycle,
  Routine,
  RoutineActivation,
  RoutineCompletionExport,
  RoutineFieldGuardOp,
  RoutineFieldGuardUnit,
  RoutineFieldGuardValue,
  RoutineGuard,
  RoutineInputBinding,
  RoutineReentryMode,
  RoutineSlotSchema,
  RoutineSlotType,
  RoutineStep,
  RoutineStepMode,
  RoutineTransition,
} from "@radioso/conversation-contract";

export type UpdateConversationKitAgentInput = Partial<Omit<ConversationAgentConfig, "id">>;
export type UpdateConversationKitDirectiveInput = Partial<Omit<Directive, "id">>;
export type UpdateConversationKitRoutineInput = Partial<Omit<Routine, "id">>;

export interface ConversationKitAuthoringStore {
  createAgent(agent: ConversationAgentConfig): ConversationAgentConfig;
  getAgent(agentId: string): ConversationAgentConfig | null;
  listAgents(): ConversationAgentConfig[];
  updateAgent(agentId: string, input: UpdateConversationKitAgentInput): ConversationAgentConfig | null;
  deleteAgent(agentId: string): boolean;

  createDirective(agentId: string, directive: Directive): Directive;
  getDirective(agentId: string, directiveId: string): Directive | null;
  listDirectives(agentId: string): Directive[];
  updateDirective(agentId: string, directiveId: string, input: UpdateConversationKitDirectiveInput): Directive | null;
  deleteDirective(agentId: string, directiveId: string): boolean;

  createRoutine(routine: Routine): Routine;
  getRoutine(routineId: string): Routine | null;
  listRoutines(): Routine[];
  updateRoutine(routineId: string, input: UpdateConversationKitRoutineInput): Routine | null;
  deleteRoutine(routineId: string): boolean;
}

interface StoredDirective {
  agentId: string;
  directive: Directive;
}

/** The portable shape a persistent adapter reads and writes. */
export interface ConversationKitAuthoringSnapshot {
  agents: ConversationAgentConfig[];
  directives: StoredDirective[];
  routines: Routine[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const cloneValue = <T>(value: T): T => {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneValue(entry)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]),
    ) as T;
  }
  return value;
};

const cloneRecord = <T extends Record<string, unknown>>(value: T | undefined): T | undefined =>
  value ? cloneValue(value) : undefined;

const parseStringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;

/**
 * Sentinel for "this authored value is structurally invalid". A plain `null`
 * cannot express it because `null` is itself a legal authored value for
 * nullable contract fields such as `Directive.binding`.
 */
const INVALID = Symbol("conversation_kit_invalid_value");
type Invalid = typeof INVALID;
type Parser<T> = (value: unknown) => T | Invalid;

const isInvalid = (value: unknown): value is Invalid => value === INVALID;

/** Absent optionals stay absent; present ones must parse or the owner is rejected. */
const parseOptional = <T>(value: unknown, parse: Parser<T>): T | undefined | Invalid =>
  value === undefined ? undefined : parse(value);

/** As {@link parseOptional}, for contract fields whose type includes `null`. */
const parseOptionalNullable = <T>(value: unknown, parse: Parser<T>): T | null | undefined | Invalid =>
  value === null ? null : parseOptional(value, parse);

const parseArrayOf = <T>(value: unknown, parse: Parser<T>): T[] | Invalid => {
  if (!Array.isArray(value)) {
    return INVALID;
  }
  const entries: T[] = [];
  for (const entry of value) {
    const parsed = parse(entry);
    if (isInvalid(parsed)) {
      return INVALID;
    }
    entries.push(parsed);
  }
  return entries;
};

const parseRecordOf = <T>(value: unknown, parse: Parser<T>): Record<string, T> | Invalid => {
  if (!isRecord(value)) {
    return INVALID;
  }
  const record: Record<string, T> = {};
  for (const [key, entry] of Object.entries(value)) {
    const parsed = parse(entry);
    if (isInvalid(parsed)) {
      return INVALID;
    }
    record[key] = parsed;
  }
  return record;
};

const parseString = (value: unknown): string | Invalid => (typeof value === "string" ? value : INVALID);

const parseFiniteNumber = (value: unknown): number | Invalid =>
  typeof value === "number" && Number.isFinite(value) ? value : INVALID;

/** Builds a parser that accepts only the listed literal members of a string union. */
const literalUnionParser = <T extends string>(members: readonly T[]): Parser<T> =>
  (value: unknown): T | Invalid =>
    typeof value === "string" && (members as readonly string[]).includes(value)
      ? (value as T)
      : INVALID;

const parseDirectiveBinding: Parser<DirectiveBinding> = (value) =>
  isRecord(value) && value.kind === "skill" && typeof value.skillName === "string"
    ? { kind: "skill", skillName: value.skillName }
    : INVALID;

const parseDirectiveLifecycle: Parser<DirectiveLifecycle> = (value) => {
  if (!isRecord(value)) {
    return INVALID;
  }
  if (value.kind === "repeatable" || value.kind === "once_per_conversation") {
    return { kind: value.kind };
  }
  if (value.kind === "cooldown") {
    const turns = parseFiniteNumber(value.turns);
    return isInvalid(turns) ? INVALID : { kind: "cooldown", turns };
  }
  return INVALID;
};

const parseAgent = (value: unknown): ConversationAgentConfig | null => {
  if (!isRecord(value) || typeof value.id !== "string") {
    return null;
  }
  return {
    id: value.id,
    name: typeof value.name === "string" ? value.name : undefined,
    instructions: parseStringArray(value.instructions),
    defaultLocale: typeof value.defaultLocale === "string" || value.defaultLocale === null
      ? value.defaultLocale
      : undefined,
    model: value.model === null
      ? null
      : isRecord(value.model)
        ? {
          provider: typeof value.model.provider === "string" ? value.model.provider : undefined,
          model: typeof value.model.model === "string" ? value.model.model : undefined,
        }
        : undefined,
    metadata: isRecord(value.metadata) ? cloneRecord(value.metadata) : undefined,
  };
};

const parseDirective = (value: unknown): Directive | null => {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.action !== "string") {
    return null;
  }
  const condition = value.condition;
  if (!isRecord(condition)) {
    return null;
  }
  const parsedCondition = condition.kind === "always"
    ? { kind: "always" as const }
    : condition.kind === "contextual" && typeof condition.description === "string"
      ? { kind: "contextual" as const, description: condition.description }
      : null;
  if (!parsedCondition) {
    return null;
  }
  const binding = parseOptionalNullable(value.binding, parseDirectiveBinding);
  const lifecycle = parseOptional(value.lifecycle, parseDirectiveLifecycle);
  if (isInvalid(binding) || isInvalid(lifecycle)) {
    return null;
  }
  return {
    id: typeof value.id === "string" ? value.id : undefined,
    name: value.name,
    condition: parsedCondition,
    action: value.action,
    binding,
    tags: parseStringArray(value.tags),
    lifecycle,
    priority: typeof value.priority === "number" ? value.priority : undefined,
    requiredCapabilities: parseStringArray(value.requiredCapabilities),
    dependsOn: parseStringArray(value.dependsOn),
    excludes: parseStringArray(value.excludes),
    description: typeof value.description === "string" ? value.description : undefined,
    metadata: isRecord(value.metadata) ? cloneRecord(value.metadata) : undefined,
  };
};

const parseRoutineStepKind = literalUnionParser<RoutineStep["kind"]>([
  "chat",
  "skill",
  "action",
  "terminal",
  "await",
]);

const parseRoutineStepMode = literalUnionParser<RoutineStepMode>(["typed", "untyped"]);

const parseDecisionOption: Parser<DecisionOption> = (value) => {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.label !== "string") {
    return INVALID;
  }
  return {
    id: value.id,
    label: value.label,
    description: typeof value.description === "string" ? value.description : undefined,
    // `payload` is contract-typed `unknown`: carry it through without shaping it.
    payload: "payload" in value ? cloneValue(value.payload) : undefined,
  };
};

const parseRoutineStepDecision: Parser<NonNullable<RoutineStep["decision"]>> = (value) => {
  if (!isRecord(value) || typeof value.captureKey !== "string") {
    return INVALID;
  }
  const options = parseArrayOf(value.options, parseDecisionOption);
  return isInvalid(options) ? INVALID : { captureKey: value.captureKey, options };
};

const parseRoutineInputBinding: Parser<RoutineInputBinding> = (value) => {
  if (!isRecord(value)) {
    return INVALID;
  }
  if (value.kind === "literal") {
    const literal = value.value;
    return typeof literal === "string" || typeof literal === "number" || typeof literal === "boolean"
      ? { kind: "literal", value: literal }
      : INVALID;
  }
  if (value.kind === "variableRef") {
    return typeof value.ref === "string" ? { kind: "variableRef", ref: value.ref } : INVALID;
  }
  if (value.kind === "contextVariableRef") {
    return typeof value.contextVariable === "string"
      ? { kind: "contextVariableRef", contextVariable: value.contextVariable }
      : INVALID;
  }
  return INVALID;
};

const parseRoutineStep = (value: unknown): RoutineStep | null => {
  if (!isRecord(value) || typeof value.id !== "string") {
    return null;
  }
  const kind = parseRoutineStepKind(value.kind);
  const decision = parseOptional(value.decision, parseRoutineStepDecision);
  const inputBindings = parseOptional(
    value.inputBindings,
    (entry) => parseRecordOf(entry, parseRoutineInputBinding),
  );
  const outputAssignments = parseOptional(
    value.outputAssignments,
    (entry) => parseRecordOf(entry, parseString),
  );
  const mode = parseOptional(value.mode, parseRoutineStepMode);
  if (
    isInvalid(kind) ||
    isInvalid(decision) ||
    isInvalid(inputBindings) ||
    isInvalid(outputAssignments) ||
    isInvalid(mode)
  ) {
    return null;
  }
  return {
    id: value.id,
    kind,
    action: typeof value.action === "string" ? value.action : undefined,
    skillName: typeof value.skillName === "string" ? value.skillName : undefined,
    actionType: typeof value.actionType === "string" ? value.actionType : undefined,
    decision,
    inputBindings,
    outputAssignments,
    mode,
    metadata: isRecord(value.metadata) ? cloneRecord(value.metadata) : undefined,
  };
};

const parseRoutineFieldGuardOp = literalUnionParser<RoutineFieldGuardOp>([
  "is_true",
  "is_false",
  "equals",
  "not_equals",
  "in",
  "is_present",
  "is_absent",
  "gt",
  "gte",
  "lt",
  "lte",
  "older_than",
  "within",
]);

const parseRoutineFieldGuardUnit = literalUnionParser<RoutineFieldGuardUnit>([
  "days",
  "weeks",
  "months",
  "years",
]);

const parseRoutineFieldGuardValue: Parser<RoutineFieldGuardValue> = (value) =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : INVALID;

const parseRoutineFieldGuard = (value: Record<string, unknown>): RoutineGuard | Invalid => {
  const ref = parseString(value.ref);
  const op = parseRoutineFieldGuardOp(value.op);
  const fieldValue = parseOptional(value.value, parseRoutineFieldGuardValue);
  const values = parseOptional(value.values, (entry) => parseArrayOf(entry, parseRoutineFieldGuardValue));
  const unit = parseOptional(value.unit, parseRoutineFieldGuardUnit);
  if (isInvalid(ref) || isInvalid(op) || isInvalid(fieldValue) || isInvalid(values) || isInvalid(unit)) {
    return INVALID;
  }
  return { kind: "field", ref, op, value: fieldValue, values, unit };
};

const parseRoutineGuard: Parser<RoutineGuard> = (value) => {
  if (!isRecord(value)) {
    return INVALID;
  }
  switch (value.kind) {
    case "slot_filled": {
      const slots = parseArrayOf(value.slots, parseString);
      return isInvalid(slots) ? INVALID : { kind: "slot_filled", slots };
    }
    case "outcome": {
      const status = parseString(value.status);
      return isInvalid(status) ? INVALID : { kind: "outcome", status };
    }
    case "counter": {
      const limit = parseFiniteNumber(value.limit);
      return isInvalid(limit) ? INVALID : { kind: "counter", limit };
    }
    case "field":
      return parseRoutineFieldGuard(value);
    case "default":
      return { kind: "default" };
    case "llm":
      return { kind: "llm" };
    default:
      return INVALID;
  }
};

const parseRoutineTransition = (value: unknown): RoutineTransition | null => {
  if (
    !isRecord(value) ||
    typeof value.from !== "string" ||
    typeof value.to !== "string" ||
    typeof value.condition !== "string"
  ) {
    return null;
  }
  const guard = parseOptional(value.guard, parseRoutineGuard);
  if (isInvalid(guard)) {
    return null;
  }
  return {
    from: value.from,
    to: value.to,
    condition: value.condition,
    guard,
  };
};

const parseRoutineSlotType = literalUnionParser<RoutineSlotType>([
  "text",
  "number",
  "boolean",
  "email",
  "date",
]);

const parseRoutineSlot: Parser<RoutineSlotSchema> = (value) => {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.key !== "string" ||
    typeof value.required !== "boolean"
  ) {
    return INVALID;
  }
  const type = parseRoutineSlotType(value.type);
  if (isInvalid(type)) {
    return INVALID;
  }
  return {
    id: value.id,
    key: value.key,
    type,
    required: value.required,
    description: typeof value.description === "string" ? value.description : undefined,
    mutable: typeof value.mutable === "boolean" ? value.mutable : undefined,
  };
};

const parseRoutineCompletionTriggerKind = literalUnionParser<RoutineCompletionExport["triggerKinds"][number]>([
  "complete",
  "handoff",
]);

const parseRoutineCompletionExport: Parser<RoutineCompletionExport> = (value) => {
  if (!isRecord(value) || typeof value.enabled !== "boolean" || typeof value.destinationRef !== "string") {
    return INVALID;
  }
  const triggerKinds = parseArrayOf(value.triggerKinds, parseRoutineCompletionTriggerKind);
  return isInvalid(triggerKinds)
    ? INVALID
    : { enabled: value.enabled, triggerKinds, destinationRef: value.destinationRef };
};

const parseRoutineReentryMode = literalUnionParser<RoutineReentryMode>([
  "once_per_conversation",
  "always",
  "semantic",
]);

const parseRoutineActivation: Parser<RoutineActivation> = (value) => {
  if (!isRecord(value) || typeof value.triggerDescription !== "string") {
    return INVALID;
  }
  const priority = parseFiniteNumber(value.priority);
  const reentryMode = parseRoutineReentryMode(value.reentryMode);
  if (isInvalid(priority) || isInvalid(reentryMode)) {
    return INVALID;
  }
  return {
    triggerDescription: value.triggerDescription,
    priority,
    reentryMode,
    gateRef: typeof value.gateRef === "string" ? value.gateRef : undefined,
  };
};

const parseRoutine = (value: unknown): Routine | null => {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.rootStepId !== "string") {
    return null;
  }
  if (!Array.isArray(value.steps) || !Array.isArray(value.transitions)) {
    return null;
  }
  const parsedSteps = value.steps.map(parseRoutineStep);
  const parsedTransitions = value.transitions.map(parseRoutineTransition);
  if (parsedSteps.some((entry) => entry === null) || parsedTransitions.some((entry) => entry === null)) {
    return null;
  }
  const steps = parsedSteps.filter((entry): entry is Routine["steps"][number] => entry !== null);
  const transitions = parsedTransitions.filter((entry): entry is Routine["transitions"][number] => entry !== null);
  const slots = parseOptional(value.slots, (entry) => parseArrayOf(entry, parseRoutineSlot));
  const completionExport = parseOptional(value.completionExport, parseRoutineCompletionExport);
  const activation = parseOptional(value.activation, parseRoutineActivation);
  if (isInvalid(slots) || isInvalid(completionExport) || isInvalid(activation)) {
    return null;
  }
  return {
    id: value.id,
    rootStepId: value.rootStepId,
    slots,
    steps,
    transitions,
    completionExport,
    activation,
    metadata: isRecord(value.metadata) ? cloneRecord(value.metadata) : undefined,
  };
};

export const emptySnapshot = (): ConversationKitAuthoringSnapshot => ({
  agents: [],
  directives: [],
  routines: [],
});

export const parseSnapshot = (value: unknown): ConversationKitAuthoringSnapshot => {
  if (!isRecord(value)) {
    return emptySnapshot();
  }
  const agents = Array.isArray(value.agents)
    ? value.agents.flatMap((entry) => {
      const parsed = parseAgent(entry);
      return parsed ? [parsed] : [];
    })
    : [];
  const directives = Array.isArray(value.directives)
    ? value.directives.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.agentId !== "string") {
        return [];
      }
      const directive = parseDirective(entry.directive);
      return directive ? [{ agentId: entry.agentId, directive }] : [];
    })
    : [];
  const routines = Array.isArray(value.routines)
    ? value.routines.flatMap((entry) => {
      const parsed = parseRoutine(entry);
      return parsed ? [parsed] : [];
    })
    : [];
  return { agents, directives, routines };
};

export class TransientConversationKitAuthoringStore implements ConversationKitAuthoringStore {
  private readonly agents = new Map<string, ConversationAgentConfig>();
  private readonly directivesByAgent = new Map<string, Map<string, Directive>>();
  private readonly routines = new Map<string, Routine>();

  constructor(snapshot: ConversationKitAuthoringSnapshot = emptySnapshot()) {
    for (const agent of snapshot.agents) {
      this.agents.set(agent.id, cloneValue(agent));
    }
    for (const entry of snapshot.directives) {
      if (entry.directive.id) {
        this.directiveMap(entry.agentId).set(entry.directive.id, cloneValue(entry.directive));
      }
    }
    for (const routine of snapshot.routines) {
      this.routines.set(routine.id, cloneValue(routine));
    }
  }

  createAgent(agent: ConversationAgentConfig): ConversationAgentConfig {
    if (this.agents.has(agent.id)) {
      throw new Error(`conversation_kit_agent_already_exists:${agent.id}`);
    }
    this.agents.set(agent.id, cloneValue(agent));
    this.changed();
    return cloneValue(agent);
  }

  getAgent(agentId: string): ConversationAgentConfig | null {
    const agent = this.agents.get(agentId);
    return agent ? cloneValue(agent) : null;
  }

  listAgents(): ConversationAgentConfig[] {
    return [...this.agents.values()].map((agent) => cloneValue(agent));
  }

  updateAgent(agentId: string, input: UpdateConversationKitAgentInput): ConversationAgentConfig | null {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return null;
    }
    const updated: ConversationAgentConfig = { ...agent, ...cloneValue(input), id: agentId };
    this.agents.set(agentId, updated);
    this.changed();
    return cloneValue(updated);
  }

  deleteAgent(agentId: string): boolean {
    const deleted = this.agents.delete(agentId);
    this.directivesByAgent.delete(agentId);
    if (deleted) {
      this.changed();
    }
    return deleted;
  }

  createDirective(agentId: string, directive: Directive): Directive {
    this.requireAgent(agentId);
    if (!directive.id) {
      throw new Error("conversation_kit_directive_id_required");
    }
    const directives = this.directiveMap(agentId);
    if (directives.has(directive.id)) {
      throw new Error(`conversation_kit_directive_already_exists:${directive.id}`);
    }
    directives.set(directive.id, cloneValue(directive));
    this.changed();
    return cloneValue(directive);
  }

  getDirective(agentId: string, directiveId: string): Directive | null {
    const directive = this.directivesByAgent.get(agentId)?.get(directiveId);
    return directive ? cloneValue(directive) : null;
  }

  listDirectives(agentId: string): Directive[] {
    return [...(this.directivesByAgent.get(agentId)?.values() ?? [])].map((directive) => cloneValue(directive));
  }

  updateDirective(agentId: string, directiveId: string, input: UpdateConversationKitDirectiveInput): Directive | null {
    const directive = this.directivesByAgent.get(agentId)?.get(directiveId);
    if (!directive) {
      return null;
    }
    const updated: Directive = { ...directive, ...cloneValue(input), id: directiveId };
    this.directiveMap(agentId).set(directiveId, updated);
    this.changed();
    return cloneValue(updated);
  }

  deleteDirective(agentId: string, directiveId: string): boolean {
    const deleted = this.directivesByAgent.get(agentId)?.delete(directiveId) ?? false;
    if (deleted) {
      this.changed();
    }
    return deleted;
  }

  createRoutine(routine: Routine): Routine {
    if (this.routines.has(routine.id)) {
      throw new Error(`conversation_kit_routine_already_exists:${routine.id}`);
    }
    this.routines.set(routine.id, cloneValue(routine));
    this.changed();
    return cloneValue(routine);
  }

  getRoutine(routineId: string): Routine | null {
    const routine = this.routines.get(routineId);
    return routine ? cloneValue(routine) : null;
  }

  listRoutines(): Routine[] {
    return [...this.routines.values()].map((routine) => cloneValue(routine));
  }

  updateRoutine(routineId: string, input: UpdateConversationKitRoutineInput): Routine | null {
    const routine = this.routines.get(routineId);
    if (!routine) {
      return null;
    }
    const updated: Routine = { ...routine, ...cloneValue(input), id: routineId };
    this.routines.set(routineId, updated);
    this.changed();
    return cloneValue(updated);
  }

  deleteRoutine(routineId: string): boolean {
    const deleted = this.routines.delete(routineId);
    if (deleted) {
      this.changed();
    }
    return deleted;
  }

  protected exportSnapshot(): ConversationKitAuthoringSnapshot {
    return {
      agents: this.listAgents(),
      directives: [...this.directivesByAgent.entries()].flatMap(([agentId, directives]) =>
        [...directives.values()].map((directive) => ({ agentId, directive: cloneValue(directive) })),
      ),
      routines: this.listRoutines(),
    };
  }

  protected changed(): void {
    return;
  }

  private directiveMap(agentId: string): Map<string, Directive> {
    const existing = this.directivesByAgent.get(agentId);
    if (existing) {
      return existing;
    }
    const created = new Map<string, Directive>();
    this.directivesByAgent.set(agentId, created);
    return created;
  }

  private requireAgent(agentId: string): void {
    if (!this.agents.has(agentId)) {
      throw new Error(`conversation_kit_agent_not_found:${agentId}`);
    }
  }
}
