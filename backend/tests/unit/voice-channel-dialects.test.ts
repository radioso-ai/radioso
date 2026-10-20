import { describe, expect, it } from "vitest";

import {
  findCompletionsDialect,
  languageSwitchOfferFor,
  languageSwitchResultFor,
  sessionKeyFor,
  turnLanguageFor,
  type CompletionsDialect,
} from "../../src/modules/voiceChannel/adapters/openaiCompletions/dialects.js";
import {
  completionsRequestSchema,
  heardUntilFor,
  utteranceOf,
} from "../../src/modules/voiceChannel/adapters/openaiCompletions/requestSchema.js";
import { heardSpeechOf } from "../../src/modules/voiceChannel/services/heardSpeech.js";
import { ELEVENLABS_MIN_RELEASABLE_SENTENCE_CHARS } from "../../src/modules/voiceChannel/public.js";
import { readFileSync } from "node:fs";

const dialect = (id: string): CompletionsDialect => {
  const found = findCompletionsDialect(id);
  if (!found) throw new Error(`missing dialect ${id}`);
  return found;
};

describe("completions dialects", () => {
  it("knows the elevenlabs and generic dialects and nothing else", () => {
    expect(dialect("elevenlabs")).toMatchObject({ id: "elevenlabs", transportDefault: "web" });
    expect(dialect("generic")).toMatchObject({ id: "generic" });
    // ElevenLabs holds a first sentence shorter than about 45 characters until more text arrives.
    expect(dialect("elevenlabs").minReleasableSentenceChars).toBe(45);
    expect(dialect("elevenlabs").minReleasableSentenceChars).toBe(ELEVENLABS_MIN_RELEASABLE_SENTENCE_CHARS);
    expect(dialect("generic")).not.toHaveProperty("minReleasableSentenceChars");
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

    it("counts the heard characters of a spoken reply from what the replay leaves out", () => {
      const heard = (answer: string[], report: string) => heardSpeechOf({ operatorReplies: [], bridge: null, answer }, report);
      expect(heard(["We open at nine. ", "See you then!"], "We open at nine.  \u200BSee")?.answerHeardCharacterCount).toBe(20);
      expect(heard(["Sì, è gratis."], "Sì, è")?.answerHeardCharacterCount).toBe(5);
      expect(heard(["We open at nine."], "We open at nine.")).toMatchObject({ answerHeardCharacterCount: 16, answerSpokenCharacterCount: 16 });
      // A reply that itself ends in "..." comes back with only its own punctuation missing: heard whole.
      expect(heard(["Let me check..."], "Let me check")).toMatchObject({ answerHeardCharacterCount: 15, answerSpokenCharacterCount: 15 });
      expect(heard(["We open at nine!"], "We open at nine")).toMatchObject({ answerHeardCharacterCount: 16, answerSpokenCharacterCount: 16 });
      expect(heard(["We open at nine."], "We close at")).toBeNull();
    });
  });
});

/**
 * The assistant message ElevenLabs replays for a call of its `language_detection` system tool, in
 * the OpenAI tool-call shape its custom-LLM docs give (`function.arguments` a JSON string with
 * `reason` and `language`).
 */
const languageSwitch = (args: unknown, id = "call_lang_1") => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id, type: "function", function: { name: "language_detection", arguments: typeof args === "string" ? args : JSON.stringify(args) } }],
});

/** The tool's result as the next request replays it: the vendor's result model, as JSON. */
const switchResult = (id: string, result: unknown) => ({ role: "tool", tool_call_id: id, content: typeof result === "string" ? result : JSON.stringify(result) });
const switched = (language: string) => ({ result_type: "language_detection_success", status: "success", reason: "The caller speaks another language", language });
const refused = { status: "error", error: "Switching is only allowed at the start of the conversation" };

/** A switch to `language` the vendor carried out. */
const carriedOut = (language: string, id = "call_lang_1") => [languageSwitch({ reason: "Caller", language }, id), switchResult(id, switched(language))];

