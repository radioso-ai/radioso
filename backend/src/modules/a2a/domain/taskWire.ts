import { A2A_CONVERSE_EXTENSION_URI } from "../../../shared/domain/a2aConverseExtension.js";
import type { A2aTaskRecord, A2aTurnEnvelope } from "../contracts/ports.js";
import type { A2aTaskState } from "./taskState.js";
import type { AuthoredMessage } from "./turnMessages.js";

/** A2A v1.0 shapes in ProtoJSON: camelCase fields, enum names as strings, parts with no `kind`. */
interface WirePart {
  text: string;
}

export interface WireMessage {
  messageId: string;
  contextId: string;
  taskId?: string;
  role: "ROLE_USER" | "ROLE_AGENT";
  parts: WirePart[];
  /** The extensions whose metadata the message carries. */
  extensions?: string[];
  metadata?: Record<string, unknown>;
}

interface WireArtifact {
  artifactId: string;
  name?: string;
  parts: WirePart[];
  extensions?: string[];
  metadata?: Record<string, unknown>;
}

export interface WireTask {
  id: string;
  contextId: string;
  status: { state: string; message?: WireMessage; timestamp: string };
  artifacts?: WireArtifact[];
  history?: WireMessage[];
  metadata?: Record<string, unknown>;
}

export const wireTaskState = (state: A2aTaskState): string => `TASK_STATE_${state.toUpperCase()}`;

/**
 * The converse extension's metadata: the reply envelope core a turn reported (FR-041) and who
 * wrote the message, beside the extension's URI in `extensions`, as A2A names the extensions an
 * object carries. Emitted only when the caller activated the extension.
 */
const extensionFields = (
  envelope: A2aTurnEnvelope | null,
  author: "agent" | "human",
): { extensions: string[]; metadata: Record<string, unknown> } => ({
  extensions: [A2A_CONVERSE_EXTENSION_URI],
  metadata: {
    [A2A_CONVERSE_EXTENSION_URI]: {
      ...(envelope?.answerCoverage ? { answerCoverage: envelope.answerCoverage } : {}),
      ...(envelope?.ownership ? { ownership: envelope.ownership } : {}),
      ...(envelope?.routine ? { routine: envelope.routine } : {}),
      ...(envelope?.invocation ? { invocation: envelope.invocation } : {}),
      citations: envelope?.citations ?? [],
      author,
    },
  },
});

export const renderAgentMessage = (input: {
  messageId: string;
  text: string;
  contextId: string;
  taskId?: string;
  extension: { envelope: A2aTurnEnvelope | null; author: "agent" | "human" } | null;
}): WireMessage => ({
  messageId: input.messageId,
  contextId: input.contextId,
  ...(input.taskId ? { taskId: input.taskId } : {}),
  role: "ROLE_AGENT",
  parts: [{ text: input.text }],
  ...(input.extension ? extensionFields(input.extension.envelope, input.extension.author) : {}),
});

const renderHistoryMessage = (message: AuthoredMessage, contextId: string, taskId: string): WireMessage => ({
  messageId: message.id,
  contextId,
  taskId,
  role: message.author === "caller" ? "ROLE_USER" : "ROLE_AGENT",
  parts: [{ text: message.text }],
});

const replyAuthor = (message: AuthoredMessage): "agent" | "human" => (message.author === "human" ? "human" : "agent");

/**
 * A task as the wire carries it. Its status message and artifact carry only text a turn produced or
 * a person wrote; a transition no turn produced carries the state, and the reason under the
 * extension's metadata when the caller activated it. `history` is the task's own messages, or
 * absent when the caller asked for none.
 */
export const renderTask = (input: {
  task: A2aTaskRecord;
  statusMessage: AuthoredMessage | null;
  artifact: AuthoredMessage | null;
  history: readonly AuthoredMessage[] | null;
  extensionActive: boolean;
  includeArtifacts: boolean;
}): WireTask => {
  const { task } = input;
  const contextId = task.contextToken;
  const extension = (author: "agent" | "human") => (input.extensionActive ? { envelope: task.envelope, author } : null);
  return {
    id: task.id,
    contextId,
    status: {
      state: wireTaskState(task.state),
      ...(input.statusMessage
        ? {
          message: renderAgentMessage({
            messageId: input.statusMessage.id,
            text: input.statusMessage.text,
            contextId,
            taskId: task.id,
            extension: extension(replyAuthor(input.statusMessage)),
          }),
        }
        : {}),
      timestamp: task.stateAt.toISOString(),
    },
    ...(input.includeArtifacts && input.artifact
      ? {
        artifacts: [{
          artifactId: input.artifact.id,
          ...(task.envelope?.routine?.name ? { name: task.envelope.routine.name } : {}),
          parts: [{ text: input.artifact.text }],
          ...(input.extensionActive ? extensionFields(task.envelope, replyAuthor(input.artifact)) : {}),
        }],
      }
      : {}),
    ...(input.history ? { history: input.history.map((message) => renderHistoryMessage(message, contextId, task.id)) } : {}),
    ...(input.extensionActive && task.reason ? { metadata: { [A2A_CONVERSE_EXTENSION_URI]: { reason: task.reason } } } : {}),
  };
};
