/**
 * What the conversation-quality runner's channels share: the run's flags and target, the corpus
 * every channel's agent answers from, publishing, the baseline file and its gate, and closing the
 * composition. `runEvals.ts` runs the text cases and dispatches the voice ones to
 * `runVoiceEvals.ts`; both build on this.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import type { buildDependencies } from "../src/app/server/dependencies.js";
import {
  hasBaselineGateFailures,
  isBaselineInitialized,
  readBaselineJson,
  type BaselineFile,
  type ConversationQualityCase,
  type diffAgainstBaseline,
  type VoiceBaselineFile,
} from "../src/modules/eval/suite/index.js";
import type { OwnershipActor } from "../src/modules/handoff/public.js";
import { conversationQualityCorpus } from "../tests/fixtures/conversation-quality/corpus.js";

/** Which cases a run drives: the text turns, or the voice calls through the voice runtime's door. */
export type EvalChannel = "text" | "voice";

export interface EvalRunFlags {
  updateBaseline: boolean;
  judge: boolean;
  judgeTags: string[];
  judgeModel?: string;
  tags: string[];
  workspaceId: string;
  agentId: string;
  samples: number;
  passThreshold: number;
  migrate: boolean;
  channel: EvalChannel;
}

/** The workspace and agent a run seeds and drives, and the teammate a bootstrapped workspace registered. */
export interface EvalTarget {
  workspaceId: string;
  agentId: string;
  teammate?: OwnershipActor;
}

/**
 * Resolves the workspace + agent to seed and run against. An explicit --workspace/--agent
 * (or RADIOSO_EVAL_* env) targets a specific disposable agent; otherwise a throwaway
 * account is registered so a fresh CI database is a one-liner. The agent is materialized
 * lazily via resolve().
 */
export const ensureTarget = async (deps: EvalDeps, flags: EvalRunFlags): Promise<EvalTarget> => {
  if (flags.workspaceId && flags.agentId) {
    return { workspaceId: flags.workspaceId, agentId: flags.agentId };
  }
  const email = `eval-suite+${randomUUID()}@example.invalid`;
  const registration = await deps.authService.register({ email, password: `Ev@l-${randomUUID()}` });
  const agent = await deps.agentService.resolve(registration.workspaceId);
  console.log(`Bootstrapped disposable workspace ${registration.workspaceId} / agent ${agent.id}`);
  return {
    workspaceId: registration.workspaceId,
    agentId: agent.id,
    teammate: { accountId: registration.accountId, userId: registration.userId, workspaceId: registration.workspaceId },
  };
};

/** A committed baseline: empty when its file does not exist; a file that cannot be read stops the run. */
export const loadBaselineFile = (filePath: string): BaselineFile & { latency?: VoiceBaselineFile["latency"] } => {
  const parsed = readBaselineJson(() => readFileSync(filePath, "utf8")) as Partial<VoiceBaselineFile> | null;
  return {
    generatedAt: parsed?.generatedAt,
    passThreshold: parsed?.passThreshold,
    cases: parsed?.cases ?? {},
    ...(parsed?.latency ? { latency: parsed.latency } : {}),
  };
};

export const filterByTags = (cases: ConversationQualityCase[], tags: string[]): ConversationQualityCase[] =>
  tags.length === 0 ? cases : cases.filter((evalCase) => (evalCase.tags ?? []).some((tag) => tags.includes(tag)));

export type EvalDeps = ReturnType<typeof buildDependencies>;

/**
 * Ingests the fixture corpus into the target workspace and returns the fixture-id → live-id map.
 * A document already ingested by a prior run is logged and skipped rather than aborting.
 */
