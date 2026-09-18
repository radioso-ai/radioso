import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { VisitorObservedFacts, VisitorRecord, VisitorRepositoryPort } from "../../src/db/repositories/visitorRepository.js";
import { VisitorResolver } from "../../src/modules/visitors/services/visitorResolver.js";

const noObservation: VisitorObservedFacts = { country: null, language: null, userAgent: null };

const buildVisitor = (overrides: Partial<VisitorRecord> = {}): VisitorRecord => ({
  id: randomUUID(),
  workspaceId: "workspace-1",
  visitorKey: null,
  verifiedCustomerId: null,
  firstSeenAt: new Date("2026-06-01T00:00:00.000Z"),
  lastSeenAt: new Date("2026-06-01T00:00:00.000Z"),
  conversationCount: 1,
  lastCountry: null,
  lastLanguage: null,
  lastUserAgent: null,
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  updatedAt: new Date("2026-06-01T00:00:00.000Z"),
  ...overrides,
});

interface RepositoryMock extends VisitorRepositoryPort {
  findByVerifiedCustomerId: ReturnType<typeof vi.fn<VisitorRepositoryPort["findByVerifiedCustomerId"]>>;
  findByVisitorKey: ReturnType<typeof vi.fn<VisitorRepositoryPort["findByVisitorKey"]>>;
  findById: ReturnType<typeof vi.fn<VisitorRepositoryPort["findById"]>>;
  insertOrGet: ReturnType<typeof vi.fn<VisitorRepositoryPort["insertOrGet"]>>;
  recordObservation: ReturnType<typeof vi.fn<VisitorRepositoryPort["recordObservation"]>>;
  upgradeToVerified: ReturnType<typeof vi.fn<VisitorRepositoryPort["upgradeToVerified"]>>;
  moveConversation: ReturnType<typeof vi.fn<VisitorRepositoryPort["moveConversation"]>>;
}

const buildRepository = (): RepositoryMock => ({
  findByVerifiedCustomerId: vi.fn<VisitorRepositoryPort["findByVerifiedCustomerId"]>().mockResolvedValue(null),
  findByVisitorKey: vi.fn<VisitorRepositoryPort["findByVisitorKey"]>().mockResolvedValue(null),
  findById: vi.fn<VisitorRepositoryPort["findById"]>().mockResolvedValue(null),
  insertOrGet: vi.fn<VisitorRepositoryPort["insertOrGet"]>(),
  recordObservation: vi.fn<VisitorRepositoryPort["recordObservation"]>().mockResolvedValue(undefined),
  upgradeToVerified: vi.fn<VisitorRepositoryPort["upgradeToVerified"]>().mockResolvedValue(undefined),
  moveConversation: vi.fn<VisitorRepositoryPort["moveConversation"]>().mockResolvedValue(undefined),
});

