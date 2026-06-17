import { createHash, randomUUID } from "node:crypto";

import type { RoutineAwaitingDecision } from "@radioso/conversation-contract";
import type {
  PendingDecisionCreateInput,
  PendingDecisionOption,
} from "../../db/repositories/pendingDecisionRepository.js";

export interface ProposalContentHashInput {
  routineId: string;
  stepId: string;
  captureKey: string;
  options: Array<{ id: string; label: string }>;
}

export interface BuildPendingDecisionTransitionInput {
  conversationId: string;
  sessionId: string;
  workspaceId: string;
  agentId: string;
  routineId: string;
  awaitingDecision: RoutineAwaitingDecision;
  deciderScope?: Record<string, unknown>;
  deadline?: Date | null;
}

const defaultDeciderScope = (): Record<string, unknown> => ({ kind: "workspace_member" });

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const canonicalSerialize = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalSerialize(item)).join(",")}]`;
  }

  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalSerialize(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
};

export const mintDecisionHandle = (): string => `pd_${randomUUID()}`;

export const computeProposalContentHash = (proposal: ProposalContentHashInput): string =>
  createHash("sha256").update(canonicalSerialize(proposal)).digest("hex");

export const buildPendingDecisionTransition = (
  input: BuildPendingDecisionTransitionInput,
): PendingDecisionCreateInput => {
  const options: PendingDecisionOption[] = input.awaitingDecision.options.map((option) => ({
    id: option.id,
    label: option.label,
    ...(option.description === undefined ? {} : { description: option.description }),
  }));

  return {
    handle: mintDecisionHandle(),
    conversationId: input.conversationId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    routineId: input.routineId,
    stepId: input.awaitingDecision.stepId,
    reason: input.awaitingDecision.reason ?? null,
    options,
    deciderScope: input.deciderScope ?? defaultDeciderScope(),
    contentHash: computeProposalContentHash({
      routineId: input.routineId,
      stepId: input.awaitingDecision.stepId,
      captureKey: input.awaitingDecision.captureKey,
      options: input.awaitingDecision.options.map((option) => ({
        id: option.id,
        label: option.label,
      })),
    }),
    deadline: input.deadline ?? null,
  };
};