const elevenlabsHistory = (...messages: unknown[]) => ({
  headers: {},
  body: {
    stream: true,
    messages: [{ role: "system", content: "Vendor prompt" }, { role: "user", content: "Hello" }, ...messages],
    elevenlabs_extra_body: { session_key: "conv_abc", locale: "en" },
  },
});

/** The reader as the route calls it: with the request's messages as the schema parsed them. */
const turnLanguageOf = (dialect: CompletionsDialect, request: { headers: Record<string, string | string[] | undefined>; body: unknown }) => {
  const parsed = completionsRequestSchema.safeParse(request.body);
  return turnLanguageFor(dialect, { ...request, messages: parsed.success ? parsed.data.messages : [] });
};

describe("the language of one turn", () => {
  it("reads the language the newest language_detection call switched to, as new on the turn after the caller's previous utterance", () => {
    expect(turnLanguageOf(dialect("elevenlabs"), elevenlabsHistory(
      { role: "assistant", content: "Hi, how can I help?" },
      { role: "user", content: "Parla italiano?" },
      ...carriedOut("it"),
      { role: "assistant", content: "Certo." },
      { role: "user", content: "Vorrei prenotare un tavolo" },
    ))).toEqual({ turnLanguage: { tag: "it", source: "vendor_detected", isNew: true } });
    // The vendor's request right after the call, whose newest message is the result.
    expect(turnLanguageOf(dialect("elevenlabs"), elevenlabsHistory(...carriedOut("it"))))
      .toEqual({ turnLanguage: { tag: "it", source: "vendor_detected", isNew: true } });
  });

  it("reads a switch Radioso asked for as no news for chat, and one with another reason as news", () => {
    const asked = (reason: string) => turnLanguageOf(dialect("elevenlabs"), elevenlabsHistory(
      { role: "user", content: "A che ora aprite?" },
      languageSwitch({ reason, language: "it" }, "fc_switch-1"),
      switchResult("fc_switch-1", switched("it")),
      { role: "assistant", content: "Apriamo alle nove." },
      { role: "user", content: "E la domenica?" },
    ));

    expect(asked("response_language")).toEqual({ turnLanguage: { tag: "it", source: "vendor_detected", isNew: false } });
    expect(asked("The caller speaks Italian")).toEqual({ turnLanguage: { tag: "it", source: "vendor_detected", isNew: true } });
  });

  it("keeps a switch an earlier turn made as the call's language, and no longer as news", () => {
    expect(turnLanguageOf(dialect("elevenlabs"), elevenlabsHistory(
      ...carriedOut("it"),
      { role: "assistant", content: "Certo." },
      { role: "user", content: "Grazie" },
      { role: "assistant", content: "Prego." },
      { role: "user", content: "Siete aperti domenica?" },
    ))).toEqual({ turnLanguage: { tag: "it", source: "vendor_detected", isNew: false } });
  });

  it("takes the newest switch, across messages and within one message", () => {
    expect(turnLanguageOf(dialect("elevenlabs"), elevenlabsHistory(
      ...carriedOut("it", "call_1"),
      { role: "user", content: "Grazie" },
      ...carriedOut("en", "call_2"),
    ))).toMatchObject({ turnLanguage: { tag: "en", source: "vendor_detected" } });
    expect(turnLanguageOf(dialect("elevenlabs"), elevenlabsHistory(
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_a", type: "function", function: { name: "language_detection", arguments: JSON.stringify({ reason: "German", language: "de" }) } },
          { id: "call_b", type: "function", function: { name: "language_detection", arguments: JSON.stringify({ reason: "Italian", language: "it" }) } },
        ],
      },
      switchResult("call_a", switched("de")),
      switchResult("call_b", switched("it")),
      { role: "user", content: "Ciao" },
    ))).toMatchObject({ turnLanguage: { tag: "it" } });
  });

  it("does not take a switch the vendor refused, and keeps the one before it", () => {
    // The vendor answers a refused switch with an error for the LLM, as text.
    expect(turnLanguageOf(dialect("elevenlabs"), elevenlabsHistory(
      ...carriedOut("de", "call_1"),
      { role: "user", content: "Danke" },
      languageSwitch({ reason: "Italian", language: "it" }, "call_2"),
      switchResult("call_2", "Language switching is only available at the start of the conversation. Keep speaking the current language."),
      { role: "user", content: "Ciao" },
    ))).toEqual({ turnLanguage: { tag: "de", source: "vendor_detected", isNew: false }, languageReport: "blocked" });
    expect(turnLanguageOf(dialect("elevenlabs"), elevenlabsHistory(
      languageSwitch({ reason: "Italian", language: "it" }),
      switchResult("call_lang_1", refused),
      { role: "user", content: "Ciao" },
    ))).toEqual({ languageReport: "blocked" });
    expect(turnLanguageOf(dialect("elevenlabs"), elevenlabsHistory(
      ...carriedOut("de", "call_1"),
      { role: "user", content: "Danke" },
      languageSwitch({ reason: "Italian", language: "it" }, "call_2"),
      switchResult("call_2", { ...refused, is_error: true }),
      { role: "user", content: "Ciao" },
    ))).toEqual({ turnLanguage: { tag: "de", source: "vendor_detected", isNew: false }, languageReport: "blocked" });
  });

  it("reports a newest switch it cannot read as unreadable, rather than an older one the call may have moved past", () => {
    const after = (...newest: unknown[]) => turnLanguageOf(dialect("elevenlabs"), elevenlabsHistory(
      ...carriedOut("de", "call_1"),
      { role: "user", content: "Danke" },
      ...newest,
      { role: "user", content: "Ciao" },
    ));

    // No result to say whether the switch happened.
    expect(after(languageSwitch({ reason: "Italian", language: "it" }, "call_2"))).toEqual({ languageReport: "unreadable" });
    // A result object of a shape the vendor's model does not have, JSON that does not parse, or JSON that is no object.
    expect(after(languageSwitch({ reason: "Italian", language: "it" }, "call_2"), switchResult("call_2", { language: "it" }))).toEqual({ languageReport: "unreadable" });
    expect(after(languageSwitch({ reason: "Italian", language: "it" }, "call_2"), switchResult("call_2", "{\"status\": \"succ"))).toEqual({ languageReport: "unreadable" });
    expect(after(languageSwitch({ reason: "Italian", language: "it" }, "call_2"), switchResult("call_2", "[\"success\"]"))).toEqual({ languageReport: "unreadable" });
    expect(after(languageSwitch({ reason: "Italian", language: "it" }, "call_2"), switchResult("call_2", "  "))).toEqual({ languageReport: "unreadable" });
    // A result for another call does not answer this one.
    expect(after(languageSwitch({ reason: "Italian", language: "it" }, "call_2"), switchResult("call_9", switched("it")))).toEqual({ languageReport: "unreadable" });
    // Arguments that are not JSON, or name no language tag.
    for (const unreadable of ["{not json", { reason: "Italian" }, { reason: "Italian", language: "Italian" }, { language: 7 }]) {
      expect(after(languageSwitch(unreadable, "call_2"), switchResult("call_2", switched("it")))).toEqual({ languageReport: "unreadable" });
    }
    // A call with no id cannot be paired with its result.
    expect(after({
      role: "assistant",
      content: null,
      tool_calls: [{ type: "function", function: { name: "language_detection", arguments: JSON.stringify({ reason: "Italian", language: "it" }) } }],
    }, switchResult("call_2", switched("it")))).toEqual({ languageReport: "unreadable" });
  });

  it("reports the language unknown when a refused switch sits over one it cannot read", () => {
    expect(turnLanguageOf(dialect("elevenlabs"), elevenlabsHistory(
      ...carriedOut("de", "call_0"),
      { role: "user", content: "Danke" },
      languageSwitch({ reason: "French", language: "fr" }, "call_1"),
      { role: "user", content: "Merci" },
      languageSwitch({ reason: "Italian", language: "it" }, "call_2"),
      switchResult("call_2", refused),
      { role: "user", content: "Ciao" },
    ))).toEqual({ languageReport: "unreadable" });
  });

  it("pairs each call with the nearest result for its id, which a later call may reuse", () => {
    // The older call has no result of its own; the one after it answers the newer call.
    expect(turnLanguageOf(dialect("elevenlabs"), elevenlabsHistory(
      languageSwitch({ reason: "German", language: "de" }, "call_1"),
      { role: "user", content: "Danke" },
      languageSwitch({ reason: "Italian", language: "it" }, "call_1"),
      switchResult("call_1", refused),
      { role: "user", content: "Ciao" },
    ))).toEqual({ languageReport: "unreadable" });
    expect(turnLanguageOf(dialect("elevenlabs"), elevenlabsHistory(
      ...carriedOut("de", "call_1"),
      { role: "user", content: "Danke" },
      languageSwitch({ reason: "Italian", language: "it" }, "call_1"),
      switchResult("call_1", refused),
      { role: "user", content: "Ciao" },
    ))).toEqual({ turnLanguage: { tag: "de", source: "vendor_detected", isNew: false }, languageReport: "blocked" });
    expect(turnLanguageOf(dialect("elevenlabs"), elevenlabsHistory(
      ...carriedOut("de", "call_1"),
      { role: "user", content: "Danke" },
      ...carriedOut("it", "call_1"),
      { role: "user", content: "Ciao" },
    ))).toMatchObject({ turnLanguage: { tag: "it" } });
  });

  it("takes the arguments as an object too, reads text-part results, and ignores the vendor's other tools", () => {
    expect(turnLanguageOf(dialect("elevenlabs"), elevenlabsHistory({
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call_end", type: "function", function: { name: "end_call", arguments: "{\"reason\":\"done\"}" } },
        { id: "call_lang", type: "function", function: { name: "language_detection", arguments: { reason: "German", language: "de-AT" } } },
      ],
    }, { role: "tool", tool_call_id: "call_lang", content: [{ type: "text", text: JSON.stringify(switched("de-AT")) }] }, { role: "user", content: "Danke" })))
      .toMatchObject({ turnLanguage: { tag: "de-AT", source: "vendor_detected" } });
    expect(turnLanguageOf(dialect("elevenlabs"), elevenlabsHistory({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_end", type: "function", function: { name: "end_call", arguments: "{}" } }],
    }, { role: "user", content: "Bye" }))).toEqual({});
  });

  it("reports nothing for a call with no switch, and leaves the session's locale to the session", () => {
    expect(turnLanguageOf(dialect("elevenlabs"), elevenlabsHistory({ role: "user", content: "When do you open?" }))).toEqual({});
    expect(turnLanguageOf(dialect("elevenlabs"), elevenlabsHistory({ role: "user", content: [{ type: "text", text: "Hi" }], tool_calls: "language_detection" })))
      .toEqual({});
    expect(turnLanguageOf(dialect("elevenlabs"), { headers: {}, body: null })).toEqual({});
    // The elevenlabs dialect reads no generic header.
    expect(turnLanguageOf(dialect("elevenlabs"), { headers: { "x-radioso-voice-turn-locale": "fr" }, body: {} })).toEqual({});
  });

  it("reads the generic turn locale from its header, then the metadata body field, always as this turn's own", () => {
    const generic = dialect("generic");
    const fromBody = { turnLanguage: { tag: "es", source: "turn_field", isNew: true } };

    expect(turnLanguageOf(generic, { headers: { "x-radioso-voice-turn-locale": "fr-CA" }, body: { metadata: { turn_locale: "es" } } }))
      .toEqual({ turnLanguage: { tag: "fr-CA", source: "turn_field", isNew: true } });
    // A header that is not a language tag falls through to the body field: a word, or a header
    // sent twice, which arrives joined.
    expect(turnLanguageOf(generic, { headers: { "x-radioso-voice-turn-locale": "French" }, body: { metadata: { turn_locale: "es" } } })).toEqual(fromBody);
    expect(turnLanguageOf(generic, { headers: { "x-radioso-voice-turn-locale": "it, en" }, body: { metadata: { turn_locale: "es" } } })).toEqual(fromBody);
    expect(turnLanguageOf(generic, { headers: { "x-radioso-voice-locale": "de" }, body: { metadata: { locale: "de" } } })).toEqual({});
    expect(turnLanguageOf(generic, elevenlabsHistory(...carriedOut("it"), { role: "user", content: "Ciao" }))).toEqual({});
  });
});

