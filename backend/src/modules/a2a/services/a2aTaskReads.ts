import type { A2aTaskChanges, A2aTaskRecord, A2aTaskStore, A2aTranscriptPort } from "../contracts/ports.js";
import { a2aError } from "../domain/a2aErrors.js";
import type { GetTaskInput, ListTasksInput } from "../domain/requestParams.js";
import { decideTaskOnRead, isOpenTaskState, marksHumanStretch } from "../domain/taskState.js";
import type { WireTask } from "../domain/taskWire.js";
import { authoredMessages } from "../domain/turnMessages.js";
import type { A2aContextAdmission } from "./a2aAccess.js";
import type { A2aObserver } from "./a2aObserver.js";
import type { A2aTaskView } from "./a2aTaskView.js";
import { readToEnd } from "./transcriptReads.js";

interface ListTasksResult {
  tasks: WireTask[];
  nextPageToken: string;
  pageSize: number;
  totalSize: number;
}

/** A page token: the `(stateAt, id)` of the last task on the previous page, opaque to the caller. */
const encodePageToken = (task: A2aTaskRecord): string =>
  Buffer.from(JSON.stringify({ t: task.stateAt.toISOString(), i: task.id }), "utf8").toString("base64url");

const decodePageToken = (token: string): { stateAt: Date; id: string } | null => {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (parsed && typeof parsed === "object" && "t" in parsed && "i" in parsed
      && typeof parsed.t === "string" && typeof parsed.i === "string" && !Number.isNaN(Date.parse(parsed.t))) {
      return { stateAt: new Date(parsed.t), id: parsed.i };
    }
  } catch {
    // Unreadable is answered below, the same as a token of the wrong shape.
  }
  return null;
};

/**
 * `GetTask`, `ListTasks` and `CancelTask`. A read of an open task first applies rows 1 and 3: a reply
 * the caller has not been shown since the task's cursor makes it `input_required` on that reply, and
 * the cursor moves past it, so the next read with nothing new answers the same (FR-035). The write
 * compares and sets: a read that lost to a turn answers the task as the turn left it.
 */
export class A2aTaskReader {
  private readonly clock: () => Date;

  constructor(
    private readonly dependencies: {
      tasks: A2aTaskStore;
      transcript: Pick<A2aTranscriptPort, "readAfter">;
      view: A2aTaskView;
      observer: A2aObserver;
      clock?: () => Date;
    },
  ) {
    this.clock = dependencies.clock ?? (() => new Date());
  }

  async get(admission: A2aContextAdmission, input: GetTaskInput, options: { extensionActive: boolean }): Promise<WireTask> {
    const task = admission.task;
    if (!task) {
      throw a2aError("TASK_NOT_FOUND");
    }
    const current = await this.refresh(task);
    return this.dependencies.view.render(current, {
      historyLength: input.historyLength,
      includeArtifacts: true,
      extensionActive: options.extensionActive,
    });
  }

  /** One context's tasks only, never across contexts; with no context named, nothing (FR-036). */
  async list(
    admission: A2aContextAdmission | null,
    input: ListTasksInput,
    options: { extensionActive: boolean },
  ): Promise<ListTasksResult> {
    const empty: ListTasksResult = { tasks: [], nextPageToken: "", pageSize: input.pageSize, totalSize: 0 };
    const before = input.pageToken ? decodePageToken(input.pageToken) : null;
    if (input.pageToken && !before) {
      throw a2aError("INVALID_PARAMS");
    }
    if (!admission?.conversationId) {
      return empty;
    }
    // One more than a page: whether it comes back is whether there is a next page.
    const page = await this.dependencies.tasks.list({
      conversationId: admission.conversationId,
      state: input.state,
      stateAtOrAfter: input.statusTimestampAfter,
      before,
      limit: input.pageSize + 1,
    });
    const pageTasks = page.tasks.slice(0, input.pageSize);
    const refreshed = await Promise.all(pageTasks.map((task) => this.refresh(task)));
    const tasks = await Promise.all(refreshed.map((task) => this.dependencies.view.render(task, {
      historyLength: input.historyLength,
      includeArtifacts: input.includeArtifacts,
      extensionActive: options.extensionActive,
    })));
    const last = pageTasks.at(-1);
    return {
      tasks,
      nextPageToken: page.tasks.length > input.pageSize && last ? encodePageToken(last) : "",
      pageSize: input.pageSize,
      totalSize: page.total,
    };
  }

  /**
   * A calling agent cannot cancel a task: what is in flight is a routine or a person's work, which
   * only the conversation itself ends. Every task this caller can reach answers -32002; the access
   * check has already answered -32001 for one it cannot.
   */
  cancel(admission: A2aContextAdmission): never {
    if (!admission.task) {
      throw a2aError("TASK_NOT_FOUND");
    }
    throw a2aError("TASK_NOT_CANCELABLE");
  }

  private async refresh(task: A2aTaskRecord): Promise<A2aTaskRecord> {
    if (!isOpenTaskState(task.state) || !task.cursor) {
      return task;
    }
    const page = await readToEnd(this.dependencies.transcript, {
      workspaceId: task.workspaceId,
      conversationId: task.conversationId,
      cursor: task.cursor,
    });
    // The newest reply from the agent's side; the caller's own messages are not news to it.
    const newest = authoredMessages(page.messages).filter((message) => message.author !== "caller").at(-1);
    const decision = newest
      ? decideTaskOnRead({ ownership: page.ownership, laterMessage: { author: newest.author === "human" ? "human" : "agent" } })
      : null;
    if (!decision || !newest) {
      return task;
    }
    const changes: A2aTaskChanges = {
      state: decision.state,
      reason: decision.reason,
      statusMessageId: newest.id,
      cursor: page.cursor,
      shownThroughMessageId: page.messages.at(-1)?.id ?? task.shownThroughMessageId,
      // A read observes who owns the thread now; the rest of what the last turn reported stands.
      envelope: { ...task.envelope, ownership: { state: page.ownership, suppressed: false } },
      stateAt: this.clock(),
      ...(marksHumanStretch(decision.reason) ? { humanStretch: true } : {}),
    };
    const outcome = await this.dependencies.tasks.commit({ updates: [{ id: task.id, expectedVersion: task.version, changes }] });
    if (outcome === "conflict") {
      return (await this.dependencies.tasks.findById(task.id)) ?? task;
    }
    if (task.state !== decision.state) {
      this.dependencies.observer.transition(decision.state);
    }
    return { ...task, ...changes, version: task.version + 1 };
  }
}
