import { createHash } from "node:crypto";

import type { LowQualityTurnsPage } from "../../quality/contracts/index.js";
import type {
  QualityContentPlanningEvidenceSourcePort,
  QualityContentPlanningTurnEvidence,
} from "../../quality/contracts/contentPlanningEvidence.js";
import type {
  ContentPlanListQuery,
  ContentPlanPage,
  ContentPlanProjection,
  ContentPlanReadServicePort,
  ContentPlanTopicDetail,
  ContentPlanTopicTurnsQuery,
  ContentPlanView,
} from "../contracts/index.js";
import { resolveContentPlanWindows } from "../domain/aggregationPolicy.js";
import { resolveTopicRedirect } from "../domain/topicPolicy.js";
import type {
  ContentPlanProjectionReadSnapshot,
  ContentPlanReadSourcePort,
  ContentPlanTopicRedirectNode,
} from "../infra/contentPlanReadSource.js";
import {
  ContentPlanCursorCodec,
  ContentPlanCursorError,
  ContentPlanCursorStaleError,
  type ContentPlanCursorPayload,
} from "./contentPlanCursor.js";
import {
  presentContentPlanReport,
  type PresentedContentPlanTopic,
} from "./contentPlanPresenter.js";

const QUALITY_EVIDENCE_BATCH_SIZE = 500;

export interface ContentPlanReadServiceDependencies {
  source: ContentPlanReadSourcePort;
  qualityEvidence: QualityContentPlanningEvidenceSourcePort;
  cursorCodec: ContentPlanCursorCodec;
  now?: () => Date;
}

export class ContentPlanReadService implements ContentPlanReadServicePort {
  private readonly now: () => Date;

