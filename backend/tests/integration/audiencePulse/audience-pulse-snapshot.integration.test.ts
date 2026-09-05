import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { AudiencePulseSnapshotRepository } from "../../../src/db/repositories/audiencePulseSnapshotRepository.js";
import {
  PostgresAudiencePulseHistorySource,
  buildAudiencePulseAggregateQuery,
  buildAudiencePulseEligibleQuestionContentQuery,
} from "../../../src/modules/chat/audiencePulseHistorySource.js";
import type {
  AudiencePulseHistorySource,
  AudiencePulsePromptEvidenceReference,
} from "../../../src/modules/audiencePulse/contracts.js";
import { AUDIENCE_PULSE_EVIDENCE_EXCERPT_MAX_CHARACTERS } from "../../../src/modules/audiencePulse/contracts.js";
import type { AudiencePulseStoredReport } from "../../../src/modules/audiencePulse/domain/report.js";
import {
  AudiencePulseService,
  type AudiencePulseServiceDependencies,
} from "../../../src/modules/audiencePulse/services/audiencePulseService.js";
import { Database } from "../../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const period = {
  start: new Date("2026-07-01T00:00:00.000Z"),
  end: new Date("2026-07-31T00:00:00.000Z"),
};

const report = (summary: string): AudiencePulseStoredReport => ({
  period: { start: period.start.toISOString(), end: period.end.toISOString() },
  generatedAt: "2026-08-01T00:00:00.000Z",
  coverage: { populationSize: 2, sampleSize: 2, sampled: false, facetReadyQuestionCount: 2 },
  weeklyVolume: [{
    weekStart: "2026-06-29T00:00:00.000Z",
    visitorQuestionCount: 2,
    conversationCount: 2,
  }],
  summary,
  unclassifiedQuestionCount: 0,
  themes: [],
  contentGaps: [],
  recommendations: [],
  caveats: [],
});

const reportWithEvidence = (summary: string, evidenceId: string): AudiencePulseStoredReport => ({
  ...report(summary),
  unclassifiedQuestionCount: 1,
  themes: [{
    id: "theme-1",
    title: "Theme",
    description: "Evidence-backed discussion theme.",
    evidenceIds: [evidenceId],
    memberCount: 1,
    previousMemberCount: null,
    previousShare: null,
    transition: null,
    share: 0.5,
    weeklyPulse: [],
    grounding: { grounded: 0, degraded: 0, noSupport: 0, unknown: 1, contentGapEligible: 0 },
  }],
});

const reference = (overrides: Partial<AudiencePulsePromptEvidenceReference> = {}): AudiencePulsePromptEvidenceReference => ({
  evidenceId: "evidence-1",
  messageId: "00000000-0000-0000-0000-000000000001",
  conversationId: "10000000-0000-0000-0000-000000000001",
  ...overrides,
});

const unreachableReadDependencies = (input: {
  historySource: AudiencePulseHistorySource;
  snapshotStore: AudiencePulseSnapshotRepository;
}): AudiencePulseServiceDependencies => ({
  ...input,
  runGate: { async tryAcquire() { throw new Error("read does not acquire a refresh lease"); } },
  refreshRateLimit: { async enforce() { throw new Error("read does not enforce a refresh rate limit"); } },
  inferenceFactory: { async create() { throw new Error("read does not create inference"); } },
  censusServiceFactory: { create() { throw new Error("read does not build a census service"); } },
  usageLimitPolicy: {
    async reserveAnswer() { throw new Error("read does not reserve usage"); },
    async reserveDocument() { throw new Error("not used"); },
    async reserveIndexedStorage() { throw new Error("not used"); },
    async reserveMonthlyIndexedContent() { throw new Error("not used"); },
  },
  auditService: { async record() {} },
});

