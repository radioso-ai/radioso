import { describe, expect, it, vi } from "vitest";

import { AgentService } from "../../src/modules/agents/public.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";

const exactContent = (overrides: Record<string, unknown> = {}) => ({
  chips: [],
  variants: [{ locale: "en", body: "Welcome! How can I help?", chipLabels: {} }],
  ...overrides,
});

const createService = (agentOverrides: Record<string, unknown> = {}) => {
  const agentRepository = {
    findByIdAndWorkspaceId: vi.fn(async () => ({
      id: agentId,
      workspaceId,
      assistantDefaultLocale: "en",
      ...agentOverrides,
    })),
    updateDraftGreeting: vi.fn(async (_agentId: string, _workspaceId: string, input: unknown) => input),
  };
  const workspaceRepository = { findById: vi.fn(), updateGeneralSettings: vi.fn() };
  const service = new AgentService(agentRepository as never, workspaceRepository);
  return { service, agentRepository };
};

describe("AgentService.updateDraftGreeting", () => {
  it("saves valid exact content and reports a clean validation result", async () => {
    const { service, agentRepository } = createService();

    const result = await service.updateDraftGreeting(workspaceId, agentId, {
      exactWordsEnabled: true,
      exactContent: exactContent(),
    });

    expect(result.validation).toEqual({ ok: true });
    expect(result.greeting).toEqual({ exactWordsEnabled: true, exactContent: exactContent() });
    expect(agentRepository.updateDraftGreeting).toHaveBeenCalledWith(agentId, workspaceId, {
      exactWordsEnabled: true,
      exactContent: exactContent(),
    });
  });

  it("rejects the save when exact words is enabled and content fails validation, without writing the draft", async () => {
    const { service, agentRepository } = createService();

    await expect(
      service.updateDraftGreeting(workspaceId, agentId, {
        exactWordsEnabled: true,
        exactContent: exactContent({ variants: [{ locale: "en", body: "   ", chipLabels: {} }] }),
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      details: { issues: [expect.objectContaining({ code: "blank_body" })] },
    });
    expect(agentRepository.updateDraftGreeting).not.toHaveBeenCalled();
  });

  it("saves invalid content when exact words is off, and still surfaces the diagnostics (FR-007)", async () => {
    const { service, agentRepository } = createService();
    const invalid = exactContent({ variants: [{ locale: "en", body: "", chipLabels: {} }] });

    const result = await service.updateDraftGreeting(workspaceId, agentId, {
      exactWordsEnabled: false,
      exactContent: invalid,
    });

    expect(result.validation.ok).toBe(false);
    expect(agentRepository.updateDraftGreeting).toHaveBeenCalledWith(agentId, workspaceId, {
      exactWordsEnabled: false,
      exactContent: invalid,
    });
  });

  it("falls back to English when the agent has never set a default locale", async () => {
    const { service } = createService({ assistantDefaultLocale: null });

    const result = await service.updateDraftGreeting(workspaceId, agentId, {
      exactWordsEnabled: true,
      exactContent: exactContent(),
    });

    expect(result.validation).toEqual({ ok: true });
  });

  it("validates against no context variables or slots, since bootstrap has none to offer (spec 1150 F4)", async () => {
    const { service } = createService();

    await expect(
      service.updateDraftGreeting(workspaceId, agentId, {
        exactWordsEnabled: true,
        exactContent: exactContent({ variants: [{ locale: "en", body: "Hi {{context.plan}}!", chipLabels: {} }] }),
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      details: { issues: [expect.objectContaining({ code: "unknown_reference" })] },
    });
  });
});
