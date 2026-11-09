import type { A2aTaskRecord, A2aTranscriptPort } from "../contracts/ports.js";
import { renderTask, type WireTask } from "../domain/taskWire.js";
import { authoredMessages, type AuthoredMessage } from "../domain/turnMessages.js";

/** The most history a task renders; a caller may ask for less, never for more. */
const HISTORY_CAP = 100;

interface TaskRenderOptions {
  historyLength: number | null;
  includeArtifacts: boolean;
  extensionActive: boolean;
}

/**
 * Renders a stored task. The record holds message ids only, so its history, status message and
 * artifact are read back from the conversation: the task's own range, from its opening message
 * through the last one its caller was shown.
 */
export class A2aTaskView {
  constructor(private readonly dependencies: { transcript: Pick<A2aTranscriptPort, "readRange"> }) {}

  async render(task: A2aTaskRecord, options: TaskRenderOptions): Promise<WireTask> {
    const window = task.openingMessageId && task.shownThroughMessageId
      ? await this.range(task, task.openingMessageId, task.shownThroughMessageId, HISTORY_CAP)
      : [];
    const [statusMessage, artifact] = await Promise.all([
      this.messageById(task, task.statusMessageId, window),
      this.messageById(task, task.artifactMessageId, window),
    ]);
    const history = options.historyLength === 0
      ? null
      : options.historyLength === null ? window : window.slice(-options.historyLength);
    return renderTask({
      task,
      statusMessage,
      artifact,
      history,
      extensionActive: options.extensionActive,
      includeArtifacts: options.includeArtifacts,
    });
  }

  /** One message by id, from the history already read when it is there. */
  async messageById(task: A2aTaskRecord, id: string | null, window: readonly AuthoredMessage[] = []): Promise<AuthoredMessage | null> {
    if (!id) {
      return null;
    }
    return window.find((message) => message.id === id) ?? (await this.range(task, id, id, 1))[0] ?? null;
  }

  private async range(task: A2aTaskRecord, fromMessageId: string, throughMessageId: string, limit: number): Promise<AuthoredMessage[]> {
    return authoredMessages(await this.dependencies.transcript.readRange({
      workspaceId: task.workspaceId,
      conversationId: task.conversationId,
      fromMessageId,
      throughMessageId,
      limit,
    }));
  }
}
