import { describe, expect, it } from "vitest";

import {
  findCompletionsDialect,
  sessionKeyFor,
  type CompletionsDialect,
} from "../../src/modules/voiceChannel/adapters/openaiCompletions/dialects.js";
import {
  completionsRequestSchema,
  heardUntilFor,
} from "../../src/modules/voiceChannel/adapters/openaiCompletions/requestSchema.js";
import { heardPrefixLength } from "../../src/modules/voiceChannel/services/speechText.js";

const dialect = (id: string): CompletionsDialect => {
  const found = findCompletionsDialect(id);
  if (!found) throw new Error(`missing dialect ${id}`);
  return found;
};

describe("completions dialects", () => {
  it("knows the elevenlabs and generic dialects and nothing else", () => {
    expect(dialect("elevenlabs")).toMatchObject({ id: "elevenlabs", transportDefault: "web" });
    expect(dialect("generic")).toMatchObject({ id: "generic" });
    expect(findCompletionsDialect("vapi")).toBeNull();
    expect(findCompletionsDialect("toString")).toBeNull();
  });

  it("reads the elevenlabs session key the page put in the custom LLM extra body, and nothing else", () => {
    const elevenlabs = dialect("elevenlabs");

    expect(sessionKeyFor(elevenlabs, {
      headers: {},
      body: { elevenlabs_extra_body: { session_key: " 3f2b6c1e-session " }, user_id: "user_9" },
    })).toBe("3f2b6c1e-session");
    // ElevenLabs sends no conversation id of its own; neither a user id nor another extra-body
    // field stands in for the key the page minted.
    expect(sessionKeyFor(elevenlabs, { headers: {}, body: { user_id: "user_9" } })).toBeNull();
    expect(sessionKeyFor(elevenlabs, {
      headers: {},
      body: { elevenlabs_extra_body: { conversation_id: "conv_123" } },
    })).toBeNull();
    expect(sessionKeyFor(elevenlabs, {
      headers: {},
      body: { elevenlabs_extra_body: { session_key: "  " } },
    })).toBeNull();
  });

  it("reads the generic session key from the header before the metadata body field", () => {
    const generic = dialect("generic");

    expect(sessionKeyFor(generic, {
      headers: { "x-radioso-voice-session": "room-7" },
      body: { metadata: { session_key: "body-key" } },
    })).toBe("room-7");
    expect(sessionKeyFor(generic, {
      headers: { "x-radioso-voice-session": ["room-8", "ignored"] },
      body: {},
    })).toBe("room-8");
    expect(sessionKeyFor(generic, { headers: {}, body: { metadata: { session_key: "body-key" } } })).toBe("body-key");
  });

  it("treats an uninterpolated template placeholder as no session key, so calls never merge on it", () => {
    expect(sessionKeyFor(dialect("elevenlabs"), {
      headers: {},
      body: { elevenlabs_extra_body: { session_key: "{{system__conversation_id}}" } },
    })).toBeNull();
    expect(sessionKeyFor(dialect("elevenlabs"), {
      headers: {},
      body: { elevenlabs_extra_body: { session_key: "  {{ session }}  " } },
    })).toBeNull();
    // Only a whole-value placeholder is rejected; braces inside a real key are the vendor's business.
    expect(sessionKeyFor(dialect("elevenlabs"), {
      headers: {},
      body: { elevenlabs_extra_body: { session_key: "room-{{7}}" } },
    })).toBe("room-{{7}}");
    expect(sessionKeyFor(dialect("generic"), {
      headers: { "x-radioso-voice-session": "{{call_id}}" },
      body: { metadata: { session_key: "room-9" } },
    })).toBe("room-9");
  });

  it("returns null when no source carries a usable session key", () => {
    expect(sessionKeyFor(dialect("generic"), { headers: {}, body: {} })).toBeNull();
    expect(sessionKeyFor(dialect("generic"), { headers: {}, body: { metadata: { session_key: 42 } } })).toBeNull();
    expect(sessionKeyFor(dialect("elevenlabs"), { headers: {}, body: { elevenlabs_extra_body: "session-1" } })).toBeNull();
    expect(sessionKeyFor(dialect("elevenlabs"), { headers: {}, body: null })).toBeNull();
  });

  describe("the reply the caller heard before interrupting", () => {
    const history = (...messages: Array<{ role: string; content: unknown }>) =>
      completionsRequestSchema.parse({ stream: true, messages: [{ role: "system", content: "Vendor prompt" }, ...messages] });

    it("reads the elevenlabs history's previous reply cut short with a trailing ellipsis", () => {
      const request = history(
        { role: "user", content: "When do you open?" },
        { role: "assistant", content: "We open at nine. \u200B See you..." },
        { role: "user", content: "And on Sundays?" },
      );

      expect(heardUntilFor(dialect("elevenlabs"), request)).toBe("We open at nine. \u200B See you");
    });

    it("reads a reply sent as content parts, and an empty one the caller cut off at once", () => {
      expect(heardUntilFor(dialect("elevenlabs"), history(
        { role: "assistant", content: [{ type: "text", text: "Let me check that..." }] },
        { role: "user", content: "Sorry?" },
      ))).toBe("Let me check that");
      expect(heardUntilFor(dialect("elevenlabs"), history(
        { role: "assistant", content: "..." },
        { role: "user", content: "Sorry?" },
      ))).toBe("");
    });

    it("finds nothing when the previous reply was heard whole, is not right before the utterance, or the dialect has no marker", () => {
      expect(heardUntilFor(dialect("elevenlabs"), history(
        { role: "assistant", content: "We open at nine." },
        { role: "user", content: "And on Sundays?" },
      ))).toBeUndefined();
      expect(heardUntilFor(dialect("elevenlabs"), history(
        { role: "assistant", content: "We open at..." },
        { role: "user", content: "Hm." },
        { role: "user", content: "And on Sundays?" },
      ))).toBeUndefined();
      expect(heardUntilFor(dialect("generic"), history(
        { role: "assistant", content: "We open at..." },
        { role: "user", content: "And on Sundays?" },
      ))).toBeUndefined();
    });

    it("counts the heard characters of a spoken reply when the replay is a strict prefix of it", () => {
      expect(heardPrefixLength("We open at nine. See you then!", "We open at nine.  \u200BSee")).toBe(20);
      expect(heardPrefixLength("Sì, è gratis.", "Sì, è")).toBe(5);
      expect(heardPrefixLength("We open at nine.", "We open at nine.")).toBeNull();
      // A reply that itself ends in "..." comes back with only its own punctuation missing: heard whole.
      expect(heardPrefixLength("Let me check...", "Let me check")).toBeNull();
      expect(heardPrefixLength("We open at nine!", "We open at nine")).toBeNull();
      expect(heardPrefixLength("We open at nine.", "We close at")).toBeNull();
    });
  });
});
