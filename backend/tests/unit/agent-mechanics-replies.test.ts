import { describe, expect, it } from "vitest";

import { agentBodySchema } from "../../src/app/http/routes/agentRoutes.js";
import {
  agentMechanicsRepliesSchema,
  defaultAgentMechanicsReplies,
  materializeAgentFromConfig,
  projectInternalAgentConfig,
  readStoredAgentMechanicsReplies,
  validateAgentInput,
} from "../../src/modules/agents/public.js";
import { conversationQualityAgent } from "../fixtures/conversation-quality/agent.js";

const authored = {
  en: {
    greeting: ["Hi! What can I help you with?", "Hello! What brings you here today?"],
    thanks: ["You're welcome!"],
    farewell: ["Goodbye, and thanks for stopping by."],
    acknowledgement: ["Great."],
  },
  "it-IT": {
    greeting: ["Ciao! Come posso aiutarti?"],
    thanks: ["Prego!"],
    farewell: ["Arrivederci!"],
    acknowledgement: [],
  },
};

const lines = (count: number): string[] => Array.from({ length: count }, (_, index) => `Line ${index + 1}.`);

describe("agent mechanics replies", () => {
  it("accepts authored lines per conversational mechanic, keyed by language tag", () => {
    expect(agentMechanicsRepliesSchema.parse(authored)).toEqual(authored);
  });

  it("starts with nothing authored", () => {
    expect(defaultAgentMechanicsReplies()).toEqual({});
  });

  it("rejects more than five lines for one mechanic", () => {
    expect(agentMechanicsRepliesSchema.safeParse({
      en: { ...authored.en, greeting: lines(6) },
    }).success).toBe(false);
  });

  it.each(["italian", "en_US", "{{locale}}", "e", ""])("rejects %j as a locale key", (key) => {
    expect(agentMechanicsRepliesSchema.safeParse({ [key]: authored.en }).success).toBe(false);
  });

  it("rejects a line longer than 200 characters, and a blank one", () => {
    expect(agentMechanicsRepliesSchema.safeParse({ en: { ...authored.en, thanks: ["a".repeat(201)] } }).success).toBe(false);
    expect(agentMechanicsRepliesSchema.safeParse({ en: { ...authored.en, thanks: ["a".repeat(200)] } }).success).toBe(true);
    expect(agentMechanicsRepliesSchema.safeParse({ en: { ...authored.en, thanks: ["   "] } }).success).toBe(false);
  });

  it("rejects more than ten locales", () => {
    const locales = ["en", "it", "de", "fr", "es", "pt", "nl", "pl", "sv", "da", "fi"];
    expect(agentMechanicsRepliesSchema.safeParse(
      Object.fromEntries(locales.map((locale) => [locale, authored.en])),
    ).success).toBe(false);
    expect(agentMechanicsRepliesSchema.safeParse(
      Object.fromEntries(locales.slice(0, 10).map((locale) => [locale, authored.en])),
    ).success).toBe(true);
  });

  it("requires every mechanic in a locale entry, so a partial entry cannot reset the lines it leaves out", () => {
    expect(agentMechanicsRepliesSchema.safeParse({ en: { greeting: ["Hi!"] } }).success).toBe(false);
  });

  it("reads a stored block back as authored, and anything unreadable as nothing authored", () => {
    expect(readStoredAgentMechanicsReplies(authored)).toEqual(authored);
    expect(readStoredAgentMechanicsReplies(undefined)).toEqual({});
    expect(readStoredAgentMechanicsReplies({ en: { greeting: "Hi!" } })).toEqual({});
  });

  it("validates the block on agent input and keeps an absent one empty", () => {
    expect(validateAgentInput({ name: "Support", mechanicsReplies: authored }).mechanicsReplies).toEqual(authored);
    expect(validateAgentInput({ name: "Support" }).mechanicsReplies).toEqual({});
    expect(() => validateAgentInput({ name: "Support", mechanicsReplies: { english: authored.en } })).toThrow();
  });

  it("accepts a whole block on the agent route and adds none to a body that omits it", () => {
    expect(agentBodySchema.parse({ mechanicsReplies: authored }).mechanicsReplies).toEqual(authored);
    // validateBody replaces req.body with this parse, so a default here would reset the stored block.
    expect(agentBodySchema.parse({ name: "Renamed" })).not.toHaveProperty("mechanicsReplies");
    expect(() => agentBodySchema.parse({ mechanicsReplies: { en: { greeting: ["Hi!"] } } })).toThrow();
  });

  it("travels in the portable config, so Test Chat and eval replay speak the same lines as live chat", () => {
    const config = projectInternalAgentConfig({ ...conversationQualityAgent, mechanicsReplies: authored });

    expect(config.mechanicsReplies).toEqual(authored);
    expect(config.portability.mechanicsReplies).toBe("portable");
    expect(materializeAgentFromConfig(config, { agentId: "agent-2", workspaceId: "workspace-2" }).mechanicsReplies)
      .toEqual(authored);
    const { mechanicsReplies: _omitted, ...olderConfig } = config;
    expect(materializeAgentFromConfig(olderConfig as typeof config, { agentId: "agent-2", workspaceId: "workspace-2" }).mechanicsReplies)
      .toEqual({});
  });
});
