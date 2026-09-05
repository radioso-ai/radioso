import type {
  AttemptRoutineInput,
  ConversationEvent,
  ConversationMessage,
  ConversationProgressPhase,
  ConversationTrace,
  ConversationTraceStage,
  ProcessTurnInput,
  ProcessTurnResult,
  ProcessTurnStreamInput,
  RenderableTurn,
  ConversationSkillInputResolution,
  AwaitingSkillInput,
  RoutineActionRequest,
  RoutineAwaitingDecision,
  SelectionDecision,
  TurnOutcome,
} from "@radioso/conversation-contract";

export const reportProgress = (
  input: ProcessTurnInput | ProcessTurnStreamInput | AttemptRoutineInput,
  phase: ConversationProgressPhase,
): void => {
  if ("progress" in input) {
    input.progress?.report({ phase });
  }
};

export const nowIso = (): string => new Date().toISOString();

export const stage = (
  input: Omit<ConversationTraceStage, "startedAt" | "completedAt">,
): ConversationTraceStage => {
  const timestamp = nowIso();
  return {
    ...input,
    startedAt: timestamp,
    completedAt: timestamp,
  };
};

export const timedStage = (
  startedAtMs: number,
  completedAtMs: number,
  input: Omit<ConversationTraceStage, "startedAt" | "completedAt">,
): ConversationTraceStage => ({
  ...input,
  startedAt: new Date(startedAtMs).toISOString(),
  completedAt: new Date(completedAtMs).toISOString(),
});

export const HISTORY_TAIL_LIMIT = 12;

export const createTrace = (
  stages: ConversationTraceStage[],
  links?: ConversationTrace["links"],
): ConversationTrace => {
  const startedAt = stages[0]?.startedAt ?? nowIso();
  return {
    traceId: `conversation-turn-${startedAt}`,
    startedAt,
    completedAt: stages.at(-1)?.completedAt ?? startedAt,
    stages,
    ...(links && links.length > 0 ? { links } : {}),
  };
};

export const createInputEvent = (input: AttemptRoutineInput): ConversationEvent => ({
  id: input.inputEvent.id,
  sessionId: input.sessionId,
  kind: input.inputEvent.kind,
  role: "user",
  content: input.inputEvent.content,
  metadata: input.inputEvent.metadata,
  createdAt: nowIso(),
});

export const createResponseEvent = (sessionId: string, response: RenderableTurn): ConversationEvent => ({
  id: `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  sessionId,
  kind: "assistant.response",
  role: "assistant",
  content: response.answer,
  metadata: response.metadata,
  createdAt: nowIso(),
});

export const skillInputResolutionStage = (input: {
  skillName: string;
  resolution: ConversationSkillInputResolution;
  startedAtMs?: number;
  completedAtMs?: number;
}): ConversationTraceStage => {
  const traceInput = {
    id: `skill-input:${input.skillName}`,
    kind: "skill_input_resolution" as const,
    status: input.resolution.kind === "ready"
      ? "applied" as const
      : input.resolution.kind === "needs_input" ? "rejected" as const : "failed" as const,
    outputs: {
      skillName: input.skillName,
      fields: input.resolution.fields.map((field) => ({
        name: field.name,
        provenance: field.provenance,
        status: field.status,
        ...(field.reason ? { reason: field.reason } : {}),
      })),
      ...(input.resolution.kind === "failed" ? { failureCode: input.resolution.code } : {}),
    },
  };
  return input.startedAtMs === undefined || input.completedAtMs === undefined
    ? stage(traceInput)
    : timedStage(input.startedAtMs, input.completedAtMs, traceInput);
};

export const historyReferences = (history: ConversationMessage[]): Record<string, unknown>[] =>
  history.slice(-HISTORY_TAIL_LIMIT).map((entry, index, slice) => ({
    index: history.length - slice.length + index,
    role: entry.role,
    messageId: entry.id,
    contentLength: entry.content?.length ?? 0,
    createdAt: entry.createdAt,
  }));

export const historyGatherStage = (history: ConversationMessage[]): ConversationTraceStage => stage({
  id: "gather",
  kind: "gather",
  status: "applied",
  outputs: {
    historyCount: history.length,
    history: historyReferences(history),
  },
});

export const createProcessTurnResult = (input: {
  sessionId: string;
  events: ConversationEvent[];
  decision: SelectionDecision;
  outcomes: TurnOutcome[];
  response: RenderableTurn;
  trace: ConversationTrace;
  actions?: RoutineActionRequest[];
  handoff?: { routineId: string; stepId: string };
  awaitingDecision?: RoutineAwaitingDecision;
  awaitingSkillInput?: AwaitingSkillInput[];
}): ProcessTurnResult => ({
  sessionId: input.sessionId,
  events: input.events,
  decision: input.decision,
  outcomes: input.outcomes,
  response: input.response,
  trace: input.trace,
  ...(input.actions && input.actions.length > 0 ? { actions: input.actions } : {}),
  ...(input.handoff ? { handoff: input.handoff } : {}),
  ...(input.awaitingDecision ? { awaitingDecision: input.awaitingDecision } : {}),
  ...(input.awaitingSkillInput && input.awaitingSkillInput.length > 0
    ? { awaitingSkillInput: input.awaitingSkillInput }
    : {}),
});
