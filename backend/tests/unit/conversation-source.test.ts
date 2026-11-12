import { describe, expect, it } from "vitest";

import {
  AGENT_SOURCE_CHANNELS,
  OPERATOR_TEST_SOURCE_CHANNELS,
  WORKBENCH_TEST_SOURCE_CHANNELS,
  callerKindForSourceChannel,
  consentPresentationFor,
  isOperatorTestSourceChannel,
} from "../../src/shared/domain/conversationSource.js";
import { assistantChatSchema } from "../../src/app/http/schemas/assistantChatSchemas.js";

describe("conversationSource", () => {
  it("recognizes every operator-test source channel", () => {
    expect(OPERATOR_TEST_SOURCE_CHANNELS).toEqual([
      "authenticated_chat",
      "workbench_replay",
      "operator_copilot_probe",
    ]);
    for (const channel of OPERATOR_TEST_SOURCE_CHANNELS) {
      expect(isOperatorTestSourceChannel(channel)).toBe(true);
    }
  });

  it("keeps synthetic probes out of reopenable workbench test sessions", () => {
    expect(WORKBENCH_TEST_SOURCE_CHANNELS).toEqual([
      "authenticated_chat",
      "workbench_replay",
    ]);
    expect(WORKBENCH_TEST_SOURCE_CHANNELS).not.toContain("operator_copilot_probe");
  });

  it("keeps the operator-copilot probe channel out of the authenticated public schema", () => {
    const parsed = assistantChatSchema.safeParse({
      message: "probe",
      stream: false,
      sourceContext: { surface: "operator_copilot_probe" },
    });

    expect(parsed.success).toBe(false);
  });

  it("treats null and undefined as end-user (not operator-test)", () => {
    expect(isOperatorTestSourceChannel(null)).toBe(false);
    expect(isOperatorTestSourceChannel(undefined)).toBe(false);
  });

  it("treats real end-user channels as non-operator-test", () => {
    expect(isOperatorTestSourceChannel("website_embed")).toBe(false);
    expect(isOperatorTestSourceChannel("anonymous")).toBe(false);
    expect(isOperatorTestSourceChannel("assistant")).toBe(false);
    expect(isOperatorTestSourceChannel("slack")).toBe(false);
  });

  it("reads the machine-driven channels as agent callers", () => {
    expect(AGENT_SOURCE_CHANNELS).toEqual(["mcp", "agent_api", "a2a"]);
    for (const channel of AGENT_SOURCE_CHANNELS) {
      expect(callerKindForSourceChannel(channel)).toBe("agent");
    }
  });

  it("reads an A2A caller as an agent, exactly as an MCP caller", () => {
    expect(callerKindForSourceChannel("a2a")).toBe(callerKindForSourceChannel("mcp"));
    expect(callerKindForSourceChannel("a2a")).toBe("agent");
    expect(isOperatorTestSourceChannel("a2a")).toBe(false);
  });

  it("reads every channel a person speaks through as a human caller", () => {
    for (const channel of ["website_embed", "anonymous", "authenticated_chat", "slack", "whatsapp", "workbench_replay"]) {
      expect(callerKindForSourceChannel(channel)).toBe("human");
    }
  });

  it("reads the email channel as a human caller without making it an agent channel", () => {
    // An email sender is a person writing from a mail client; automated mail is dropped by the
    // inbound classification before any turn, so it never needs an agent caller kind.
    expect(callerKindForSourceChannel("email")).toBe("human");
    expect(AGENT_SOURCE_CHANNELS).toEqual(["mcp", "agent_api", "a2a"]);
    expect(AGENT_SOURCE_CHANNELS).not.toContain("email");
  });

  it("calls an unclassified, absent, or empty channel a human", () => {
    // The column is untyped `TEXT` with no constraint, so this default is reached by any channel
    // added without a decision here. `callerKind` scopes agent-only behaviour, and a person
    // wrongly treated as an agent is the worse failure of the two.
    expect(callerKindForSourceChannel("a_channel_nobody_has_classified")).toBe("human");
    expect(callerKindForSourceChannel(null)).toBe("human");
    expect(callerKindForSourceChannel(undefined)).toBe("human");
    expect(callerKindForSourceChannel("")).toBe("human");
  });

  describe("consentPresentationFor (#1544)", () => {
    it("asks no consent on voice, where a transcript is weak proof", () => {
      expect(consentPresentationFor("voice")).toBe("not_asked");
    });

    it("asks no consent of a calling agent, which cannot give a person's consent", () => {
      for (const channel of AGENT_SOURCE_CHANNELS) {
        expect(consentPresentationFor(channel)).toBe("not_asked");
      }
    });

    it("shows the wording and both choices as text where the channel has no buttons", () => {
      for (const channel of ["email", "whatsapp", "slack"]) {
        expect(consentPresentationFor(channel)).toBe("text");
      }
    });

    it("shows the choices as text in Test Chat and Ray's probe, which show a reply's text alone", () => {
      for (const channel of ["workbench_replay", "operator_copilot_probe"]) {
        expect(consentPresentationFor(channel)).toBe("text");
      }
    });

    it("offers the choices as buttons on the web, the REST assistant API, and on any unclassified channel", () => {
      for (const channel of ["website_embed", "anonymous", "assistant", "authenticated_chat", "a_channel_nobody_has_classified"]) {
        expect(consentPresentationFor(channel)).toBe("buttons");
      }
      expect(consentPresentationFor(null)).toBe("buttons");
      expect(consentPresentationFor(undefined)).toBe("buttons");
    });
  });
});
