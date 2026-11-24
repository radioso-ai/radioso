// What a skill reports when it runs: its status, answer, outputs, session control and error.
import type { SkillTransientGuidance } from "./index.js";
import type { SkillOutputContract } from "./skillOutputContract.js";

export type { SkillDataValueType, SkillOutputContract, SkillOutputContractEntry, SkillOutputFieldContract, SkillOutputFieldRole } from "./skillOutputContract.js";
export { renderSkillOutputLines } from "./skillOutputContract.js";

export type SkillOutcomeStatus =
  | "active"
  | "paused"
  | "completed"
  | "failed"
  | "awaiting_confirmation"
  | "awaiting_tool"
  | "cancelled"
  | "expired";

export type RoutineSkillOutcomeStatus = SkillOutcomeStatus | (string & {});

export interface SkillOutcomeControl {
  sessionMode?: "automatic" | "manual";
  lifespan?: "response" | "session";
}

export interface SkillOutcome {
  status: SkillOutcomeStatus;
  answer?: string;
  outputs?: Record<string, unknown>;
  /** The typed contract `outputs` follow, when the skill declares one; the model reads them by it. */
  outputContract?: SkillOutputContract;
  control?: SkillOutcomeControl;
  guidance?: SkillTransientGuidance[];
  metadata?: Record<string, unknown>;
  error?: SkillOutcomeError;
}

export interface SkillOutcomeError {
  code: string;
  message: string;
  retryable?: boolean;
  metadata?: Record<string, unknown>;
}