describeIntegration("Audience Pulse snapshot persistence", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new AudiencePulseSnapshotRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();

  beforeAll(async () => {
    await database.query(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)",
      [accountId, "Audience Pulse Test", `audience-pulse-${accountId}@example.com`, "hash"],
    );
    await database.query(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)",
      [workspaceId, accountId, "Audience Pulse Workspace", `audience-pulse-${workspaceId}`],
    );
  });

  beforeEach(async () => {
    await database.query("DELETE FROM audience_pulse_snapshots WHERE workspace_id = $1", [workspaceId]);
    await database.query("DELETE FROM messages WHERE workspace_id = $1", [workspaceId]);
    await database.query("DELETE FROM conversations WHERE workspace_id = $1", [workspaceId]);
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("replaces one workspace row with a new revision and never lets a stale reader invalidate the refresh", async () => {
    const first = await repository.replace({
      workspaceId,
      period,
      generatedAt: new Date("2026-08-01T00:00:00.000Z"),
      report: report("First saved report"),
      promptEvidenceRefs: [reference(), reference({
        evidenceId: "evidence-omitted-from-theme",
        messageId: "00000000-0000-0000-0000-000000000002",
        conversationId: "10000000-0000-0000-0000-000000000002",
      })],
    });
    const refreshed = await repository.replace({
      workspaceId,
      period,
      generatedAt: new Date("2026-08-02T00:00:00.000Z"),
      report: report("Refreshed report"),
      promptEvidenceRefs: [reference({ evidenceId: "fresh-evidence" })],
    });

    expect(refreshed.revision).not.toBe(first.revision);
    expect(await repository.invalidate({ workspaceId, expectedRevision: first.revision })).toBe(false);
    await expect(repository.find(workspaceId)).resolves.toMatchObject({
      revision: refreshed.revision,
      report: { summary: "Refreshed report" },
      promptEvidenceRefs: [{ evidenceId: "fresh-evidence" }],
    });
  });

  it("keeps aggregate reads metadata-only and caps per-item content on the full eligible read", () => {
    const analysisInput = { workspaceId, analysisStart: period.start, analysisEnd: period.end };

    const aggregateSql = buildAudiencePulseAggregateQuery(database.kysely, analysisInput).compile().sql;
    const contentSql = buildAudiencePulseEligibleQuestionContentQuery(database.kysely, analysisInput).compile().sql;

    expect(aggregateSql).not.toContain("content");
    expect(contentSql).toContain("left(m.content");
  });

  it("re-reads a replacement after a stale read loses its revision-conditional delete", async () => {
    const old = await repository.replace({
      workspaceId,
      period,
      generatedAt: new Date("2026-08-01T00:00:00.000Z"),
      report: report("Old report"),
      promptEvidenceRefs: [reference({ evidenceId: "old-evidence" })],
    });
    const newReference = reference({
      evidenceId: "new-evidence",
      messageId: "00000000-0000-0000-0000-000000000099",
      conversationId: "10000000-0000-0000-0000-000000000099",
    });
    let replacementRevision: string | null = null;
    const historySource: AudiencePulseHistorySource = {
      async read() { throw new Error("not used by saved reads"); },
      async listEligibleQuestionIds() { throw new Error("not used by saved reads"); },
      async rehydrate(input) {
        if (input.references[0]?.evidenceId === "old-evidence") {
          const replacement = await repository.replace({
            workspaceId,
            period,
            generatedAt: new Date("2026-08-02T00:00:00.000Z"),
            report: report("New report"),
            promptEvidenceRefs: [newReference],
          });
          replacementRevision = replacement.revision;
          return new Map();
        }
        return new Map(input.references.map((item) => [item.evidenceId, {
          evidenceId: item.evidenceId,
          conversationId: item.conversationId,
          messageId: item.messageId,
          question: "Current authorized source",
        }]));
      },
      async readEvidenceAnchor() { return null; },
    };
    const service = new AudiencePulseService(unreachableReadDependencies({ historySource, snapshotStore: repository }));

    await expect(service.read({ accountId, userId: randomUUID(), workspaceId })).resolves.toMatchObject({
      kind: "completed",
      report: { summary: "New report" },
    });
    expect(replacementRevision).not.toBeNull();
    expect((await repository.find(workspaceId))?.revision).toBe(replacementRevision);
    expect((await repository.find(workspaceId))?.revision).not.toBe(old.revision);
  });

  it("invalidates the full snapshot when a prompt source is deleted before a saved read", async () => {
    const conversationId = randomUUID();
    const messageId = randomUUID();
    await database.query(
      "INSERT INTO conversations (id, workspace_id, source_channel) VALUES ($1, $2, NULL)",
      [conversationId, workspaceId],
    );
    await database.query(
      "INSERT INTO messages (id, conversation_id, role, content, created_at, workspace_id, source) VALUES ($1, $2, 'user', $3, $4, $5, 'customer')",
      [messageId, conversationId, "This source must be reauthorized", "2026-07-15T12:00:00.000Z", workspaceId],
    );
    await repository.replace({
      workspaceId,
      period,
      generatedAt: new Date("2026-08-01T00:00:00.000Z"),
      report: report("Report whose full source set is still available"),
      promptEvidenceRefs: [reference({ evidenceId: "prompt-only-evidence", messageId, conversationId })],
    });
    const historySource = new PostgresAudiencePulseHistorySource(database.kysely);
    const service = new AudiencePulseService(unreachableReadDependencies({ historySource, snapshotStore: repository }));

    await expect(service.read({ accountId, userId: randomUUID(), workspaceId })).resolves.toMatchObject({ kind: "completed" });
    await database.query("DELETE FROM messages WHERE id = $1", [messageId]);
    await expect(service.read({ accountId, userId: randomUUID(), workspaceId }))
      .resolves.toEqual({ kind: "not_generated" });
    await expect(repository.find(workspaceId)).resolves.toBeNull();
  });

  it("caps a saved-read source and returns its exact message id only after reauthorization", async () => {
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const sourceText = "x".repeat(AUDIENCE_PULSE_EVIDENCE_EXCERPT_MAX_CHARACTERS + 200);
    await database.query(
      "INSERT INTO conversations (id, workspace_id, source_channel) VALUES ($1, $2, NULL)",
      [conversationId, workspaceId],
    );
    await database.query(
      "INSERT INTO messages (id, conversation_id, role, content, created_at, workspace_id, source) VALUES ($1, $2, 'user', $3, $4, $5, 'customer')",
      [messageId, conversationId, sourceText, "2026-07-15T12:00:00.000Z", workspaceId],
    );
    await repository.replace({
      workspaceId,
      period,
      generatedAt: new Date("2026-08-01T00:00:00.000Z"),
      report: reportWithEvidence("Report with a representative source", "representative-evidence"),
      promptEvidenceRefs: [reference({ evidenceId: "representative-evidence", messageId, conversationId })],
    });
    const service = new AudiencePulseService(unreachableReadDependencies({
      historySource: new PostgresAudiencePulseHistorySource(database.kysely),
      snapshotStore: repository,
    }));

    const result = await service.read({ accountId, userId: randomUUID(), workspaceId });
    if (result.kind !== "completed") throw new Error("expected a rehydrated saved report");
    expect(result.report.themes[0]?.evidence[0]).toEqual({
      reference: "representative-evidence",
      conversationId,
      messageId,
      question: sourceText.slice(0, AUDIENCE_PULSE_EVIDENCE_EXCERPT_MAX_CHARACTERS),
      occurrenceCount: 1,
    });
  });
});
