import { describe, expect, it, vi } from "vitest";

import { contextScopeLadder, conversationSaveScope, conversationScopeLadder } from "../../src/modules/context-variables/domain.js";
import {
  ContextVariableResolverService,
  type AgentContextVariableEnablement,
  type ContextResolverPort,
  type ContextVariable,
  type ContextVariableScope,
  type ContextVariableValue,
} from "../../src/modules/context-variables/public.js";
import type { ContextVariableResolverRepositoryPort } from "../../src/modules/context-variables/repository.js";
import { channelPersonKeyId, whatsAppNumberKey, type ChannelPersonKey } from "../../src/shared/domain/channelPersonKey.js";

const workspaceId = "workspace-1";
const agentId = "agent-1";
const nowMs = Date.parse("2026-11-24T10:00:00.000Z");
// Obviously fake numbers in the reserved 555-01xx range.
const numberA: ChannelPersonKey = { kind: "whatsapp_contact", id: "15550100101" };
const numberB: ChannelPersonKey = { kind: "whatsapp_contact", id: "15550100102" };

describe("whatsAppNumberKey", () => {
  it("keeps a number the way wa_id stores it: its digits, country code first, with no plus", () => {
    expect(whatsAppNumberKey("15550100101")).toBe("15550100101");
    expect(whatsAppNumberKey("+1 555-010-0101")).toBe("15550100101");
    expect(whatsAppNumberKey(" +1 (555) 010.0101 ")).toBe("15550100101");
    expect(channelPersonKeyId("whatsapp_contact", "+15550100101")).toBe("15550100101");
  });

  it("refuses what is not a number", () => {
    expect(whatsAppNumberKey("")).toBeNull();
    expect(whatsAppNumberKey("customer-1")).toBeNull();
    expect(whatsAppNumberKey("+1 555 01x 0101")).toBeNull();
    expect(whatsAppNumberKey("12345")).toBeNull();
    expect(whatsAppNumberKey("1".repeat(21))).toBeNull();
  });
});

describe("the ladder with a channel's person key", () => {
  it("places a WhatsApp number at the person step, between the session and the agent", () => {
    expect(contextScopeLadder({ conversationId: "c-1", chatSessionId: "s-1", verifiedCustomerId: null, channelPersonKey: numberA, agentId, workspaceId }))
      .toEqual([
        { type: "conversation", id: "c-1" },
        { type: "session", id: "s-1" },
        { type: "whatsapp_contact", id: "15550100101" },
        { type: "agent", id: agentId },
        { type: "workspace", id: workspaceId },
      ]);
    expect(conversationScopeLadder({ conversationId: "c-1", chatSessionId: null, verifiedCustomerId: null, channelPersonKey: numberA }))
      .toEqual([{ type: "conversation", id: "c-1" }, { type: "whatsapp_contact", id: "15550100101" }]);
  });

  it("gives a conversation one person key: a verified customer is never joined by a channel's key", () => {
    expect(conversationScopeLadder({ conversationId: "c-1", chatSessionId: null, verifiedCustomerId: "customer-1", channelPersonKey: numberA }))
      .toEqual([{ type: "conversation", id: "c-1" }, { type: "customer", id: "customer-1" }]);
  });

  it("keeps a turn without a channel's key on the ladder it always had", () => {
    expect(conversationScopeLadder({ conversationId: "c-1", chatSessionId: null, verifiedCustomerId: null }))
      .toEqual([{ type: "conversation", id: "c-1" }]);
  });
});

describe("conversationSaveScope with a channel's person key", () => {
  it("saves a person value for the WhatsApp number when the conversation has no verified customer", () => {
    expect(conversationSaveScope("person", { conversationId: "c-1", verifiedCustomerId: null, channelPersonKey: numberA }))
      .toEqual({ type: "whatsapp_contact", id: "15550100101" });
  });

  it("prefers the verified customer, and keeps a conversation save on the conversation", () => {
    expect(conversationSaveScope("person", { conversationId: "c-1", verifiedCustomerId: "customer-1", channelPersonKey: numberA }))
      .toEqual({ type: "customer", id: "customer-1" });
    expect(conversationSaveScope("conversation", { conversationId: "c-1", verifiedCustomerId: null, channelPersonKey: numberA }))
      .toEqual({ type: "conversation", id: "c-1" });
  });
});

