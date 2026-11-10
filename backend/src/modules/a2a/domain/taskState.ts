import type { ChatRoutineTurnState } from "../../chat/contracts/index.js";

/** Task states as the store keeps them; the wire spells them `TASK_STATE_<UPPER>`. */
export const A2A_TASK_STATES = [
  "submitted",
  "working",
  "input_required",
  "auth_required",
  "completed",
  "failed",
  "canceled",
  "rejected",
] as const;

export type A2aTaskState = typeof A2A_TASK_STATES[number];

/** The states a task can still leave. The store allows one task per conversation in them. */
export const OPEN_TASK_STATES = ["submitted", "working", "input_required", "auth_required"] as const satisfies readonly A2aTaskState[];

export const isOpenTaskState = (state: A2aTaskState): boolean =>
  (OPEN_TASK_STATES as readonly A2aTaskState[]).includes(state);

/**
 * Why a task is in its state: the row of the precedence table that put it there. A structured
 * value, never copy: a transition no turn produced carries this and the state, and nothing else.
 */
export const A2A_TASK_REASONS = [
  "human_message",
  "human_owned",
  "agent_message",
  "awaiting_approval",
  "awaiting_input",
  "routine_replaced",
  "routine_completed",
  "routine_declined",
  "handed_back",
  "routine_ended",
] as const;

export type A2aTaskReason = typeof A2A_TASK_REASONS[number];

/**
 * A person's ownership or message makes a task a stretch of human ownership (row 9). The task keeps
 * that mark for good, whatever a later read or turn records as its reason.
 */
export const marksHumanStretch = (reason: A2aTaskReason): boolean =>
  reason === "human_owned" || reason === "human_message";

type RoutineStatus = ChatRoutineTurnState["status"];

const ROUTINE_IN_FLIGHT: ReadonlySet<RoutineStatus> = new Set(["active", "waiting_for_input", "waiting_for_approval"]);

/** What the decision needs of the task open in the context, if any. */
export interface OpenTaskFacts {
  /** The routine run the task follows; null for a task that follows none (a stretch of human ownership). */
  routineExecutionId: string | null;
  /** A person owned the thread or wrote in it at some point while the task was open. */
  humanStretch: boolean;
}

/** What one turn reported, reduced to the facts the table reads. */
export interface TurnTaskFacts {
  ownership: "ai_owned" | "human_owned";
  /** The routine the turn reported and the run it names; null when it reported none. */
  routine: { status: RoutineStatus; executionId: string | null } | null;
  /**
   * The routine run still active after the turn; null when none is (it ended, expired, or never
   * started). A routine that yields to an off-topic message reports nothing yet is still active.
   */
  activeRoutineExecutionId: string | null;
  /** What became of a typed invocation; null on a message turn. */
  invocationOutcome: string | null;
  /**
   * A person wrote what the caller has not been shown: after its previous message (no task open) or
   * past the open task's cursor, before the turn's own message or while the turn ran.
   */
  unseenHumanMessages: boolean;
}

/** Which message a task's status carries: the turn's reply, a message observed after it, or none. */
export type TaskStatusSource = "reply" | "later_message" | "none";

export type TurnTaskDecision =
  | { kind: "message" }
  | {
    kind: "task";
    /** Continue the open task, or open a new one. */
    target: "open" | "new";
    /** Row 6: the open task ends `canceled` / `routine_replaced` before the new one opens. */
    replacesOpenTask: boolean;
    state: A2aTaskState;
    reason: A2aTaskReason;
    status: TaskStatusSource;
    /** Row 8: the turn's reply is the task's artifact. */
    artifact: boolean;
    routineExecutionId: string | null;
  };

const taskDecision = (
  target: "open" | "new",
  routineExecutionId: string | null,
  outcome: Pick<Extract<TurnTaskDecision, { kind: "task" }>, "state" | "reason" | "status"> & { artifact?: boolean; replacesOpenTask?: boolean },
): TurnTaskDecision => ({
  kind: "task",
  target,
  replacesOpenTask: outcome.replacesOpenTask ?? false,
  state: outcome.state,
  reason: outcome.reason,
  status: outcome.status,
  artifact: outcome.artifact ?? false,
  routineExecutionId,
});

