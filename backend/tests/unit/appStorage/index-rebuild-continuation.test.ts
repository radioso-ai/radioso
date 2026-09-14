import { describe, expect, it } from "vitest";

import {
  decodeIndexRebuildContinuation,
  encodeIndexRebuildContinuation,
  type AppStorageIndexRebuildContinuation,
} from "../../../src/modules/appStorage/public.js";

const continuation: AppStorageIndexRebuildContinuation = {
  workspaceId: "workspace-1",
  installationId: "installation-1",
  collectionId: "rebuilt",
  indexId: "by_sequence",
  generation: 3,
  pass: "first",
  after: "post-4",
  startVersion: 12,
};

describe("app storage index rebuild continuation", () => {
  it("round-trips every field through encode and decode", () => {
    const token = encodeIndexRebuildContinuation(continuation);
    expect(decodeIndexRebuildContinuation(token)).toEqual(continuation);
  });

  it("round-trips a null cursor and the convergence pass", () => {
    const converging: AppStorageIndexRebuildContinuation = {
      ...continuation,
      pass: "convergence",
      after: null,
    };

    expect(decodeIndexRebuildContinuation(encodeIndexRebuildContinuation(converging))).toEqual(converging);
  });

  it("rejects a token that is not base64url JSON at all", () => {
    expect(decodeIndexRebuildContinuation("not a token")).toBeNull();
  });

  it("rejects a token whose payload is valid JSON but not an object", () => {
    const token = Buffer.from(JSON.stringify("just a string"), "utf8").toString("base64url");
    expect(decodeIndexRebuildContinuation(token)).toBeNull();
  });

  it("rejects a token missing a required field", () => {
    const { startVersion: _startVersion, ...incomplete } = continuation;
    const token = Buffer.from(JSON.stringify(incomplete), "utf8").toString("base64url");
    expect(decodeIndexRebuildContinuation(token)).toBeNull();
  });

  it("rejects a token whose pass names neither phase of a rebuild", () => {
    const token = Buffer.from(JSON.stringify({ ...continuation, pass: "sideways" }), "utf8").toString(
      "base64url",
    );
    expect(decodeIndexRebuildContinuation(token)).toBeNull();
  });

  it("rejects a token whose generation is not an integer", () => {
    const token = Buffer.from(JSON.stringify({ ...continuation, generation: 1.5 }), "utf8").toString(
      "base64url",
    );
    expect(decodeIndexRebuildContinuation(token)).toBeNull();
  });
});