describe("the switch of the call's language a turn may ask for", () => {
  /** `language_detection` as the vendor offers it in every request's `tools`, observed 2026-10-18. */
  const languageDetectionTool = {
    type: "function",
    function: {
      name: "language_detection",
      description: "Switch the conversation language",
      parameters: { type: "object", properties: { reason: { type: "string" }, language: { type: "string" } }, required: ["reason", "language"] },
    },
  };
  const endCallTool = { type: "function", function: { name: "end_call", parameters: { type: "object", properties: {} } } };
  const parsed = (history: ReturnType<typeof elevenlabsHistory>, tools?: unknown[]) =>
    completionsRequestSchema.parse({ ...history.body, ...(tools ? { tools } : {}) });

  /** The history of the follow-up after the switch Radioso asked for as `switch-1`, as the vendor replays it. */
  const followUpAfter = (result: unknown, callId = "fc_switch-1", tool = "language_detection") => elevenlabsHistory(
    { role: "assistant", content: "Hi, how can I help?" },
    { role: "user", content: "A che ora aprite?" },
    { role: "assistant", content: null, tool_calls: [{ id: callId, type: "function", function: { name: tool, arguments: JSON.stringify({ reason: "response_language", language: "it" }) } }] },
    switchResult(callId, result),
  );

  it("reads the offer from the request's tools, with the languages the runtime refused earlier in the call", () => {
    const utterance = elevenlabsHistory({ role: "user", content: "A che ora aprite?" });
    const afterRefusal = elevenlabsHistory(
      languageSwitch({ reason: "response_language", language: "it" }, "fc_switch-0"),
      switchResult("fc_switch-0", "Invalid language. Keep speaking English."),
      { role: "user", content: "A che ora aprite?" },
    );

    expect(languageSwitchOfferFor(dialect("elevenlabs"), parsed(utterance, [endCallTool, languageDetectionTool]))).toEqual({ refused: [] });
    expect(languageSwitchOfferFor(dialect("elevenlabs"), parsed(afterRefusal, [languageDetectionTool]))).toEqual({ refused: ["it"] });
    expect(languageSwitchOfferFor(dialect("elevenlabs"), parsed(utterance))).toBeUndefined();
    expect(languageSwitchOfferFor(dialect("elevenlabs"), parsed(utterance, [endCallTool]))).toBeUndefined();
    expect(languageSwitchOfferFor(dialect("generic"), parsed(utterance, [languageDetectionTool]))).toBeUndefined();
  });

  it("reads the runtime's follow-up after the switch Radioso asked for, by the id the runtime replays it under", () => {
    const success = { result_type: "language_detection_success", status: "success", reason: "response_language", language: "it" };

    expect(languageSwitchResultFor(dialect("elevenlabs"), parsed(followUpAfter(success)))).toEqual({ switchId: "switch-1", confirmed: true });
    // A language outside the agent's presets: the vendor answers in plain text, and still asks again.
    expect(languageSwitchResultFor(dialect("elevenlabs"), parsed(followUpAfter("Invalid language. Keep speaking English."))))
      .toEqual({ switchId: "switch-1", confirmed: false });
    // A result it cannot read is no confirmation; an id the vendor did not prefix is still the switch's.
    expect(languageSwitchResultFor(dialect("elevenlabs"), parsed(followUpAfter("{not json", "switch-1"))))
      .toEqual({ switchId: "switch-1", confirmed: false });
  });

  it("reads no follow-up of the switch for another tool's result, a turn, or the generic dialect", () => {
    expect(languageSwitchResultFor(dialect("elevenlabs"), parsed(followUpAfter("ok", "fc_end-1", "end_call")))).toBeNull();
    expect(languageSwitchResultFor(dialect("elevenlabs"), parsed(elevenlabsHistory({ role: "user", content: "A che ora aprite?" })))).toBeNull();
    expect(languageSwitchResultFor(dialect("generic"), parsed(followUpAfter({ status: "success" })))).toBeNull();
  });
});