/**
 * The precedence table (spec "How A2A maps onto a Radioso conversation"), applied after a turn.
 * The first matching row wins, with three readings the table leaves implicit:
 *
 * - Row 7 (declined) is checked before row 8 (completed), as the table orders them: a declined
 *   call reports the routine it named as `completed`, because it completed in an earlier turn.
 * - Row 6 compares execution ids only when the open task follows a routine. A task that follows
 *   none is a stretch of human ownership; a routine that starts after the hand-back continues it.
 * - A routine run still active after a turn that reported none (it yielded to an off-topic
 *   message) is still in flight: rows 5 and 6 apply to it, and rows 9 and 10 do not.
 *
 * Row 3 never applies here: the agent message after the caller's is the turn's own reply, which
 * the caller is being shown. Reads apply rows 1 and 3 through {@link decideTaskOnRead}.
 */
export const decideTaskAfterTurn = (open: OpenTaskFacts | null, turn: TurnTaskFacts): TurnTaskDecision => {
  const routine = turn.routine;
  const target = open ? "open" : "new";

  if (turn.ownership === "human_owned") {
    const routineExecutionId = open ? open.routineExecutionId ?? routine?.executionId ?? null : routine?.executionId ?? null;
    return turn.unseenHumanMessages
      ? taskDecision(target, routineExecutionId, { state: "input_required", reason: "human_message", status: "later_message" })
      : taskDecision(target, routineExecutionId, { state: "working", reason: "human_owned", status: "reply" });
  }

  if (turn.invocationOutcome === "declined") {
    return taskDecision(target, open?.routineExecutionId ?? null, { state: "rejected", reason: "routine_declined", status: "reply" });
  }

  const inFlight = routine !== null && ROUTINE_IN_FLIGHT.has(routine.status);
  const completed = routine?.status === "completed";
  if (routine && (inFlight || completed)) {
    const replaces = open !== null && open.routineExecutionId !== null && open.routineExecutionId !== routine.executionId;
    const routineTarget = open && !replaces ? "open" : "new";
    const outcome = completed
      ? { state: "completed", reason: "routine_completed", status: "none", artifact: true } as const
      : routine.status === "waiting_for_approval"
        ? { state: "working", reason: "awaiting_approval", status: "reply" } as const
        : { state: "input_required", reason: "awaiting_input", status: "reply" } as const;
    return taskDecision(routineTarget, routine.executionId, { ...outcome, replacesOpenTask: replaces });
  }

  const parked = turn.activeRoutineExecutionId;
  if (parked) {
    const replaces = open !== null && open.routineExecutionId !== null && open.routineExecutionId !== parked;
    return taskDecision(open && !replaces ? "open" : "new", parked, {
      state: "input_required",
      reason: "awaiting_input",
      status: "reply",
      replacesOpenTask: replaces,
    });
  }

  if (open) {
    return open.humanStretch
      ? taskDecision("open", open.routineExecutionId, { state: "completed", reason: "handed_back", status: "reply" })
      : taskDecision("open", open.routineExecutionId, { state: "canceled", reason: "routine_ended", status: "reply" });
  }
  if (turn.unseenHumanMessages) {
    // The task opened to carry what a person wrote; the AI owns the thread again, so it is done.
    return taskDecision("new", null, { state: "completed", reason: "handed_back", status: "reply" });
  }
  return { kind: "message" };
};

/** What a read needs: who owns the thread now, and the newest reply after the task's cursor. */
interface TaskReadFacts {
  ownership: "ai_owned" | "human_owned";
  laterMessage: { author: "agent" | "human" } | null;
}

interface ReadTaskDecision {
  state: A2aTaskState;
  reason: A2aTaskReason;
  status: "later_message";
}

/**
 * Rows 1 and 3, observed on a read of an open task: a reply the caller has not been shown makes
 * the task `input_required` on that reply. Nothing new leaves the task as it is, which is what
 * makes the state sticky until the caller's next turn. A person's message read under AI ownership
 * (a teammate replied, then handed back) is reported as one, so the task stays a stretch of human
 * ownership for the turn that follows.
 */
export const decideTaskOnRead = (read: TaskReadFacts): ReadTaskDecision | null => {
  if (!read.laterMessage) {
    return null;
  }
  return {
    state: "input_required",
    reason: read.laterMessage.author === "human" ? "human_message" : "agent_message",
    status: "later_message",
  };
};
