import { randomUUID } from "node:crypto";

import type {
  ActivityStage,
  ActivityStageStatus,
  ActivitySummary,
  ActivityTrace,
} from "../radiosoModuleTypes.js";

export const buildContactStage = (
  stageId: string,
  kind: string,
  label: string,
  status: ActivityStageStatus,
  fields: Omit<ActivityStage, "stageId" | "kind" | "label" | "status"> = {},
): ActivityStage => ({
  stageId,
  kind,
  label,
  status,
  startedAt: fields.startedAt ?? new Date().toISOString(),
  ...fields,
});

export const summarizeContact = (trace: ActivityTrace, outcome: string, status: ActivitySummary["status"]): ActivitySummary => ({
  traceId: trace.traceId,
  skillName: "human_contact.request",
  surface: "assistant",
  path: "human_contact.request",
  status,
  outcome,
  fallbackApplied: false,
  contact: {
    stageCount: trace.stages.length,
  },
});

export const buildContactTrace = (
  stages: ActivityStage[],
  outcome: string,
  status: ActivitySummary["status"] = "success",
): ActivityTrace => {
  const startedAt = stages[0]?.startedAt ?? new Date().toISOString();
  const completedAt = new Date().toISOString();
  const trace: ActivityTrace = {
    traceId: randomUUID(),
    startedAt,
    completedAt,
    totalDurationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
    stages,
    links: stages.slice(0, -1).map((stage, index) => ({
      fromStageId: stage.stageId,
      toStageId: stages[index + 1]?.stageId ?? stage.stageId,
      kind: "sequence",
    })),
  };
  return {
    ...trace,
    summary: summarizeContact(trace, outcome, status),
  };
};

export const replaceContactTraceStage = (
  trace: ActivityTrace | null | undefined,
  replacement: ActivityStage,
  outcome: string,
  status: ActivitySummary["status"],
): ActivityTrace | undefined => {
  if (!trace) {
    return undefined;
  }
  const stages = trace.stages.map((stage) => stage.stageId === replacement.stageId ? replacement : stage);
  return {
    ...trace,
    completedAt: new Date().toISOString(),
    stages,
    summary: summarizeContact({ ...trace, stages }, outcome, status),
  };
};
