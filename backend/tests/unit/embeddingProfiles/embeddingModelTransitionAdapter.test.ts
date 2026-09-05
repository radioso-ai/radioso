import { describe, expect, it, vi } from "vitest";

import {
  EmbeddingModelTransitionAdapter,
  RegistryFixedInputEmbeddingValidation,
} from "../../../src/app/composition/embeddingModelTransitionAdapter.js";
import {
  EmbeddingTransitionCoordinatorError,
  EmbeddingVectorContractError,
} from "../../../src/modules/embeddingProfiles/public.js";

const space = (
  id: string,
  model: "text-embedding-3-small" | "text-embedding-3-large",
) => ({
  id,
  identityFingerprint: `fingerprint:${id}`,
  provider: "openai",
  endpointScopeFingerprint: "scope",
  model,
  dimensions: model === "text-embedding-3-small" ? 1536 : 3072,
  distanceMetric: "cosine" as const,
  normalization: "provider_unit",
  documentTask: null,
  queryTask: null,
  vectorOptions: {},
  modelVersion: null,
  status: "active" as const,
  quarantineReason: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

const activeProfile = {
  workspaceId: "workspace-1",
  activeEmbeddingSpaceId: "space-active",
  pendingEmbeddingSpaceId: null,
  generation: "1",
  transition: null,
};

describe("EmbeddingModelTransitionAdapter", () => {
  it.each([
    {
      name: "existing Gemini",
      activeModel: "gemini-embedding-001",
      activeProvider: "gemini",
      activeEndpoint: "gemini-scope",
    },
    {
      name: "uncatalogued persisted",
      activeModel: "existing-embedding-model",
      activeProvider: "openai-compatible",
      activeEndpoint: "compatible-scope",
    },
  ])("materializes the $name active binding before starting the first transition", async ({
    activeModel,
    activeProvider,
    activeEndpoint,
  }) => {
    const spaces = new Map<string, ReturnType<typeof space> | Record<string, unknown>>();
    const profiles = {
      findWorkspaceProfile: vi.fn().mockResolvedValueOnce(null),
      findEmbeddingSpaceById: vi.fn(async (id: string) => spaces.get(id) ?? null),
      createEmbeddingSpace: vi.fn(async (input) => {
        const id = input.model === activeModel
          ? "space-existing-active"
          : "space-target";
        const created = {
          ...input,
          id,
          status: "active" as const,
          quarantineReason: null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        };
        spaces.set(id, created);
        return created;
      }),
      initializeWorkspaceProfile: vi.fn(async (input) => ({
        workspaceId: "workspace-1",
        activeEmbeddingSpaceId: input.activeEmbeddingSpaceId,
        pendingEmbeddingSpaceId: null,
        generation: "1",
        transition: null,
      })),
    };
    const coordinator = {
      start: vi.fn(async ({ targetEmbeddingSpaceId }) => ({
        outcome: "started",
        profile: {
          workspaceId: "workspace-1",
          activeEmbeddingSpaceId: "space-existing-active",
          pendingEmbeddingSpaceId: targetEmbeddingSpaceId,
          generation: "2",
          transition: {
            id: "transition-1",
            sourceEmbeddingSpaceId: "space-existing-active",
            targetEmbeddingSpaceId,
            generation: "2",
            status: "building" as const,
            failureReason: null,
          },
        },
        transition: {
          id: "transition-1",
          sourceEmbeddingSpaceId: "space-existing-active",
          targetEmbeddingSpaceId,
          generation: "2",
          status: "building" as const,
          failureReason: null,
        },
      })),
      cancel: vi.fn(),
      reconcilePromotion: vi.fn(),
    };
    const adapter = new EmbeddingModelTransitionAdapter(
      profiles as never,
      (model) => model === activeModel
        ? {
            provider: activeProvider,
            endpointScopeFingerprint: activeEndpoint,
          }
        : {
            provider: "openai",
            endpointScopeFingerprint: "openai-scope",
          },
      coordinator as never,
      { prepare: vi.fn().mockResolvedValue(undefined) },
    );

    await expect(adapter.start({
      workspaceId: "workspace-1",
      activeModel,
      targetModel: "text-embedding-3-small",
    })).resolves.toMatchObject({
      activeModel,
      pendingModel: "text-embedding-3-small",
      status: "building",
    });

    expect(profiles.createEmbeddingSpace).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        model: activeModel,
        provider: activeProvider,
        endpointScopeFingerprint: activeEndpoint,
        dimensions: 1536,
        normalization: "application_unit",
        documentTask: null,
        queryTask: null,
      }),
    );
    expect(profiles.initializeWorkspaceProfile).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      activeEmbeddingSpaceId: "space-existing-active",
    });
    expect(profiles.createEmbeddingSpace).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        model: "text-embedding-3-small",
        dimensions: 1536,
        normalization: "provider_unit",
      }),
    );
  });

  it("materializes the target identity and delegates a model change to the coordinator", async () => {
    const spaces = new Map([
      ["space-active", space("space-active", "text-embedding-3-small")],
    ]);
    const profiles = {
      findWorkspaceProfile: vi.fn().mockResolvedValue(activeProfile),
      findEmbeddingSpaceById: vi.fn(async (id: string) => spaces.get(id) ?? null),
      createEmbeddingSpace: vi.fn(async (input) => {
        const created = {
          ...space("space-target", "text-embedding-3-large"),
          ...input,
          id: "space-target",
        };
        spaces.set(created.id, created);
        return created;
      }),
      initializeWorkspaceProfile: vi.fn(),
    };
    const coordinator = {
      start: vi.fn().mockResolvedValue({
        outcome: "started",
        profile: {
          ...activeProfile,
          pendingEmbeddingSpaceId: "space-target",
          generation: "2",
          transition: {
            id: "transition-secret",
            sourceEmbeddingSpaceId: "space-active",
            targetEmbeddingSpaceId: "space-target",
            generation: "2",
            status: "building",
            failureReason: null,
          },
        },
        transition: {
          id: "transition-secret",
          sourceEmbeddingSpaceId: "space-active",
          targetEmbeddingSpaceId: "space-target",
          generation: "2",
          status: "building",
          failureReason: null,
        },
      }),
      cancel: vi.fn(),
      reconcilePromotion: vi.fn().mockImplementation(async () => ({
        outcome: "waiting",
        profile: {
          ...activeProfile,
          pendingEmbeddingSpaceId: "space-target",
          generation: "2",
          transition: {
            id: "transition-secret",
            sourceEmbeddingSpaceId: "space-active",
            targetEmbeddingSpaceId: "space-target",
            generation: "2",
            status: "building",
            failureReason: null,
          },
        },
      })),
    };
    const indexPreparation = {
      prepare: vi.fn().mockResolvedValue(undefined),
    };
    const adapter = new EmbeddingModelTransitionAdapter(
      profiles,
      () => ({
        provider: "openai",
        endpointScopeFingerprint: "scope",
      }),
      coordinator,
      indexPreparation,
    );

    const result = await adapter.start({
      workspaceId: "workspace-1",
      activeModel: "text-embedding-3-small",
      targetModel: "text-embedding-3-large",
    });

    expect(profiles.createEmbeddingSpace).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "text-embedding-3-large",
        dimensions: 3072,
        provider: "openai",
        endpointScopeFingerprint: "scope",
        identityFingerprint: expect.any(String),
      }),
    );
    expect(coordinator.start).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      targetEmbeddingSpaceId: "space-target",
      expectedGeneration: "1",
    });
    expect(indexPreparation.prepare).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      space: {
        id: "space-target",
        dimensions: 3072,
        distanceMetric: "cosine",
      },
    });
    expect(indexPreparation.prepare.mock.invocationCallOrder[0]).toBeLessThan(
      coordinator.start.mock.invocationCallOrder[0],
    );
    expect(coordinator.reconcilePromotion).not.toHaveBeenCalled();
    expect(result).toEqual({
      activeModel: "text-embedding-3-small",
      pendingModel: "text-embedding-3-large",
      status: "building",
      readiness: "building",
      failureReason: null,
    });
    expect(JSON.stringify(result)).not.toContain("transition-secret");
    expect(JSON.stringify(result)).not.toContain("space-target");
  });

  it("leaves promotion to the explicit reconciliation command after preparation", async () => {
    const spaces = new Map([
      ["space-active", space("space-active", "text-embedding-3-small")],
      ["space-target", space("space-target", "text-embedding-3-large")],
    ]);
    const building = {
      id: "transition-secret",
      sourceEmbeddingSpaceId: "space-active",
      targetEmbeddingSpaceId: "space-target",
      generation: "2",
      status: "building" as const,
      failureReason: null,
    };
    const coordinator = {
      start: vi.fn().mockResolvedValue({
        outcome: "started",
        profile: {
          ...activeProfile,
          pendingEmbeddingSpaceId: "space-target",
          generation: "2",
          transition: building,
        },
        transition: building,
      }),
      cancel: vi.fn(),
      reconcilePromotion: vi.fn(),
    };
    const adapter = new EmbeddingModelTransitionAdapter(
      {
        findWorkspaceProfile: vi.fn().mockResolvedValue(activeProfile),
        findEmbeddingSpaceById: vi.fn(async (id: string) =>
          spaces.get(id) ?? null),
        createEmbeddingSpace: vi.fn().mockResolvedValue(
          space("space-target", "text-embedding-3-large"),
        ),
        initializeWorkspaceProfile: vi.fn(),
      },
      () => ({
        provider: "openai",
        endpointScopeFingerprint: "scope",
      }),
      coordinator,
      { prepare: vi.fn().mockResolvedValue(undefined) },
    );

    await expect(adapter.start({
      workspaceId: "workspace-1",
      activeModel: "text-embedding-3-small",
      targetModel: "text-embedding-3-large",
    })).resolves.toMatchObject({
      activeModel: "text-embedding-3-small",
      pendingModel: "text-embedding-3-large",
      status: "building",
    });
    expect(coordinator.reconcilePromotion).not.toHaveBeenCalled();
  });

  it("does not start or schedule a transition when index preparation fails", async () => {
    const profiles = {
      findWorkspaceProfile: vi.fn().mockResolvedValue(activeProfile),
      findEmbeddingSpaceById: vi.fn(async (id: string) =>
        id === "space-active"
          ? space("space-active", "text-embedding-3-small")
          : space("space-target", "text-embedding-3-large")),
      createEmbeddingSpace: vi.fn().mockResolvedValue(
        space("space-target", "text-embedding-3-large"),
      ),
      initializeWorkspaceProfile: vi.fn(),
    };
    const coordinator = {
      start: vi.fn(),
      cancel: vi.fn(),
      reconcilePromotion: vi.fn(),
    };
    const preparationFailure = new Error("checkpoint unavailable");
    const indexPreparation = {
      prepare: vi.fn().mockRejectedValue(preparationFailure),
    };
    const adapter = new EmbeddingModelTransitionAdapter(
      profiles,
      () => ({
        provider: "openai",
        endpointScopeFingerprint: "scope",
      }),
      coordinator,
      indexPreparation,
    );

    await expect(adapter.start({
      workspaceId: "workspace-1",
      activeModel: "text-embedding-3-small",
      targetModel: "text-embedding-3-large",
    })).rejects.toMatchObject({
      code: "service_unavailable",
      message: "Embedding model transition is temporarily unavailable",
    });

    expect(indexPreparation.prepare).toHaveBeenCalledOnce();
    expect(coordinator.start).not.toHaveBeenCalled();
  });

  it("rejects a quarantined target before preparation or transition startup", async () => {
    const quarantinedTarget = {
      ...space("space-target", "text-embedding-3-large"),
      status: "quarantined" as const,
      quarantineReason: "validation_failed",
    };
    const profiles = {
      findWorkspaceProfile: vi.fn().mockResolvedValue(activeProfile),
      findEmbeddingSpaceById: vi.fn(async (id: string) =>
        id === "space-active"
          ? space("space-active", "text-embedding-3-small")
          : quarantinedTarget),
      createEmbeddingSpace: vi.fn().mockResolvedValue(quarantinedTarget),
      initializeWorkspaceProfile: vi.fn(),
    };
    const coordinator = {
      start: vi.fn(),
      cancel: vi.fn(),
      reconcilePromotion: vi.fn(),
    };
    const indexPreparation = {
      prepare: vi.fn(),
    };
    const adapter = new EmbeddingModelTransitionAdapter(
      profiles as never,
      () => ({
        provider: "openai",
        endpointScopeFingerprint: "scope",
      }),
      coordinator,
      indexPreparation,
    );

    await expect(adapter.start({
      workspaceId: "workspace-1",
      activeModel: "text-embedding-3-small",
      targetModel: "text-embedding-3-large",
    })).rejects.toMatchObject({
      code: "bad_request",
      message: "The replacement embedding model failed compatibility validation",
    });

    expect(indexPreparation.prepare).not.toHaveBeenCalled();
    expect(coordinator.start).not.toHaveBeenCalled();
  });

  it("maps coordinator failures to bounded public-safe settings errors", async () => {
    const profiles = {
      findWorkspaceProfile: vi.fn().mockResolvedValue(activeProfile),
      findEmbeddingSpaceById: vi.fn(async (id: string) =>
        id === "space-active"
          ? space("space-active", "text-embedding-3-small")
          : space("space-target", "text-embedding-3-large")),
      createEmbeddingSpace: vi.fn().mockResolvedValue(
        space("space-target", "text-embedding-3-large"),
      ),
      initializeWorkspaceProfile: vi.fn(),
    };
    const coordinator = {
      start: vi.fn().mockRejectedValue(
        new EmbeddingTransitionCoordinatorError(
          "validation_failed",
          "internal target space target-secret failed",
        ),
      ),
      cancel: vi.fn(),
      reconcilePromotion: vi.fn(),
    };
    const adapter = new EmbeddingModelTransitionAdapter(
      profiles,
      () => ({
        provider: "openai",
        endpointScopeFingerprint: "scope",
      }),
      coordinator,
      { prepare: vi.fn().mockResolvedValue(undefined) },
    );

    await expect(adapter.start({
      workspaceId: "workspace-1",
      activeModel: "text-embedding-3-small",
      targetModel: "text-embedding-3-large",
    })).rejects.toMatchObject({
      code: "bad_request",
      message: "The replacement embedding model failed compatibility validation",
    });
  });
});

