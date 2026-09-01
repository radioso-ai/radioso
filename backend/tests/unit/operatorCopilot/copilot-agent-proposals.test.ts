import { describe, expect, it, vi } from "vitest";

import { createAgentCopilotProposalAdapter } from "../../../src/modules/operatorCopilot/agentProposalAdapter.js";
import { createAgentProposalCopilotTools, createWebsiteAnalysisProbeCopilotTools } from "../../../src/modules/operatorCopilot/tools/agentProposals.js";
import { WebsiteAnalysisProbeService } from "../../../src/modules/operatorCopilot/services/websiteAnalysisProbeService.js";

const context = {
  workspaceId: "workspace-1",
  accountId: "account-1",
  operatorUserId: "operator-1",
  currentAuthorization: { hasAllPermissions: vi.fn(async () => true) },
  copilotConversationId: "conversation-1",
  surface: "dashboard" as const,
  pageContext: { view: "agent" as const, agentId: null, conversationId: null, selection: null, entities: [] },
};

const analysis = () => ({
  sourceUrl: "https://acme.example.com",
  suggestedName: "Acme Support",
  suggestedCustomInstruction: "Answer questions about Acme's plans and billing.",
  suggestedGreetingMessage: "Hi! Ask me anything about Acme.",
  suggestedChunkingStrategy: { strategy: "structured_semantic" as const, reasoning: "The site is documentation-shaped." },
  faviconUrl: "https://acme.example.com/favicon.ico",
  pagesAnalyzed: [{ url: "https://acme.example.com", title: "Acme" }],
  suggestedLocale: "en",
  suggestedPrivacyPolicyUrl: "https://acme.example.com/privacy",
  suggestedContactEmail: "support@acme.example.com",
});

type CreateResult = {
  agentId: string;
  crawlJobId: string | null;
  incomplete?: { step: "configuration" | "ingestion"; reason: string };
};

const creationPort = () => ({
  createFromWizard: vi.fn(async (): Promise<CreateResult> => ({
    agentId: "11111111-1111-4111-8111-111111111111",
    crawlJobId: "job-1",
  })),
});

const adapterFor = (creation = creationPort()) => ({
  adapter: createAgentCopilotProposalAdapter({
    agentCreation: creation,
    workspaceAccount: { resolveAccountId: vi.fn(async () => "account-1") },
  }),
  creation,
});

const toolFor = (adapter: ReturnType<typeof createAgentCopilotProposalAdapter>) => {
  const createProposal = vi.fn(async (input: Record<string, unknown>) => ({
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    ...input,
  }) as never);
  const record = vi.fn(async () => undefined);
  const [descriptor] = createAgentProposalCopilotTools({
    proposalRepository: { createProposal },
    proposalAdapters: [adapter],
    auditService: { record },
  });
  if (!descriptor) throw new Error("No agent proposal descriptor");
  return { descriptor, createProposal, record };
};

const change = {
  websiteUrl: "https://acme.example.com",
  name: "Acme Support",
  customInstruction: "Answer questions about Acme's plans and billing.",
  greetingInstruction: "Hi! Ask me anything about Acme.",
  contactEmail: "support@acme.example.com",
  rationale: "Acme's plans and billing pages carry every answer the agent needs.",
};

