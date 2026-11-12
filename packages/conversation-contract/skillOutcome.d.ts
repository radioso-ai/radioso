// What a skill reports when it runs: its status, answer, outputs, session control and error.
import type { SkillTransientGuidance } from "./index.js";

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

/**
 * A picture a skill returned as bytes, which the host stored while the skill ran. The outcome
 * carries only this reference, never the bytes, so an outcome stays small wherever it is kept.
 */
export interface SkillOutcomeMedia {
  kind: "image";
  imageId: string;
}

export interface SkillOutcome {
  status: SkillOutcomeStatus;
  answer?: string;
  outputs?: Record<string, unknown>;
  media?: SkillOutcomeMedia[];
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