describe("VisitorResolver.resolveForConversation", () => {
  it("resolves an existing verified visitor first and records the observation", async () => {
    const repository = buildRepository();
    const verified = buildVisitor({ verifiedCustomerId: "customer-1" });
    repository.findByVerifiedCustomerId.mockResolvedValue(verified);
    const resolver = new VisitorResolver(repository);

    const result = await resolver.resolveForConversation({
      workspaceId: "workspace-1",
      visitorKey: null,
      verifiedCustomerId: "customer-1",
      observed: { country: "DE", language: "de", userAgent: "UA" },
    });

    expect(result.visitorId).toBe(verified.id);
    expect(repository.recordObservation).toHaveBeenCalledWith(verified.id, {
      country: "DE",
      language: "de",
      userAgent: "UA",
    });
    expect(repository.findByVisitorKey).not.toHaveBeenCalled();
    expect(repository.insertOrGet).not.toHaveBeenCalled();
  });

  it("falls back to the anonymous visitor when no verified row exists", async () => {
    const repository = buildRepository();
    const anon = buildVisitor({ visitorKey: "anon-1" });
    repository.findByVisitorKey.mockResolvedValue(anon);
    const resolver = new VisitorResolver(repository);

    const result = await resolver.resolveForConversation({
      workspaceId: "workspace-1",
      visitorKey: "anon-1",
      verifiedCustomerId: null,
      observed: noObservation,
    });

    expect(result.visitorId).toBe(anon.id);
    expect(repository.recordObservation).toHaveBeenCalledWith(anon.id, noObservation);
    expect(repository.upgradeToVerified).not.toHaveBeenCalled();
  });

  it("upgrades an anonymous-only row in place when a verified id newly resolves alongside it", async () => {
    const repository = buildRepository();
    const anon = buildVisitor({ visitorKey: "anon-1", verifiedCustomerId: null });
    repository.findByVisitorKey.mockResolvedValue(anon);
    const resolver = new VisitorResolver(repository);

    const result = await resolver.resolveForConversation({
      workspaceId: "workspace-1",
      visitorKey: "anon-1",
      verifiedCustomerId: "customer-1",
      observed: noObservation,
    });

    expect(repository.upgradeToVerified).toHaveBeenCalledWith(anon.id, "customer-1");
    expect(repository.recordObservation).toHaveBeenCalledWith(anon.id, noObservation);
    expect(result.visitorId).toBe(anon.id);
  });

  it("never re-attaches an anonymous row already bound to a different verified id", async () => {
    const repository = buildRepository();
    const anon = buildVisitor({ visitorKey: "anon-1", verifiedCustomerId: "customer-old" });
    repository.findByVisitorKey.mockResolvedValue(anon);
    const resolver = new VisitorResolver(repository);

    await resolver.resolveForConversation({
      workspaceId: "workspace-1",
      visitorKey: "anon-1",
      verifiedCustomerId: "customer-new",
      observed: noObservation,
    });

    expect(repository.upgradeToVerified).not.toHaveBeenCalled();
  });

  it("inserts a new row when neither key resolves", async () => {
    const repository = buildRepository();
    const created = buildVisitor({ visitorKey: "anon-1" });
    repository.insertOrGet.mockResolvedValue({ record: created, inserted: true });
    const resolver = new VisitorResolver(repository);

    const result = await resolver.resolveForConversation({
      workspaceId: "workspace-1",
      visitorKey: "anon-1",
      verifiedCustomerId: null,
      observed: noObservation,
    });

    expect(result.visitorId).toBe(created.id);
    expect(repository.recordObservation).not.toHaveBeenCalled();
  });

  it("records a second observation when a concurrent insert lost the race (User Story 2 scenario 4)", async () => {
    const repository = buildRepository();
    const winner = buildVisitor({ visitorKey: "anon-1", conversationCount: 1 });
    repository.insertOrGet.mockResolvedValue({ record: winner, inserted: false });
    const resolver = new VisitorResolver(repository);

    const result = await resolver.resolveForConversation({
      workspaceId: "workspace-1",
      visitorKey: "anon-1",
      verifiedCustomerId: null,
      observed: noObservation,
    });

    expect(result.visitorId).toBe(winner.id);
    expect(repository.recordObservation).toHaveBeenCalledWith(winner.id, noObservation);
  });
});