  constructor(private readonly dependencies: ContentPlanReadServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async list(workspaceId: string, query: ContentPlanListQuery): Promise<ContentPlanPage> {
    const snapshot = await this.dependencies.source.getProjection(workspaceId);
    const generationId = snapshot?.coherentGenerationId ?? null;
    const cursor = query.cursor
      ? this.decodeCursor(query.cursor, workspaceId, query.view, generationId)
      : null;
    const asOf = cursor ? new Date(cursor.asOf) : this.now();
    const windows = resolveContentPlanWindows(asOf);
    const projection = presentProjection(snapshot, asOf);
    if (!generationId) {
      return emptyPage({ asOf: windows.asOf, windows, projection });
    }

    const data = await this.dependencies.source.getReportData(
      workspaceId,
      generationId,
      { from: windows.comparison.from, to: windows.current.to },
    );
    const evidence = await this.getEvidence(
      workspaceId,
      data.observations.map((observation) => observation.sourceAssistantMessageId),
    );
    const report = presentContentPlanReport({ asOf, projection, data, evidenceByAssistantMessageId: evidence });
    const snapshotFingerprint = fingerprintReport(report);
    if (cursor && cursor.snapshotFingerprint !== snapshotFingerprint) {
      throw new ContentPlanCursorStaleError();
    }
    const visible = report.topics
      .filter((topic) => query.view === "all_interests" || topic.summary.opportunity.credible)
      .filter((topic) => !cursor || isAfterCursor(topic, cursor));
    const selected = visible.slice(0, query.limit);
    const hasNext = visible.length > query.limit;
    const last = selected.at(-1);

    return {
      range: "30d",
      window: windows.current,
      comparisonWindow: windows.comparison,
      asOf: windows.asOf,
      projection,
      summary: report.summary,
      rankingVersion: 1,
      recommendedTopicId: cursor === null && selected[0]?.summary.opportunity.credible
        ? selected[0].summary.id
        : null,
      items: selected.map(({ summary }) => summary),
      emerging: report.emerging,
      nextCursor: hasNext && last
        ? this.dependencies.cursorCodec.encode(toCursor({
            workspaceId,
            generationId,
            asOf: windows.asOf,
            view: query.view,
            topic: last,
            snapshotFingerprint,
          }))
        : null,
    };
  }

  async getTopic(workspaceId: string, topicId: string): Promise<ContentPlanTopicDetail | null> {
    const asOf = this.now();
    const windows = resolveContentPlanWindows(asOf);
    const snapshot = await this.dependencies.source.getProjection(workspaceId);
    const generationId = snapshot?.coherentGenerationId;
    if (!generationId) return null;
    const resolved = await this.resolveTopic(workspaceId, generationId, topicId, asOf);
    if (!resolved) return null;

    const projection = presentProjection(snapshot, asOf);
    const data = await this.dependencies.source.getReportData(
      workspaceId,
      generationId,
      { from: windows.comparison.from, to: windows.current.to },
    );
    const evidence = await this.getEvidence(
      workspaceId,
      data.observations.map((observation) => observation.sourceAssistantMessageId),
    );
    const report = presentContentPlanReport({ asOf, projection, data, evidenceByAssistantMessageId: evidence });
    const topic = report.topics.find((candidate) => candidate.summary.id === resolved.canonicalTopicId);
    if (!topic) return null;
    return {
      asOf: windows.asOf,
      window: windows.current,
      comparisonWindow: windows.comparison,
      projection,
      canonicalTopicId: resolved.canonicalTopicId,
      redirectedFromTopicId: resolved.redirectedFromTopicId,
      ...topic.detail,
    };
  }

  async listTopicTurns(
    workspaceId: string,
    topicId: string,
    query: ContentPlanTopicTurnsQuery,
  ): Promise<LowQualityTurnsPage | null> {
    const asOf = this.now();
    const windows = resolveContentPlanWindows(asOf);
    const snapshot = await this.dependencies.source.getProjection(workspaceId);
    const generationId = snapshot?.coherentGenerationId;
    if (!generationId) return null;
    const resolved = await this.resolveTopic(workspaceId, generationId, topicId, asOf);
    if (!resolved) return null;

    const requestedWindow = query.window === "current"
      ? windows.current
      : query.window === "comparison"
        ? windows.comparison
        : { from: windows.comparison.from, to: windows.current.to };
    const memberPage = await this.dependencies.source.pageTopicAssistantMessageIds(
      workspaceId,
      generationId,
      resolved.canonicalTopicId,
      requestedWindow,
      query.page,
      query.pageSize,
    );
    return this.dependencies.qualityEvidence.mapMemberTurnPage(workspaceId, {
      assistantMessageIds: memberPage.assistantMessageIds,
      total: memberPage.total,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  private decodeCursor(
    cursor: string,
    workspaceId: string,
    view: ContentPlanView,
    generationId: string | null,
  ): ContentPlanCursorPayload {
    if (!generationId) throw new ContentPlanCursorError();
    return this.dependencies.cursorCodec.decode(cursor, {
      workspaceId,
      view,
      projectionGenerationId: generationId,
    });
  }

  private async getEvidence(
    workspaceId: string,
    assistantMessageIds: string[],
  ): Promise<ReadonlyMap<string, QualityContentPlanningTurnEvidence>> {
    const unique = [...new Set(assistantMessageIds)];
    const batches: string[][] = [];
    for (let index = 0; index < unique.length; index += QUALITY_EVIDENCE_BATCH_SIZE) {
      batches.push(unique.slice(index, index + QUALITY_EVIDENCE_BATCH_SIZE));
    }
    const results = await Promise.all(batches.map((batch) =>
      this.dependencies.qualityEvidence.getEvidenceByAssistantMessageIds(workspaceId, batch)));
    return new Map(results.flatMap((result) => [...result.entries()]));
  }

  private async resolveTopic(
    workspaceId: string,
    generationId: string,
    topicId: string,
    asOf: Date,
  ): Promise<{ canonicalTopicId: string; redirectedFromTopicId: string | null } | null> {
    const chain = await this.dependencies.source.getTopicRedirectChain(
      workspaceId,
      generationId,
      topicId,
    );
    const byId = new Map(chain.map((node) => [node.id, node]));
    const resolution = resolveTopicRedirect(topicId, (candidateId) => {
      const node = byId.get(candidateId);
      if (!node || node.lifecycle !== "merged" || !redirectIsLive(node, asOf)) return null;
      return node.mergedIntoTopicId;
    });
    if (resolution.kind === "invalid") return null;
    const canonical = byId.get(resolution.canonicalTopicId);
    if (!canonical || canonical.lifecycle !== "mature") return null;
    return resolution;
  }
}

const redirectIsLive = (node: ContentPlanTopicRedirectNode, asOf: Date): boolean =>
  node.mergedIntoTopicId !== null
  && node.redirectExpiresAt !== null
  && new Date(node.redirectExpiresAt).getTime() > asOf.getTime();

const presentProjection = (
  snapshot: ContentPlanProjectionReadSnapshot | null,
  asOf: Date,
): ContentPlanProjection => {
  const processedThrough = snapshot?.processedThrough ?? null;
  return {
    state: snapshot?.state ?? "bootstrapping",
    processedThrough,
    processingLagSeconds: processedThrough === null
      ? null
      : Math.max(0, Math.floor((asOf.getTime() - new Date(processedThrough).getTime()) / 1_000)),
    pendingEmbeddingCount: snapshot?.pendingEmbeddingCount ?? 0,
    pendingAssignmentCount: snapshot?.pendingAssignmentCount ?? 0,
    pendingEnrichmentTopicCount: snapshot?.pendingEnrichmentTopicCount ?? 0,
    processedCount: snapshot?.processedCount ?? null,
    totalCount: snapshot?.totalCount ?? null,
    embeddingSpaceFingerprint: snapshot?.embeddingSpaceFingerprint ?? null,
    reason: snapshot?.reason ?? null,
  };
};

const emptyPage = (input: {
  asOf: string;
  windows: ReturnType<typeof resolveContentPlanWindows>;
  projection: ContentPlanProjection;
}): ContentPlanPage => ({
  range: "30d",
  window: input.windows.current,
  comparisonWindow: input.windows.comparison,
  asOf: input.asOf,
  projection: input.projection,
  summary: {
    questionCount: 0,
    conversationCount: 0,
    matureTopicCount: 0,
    emergingQuestionCount: 0,
    opportunityCount: 0,
    grounding: {
      evaluatedAnswerCount: 0,
      groundedAnswerCount: 0,
      degradedAnswerCount: 0,
      noSupportAnswerCount: 0,
      notEvaluatedAnswerCount: 0,
      reducedOrNoSupportRate: null,
      headlineState: "unmeasured",
    },
  },
  rankingVersion: 1,
  recommendedTopicId: null,
  items: [],
  emerging: [],
  nextCursor: null,
});

const toCursor = (input: {
  workspaceId: string;
  generationId: string;
  asOf: string;
  view: ContentPlanView;
  topic: PresentedContentPlanTopic;
  snapshotFingerprint: string;
}): ContentPlanCursorPayload => ({
  version: 1,
  workspaceId: input.workspaceId,
  projectionGenerationId: input.generationId,
  asOf: input.asOf,
  view: input.view,
  rankingVersion: 1,
  snapshotFingerprint: input.snapshotFingerprint,
  order: {
    activeNoSupportConversationCount: input.topic.activeNoSupportConversationCount,
    activeDegradedConversationCount: input.topic.activeDegradedConversationCount,
    currentConversationCount: input.topic.summary.demand.currentConversationCount,
    trendRank: input.topic.trendRank,
    topicId: input.topic.summary.id,
  },
});

const fingerprintReport = (
  report: ReturnType<typeof presentContentPlanReport>,
): string => createHash("sha256")
  .update(JSON.stringify({
    summary: report.summary,
    topics: report.topics.map(({ summary }) => summary),
    emerging: report.emerging,
  }), "utf8")
  .digest("hex");

const isAfterCursor = (
  topic: PresentedContentPlanTopic,
  cursor: ContentPlanCursorPayload,
): boolean => {
  const candidate = [
    topic.activeNoSupportConversationCount,
    topic.activeDegradedConversationCount,
    topic.summary.demand.currentConversationCount,
    topic.trendRank,
  ];
  const boundary = [
    cursor.order.activeNoSupportConversationCount,
    cursor.order.activeDegradedConversationCount,
    cursor.order.currentConversationCount,
    cursor.order.trendRank,
  ];
  for (let index = 0; index < candidate.length; index += 1) {
    if (candidate[index] === boundary[index]) continue;
    return candidate[index]! < boundary[index]!;
  }
  return topic.summary.id.localeCompare(cursor.order.topicId) > 0;
};
