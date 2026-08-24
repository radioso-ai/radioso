import { describe, expect, it } from "vitest";
import {
  BROWSER_FRAME_MAX_BYTES,
  INVALIDATION_KINDS,
  TRANSPORT_ENVELOPE_MAX_BYTES,
  browserEventFrameSchema,
  parseTransportEnvelope,
  decodeBrowserEventFrame,
  protocolVersion,
  workspaceChannel,
  workspaceInvalidationEnvelopeSchema,
} from "../src/index.js";

const workspaceId = "4d7293c8-d241-4f8f-a4db-3df5b88da44c";

describe("workspace invalidation contract v1", () => {
  it("accepts every and only the version-1 invalidation kinds", () => {
    expect(INVALIDATION_KINDS).toHaveLength(12);
    for (const kind of INVALIDATION_KINDS) {
      expect(workspaceInvalidationEnvelopeSchema.parse({ protocolVersion, workspaceId, changeKinds: [kind] })).toEqual({
        protocolVersion,
        workspaceId,
        changeKinds: [kind],
      });
    }
    expect(workspaceInvalidationEnvelopeSchema.safeParse({ protocolVersion, workspaceId, changeKinds: ["future.kind"] }).success).toBe(false);
  });

  it("rejects content and unknown fields from strict transport envelopes", () => {
    expect(workspaceInvalidationEnvelopeSchema.safeParse({
      protocolVersion,
      workspaceId,
      changeKinds: ["crawl.progress", "crawl.progress"],
      documentContent: "never transport content",
    }).success).toBe(false);
  });

  it("uses an unambiguous UUID channel scoped to its workspace", () => {
    expect(workspaceChannel("radioso", workspaceId)).toBe(`radioso:workspace:{${workspaceId}}`);
  });

  it("validates content-free browser frames and keeps workspace scope out of them", () => {
    expect(browserEventFrameSchema.parse({ protocolVersion, type: "ready" })).toEqual({ protocolVersion, type: "ready" });
    expect(browserEventFrameSchema.parse({ protocolVersion, type: "resync" })).toEqual({ protocolVersion, type: "resync" });
    expect(browserEventFrameSchema.parse({ protocolVersion, type: "invalidate", changeKinds: ["quality.triage_changed"] })).toEqual({
      protocolVersion,
      type: "invalidate",
      changeKinds: ["quality.triage_changed"],
    });
    expect(browserEventFrameSchema.safeParse({ protocolVersion, type: "invalidate", workspaceId, changeKinds: ["quality.triage_changed"] }).success).toBe(false);
    expect(browserEventFrameSchema.safeParse({ protocolVersion, type: "invalidate", changeKinds: ["future.kind"] }).success).toBe(false);
  });

  it("rejects oversized transport envelopes before accepting them", () => {
    const encoded = new TextEncoder().encode(JSON.stringify({ protocolVersion, workspaceId, changeKinds: ["crawl.progress"] }));
    expect(parseTransportEnvelope(encoded, TRANSPORT_ENVELOPE_MAX_BYTES)).toEqual({ protocolVersion, workspaceId, changeKinds: ["crawl.progress"] });
    expect(() => parseTransportEnvelope(new Uint8Array(TRANSPORT_ENVELOPE_MAX_BYTES + 1), TRANSPORT_ENVELOPE_MAX_BYTES)).toThrow(/byte cap/i);
    expect(BROWSER_FRAME_MAX_BYTES).toBeLessThan(TRANSPORT_ENVELOPE_MAX_BYTES);
  });

  it("decodes browser frames defensively without accepting future or malformed input", () => {
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    expect(decodeBrowserEventFrame(encode({ protocolVersion, type: "invalidate", changeKinds: ["crawl.progress", "future.kind"] }))).toEqual({ protocolVersion, type: "invalidate", changeKinds: ["crawl.progress"] });
    expect(decodeBrowserEventFrame(encode({ protocolVersion, type: "invalidate", changeKinds: ["future.kind"] }))).toBeUndefined();
    expect(decodeBrowserEventFrame(encode({ protocolVersion: 2, type: "invalidate", changeKinds: ["crawl.progress"] }))).toBeUndefined();
    expect(decodeBrowserEventFrame(encode({ protocolVersion, type: "invalidate", changeKinds: ["crawl.progress"], content: "forbidden" }))).toBeUndefined();
    expect(decodeBrowserEventFrame(new Uint8Array([0xff]))).toBeUndefined();
    expect(decodeBrowserEventFrame(new Uint8Array(BROWSER_FRAME_MAX_BYTES + 1))).toBeUndefined();
    expect(decodeBrowserEventFrame("x".repeat(BROWSER_FRAME_MAX_BYTES + 1))).toBeUndefined();
  });
});