describe("VisitorResolver.attachVerifiedIdentity", () => {
  it("scenario 1: upgrades an anonymous-only row when no row exists for the verified id", async () => {
    const repository = buildRepository();
    const anon = buildVisitor({ visitorKey: "anon-A", verifiedCustomerId: null });
    repository.findByVisitorKey.mockResolvedValue(anon);
    repository.findByVerifiedCustomerId.mockResolvedValue(null);
    const metrics = { incrementCounter: vi.fn() };
    const resolver = new VisitorResolver(repository, metrics);

    const result = await resolver.attachVerifiedIdentity({
      conversationId: "conversation-1",
      workspaceId: "workspace-1",
      visitorKey: "anon-A",
      verifiedCustomerId: "customer-C",
    });

    expect(result.outcome).toBe("upgraded");
    expect(repository.upgradeToVerified).toHaveBeenCalledWith(anon.id, "customer-C");
    expect(repository.moveConversation).not.toHaveBeenCalled();
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      "visitor_identity_attached_total",
      expect.objectContaining({ labels: { outcome: "upgraded" } }),
    );
  });

  it("scenario 2: moves the conversation to an existing verified row and leaves the anonymous row unchanged", async () => {
    const repository = buildRepository();
    const anon = buildVisitor({ visitorKey: "anon-A", verifiedCustomerId: null });
    const verified = buildVisitor({ verifiedCustomerId: "customer-C" });
    repository.findByVisitorKey.mockResolvedValue(anon);
    repository.findByVerifiedCustomerId.mockResolvedValue(verified);
    const resolver = new VisitorResolver(repository);

    const result = await resolver.attachVerifiedIdentity({
      conversationId: "conversation-1",
      workspaceId: "workspace-1",
      visitorKey: "anon-A",
      verifiedCustomerId: "customer-C",
    });

    expect(result.outcome).toBe("moved_existing");
    expect(repository.upgradeToVerified).not.toHaveBeenCalled();
    expect(repository.moveConversation).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      workspaceId: "workspace-1",
      fromVisitorId: anon.id,
      toVisitorId: verified.id,
    });
  });

  it("scenario 3: moves the conversation to a freshly inserted row for a different verified id and never re-attaches", async () => {
    const repository = buildRepository();
    const anon = buildVisitor({ visitorKey: "anon-A", verifiedCustomerId: "customer-C" });
    const insertedForD = buildVisitor({ verifiedCustomerId: "customer-D" });
    repository.findByVisitorKey.mockResolvedValue(anon);
    repository.findByVerifiedCustomerId.mockResolvedValue(null);
    repository.insertOrGet.mockResolvedValue({ record: insertedForD, inserted: true });
    const resolver = new VisitorResolver(repository);

    const result = await resolver.attachVerifiedIdentity({
      conversationId: "conversation-1",
      workspaceId: "workspace-1",
      visitorKey: "anon-A",
      verifiedCustomerId: "customer-D",
    });

    expect(result.outcome).toBe("moved_new");
    expect(repository.upgradeToVerified).not.toHaveBeenCalled();
    expect(repository.insertOrGet).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace-1", verifiedCustomerId: "customer-D" }),
    );
    expect(repository.moveConversation).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      workspaceId: "workspace-1",
      fromVisitorId: anon.id,
      toVisitorId: insertedForD.id,
    });
  });

  it("scenario 4 (idempotent re-verify): reports unchanged when the anonymous and verified lookups already share a row", async () => {
    const repository = buildRepository();
    const merged = buildVisitor({ visitorKey: "anon-A", verifiedCustomerId: "customer-C" });
    repository.findByVisitorKey.mockResolvedValue(merged);
    repository.findByVerifiedCustomerId.mockResolvedValue(merged);
    const metrics = { incrementCounter: vi.fn() };
    const resolver = new VisitorResolver(repository, metrics);

    const result = await resolver.attachVerifiedIdentity({
      conversationId: "conversation-1",
      workspaceId: "workspace-1",
      visitorKey: "anon-A",
      verifiedCustomerId: "customer-C",
    });

    expect(result.outcome).toBe("unchanged");
    expect(repository.upgradeToVerified).not.toHaveBeenCalled();
    expect(repository.moveConversation).not.toHaveBeenCalled();
    expect(metrics.incrementCounter).not.toHaveBeenCalled();
  });

  it("moves a dashboard-created conversation (no anonymous id) to an existing verified row without a from-side decrement", async () => {
    const repository = buildRepository();
    const verified = buildVisitor({ verifiedCustomerId: "customer-C" });
    repository.findByVerifiedCustomerId.mockResolvedValue(verified);
    const resolver = new VisitorResolver(repository);

    const result = await resolver.attachVerifiedIdentity({
      conversationId: "conversation-1",
      workspaceId: "workspace-1",
      visitorKey: null,
      verifiedCustomerId: "customer-C",
    });

    expect(result.outcome).toBe("moved_existing");
    expect(repository.moveConversation).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      workspaceId: "workspace-1",
      fromVisitorId: null,
      toVisitorId: verified.id,
    });
  });
});
