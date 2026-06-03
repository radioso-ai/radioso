import type { ConversationAgentConfig, Directive } from "@radioso/conversation-contract";

export interface TurnRequestBody {
  sessionId?: string;
  message: string;
  agent?: ConversationAgentConfig;
  directives?: Directive[];
  metadata?: Record<string, unknown>;
}

export interface TurnResponseBody {
  sessionId: string;
  reply: {
    answer: string;
    citations?: unknown[];
    suggestions?: unknown[];
    metadata?: Record<string, unknown>;
  };
  traceId: string;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const parseAgent = (value: unknown): ConversationAgentConfig | undefined => {
  if (!isRecord(value) || typeof value.id !== "string") {
    return undefined;
  }
  return {
    id: value.id,
    name: typeof value.name === "string" ? value.name : undefined,
    instructions: Array.isArray(value.instructions)
      ? value.instructions.filter((entry): entry is string => typeof entry === "string")
      : undefined,
    defaultLocale: typeof value.defaultLocale === "string" || value.defaultLocale === null
      ? value.defaultLocale
      : undefined,
    metadata: isRecord(value.metadata) ? value.metadata : undefined,
  };
};

const isDirectiveArray = (value: unknown): value is Directive[] =>
  Array.isArray(value) && value.every((entry) =>
    isRecord(entry) &&
    typeof entry.name === "string" &&
    isRecord(entry.condition) &&
    typeof entry.action === "string"
  );

export const parseTurnRequestBody = (value: unknown): TurnRequestBody => {
  if (!isRecord(value) || typeof value.message !== "string") {
    throw new Error("invalid_turn_request");
  }
  return {
    message: value.message,
    sessionId: typeof value.sessionId === "string" ? value.sessionId : undefined,
    agent: parseAgent(value.agent),
    directives: isDirectiveArray(value.directives) ? value.directives : undefined,
    metadata: isRecord(value.metadata) ? value.metadata : undefined,
  };
};