describe("propose_agent", () => {
  it("drafts an agent for review rather than creating one", async () => {
    const { adapter, creation } = adapterFor();
    const { descriptor, createProposal, record } = toolFor(adapter);

    const result = await descriptor.createTool(context).invoke(change, {} as never) as {
      targetType: string; targetLabel: string; summary: string;
    };

    expect(creation.createFromWizard).not.toHaveBeenCalled();
    expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({
      targetType: "agent",
      targetRef: { websiteUrl: "https://acme.example.com" },
      payload: expect.objectContaining({ name: "Acme Support", websiteUrl: "https://acme.example.com" }),
      evidence: null,
    }));
    expect(result.targetType).toBe("agent");
    expect(result.targetLabel).toBe("Acme Support");
    expect(result.summary).toContain("Acme Support");
  });

  it("states the locale on the card only when the proposal sets one", async () => {
    const { adapter } = adapterFor();
    const { descriptor } = toolFor(adapter);

    const withoutLocale = await descriptor.createTool(context).invoke(change, {} as never) as { summary: string };
    const withLocale = await descriptor.createTool(context).invoke(
      { ...change, assistantDefaultLocale: "it" },
      {} as never,
    ) as { summary: string };

    expect(withoutLocale.summary).not.toContain("locale");
    expect(withLocale.summary).toContain("Default locale it.");
  });

  it("refuses a chunking strategy on the card, because creating an agent does not write one", async () => {
    // AgentWizardService records the suggested strategy in its audit event and deliberately does not
    // apply it: chunking is workspace-scoped ingestion configuration. A card carrying the field
    // would state a change the apply never makes.
    const { adapter } = adapterFor();
    const { descriptor, createProposal } = toolFor(adapter);

    await expect(descriptor.createTool(context).invoke(
      { ...change, chunkingStrategy: "structured_semantic" },
      {} as never,
    )).rejects.toThrow();
    expect(createProposal).not.toHaveBeenCalled();
  });

  it("records the draft in the audit trail", async () => {
    const { adapter } = adapterFor();
    const { descriptor, record } = toolFor(adapter);

    await descriptor.createTool(context).invoke(change, {} as never);

    expect(record).toHaveBeenCalledWith(expect.objectContaining({ eventType: "copilot.proposal.created" }));
  });

  it("refuses a draft the operator is no longer authorized to make", async () => {
    const { adapter } = adapterFor();
    const { descriptor, createProposal } = toolFor(adapter);
    const denied = { ...context, currentAuthorization: { hasAllPermissions: vi.fn(async () => false) } };

    await expect(descriptor.createTool(denied).invoke(change, {} as never)).rejects.toThrow();
    expect(createProposal).not.toHaveBeenCalled();
  });

  it("creates the agent and returns its identity when the proposal is applied", async () => {
    const { adapter, creation } = adapterFor();
    const validated = await adapter.validatePayload("workspace-1", { websiteUrl: change.websiteUrl }, change);

    const outcome = await adapter.applyIfVersionMatches(
      "workspace-1",
      validated.targetRef,
      validated.payload,
      validated.versionToken,
    );

    expect(creation.createFromWizard).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      accountId: "account-1",
      config: expect.objectContaining({ name: "Acme Support", websiteUrl: "https://acme.example.com" }),
    }));
    expect(outcome).toMatchObject({
      outcome: "applied",
      appliedRef: { agentId: "11111111-1111-4111-8111-111111111111", crawlJobId: "job-1" },
    });
  });

  it("never retries after an interrupted apply, because a retry would create a second agent", () => {
    const { adapter } = adapterFor();
    expect(adapter.canRetryAfterInterruptedApply?.({ websiteUrl: change.websiteUrl }, change)).toBe(false);
  });

  it("reports the created agent when a step after creation fails, rather than losing it", async () => {
    // The wizard creates the agent before it applies branding, locale, and contact settings and
    // before it queues the website. Calling a partial run a failed apply would leave a real agent
    // in the workspace behind a card that says nothing happened - and the operator would ask Ray
    // to create it again.
    const creation = creationPort();
    creation.createFromWizard.mockResolvedValueOnce({
      agentId: "22222222-2222-4222-8222-222222222222",
      crawlJobId: null,
      incomplete: { step: "ingestion" as const, reason: "Crawl queue is unavailable" },
    });
    const { adapter } = adapterFor(creation);
    const validated = await adapter.validatePayload("workspace-1", { websiteUrl: change.websiteUrl }, change);

    const outcome = await adapter.applyIfVersionMatches(
      "workspace-1",
      validated.targetRef,
      validated.payload,
      validated.versionToken,
    );

    expect(outcome).toMatchObject({
      outcome: "applied",
      appliedRef: {
        agentId: "22222222-2222-4222-8222-222222222222",
        crawlJobId: null,
        incomplete: { step: "ingestion", reason: "Crawl queue is unavailable" },
      },
    });
    // The card has to say what is left: an agent whose site never queued has nothing to answer
    // from, and a clean "applied" would read as ready.
    expect(outcome).toMatchObject({ reason: expect.stringContaining("Crawl queue is unavailable") });
    expect((outcome as { reason: string }).reason).toContain("Knowledge");
  });

  it("says nothing extra when the whole apply finished", async () => {
    const { adapter } = adapterFor();
    const validated = await adapter.validatePayload("workspace-1", { websiteUrl: change.websiteUrl }, change);

    const outcome = await adapter.applyIfVersionMatches(
      "workspace-1",
      validated.targetRef,
      validated.payload,
      validated.versionToken,
    );

    expect(outcome).not.toHaveProperty("reason");
  });

  it("reports a failed creation as a failed apply rather than throwing", async () => {
    const creation = creationPort();
    creation.createFromWizard.mockRejectedValueOnce(new Error("Workspace agent limit reached"));
    const { adapter } = adapterFor(creation);
    const validated = await adapter.validatePayload("workspace-1", { websiteUrl: change.websiteUrl }, change);

    const outcome = await adapter.applyIfVersionMatches(
      "workspace-1",
      validated.targetRef,
      validated.payload,
      validated.versionToken,
    );

    expect(outcome).toMatchObject({ outcome: "failed", reason: "Workspace agent limit reached" });
  });

  it("previews the agent as an addition, with no current state to diff against", async () => {
    const { adapter } = adapterFor();
    const validated = await adapter.validatePayload("workspace-1", { websiteUrl: change.websiteUrl }, change);

    const preview = await adapter.preview("workspace-1", validated.targetRef, validated.payload);

    expect(preview.targetLabel).toBe("Acme Support");
    expect(preview.current).toBeNull();
    expect(preview.proposed).toMatchObject({ name: "Acme Support", websiteUrl: "https://acme.example.com" });
  });
});