describe("a replayed history that carries the vendor's keep-alive before a tool call", () => {
  it("finds the reply the caller cut short behind the whitespace-only message the keep-alive left", () => {
    // Observed 2026-10-18: a keep-alive sent before the switch's tool call is replayed as an
    // assistant message of its own, holding only the space and zero-width space.
    const request = completionsRequestSchema.parse(elevenlabsHistory(
      { role: "user", content: "A che ora aprite?" },
      { role: "assistant", content: "Apriamo alle nove, e la domenica..." },
      { role: "assistant", content: " \u200B \u200B" },
      ...carriedOut("it"),
      { role: "user", content: "E la domenica?" },
    ).body);

    expect(heardUntilFor(dialect("elevenlabs"), request)).toBe("Apriamo alle nove, e la domenica");
    expect(utteranceOf(request)).toBe("E la domenica?");
  });
});

describe("a replayed history that carries the vendor's tool calls", () => {
  it("parses, and its newest user message is still the utterance", () => {
    const request = completionsRequestSchema.parse(elevenlabsHistory(
      { role: "assistant", content: "Hi, how can I help?" },
      ...carriedOut("it"),
      { role: "assistant", content: "Certo, posso aiutarti..." },
      { role: "user", content: "Vorrei prenotare un tavolo" },
    ).body);

    expect(utteranceOf(request)).toBe("Vorrei prenotare un tavolo");
    expect(heardUntilFor(dialect("elevenlabs"), request)).toBe("Certo, posso aiutarti");
  });

  it("finds the reply the caller cut short behind the tool calls and results replayed after it", () => {
    const request = completionsRequestSchema.parse(elevenlabsHistory(
      { role: "assistant", content: "Certo, posso aiutarti..." },
      ...carriedOut("it"),
      { role: "user", content: "Vorrei prenotare un tavolo" },
    ).body);

    expect(heardUntilFor(dialect("elevenlabs"), request)).toBe("Certo, posso aiutarti");
    // A message that says something is the reply, tool calls or not.
    expect(heardUntilFor(dialect("elevenlabs"), completionsRequestSchema.parse(elevenlabsHistory(
      { role: "assistant", content: "We open at..." },
      { ...languageSwitch({ reason: "Italian", language: "it" }), content: "Un momento." },
      { role: "user", content: "Vorrei prenotare" },
    ).body))).toBeUndefined();
  });
});

describe("the elevenlabs first-sentence floor outside the voice module", () => {
  // frontend/lib/voice-settings-form.ts is a separate workspace package with no shared contract
  // package for this number, so the Voice card's mirror is read as source text and pinned here.
  it("is the number the dashboard's Voice card warns at", () => {
    const source = readFileSync(new URL("../../../frontend/lib/voice-settings-form.ts", import.meta.url), "utf8");
    const mirrored = source.match(/export const ELEVENLABS_MIN_RELEASABLE_SENTENCE_CHARS = (\d+)/)?.[1];
    if (!mirrored) throw new Error("ELEVENLABS_MIN_RELEASABLE_SENTENCE_CHARS moved out of frontend/lib/voice-settings-form.ts; update this test.");
    expect(Number(mirrored)).toBe(ELEVENLABS_MIN_RELEASABLE_SENTENCE_CHARS);
  });
});
