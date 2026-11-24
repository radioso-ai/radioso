/**
 * The skill a stored chat turn ran and how it ended, read back from the turn's audit metadata
 * or its assistant message, whichever recorded it.
 */

import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import { skillOutcomeStatusSchema } from "../../skills/public.js";
import {
  type AssistantTurnOutcome,
  type SkillTurnOutcome,
  skillTurnOutcomeFromLegacyAnswerOutcome,
} from "./assistantTurnOutcomeTypes.js";

/** The audit-metadata fields a turn's skill outcome can come from. */
interface SkillTurnAuditFields {
  answerOutcome?: AssistantTurnOutcome;
  skillTurn?: unknown;
  skillIntake?: unknown;
}

export interface NormalizedSkillTurnOutcome {
  skillName: string;
  outcome?: string;
  status: SkillTurnOutcome["status"];
}

const normalizeSkillStatus = (value: unknown): SkillTurnOutcome["status"] | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = skillOutcomeStatusSchema.safeParse(value.trim());
  return parsed.success ? parsed.data : undefined;
};

const normalizeSkillTurnFields = (input: {
  skillName?: unknown;
  skillOutcome?: unknown;
  skillStatus?: unknown;
  requireOutcome: boolean;
}): NormalizedSkillTurnOutcome | undefined => {
  if (typeof input.skillName !== "string" || input.skillName.trim().length === 0) {
    return undefined;
  }
  const status = normalizeSkillStatus(input.skillStatus);
  if (!status) {
    return undefined;
  }
  const outcome = typeof input.skillOutcome === "string" && input.skillOutcome.trim().length > 0
    ? input.skillOutcome.trim()
    : undefined;
  if (input.requireOutcome && !outcome) {
    return undefined;
  }

  return {
    skillName: input.skillName.trim(),
    outcome,
    status,
  };
};

const normalizeSkillIntakeOutcome = (value: unknown): NormalizedSkillTurnOutcome | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as { skillName?: unknown; skillOutcome?: unknown; status?: unknown };
  const normalized = normalizeSkillTurnFields({
    skillName: candidate.skillName,
    skillOutcome: candidate.skillOutcome,
    skillStatus: candidate.status,
    requireOutcome: false,
  });
  return normalized
    ? {
        ...normalized,
        outcome: normalized.outcome ?? "unknown",
      }
    : undefined;
};

const normalizeMessageSkillTurnOutcome = (message: MessageRecord | undefined): NormalizedSkillTurnOutcome | undefined =>
  normalizeSkillTurnFields({
    skillName: message?.skillName,
    skillOutcome: message?.skillOutcome,
    skillStatus: message?.skillStatus,
    requireOutcome: false,
  });

export const normalizeSkillTurnOutcome = (
  metadata: SkillTurnAuditFields,
  message: MessageRecord | undefined,
): NormalizedSkillTurnOutcome | undefined => {
  if (metadata.skillTurn && typeof metadata.skillTurn === "object" && !Array.isArray(metadata.skillTurn)) {
    const candidate = metadata.skillTurn as { skillName?: unknown; outcome?: unknown; status?: unknown };
    const normalized = normalizeSkillTurnFields({
      skillName: candidate.skillName,
      skillOutcome: candidate.outcome,
      skillStatus: candidate.status,
      requireOutcome: true,
    });
    if (normalized) {
      return normalized;
    }
  }

  const messageSkillTurnOutcome = normalizeMessageSkillTurnOutcome(message);
  if (messageSkillTurnOutcome) {
    return messageSkillTurnOutcome;
  }

  const skillIntakeOutcome = normalizeSkillIntakeOutcome(metadata.skillIntake);
  if (skillIntakeOutcome) {
    return skillIntakeOutcome;
  }

  return skillTurnOutcomeFromLegacyAnswerOutcome(metadata.answerOutcome);
};
