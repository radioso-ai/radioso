import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { ConversationAgentConfig, Directive, Routine } from "@radioso/conversation-contract";

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

interface ConversationKitAuthoringSnapshot {
  agents: ConversationAgentConfig[];
  directives: StoredDirective[];
  routines: Routine[];
}

export interface FileConversationKitAuthoringStoreOptions {
  path: string;
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
    model: isRecord(value.model)
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
  return {
    id: typeof value.id === "string" ? value.id : undefined,
    name: value.name,
    condition: parsedCondition,
    action: value.action,
    priority: typeof value.priority === "number" ? value.priority : undefined,
    criticality: value.criticality === "low" || value.criticality === "medium" || value.criticality === "high"
      ? value.criticality
      : undefined,
    requiredCapabilities: parseStringArray(value.requiredCapabilities),
    dependsOn: parseStringArray(value.dependsOn),
    excludes: parseStringArray(value.excludes),
    description: typeof value.description === "string" ? value.description : undefined,
    metadata: isRecord(value.metadata) ? cloneRecord(value.metadata) : undefined,
  };
};

const parseRoutineStep = (value: unknown): Routine["steps"][number] | null => {
  if (!isRecord(value) || typeof value.id !== "string") {
    return null;
  }
  if (value.kind !== "chat" && value.kind !== "skill" && value.kind !== "action" && value.kind !== "terminal") {
    return null;
  }
  return {
    id: value.id,
    kind: value.kind,
    action: typeof value.action === "string" ? value.action : undefined,
    skillName: typeof value.skillName === "string" ? value.skillName : undefined,
    actionType: typeof value.actionType === "string" ? value.actionType : undefined,
    metadata: isRecord(value.metadata) ? cloneRecord(value.metadata) : undefined,
  };
};

const parseRoutineTransition = (value: unknown): Routine["transitions"][number] | null => {
  if (
    !isRecord(value) ||
    typeof value.from !== "string" ||
    typeof value.to !== "string" ||
    typeof value.condition !== "string"
  ) {
    return null;
  }
  return {
    from: value.from,
    to: value.to,
    condition: value.condition,
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
  return {
    id: value.id,
    rootStepId: value.rootStepId,
    steps,
    transitions,
    metadata: isRecord(value.metadata) ? cloneRecord(value.metadata) : undefined,
  };
};

const emptySnapshot = (): ConversationKitAuthoringSnapshot => ({
  agents: [],
  directives: [],
  routines: [],
});

const parseSnapshot = (value: unknown): ConversationKitAuthoringSnapshot => {
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

export class FileConversationKitAuthoringStore extends TransientConversationKitAuthoringStore {
  private readonly path: string;

  constructor(options: FileConversationKitAuthoringStoreOptions) {
    super(loadFileSnapshot(options.path));
    this.path = options.path;
  }

  protected override changed(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(this.exportSnapshot(), null, 2)}\n`, "utf8");
    renameSync(temporaryPath, this.path);
  }
}

const loadFileSnapshot = (path: string): ConversationKitAuthoringSnapshot => {
  if (!existsSync(path)) {
    return emptySnapshot();
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return parseSnapshot(parsed);
};
