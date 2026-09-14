import type { AgentRevision } from "../agents/public.js";
import type { FrozenTestValue } from "../context-variables/public.js";

/**
 * The minimum private-test evidence Eval needs to capture one immutable turn.
 * It deliberately omits test conversation ids, continuations, and traces.
 */
export interface TestExecutionEvalSnapshotSource {
  testValues: readonly FrozenTestValue[];
  sides: readonly TestExecutionEvalSnapshotSide[];
}

export interface TestExecutionEvalSnapshotSide {
  id: string;
  revision: AgentRevision;
  history: readonly TestExecutionEvalSnapshotHistoryEntry[];
}

interface TestExecutionEvalSnapshotHistoryEntry {
  turnId: string;
  role: "user" | "assistant";
  content: string;
  messageId?: string;
  createdAt: Date;
}

export {
  type TestExecutionHistoryEntry,
  type TrustedTestExecutionRunnerPort,
} from "./testExecution.js";
export type { FrozenTestValue } from "../context-variables/public.js";
