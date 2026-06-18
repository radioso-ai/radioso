import type {
  ConversationMessage,
  ConversationModelGateway,
  ConversationRoutineReentryGate,
  Routine,
  RoutineReentryDecision,
  RoutineState,
  TurnContext,
} from "@radioso/conversation-contract";

import { DEFAULT_ROUTINE_REENTRY_GATE_PROMPT } from "./generated/defaultPrompts.js";
import { renderPromptTemplate } from "./promptTemplate.js";

const turnMessages = (turn: TurnContext): ConversationMessage[] => [
  ...turn.history,
  { role: "user", content: turn.inputEvent.content },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const SUPPRESS: RoutineReentryDecision = { kind: "suppress" };

/**
 * Reads the author-chosen reentry mode + trigger guidance off the compiled routine's
 * metadata (set by the backend compiler under `metadata.activation`).
 */
const activationOf = (routine: Routine): { reentryMode?: string; triggerDescription?: string } => {
  const metadata = isRecord(routine.metadata) ? routine.metadata : {};
  const activation = isRecord(metadata.activation) ? metadata.activation : {};
  return {
    reentryMode: typeof activation.reentryMode === "string" ? activation.reentryMode : undefined,
    triggerDescription: typeof activation.triggerDescription === "string" ? activation.triggerDescription : undefined,
  };
};

const variablesBlock = (variables: Record<string, unknown>): string => {
  const entries = Object.entries(variables);
  if (entries.length === 0) {
    return "(nothing was collected)";
  }
  return entries.map(([key, value]) => `- ${key}: ${String(value)}`).join("\n");
};

const parseDecision = (raw: string): RoutineReentryDecision => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed.decision === "string") {
      if (parsed.decision === "resume_existing") {
        return { kind: "resume_existing" };
      }
      if (parsed.decision === "start_new") {
        return { kind: "start_new" };
      }
    }
  } catch {
    // fall through to the safe default
  }
  return SUPPRESS;
};

/**
 * Host implementation of {@link ConversationRoutineReentryGate}. It returns `suppress`
 * without a model call for any routine that is not in `semantic` reentry mode, so the gate
 * is inert unless an author opted in. For a semantic routine it runs one structured model
 * decision over the completed instance, defaulting to `suppress` on any malformed output.
 */
export class RoutineReentryGate implements ConversationRoutineReentryGate {
  private readonly routinesById: Map<string, Routine>;
  private readonly promptTemplate: string;

  constructor(
    routines: readonly Routine[],
    private readonly modelGateway: ConversationModelGateway,
    options: { promptTemplate?: string } = {},
  ) {
    this.routinesById = new Map(routines.map((routine) => [routine.id, routine]));
    this.promptTemplate = options.promptTemplate ?? DEFAULT_ROUTINE_REENTRY_GATE_PROMPT;
  }

  async decide(input: { turn: TurnContext; completedState: RoutineState }): Promise<RoutineReentryDecision> {
    const routine = this.routinesById.get(input.completedState.routineId);
    if (!routine) {
      return SUPPRESS;
    }
    const { reentryMode, triggerDescription } = activationOf(routine);
    if (reentryMode !== "semantic") {
      return SUPPRESS;
    }
    const { text } = await this.modelGateway.complete({
      messages: turnMessages(input.turn),
      systemPrompt: renderPromptTemplate("chat/routine-reentry-gate.md", this.promptTemplate, {
        guidance: triggerDescription ?? routine.id,
        variables: variablesBlock(input.completedState.variables),
      }),
      metadata: {
        routineReentryGate: true,
        agentId: input.turn.agent.id,
      },
    });
    return parseDecision(text);
  }
}
