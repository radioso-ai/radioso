import { describe, expect, it } from "vitest";

import {
  agentPrivacyNoticesInputSchema,
  choosePrivacyNotice,
  isPrivacyNoticeVersionOf,
  normalizePrivacyNotices,
  validateAgentInput,
} from "../../../src/modules/agents/public.js";

const notice = { text: "We use your messages to answer you.", url: "https://example.com/privacy" };

describe("privacy notice normalization", () => {
  it("is empty when the agent has none", () => {
    expect(normalizePrivacyNotices(undefined)).toEqual({});
    expect(normalizePrivacyNotices(null)).toEqual({});
    expect(validateAgentInput({ name: "Agent" }).branding.privacyNotice).toEqual({});
  });

  it("keeps the line on one line and stamps each language with a version of its words and link", () => {
    const normalized = normalizePrivacyNotices({
      en: { text: "  We use your\nmessages   to answer you. ", url: " https://example.com/privacy " },
    });

    expect(normalized.en).toEqual({
      text: "We use your messages to answer you.",
      url: "https://example.com/privacy",
      version: expect.stringMatching(/^en:[0-9a-f]{16}$/),
    });
  });

  it("gives the same notice the same version on every save, and a changed notice a new one", () => {
    const first = normalizePrivacyNotices({ en: notice }).en?.version;
    const again = normalizePrivacyNotices({ en: { ...notice, version: "en:forged" } }).en?.version;
    const reworded = normalizePrivacyNotices({ en: { ...notice, text: "We read your messages." } }).en?.version;
    const relinked = normalizePrivacyNotices({ en: { ...notice, url: "https://example.com/privacy-v2" } }).en?.version;
    const otherLanguage = normalizePrivacyNotices({ de: notice }).de?.version;

    expect(again).toBe(first);
    expect(new Set([first, reworded, relinked, otherLanguage]).size).toBe(4);
  });

  it("refuses a notice without its line or its link, or with a link that is not a web page", () => {
    expect(() => normalizePrivacyNotices({ en: { text: "  ", url: notice.url } })).toThrow(/branding\.privacyNotice\.en\.text/);
    expect(() => normalizePrivacyNotices({ en: { text: notice.text, url: "" } })).toThrow(/branding\.privacyNotice\.en\.url/);
    expect(() => normalizePrivacyNotices({ en: { text: notice.text, url: "javascript:alert(1)" } })).toThrow(/http or https/);
    expect(() => normalizePrivacyNotices({ en: { text: notice.text, url: "not a url" } })).toThrow(/valid URL/);
  });

  it("refuses a line or link past its bound, a key that is not a language tag, and a repeated language", () => {
    expect(() => normalizePrivacyNotices({ en: { text: "x".repeat(201), url: notice.url } })).toThrow(/200/);
    expect(() => normalizePrivacyNotices({ en: { text: notice.text, url: `https://example.com/${"p".repeat(500)}` } })).toThrow(/500/);
    expect(() => normalizePrivacyNotices({ english: notice })).toThrow(/language tag/);
    expect(() => normalizePrivacyNotices({ en: notice, EN: notice })).toThrow(/once/);
  });

  it("holds at most ten languages", () => {
    const tags = ["en", "de", "fr", "it", "es", "pt", "nl", "pl", "ja", "zh", "ru"];
    expect(() => normalizePrivacyNotices(Object.fromEntries(tags.map((tag) => [tag, notice])))).toThrow(/10/);
  });

  it("accepts on write what agent_configuration reads back, version included", () => {
    const stored = normalizePrivacyNotices({ en: notice });
    expect(agentPrivacyNoticesInputSchema.safeParse(stored).success).toBe(true);
    expect(agentPrivacyNoticesInputSchema.safeParse({ en: { text: notice.text } }).success).toBe(false);
  });
});

describe("choosing the notice a conversation is shown", () => {
  const notices = normalizePrivacyNotices({
    de: { text: "Wir nutzen Ihre Nachrichten.", url: "https://example.com/de/datenschutz" },
    en: notice,
    "pt-BR": { text: "Usamos suas mensagens.", url: "https://example.com/pt/privacidade" },
  });

  it("is in the first preferred language the agent has a notice for, by tag then by language", () => {
    expect(choosePrivacyNotice(notices, ["de-AT"])?.locale).toBe("de");
    expect(choosePrivacyNotice(notices, ["pt"])?.locale).toBe("pt-BR");
    expect(choosePrivacyNotice(notices, ["fr", "de"])?.locale).toBe("de");
  });

  it("falls back to English, then to the first language the agent has, rather than to none", () => {
    expect(choosePrivacyNotice(notices, ["fr"])?.locale).toBe("en");
    const withoutEnglish = normalizePrivacyNotices({ it: notice, de: notice });
    expect(choosePrivacyNotice(withoutEnglish, [null])?.locale).toBe("de");
  });

  it("is none when the agent wrote none", () => {
    expect(choosePrivacyNotice({}, ["en"])).toBeNull();
  });
});

describe("accepting a reported version", () => {
  const notices = normalizePrivacyNotices({ en: notice });

  it("accepts only a version one of the agent's notices carries now", () => {
    expect(isPrivacyNoticeVersionOf(notices, notices.en.version)).toBe(true);
    expect(isPrivacyNoticeVersionOf(notices, "en:0000000000000000")).toBe(false);
    expect(isPrivacyNoticeVersionOf({}, notices.en.version)).toBe(false);
  });
});
