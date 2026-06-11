import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  DefaultWebhookDestinationResolver,
  EncryptionNotConfiguredError,
  WebhookDestinationService,
  type WebhookDestinationRecord,
  type WebhookDestinationRepositoryPort,
} from "../../src/modules/webhooks/public.js";
import { decryptField } from "../../src/shared/infra/crypto/fieldEncryption.js";

const TEST_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "22222222-2222-4222-8222-222222222222";

class FakeWebhookDestinationRepository implements WebhookDestinationRepositoryPort {
  readonly rows = new Map<string, WebhookDestinationRecord>();

  async create(input: {
    workspaceId: string;
    name: string;
    url: string;
    secretCiphertext: string;
    encryptionKeyId: string;
  }): Promise<WebhookDestinationRecord> {
    if ([...this.rows.values()].some((row) =>
      row.workspaceId === input.workspaceId && row.name.toLowerCase() === input.name.toLowerCase()
    )) {
      throw new Error("duplicate key value violates unique constraint");
    }
    const now = new Date();
    const record: WebhookDestinationRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      name: input.name,
      url: input.url,
      secretCiphertext: input.secretCiphertext,
      encryptionKeyId: input.encryptionKeyId,
      lastDeliveryStatus: null,
      lastDeliveryAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(record.id, record);
    return record;
  }

  async listByWorkspace(inputWorkspaceId: string): Promise<WebhookDestinationRecord[]> {
    return [...this.rows.values()].filter((row) => row.workspaceId === inputWorkspaceId);
  }

  async findByIdAndWorkspace(id: string, inputWorkspaceId: string): Promise<WebhookDestinationRecord | null> {
    const record = this.rows.get(id);
    return record && record.workspaceId === inputWorkspaceId ? record : null;
  }

  async update(
    id: string,
    inputWorkspaceId: string,
    input: { name: string; url: string },
  ): Promise<WebhookDestinationRecord | null> {
    const record = await this.findByIdAndWorkspace(id, inputWorkspaceId);
    if (!record) {
      return null;
    }
    const updated = { ...record, ...input, updatedAt: new Date() };
    this.rows.set(id, updated);
    return updated;
  }

  async updateSecret(
    id: string,
    inputWorkspaceId: string,
    input: { secretCiphertext: string; encryptionKeyId: string },
  ): Promise<WebhookDestinationRecord | null> {
    const record = await this.findByIdAndWorkspace(id, inputWorkspaceId);
    if (!record) {
      return null;
    }
    const updated = { ...record, ...input, updatedAt: new Date() };
    this.rows.set(id, updated);
    return updated;
  }

  async recordDeliveryOutcome(id: string, inputWorkspaceId: string, status: string): Promise<void> {
    const record = await this.findByIdAndWorkspace(id, inputWorkspaceId);
    if (!record) {
      return;
    }
    this.rows.set(id, {
      ...record,
      lastDeliveryStatus: status,
      lastDeliveryAt: new Date(),
      updatedAt: new Date(),
    });
  }

  async delete(id: string, inputWorkspaceId: string): Promise<boolean> {
    const record = await this.findByIdAndWorkspace(id, inputWorkspaceId);
    return record ? this.rows.delete(id) : false;
  }
}

const audit = () => ({
  record: vi.fn(async () => undefined),
});

const createService = (overrides: {
  key?: string;
  assertPublicUrl?: (url: string) => Promise<void>;
  allowHttpLoopback?: boolean;
  referencedRoutineNames?: string[];
} = {}) => {
  const repository = new FakeWebhookDestinationRepository();
  const service = new WebhookDestinationService({
    repository,
    auditService: audit(),
    encryption: { key: Object.hasOwn(overrides, "key") ? overrides.key : TEST_KEY },
    assertPublicUrl: overrides.assertPublicUrl ?? (async () => undefined),
    allowHttpLoopback: overrides.allowHttpLoopback,
    routineReferences: {
      async listPublishedRoutineNamesReferencingDestination() {
        return overrides.referencedRoutineNames ?? [];
      },
    },
  });
  return { repository, service };
};