describe("RegistryFixedInputEmbeddingValidation", () => {
  it("probes the persisted target model/provider and accepts valid output", async () => {
    const probe = vi.fn().mockResolvedValue({ vectors: [[1, 0]] });
    const registry = {
      createEmbeddingModelProbe: vi.fn(() => ({ probe })),
    };
    const validation = new RegistryFixedInputEmbeddingValidation(
      {
        findEmbeddingSpaceById: vi.fn().mockResolvedValue(
          space("space-target", "text-embedding-3-large"),
        ),
      },
      registry,
    );

    await expect(validation.validateFixedInput({
      workspaceId: "workspace-1",
      targetEmbeddingSpaceId: "space-target",
    })).resolves.toBeUndefined();
    expect(registry.createEmbeddingModelProbe).toHaveBeenCalledWith(
      "text-embedding-3-large",
      "openai",
      "scope",
    );
    expect(probe).toHaveBeenCalledWith("workspace-1");
  });

  it("distinguishes invalid vector contracts from temporary provider failures", async () => {
    const target = {
      findEmbeddingSpaceById: vi.fn().mockResolvedValue(
        space("space-target", "text-embedding-3-large"),
      ),
    };
    const invalid = new RegistryFixedInputEmbeddingValidation(
      target,
      {
        createEmbeddingModelProbe: () => ({
          probe: vi.fn().mockRejectedValue(
            new EmbeddingVectorContractError("wrong dimensions"),
          ),
        }),
      },
    );
    const unavailable = new RegistryFixedInputEmbeddingValidation(
      target,
      {
        createEmbeddingModelProbe: () => ({
          probe: vi.fn().mockRejectedValue(new Error("provider timeout")),
        }),
      },
    );

    await expect(invalid.validateFixedInput({
      workspaceId: "workspace-1",
      targetEmbeddingSpaceId: "space-target",
    })).rejects.toMatchObject({ code: "contract_invalid" });
    await expect(unavailable.validateFixedInput({
      workspaceId: "workspace-1",
      targetEmbeddingSpaceId: "space-target",
    })).rejects.toMatchObject({ code: "temporarily_unavailable" });
  });
});