export const seedCorpus = async (deps: EvalDeps, flags: EvalRunFlags): Promise<Map<string, string>> => {
  const documentIds = new Map<string, string>();
  for (const document of conversationQualityCorpus) {
    try {
      const result = await deps.documentIngestionService.ingest({
        workspaceId: flags.workspaceId,
        title: document.title,
        content: document.content,
        externalDocumentId: document.id,
      });
      documentIds.set(document.id, result.documentId);
    } catch (error) {
      console.warn(`  seed: document "${document.title}" skipped — ${(error as Error).message}`);
    }
  }
  return documentIds;
};

/** Publishes the agent's draft, or returns the published revision when the draft has not moved. */
export const publishAgent = async (deps: EvalDeps, flags: EvalRunFlags): Promise<string> => {
  const state = await deps.agentRevisionService.state(flags.workspaceId, flags.agentId);
  if (state.status === "draft_clean" && state.publishedRevision) {
    return state.publishedRevision.id;
  }
  const candidate = await deps.agentRevisionService.createCandidate(flags.workspaceId, flags.agentId, state.draft.generation);
  const published = await deps.agentRevisionService.publish(flags.workspaceId, flags.agentId, null, {
    revisionId: candidate.id,
    expectedDraftGeneration: state.draft.generation,
    expectedPublishedRevisionId: state.publishedRevision?.id ?? null,
    idempotencyKey: `conversation-quality-${candidate.id}`,
  });
  return published.revisionId;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Blocks until every seeded document reaches the terminal `ready` status (chunked +
 * embedded, retrieval-eligible), so retrieval assertions don't race ingestion on a fresh
 * workspace. Fails loudly on a `failed` document or if processing never completes —
 * usually a sign the document worker isn't running.
 */
export const waitForDocumentsReady = async (
  deps: EvalDeps,
  workspaceId: string,
  documentIds: Map<string, string>,
  timeoutMs = 180_000,
): Promise<void> => {
  const pending = new Set(documentIds.values());
  if (pending.size === 0) {
    return;
  }
  const deadline = Date.now() + timeoutMs;
  console.log(`Waiting for ${pending.size} document(s) to finish processing…`);
  while (pending.size > 0) {
    for (const documentId of [...pending]) {
      const document = (await deps.documentIngestionService.getDocument(workspaceId, documentId)) as {
        status: string;
        failureReason?: string | null;
      };
      if (document.status === "ready") {
        pending.delete(documentId);
      } else if (document.status === "failed") {
        throw new Error(`Document ${documentId} failed processing: ${document.failureReason ?? "unknown"}`);
      }
    }
    if (pending.size === 0) {
      break;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Documents not processed within ${timeoutMs}ms: ${[...pending].join(", ")}. Is the document worker running?`,
      );
    }
    await sleep(2_000);
  }
};

/**
 * Fails the run when the baseline cannot gate or the diff holds a gate failure. An uninitialized
 * baseline can't gate: every case reads as "new", so a run where every case fails would still
 * exit 0. It fails loudly instead until a baseline is recorded.
 */
export const gateOnBaseline = (baseline: BaselineFile, diff: ReturnType<typeof diffAgainstBaseline>, recordCommand: string): void => {
  if (!isBaselineInitialized(baseline)) {
    console.error(
      `Baseline is uninitialized — regression gating is disabled. Run \`${recordCommand}\` after a known-good run to enable it.`,
    );
    process.exitCode = 1;
  }
  if (hasBaselineGateFailures(diff)) {
    console.error(
      `${diff.regressions.length + diff.rateRegressions.length + diff.judgeRegressions.length + diff.underSampled.length + diff.newCases.length + (diff.thresholdMismatch ? 1 : 0)} baseline gate failure(s).`,
    );
    process.exitCode = 1;
  }
};

/** Closes what the composition holds open, ending with the database pool, so the process can exit. */
export const closeDependencies = async (deps: EvalDeps): Promise<void> => {
  try {
    await deps.closeApprovalResumeEffectJournal();
  } finally {
    try {
      await deps.closeAbuseControlRepository?.();
    } finally {
      await deps.connectorDb.close();
    }
  }
};