describe("WebhookDestinationService", () => {
  it("creates destinations with encrypted secrets returned only once", async () => {
    const { repository, service } = createService();

    const created = await service.create({
      workspaceId,
      name: "crm-leads",
      url: "https://hooks.example.com/leads",
      actor: { accountId: "acc-1" },
    });

    expect(created.secret).toEqual(expect.any(String));
    expect(created.destination).not.toHaveProperty("secret");
    const stored = repository.rows.get(created.destination.id);
    expect(stored?.secretCiphertext).not.toContain(created.secret);
    expect(decryptField(stored!.secretCiphertext, TEST_KEY)).toBe(created.secret);

    const listed = await service.list(workspaceId);
    expect(listed).toEqual([expect.not.objectContaining({ secret: expect.anything() })]);
    expect(JSON.stringify(listed)).not.toContain(created.secret);
  });

  it("normalizes uppercase URL schemes before public-host checks and persistence", async () => {
    const assertPublicUrl = vi.fn(async () => undefined);
    const { service } = createService({ assertPublicUrl });

    const created = await service.create({
      workspaceId,
      name: "crm-leads",
      url: "HTTPS://hooks.example.com/leads",
      actor: { accountId: "acc-1" },
    });

    expect(created.destination.url).toBe("https://hooks.example.com/leads");
    expect(assertPublicUrl).toHaveBeenCalledWith("https://hooks.example.com/leads");

    const updated = await service.update({
      workspaceId,
      id: created.destination.id,
      name: "crm-leads",
      url: "HTTPS://hooks.example.com/leads-v2",
      actor: { accountId: "acc-1" },
    });

    expect(updated.url).toBe("https://hooks.example.com/leads-v2");
  });

  it("rejects duplicate names within one workspace case-insensitively", async () => {
    const { service } = createService();
    await service.create({ workspaceId, name: "CRM", url: "https://example.com/a", actor: { accountId: "acc-1" } });

    await expect(
      service.create({ workspaceId, name: "crm", url: "https://example.com/b", actor: { accountId: "acc-1" } }),
    ).rejects.toThrow(/already exists/i);
  });

  it("rotates the secret and invalidates the previous plaintext", async () => {
    const { service } = createService();
    const created = await service.create({
      workspaceId,
      name: "ops",
      url: "https://example.com/ops",
      actor: { accountId: "acc-1" },
    });

    const rotated = await service.rotateSecret(workspaceId, created.destination.id, { accountId: "acc-1" });

    expect(rotated.secret).not.toBe(created.secret);
      await expect(service.resolveSecret(workspaceId, created.destination.id)).resolves.toBe(rotated.secret);
  });

  it("throws EncryptionNotConfiguredError when writing secrets without a key", async () => {
    const { service } = createService({ key: undefined });

    await expect(
      service.create({ workspaceId, name: "crm", url: "https://example.com", actor: { accountId: "acc-1" } }),
    ).rejects.toBeInstanceOf(EncryptionNotConfiguredError);
  });

  it("enforces https and the injected public-host guard by default", async () => {
    const assertPublicUrl = vi.fn(async (url: string) => {
      if (url.includes("internal")) {
        throw new Error("publicly routable");
      }
    });
    const { service } = createService({ assertPublicUrl });

    await expect(
      service.create({ workspaceId, name: "bad", url: "http://example.com", actor: { accountId: "acc-1" } }),
    ).rejects.toThrow(/https/i);
    await expect(
      service.create({ workspaceId, name: "internal", url: "https://internal.example", actor: { accountId: "acc-1" } }),
    ).rejects.toThrow(/publicly routable/i);
    await service.create({ workspaceId, name: "good", url: "https://example.com", actor: { accountId: "acc-1" } });
    expect(assertPublicUrl).toHaveBeenCalledWith("https://example.com");
  });

  it("allows loopback http only when the local-dev exception is explicitly enabled", async () => {
    const strict = createService();
    await expect(
      strict.service.create({ workspaceId, name: "local", url: "http://127.0.0.1:8787/hook", actor: { accountId: "acc-1" } }),
    ).rejects.toThrow(/https/i);

    const relaxed = createService({ allowHttpLoopback: true });
    await expect(
      relaxed.service.create({ workspaceId, name: "local", url: "http://127.0.0.1:8787/hook", actor: { accountId: "acc-1" } }),
    ).resolves.toMatchObject({ destination: { url: "http://127.0.0.1:8787/hook" } });
  });

  it("blocks deletion when published routines reference the destination", async () => {
    const { service } = createService({ referencedRoutineNames: ["lead intake"] });
    const created = await service.create({
      workspaceId,
      name: "crm",
      url: "https://example.com",
      actor: { accountId: "acc-1" },
    });

    await expect(service.delete(workspaceId, created.destination.id, { accountId: "acc-1" }))
      .rejects.toThrow(/lead intake/);
  });
});

describe("DefaultWebhookDestinationResolver", () => {
  it("resolves an id in the same workspace to url plus decrypted secret", async () => {
    const { service } = createService();
    const created = await service.create({
      workspaceId,
      name: "crm",
      url: "https://example.com",
      actor: { accountId: "acc-1" },
    });
    const resolver = new DefaultWebhookDestinationResolver(service);

    await expect(resolver.resolve(created.destination.id, { workspaceId }))
      .resolves.toEqual({ url: "https://example.com", secret: created.secret });
  });

  it("returns null for unknown or cross-workspace ids", async () => {
    const { service } = createService();
    const created = await service.create({
      workspaceId,
      name: "crm",
      url: "https://example.com",
      actor: { accountId: "acc-1" },
    });
    const resolver = new DefaultWebhookDestinationResolver(service);

    await expect(resolver.resolve("missing", { workspaceId })).resolves.toBeNull();
    await expect(resolver.resolve(created.destination.id, { workspaceId: otherWorkspaceId })).resolves.toBeNull();
  });
});
