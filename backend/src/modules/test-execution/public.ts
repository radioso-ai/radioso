import type { AgentRevision } from "../agents/public.js";
import type { FrozenTestValue } from "../context-variables/public.js";
import type { AnswerSegment, ChatCitation } from "../../shared/domain/answerCitation.js";
import type { SkillEffectPolicy } from "../../shared/domain/turnExecutionMode.js";
import type { TestExecutionImageInput } from "./testExecution.js";

/**
 * The minimum private-test evidence Eval needs to capture one immutable turn.
 * It deliberately omits test conversation ids, continuations, and traces.
 */
export interface TestExecutionEvalSnapshotSource {
  /** Frozen per execution; a skills-on test cannot be replayed faithfully, so Eval refuses it. */
  skillEffects: SkillEffectPolicy;
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
  /** The photos a user turn carried, beside `content`, the turn text with their readings. */
  imageInput?: TestExecutionImageInput;
  messageId?: string;
  /** The sources an assistant reply cites and where its text cites them, kept with the captured case. */
  citations?: readonly ChatCitation[];
  answerSegments?: readonly AnswerSegment[];
  createdAt: Date;
}

export {
  answerSources,
  TEST_EXECUTION_LABEL_CHARS,
  type TestExecution,
  type TestExecutionHistoryEntry,
  type TestExecutionPhotoTurnsPort,
  type TestExecutionService,
  type TestExecutionSeed,
  type TestExecutionSeedMessage,
  type TestExecutionSeedSource,
  type TrustedTestExecutionRunnerPort,
} from "./testExecution.js";
export type { TestExecutionTranscriptSide, TestExecutionTurn } from "./testExecutionTurns.js";
export type { FrozenTestValue } from "../context-variables/public.js";