describe("analyze_website", () => {
  const probeDeps = () => {
    const enforce = vi.fn(async () => undefined);
    const record = vi.fn(async () => undefined);
    const analyzeWebsite = vi.fn(async () => analysis());
    return {
      enforce,
      record,
      analyzeWebsite,
      service: new WebsiteAnalysisProbeService({
        abuseControl: { enforce } as never,
        audit: { record },
        abusePolicy: { limit: 5, windowMs: 3_600_000 },
        agentWizardAnalysis: { analyzeWebsite },
      }),
    };
  };

  const descriptorFor = (websiteAnalysisProbe: { analyze: (input: never) => Promise<unknown> }) => {
    const [descriptor] = createWebsiteAnalysisProbeCopilotTools({ websiteAnalysisProbe } as never);
    if (!descriptor) throw new Error("No website analysis descriptor");
    return descriptor;
  };

  it("returns the suggested configuration without persisting anything", async () => {
    const deps = probeDeps();
    const descriptor = descriptorFor(deps.service);

    const result = await descriptor.createTool(context).invoke({ url: "https://acme.example.com" }, {} as never) as {
      analysis: { suggestedName: string; suggestedChunkingStrategy: { strategy: string } };
    };

    expect(deps.analyzeWebsite).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://acme.example.com",
      workspaceId: "workspace-1",
      accountId: "account-1",
    }));
    expect(result.analysis.suggestedName).toBe("Acme Support");
    expect(result.analysis.suggestedChunkingStrategy.strategy).toBe("structured_semantic");
  });

  it("never returns the page screenshot, which is the largest thing the analysis produces", async () => {
    const deps = probeDeps();
    const descriptor = descriptorFor(deps.service);

    const result = await descriptor.createTool(context).invoke({ url: "https://acme.example.com" }, {} as never);

    expect(JSON.stringify(result)).not.toContain("screenshot");
  });

  it("spends the operator's expensive-operation budget before it fetches the site", async () => {
    const deps = probeDeps();
    deps.enforce.mockRejectedValueOnce(Object.assign(new Error("Too many requests"), { statusCode: 429 }));

    await expect(deps.service.analyze({
      workspaceId: "workspace-1",
      accountId: "account-1",
      operatorUserId: "operator-1",
      url: "https://acme.example.com",
    // The refusal is re-addressed to the model that called the tool, so it says not to retry rather
    // than repeating a wait-and-try-again aimed at a human.
    })).rejects.toThrow(/Do not retry this call in this turn/);

    expect(deps.analyzeWebsite).not.toHaveBeenCalled();
    expect(deps.record).toHaveBeenCalledWith(expect.objectContaining({ eventType: "security.rate_limit_enforced" }));
  });

  it("clamps an over-long suggestion instead of failing the whole analysis", async () => {
    const deps = probeDeps();
    deps.analyzeWebsite.mockResolvedValueOnce({
      ...analysis(),
      suggestedCustomInstruction: "x".repeat(5_000),
      suggestedContactEmail: `${"a".repeat(400)}@acme.example.com`,
    });
    const descriptor = descriptorFor(deps.service);

    const result = await descriptor.createTool(context).invoke({ url: "https://acme.example.com" }, {} as never) as {
      analysis: { suggestedCustomInstruction: string; suggestedContactEmail: string | null };
    };

    expect(result.analysis.suggestedCustomInstruction.length).toBeLessThanOrEqual(2_000);
    expect(result.analysis.suggestedContactEmail?.length).toBeLessThanOrEqual(320);
  });

  it("caps the pages it lists so one analysis cannot flood the turn", async () => {
    const deps = probeDeps();
    deps.analyzeWebsite.mockResolvedValueOnce({
      ...analysis(),
      pagesAnalyzed: Array.from({ length: 40 }, (_, index) => ({ url: `https://acme.example.com/${index}`, title: `Page ${index}` })),
    });
    const descriptor = descriptorFor(deps.service);

    const result = await descriptor.createTool(context).invoke({ url: "https://acme.example.com" }, {} as never) as {
      analysis: { pagesAnalyzed: unknown[] };
      omissions: Array<{ field: string; omittedCount?: number }>;
    };

    expect(result.analysis.pagesAnalyzed.length).toBeLessThanOrEqual(20);
    expect(result.omissions).toContainEqual(expect.objectContaining({ field: "analysis.pagesAnalyzed" }));
  });
});
