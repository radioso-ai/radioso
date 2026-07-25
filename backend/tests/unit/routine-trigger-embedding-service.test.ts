import { describe, expect, it, vi } from "vitest";

import { RoutineTriggerEmbeddingService } from "../../src/modules/routines/routineTriggerEmbeddingService.js";

const routine = {
  id: "routine-1",
  activation: {
    triggerDescription: "Help users request a refund",
    gateRef: null,
    priority: 0,
    reentryMode: "once_per_conversation" as const,
  },
};

describe("RoutineTriggerEmbeddingService", () => {
  it("persists a published trigger embedding and skips a second publish with unchanged content", async () => {
    const get = vi.fn().mockResolvedValue({ hash: null });
    const save = vi.fn().mockResolvedValue(undefined);
    const embedTexts = vi.fn().mockResolvedValue([[0.1, 0.2]]);
    const service = new RoutineTriggerEmbeddingService({
      embeddings: { embedTexts },
      settings: { getForWorkspace: vi.fn().mockResolvedValue({ embeddingModel: "text-embedding-3-small" }) },
      store: { get, save, clear: vi.fn() },
      logger: { warn: vi.fn() },
    });

    await service.persistPublished({ workspaceId: "workspace-1", agentId: "agent-1", routine });
    get.mockResolvedValueOnce({ hash: save.mock.calls[0]?.[0].hash });
    await service.persistPublished({ workspaceId: "workspace-1", agentId: "agent-1", routine });

    expect(embedTexts).toHaveBeenCalledTimes(1);
    expect(embedTexts).toHaveBeenCalledWith([routine.activation.triggerDescription], expect.objectContaining({
      model: "text-embedding-3-small",
    }));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      routineId: routine.id,
      model: "text-embedding-3-small",
      embedding: [0.1, 0.2],
      hash: expect.any(String),
    }));
  });

  it("skips embedding entirely when the routine has no published row", async () => {
    const embedTexts = vi.fn();
    const save = vi.fn();
    const clear = vi.fn();
    const service = new RoutineTriggerEmbeddingService({
      embeddings: { embedTexts },
      settings: { getForWorkspace: vi.fn().mockResolvedValue({ embeddingModel: "text-embedding-3-small" }) },
      store: { get: vi.fn().mockResolvedValue(null), save, clear },
      logger: { warn: vi.fn() },
    });

    await service.persistPublished({ workspaceId: "workspace-1", agentId: "agent-1", routine });

    expect(embedTexts).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("collapses concurrent persists of the same trigger into one embedding call", async () => {
    let releaseGet: (value: { hash: string | null }) => void = () => {};
    const get = vi.fn().mockImplementation(() => new Promise<{ hash: string | null }>((resolve) => {
      releaseGet = resolve;
    }));
    const embedTexts = vi.fn().mockResolvedValue([[0.1, 0.2]]);
    const save = vi.fn().mockResolvedValue(undefined);
    const service = new RoutineTriggerEmbeddingService({
      embeddings: { embedTexts },
      settings: { getForWorkspace: vi.fn().mockResolvedValue({ embeddingModel: "text-embedding-3-small" }) },
      store: { get, save, clear: vi.fn() },
      logger: { warn: vi.fn() },
    });

    const first = service.persistPublished({ workspaceId: "workspace-1", agentId: "agent-1", routine });
    const second = service.persistPublished({ workspaceId: "workspace-1", agentId: "agent-1", routine });
    releaseGet({ hash: null });
    await Promise.all([first, second]);

    expect(get).toHaveBeenCalledTimes(1);
    expect(embedTexts).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("leaves persisted fields null and does not fail publication when embedding fails", async () => {
    const clear = vi.fn().mockResolvedValue(undefined);
    const warn = vi.fn();
    const service = new RoutineTriggerEmbeddingService({
      embeddings: { embedTexts: vi.fn().mockRejectedValue(new Error("embedding unavailable")) },
      settings: { getForWorkspace: vi.fn().mockResolvedValue({ embeddingModel: "text-embedding-3-small" }) },
      store: { get: vi.fn().mockResolvedValue({ hash: null }), save: vi.fn(), clear },
      logger: { warn },
    });

    await expect(service.persistPublished({ workspaceId: "workspace-1", agentId: "agent-1", routine })).resolves.toBeUndefined();

    expect(clear).toHaveBeenCalledWith({ agentId: "agent-1", routineId: routine.id });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ routineId: routine.id }), expect.any(String));
  });
});
