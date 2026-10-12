import { describe, expect, it } from "vitest";

import {
  findCompletionsDialect,
  sessionKeyFor,
  type CompletionsDialect,
} from "../../src/modules/voiceChannel/adapters/openaiCompletions/dialects.js";

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

  it("reads the elevenlabs session key from the extra body only", () => {
    const elevenlabs = dialect("elevenlabs");

    expect(sessionKeyFor(elevenlabs, {
      headers: {},
      body: { elevenlabs_extra_body: { conversation_id: " conv_123 " }, user_id: "user_9" },
    })).toBe("conv_123");
    // A user id spans calls, so it never stands in for the conversation id.
    expect(sessionKeyFor(elevenlabs, { headers: {}, body: { user_id: "user_9" } })).toBeNull();
    expect(sessionKeyFor(elevenlabs, {
      headers: {},
      body: { elevenlabs_extra_body: { conversation_id: "  " }, user_id: "user_9" },
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

  it("returns null when no source carries a usable session key", () => {
    expect(sessionKeyFor(dialect("generic"), { headers: {}, body: {} })).toBeNull();
    expect(sessionKeyFor(dialect("generic"), { headers: {}, body: { metadata: { session_key: 42 } } })).toBeNull();
    expect(sessionKeyFor(dialect("elevenlabs"), { headers: {}, body: { elevenlabs_extra_body: "conv_123" } })).toBeNull();
    expect(sessionKeyFor(dialect("elevenlabs"), { headers: {}, body: null })).toBeNull();
  });
});