const resolverVariable: ContextVariable = {
  id: "var-1",
  workspaceId,
  name: "loyalty_tier",
  description: null,
  valueType: "json",
  options: null,
  trustTier: "unverified",
  sensitivity: "normal",
  defaultSurfacing: "always",
  createdAt: new Date(nowMs),
  updatedAt: new Date(nowMs),
};

const resolverEnablement: AgentContextVariableEnablement = {
  id: "enablement-1",
  agentId,
  variableId: resolverVariable.id,
  source: "resolver",
  resolverSkillId: "skill-1",
  maxAgeSeconds: 600,
  resolverTimeoutMs: 1_000,
  surfacing: "always",
  enabled: true,
  createdAt: new Date(nowMs),
  updatedAt: new Date(nowMs),
  variable: resolverVariable,
};

/** A resolver over an in-memory cache keyed by scope, as the value store keys it. */
const resolverOverCache = (fetched: unknown[]) => {
  const stored = new Map<string, ContextVariableValue>();
  const keyOf = (variableId: string, scope: ContextVariableScope) => `${variableId}/${scope.type}/${scope.id}`;
  const repository = {
    resolveForAgent: vi.fn(async () => []),
    listByAgent: vi.fn(async () => [resolverEnablement]),
    get: vi.fn(async () => resolverVariable),
    readMostSpecificValues: vi.fn(async () => new Map()),
    readValue: vi.fn(async (variableId: string, scope: ContextVariableScope) => stored.get(keyOf(variableId, scope)) ?? null),
    upsertValue: vi.fn(async (variableId: string, scope: ContextVariableScope, data: unknown) => {
      const row: ContextVariableValue = {
        id: keyOf(variableId, scope),
        workspaceId,
        variableId,
        scope,
        data,
        lastModified: new Date(nowMs),
        writtenBy: { kind: "api", ref: null },
      };
      stored.set(row.id, row);
      return row;
    }),
  } as unknown as ContextVariableResolverRepositoryPort;
  const resolver: ContextResolverPort = { resolve: vi.fn(async () => (fetched.length > 0 ? { value: fetched.shift() } : null)) };
  const service = new ContextVariableResolverService({ repository, resolver, now: () => nowMs });
  return { service, resolver, stored };
};

describe("a resolver on a WhatsApp turn", () => {
  const ladderFor = (conversationId: string, channelPersonKey: ChannelPersonKey | null) =>
    contextScopeLadder({ conversationId, chatSessionId: null, verifiedCustomerId: null, channelPersonKey, agentId, workspaceId });

  it("caches under the number, and never hands the number to the host's skill", async () => {
    const { service, resolver, stored } = resolverOverCache([{ tier: "gold" }]);

    await expect(service.resolveForAgent(workspaceId, agentId, ladderFor("c-1", numberA)))
      .resolves.toMatchObject([{ name: "loyalty_tier", value: { tier: "gold" } }]);

    expect([...stored.values()].map(({ scope }) => scope)).toEqual([{ type: "whatsapp_contact", id: numberA.id }]);
    expect(resolver.resolve).toHaveBeenCalledWith(expect.objectContaining({ scope: { type: "agent", id: agentId } }));
    expect(JSON.stringify(vi.mocked(resolver.resolve).mock.calls)).not.toContain(numberA.id);
  });

  it("never serves one number the value fetched for another", async () => {
    const { service, stored } = resolverOverCache([{ tier: "gold" }, { tier: "silver" }]);

    await expect(service.resolveForAgent(workspaceId, agentId, ladderFor("c-1", numberA)))
      .resolves.toMatchObject([{ value: { tier: "gold" } }]);
    await expect(service.resolveForAgent(workspaceId, agentId, ladderFor("c-2", numberB)))
      .resolves.toMatchObject([{ value: { tier: "silver" } }]);
    expect([...stored.values()].map(({ scope }) => scope.id).sort()).toEqual([numberA.id, numberB.id]);
  });

  it("serves the number's cached value to its next conversation", async () => {
    const { service, resolver } = resolverOverCache([{ tier: "gold" }]);

    await service.resolveForAgent(workspaceId, agentId, ladderFor("c-1", numberA));
    await expect(service.resolveForAgent(workspaceId, agentId, ladderFor("c-2", numberA)))
      .resolves.toMatchObject([{ value: { tier: "gold" } }]);
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
  });
});
