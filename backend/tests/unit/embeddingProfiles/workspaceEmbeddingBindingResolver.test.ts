import { describe, expect, it } from "vitest";

import { WorkspaceEmbeddingBindingResolver } from "../../../src/app/composition/workspaceEmbeddingBindingResolver.js";
import type { EmbeddingProfileRepositoryPort } from "../../../src/modules/embeddingProfiles/contracts/repositories.js";
import type { IngestionSettingsRecord } from "../../../src/modules/settings/contracts/ingestion.js";

const settings = (overrides: Partial<IngestionSettingsRecord> = {}): IngestionSettingsRecord => ({
  workspaceId: "workspace-1",
  chunkingStrategy: "fixed_window",
  fixedWindowChunkSize: 1000,
  fixedWindowChunkOverlap: 100,
  structuredMinChunkSize: 200,
  structuredMaxChunkSize: 1000,
  embeddingModel: "text-embedding-3-small",
  pendingEmbeddingModel: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...overrides,
});

describe("WorkspaceEmbeddingBindingResolver", () => {
  it("keeps query, document, and clustering generation on the active profile", async () => {
    const spaces = new Map([
      ["active-space", {
        id: "active-space",
        model: "text-embedding-3-small",
        dimensions: 1536,
        provider: "openai",
      }],
      ["pending-space", {
        id: "pending-space",
        model: "gemini-embedding-001",
        dimensions: 3072,
        provider: "gemini",
      }],
    ]);
    const profiles = {
      async createEmbeddingSpace() {
        throw new Error("not expected");
      },
      async findWorkspaceProfile() {
        return {
          workspaceId: "workspace-1",
          activeEmbeddingSpaceId: "active-space",
          pendingEmbeddingSpaceId: "pending-space",
          generation: "2",
          transition: null,
        };
      },
      async findEmbeddingSpaceById(id: string) {
        const space = spaces.get(id);
        return space
          ? {
              ...space,
              identityFingerprint: `fingerprint:${id}`,
              endpointScopeFingerprint: "endpoint",
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
            }
          : null;
      },
      async initializeWorkspaceProfile() {
        throw new Error("not expected");
      },
    } as Pick<
      EmbeddingProfileRepositoryPort,
      | "createEmbeddingSpace"
      | "findWorkspaceProfile"
      | "findEmbeddingSpaceById"
      | "initializeWorkspaceProfile"
    >;
    const resolver = new WorkspaceEmbeddingBindingResolver({
      profiles,
      settings: { async getForWorkspace() { return settings(); } },
      identifyModel: () => ({ provider: "openai" }),
    });

    await expect(resolver.resolveBinding({
      workspaceId: "workspace-1",
      purpose: "retrieval_query",
    })).resolves.toMatchObject({
      space: { id: "active-space", dimensions: 1536 },
      model: "text-embedding-3-small",
      provider: "openai",
      endpointScopeFingerprint: "endpoint",
    });
    await expect(resolver.resolveBinding({
      workspaceId: "workspace-1",
      purpose: "retrieval_document",
    })).resolves.toMatchObject({
      space: { id: "active-space", dimensions: 1536 },
      model: "text-embedding-3-small",
      provider: "openai",
      endpointScopeFingerprint: "endpoint",
    });
    await expect(resolver.resolveBinding({
      workspaceId: "workspace-1",
      purpose: "clustering",
    })).resolves.toMatchObject({
      space: { id: "active-space", dimensions: 1536 },
      model: "text-embedding-3-small",
      provider: "openai",
      endpointScopeFingerprint: "endpoint",
    });
  });

  it("materializes a compatibility binding from existing settings", async () => {
    const resolver = new WorkspaceEmbeddingBindingResolver({
      settings: {
        async getForWorkspace() {
          return settings({
            embeddingModel: "text-embedding-3-large",
            pendingEmbeddingModel: null,
          });
        },
      },
      identifyModel: (model) => {
        expect(model).toBe("text-embedding-3-large");
        return {
          provider: "openai-compatible",
          endpointScopeFingerprint: "legacy-endpoint",
        };
      },
    });

    await expect(resolver.resolveBinding({
      workspaceId: "legacy-workspace",
      purpose: "retrieval_query",
    })).resolves.toEqual({
      space: {
        id: "text-embedding-3-large",
        dimensions: 3072,
        distanceMetric: "cosine",
      },
      model: "text-embedding-3-large",
      provider: "openai-compatible",
      endpointScopeFingerprint: "legacy-endpoint",
    });
  });

  it("lazily materializes an immutable active profile for a legacy workspace", async () => {
    const createdSpaces: unknown[] = [];
    const initializedProfiles: unknown[] = [];
    const resolver = new WorkspaceEmbeddingBindingResolver({
      profiles: {
        async findWorkspaceProfile() {
          return null;
        },
        async findEmbeddingSpaceById(id) {
          return id === "space-created"
            ? {
                id,
                identityFingerprint: "fingerprint",
                endpointScopeFingerprint: "endpoint-fingerprint",
                provider: "openai",
                model: "text-embedding-3-small",
                dimensions: 1536,
                distanceMetric: "cosine",
                normalization: "provider_unit",
                documentTask: null,
                queryTask: null,
                vectorOptions: {},
                modelVersion: null,
                status: "active",
                quarantineReason: null,
                createdAt: new Date(0),
                updatedAt: new Date(0),
              }
            : null;
        },
        async createEmbeddingSpace(input) {
          createdSpaces.push(input);
          return {
            ...input,
            id: "space-created",
            status: "active",
            quarantineReason: null,
            createdAt: new Date(0),
            updatedAt: new Date(0),
          };
        },
        async initializeWorkspaceProfile(input) {
          initializedProfiles.push(input);
          return {
            workspaceId: "legacy-workspace",
            activeEmbeddingSpaceId: input.activeEmbeddingSpaceId,
            pendingEmbeddingSpaceId: null,
            generation: "1",
            transition: null,
          };
        },
      },
      settings: {
        async getForWorkspace() {
          return settings({
            workspaceId: "legacy-workspace",
            embeddingModel: "text-embedding-3-small",
          });
        },
      },
      identifyModel: () => ({
        provider: "openai",
        endpointScopeFingerprint: "endpoint-fingerprint",
      }),
    });

    await expect(resolver.resolveBinding({
      workspaceId: "legacy-workspace",
      purpose: "retrieval_document",
    })).resolves.toMatchObject({
      space: { id: "space-created", dimensions: 1536 },
      model: "text-embedding-3-small",
    });
    expect(createdSpaces).toEqual([
      expect.objectContaining({
        provider: "openai",
        endpointScopeFingerprint: "endpoint-fingerprint",
        model: "text-embedding-3-small",
        dimensions: 1536,
        identityFingerprint: expect.any(String),
      }),
    ]);
    expect(initializedProfiles).toEqual([{
      workspaceId: "legacy-workspace",
      activeEmbeddingSpaceId: "space-created",
    }]);
  });

  it("preserves the 1536-dimensional contract when materializing an existing Gemini workspace", async () => {
    const createdSpaces: Array<Record<string, unknown>> = [];
    const resolver = new WorkspaceEmbeddingBindingResolver({
      profiles: {
        async findWorkspaceProfile() {
          return null;
        },
        async findEmbeddingSpaceById(id) {
          return {
            id,
            identityFingerprint: "fingerprint",
            endpointScopeFingerprint: "gemini-endpoint",
            provider: "gemini",
            model: "gemini-embedding-001",
            dimensions: 1536,
            distanceMetric: "cosine",
            normalization: "application_unit",
            documentTask: null,
            queryTask: null,
            vectorOptions: {},
            modelVersion: null,
            status: "active",
            quarantineReason: null,
            createdAt: new Date(0),
            updatedAt: new Date(0),
          };
        },
        async createEmbeddingSpace(input) {
          createdSpaces.push(input);
          return {
            ...input,
            id: "gemini-existing-space",
            status: "active",
            quarantineReason: null,
            createdAt: new Date(0),
            updatedAt: new Date(0),
          };
        },
        async initializeWorkspaceProfile(input) {
          return {
            workspaceId: "gemini-workspace",
            activeEmbeddingSpaceId: input.activeEmbeddingSpaceId,
            pendingEmbeddingSpaceId: null,
            generation: "1",
            transition: null,
          };
        },
      },
      settings: {
        async getForWorkspace() {
          return settings({
            workspaceId: "gemini-workspace",
            embeddingModel: "gemini-embedding-001",
          });
        },
      },
      identifyModel: () => ({
        provider: "gemini",
        endpointScopeFingerprint: "gemini-endpoint",
      }),
    });

    await expect(resolver.resolveBinding({
      workspaceId: "gemini-workspace",
      purpose: "retrieval_query",
    })).resolves.toEqual({
      space: {
        id: "gemini-existing-space",
        dimensions: 1536,
        distanceMetric: "cosine",
      },
      model: "gemini-embedding-001",
      provider: "gemini",
      endpointScopeFingerprint: "gemini-endpoint",
    });
    expect(createdSpaces).toEqual([
      expect.objectContaining({
        provider: "gemini",
        model: "gemini-embedding-001",
        dimensions: 1536,
        normalization: "application_unit",
        documentTask: null,
        queryTask: null,
      }),
    ]);
  });

  it("materializes an existing uncatalogued selection with the compatibility vector contract", async () => {
    const createdSpaces: Array<Record<string, unknown>> = [];
    const resolver = new WorkspaceEmbeddingBindingResolver({
      profiles: {
        async findWorkspaceProfile() {
          return null;
        },
        async findEmbeddingSpaceById(id) {
          return {
            id,
            identityFingerprint: "fingerprint",
            endpointScopeFingerprint: "endpoint-fingerprint",
            provider: "openai-compatible",
            model: "existing-embedding-model",
            dimensions: 1536,
            distanceMetric: "cosine",
            normalization: "application_unit",
            documentTask: null,
            queryTask: null,
            vectorOptions: {},
            modelVersion: null,
            status: "active",
            quarantineReason: null,
            createdAt: new Date(0),
            updatedAt: new Date(0),
          };
        },
        async createEmbeddingSpace(input) {
          createdSpaces.push(input);
          return {
            ...input,
            id: "space-existing",
            status: "active",
            quarantineReason: null,
            createdAt: new Date(0),
            updatedAt: new Date(0),
          };
        },
        async initializeWorkspaceProfile(input) {
          return {
            workspaceId: "legacy-workspace",
            activeEmbeddingSpaceId: input.activeEmbeddingSpaceId,
            pendingEmbeddingSpaceId: null,
            generation: "1",
            transition: null,
          };
        },
      },
      settings: {
        async getForWorkspace() {
          return settings({
            workspaceId: "legacy-workspace",
            embeddingModel:
              "existing-embedding-model" as IngestionSettingsRecord["embeddingModel"],
          });
        },
      },
      identifyModel: () => ({
        provider: "openai-compatible",
        endpointScopeFingerprint: "endpoint-fingerprint",
      }),
    });

    await expect(resolver.resolveBinding({
      workspaceId: "legacy-workspace",
      purpose: "retrieval_document",
    })).resolves.toEqual({
      space: {
        id: "space-existing",
        dimensions: 1536,
        distanceMetric: "cosine",
      },
      model: "existing-embedding-model",
      provider: "openai-compatible",
      endpointScopeFingerprint: "endpoint-fingerprint",
    });
    expect(createdSpaces).toEqual([
      expect.objectContaining({
        provider: "openai-compatible",
        endpointScopeFingerprint: "endpoint-fingerprint",
        model: "existing-embedding-model",
        dimensions: 1536,
        normalization: "application_unit",
      }),
    ]);
  });

  it("binds the persisted winner when concurrent legacy initialization selects another space", async () => {
    const resolver = new WorkspaceEmbeddingBindingResolver({
      profiles: {
        async findWorkspaceProfile() {
          return null;
        },
        async findEmbeddingSpaceById(id) {
          return {
            id,
            identityFingerprint: `fingerprint:${id}`,
            endpointScopeFingerprint: "endpoint-fingerprint",
            provider: "openai",
            model: id === "space-winner"
              ? "text-embedding-3-large"
              : "text-embedding-3-small",
            dimensions: id === "space-winner" ? 3072 : 1536,
            distanceMetric: "cosine",
            normalization: "provider_unit",
            documentTask: null,
            queryTask: null,
            vectorOptions: {},
            modelVersion: null,
            status: "active",
            quarantineReason: null,
            createdAt: new Date(0),
            updatedAt: new Date(0),
          };
        },
        async createEmbeddingSpace(input) {
          return {
            ...input,
            id: "space-loser",
            status: "active",
            quarantineReason: null,
            createdAt: new Date(0),
            updatedAt: new Date(0),
          };
        },
        async initializeWorkspaceProfile() {
          return {
            workspaceId: "legacy-workspace",
            activeEmbeddingSpaceId: "space-winner",
            pendingEmbeddingSpaceId: null,
            generation: "1",
            transition: null,
          };
        },
      },
      settings: {
        async getForWorkspace() {
          return settings({
            workspaceId: "legacy-workspace",
            embeddingModel: "text-embedding-3-small",
          });
        },
      },
      identifyModel: () => ({
        provider: "openai",
        endpointScopeFingerprint: "endpoint-fingerprint",
      }),
    });

    await expect(resolver.resolveBinding({
      workspaceId: "legacy-workspace",
      purpose: "retrieval_document",
    })).resolves.toMatchObject({
      space: { id: "space-winner", dimensions: 3072 },
      model: "text-embedding-3-large",
    });
  });
});
