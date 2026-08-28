import { describe, expect, it, vi } from "vitest";

import {
  assertPublicHttpUrl,
  createConnectionBoundPublicLookup,
} from "../../src/shared/infra/http/publicUrlFetch.js";

type LookupResult = { address: string; family: number };

const runLookup = (
  lookup: ReturnType<typeof createConnectionBoundPublicLookup>,
  hostname: string,
): Promise<LookupResult> =>
  new Promise((resolve, reject) => {
    lookup(hostname, { all: false }, (error, address, family) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ address: address as string, family: family as number });
    });
  });

describe("connection-bound public URL fetch policy", () => {
  it("returns the validated DNS answer directly to the socket lookup callback", async () => {
    const resolve = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    const lookup = createConnectionBoundPublicLookup(resolve);

    await expect(runLookup(lookup, "example.com")).resolves.toEqual({
      address: "93.184.216.34",
      family: 4,
    });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("rejects private or mixed DNS answers before the socket connects", async () => {
    const privateLookup = createConnectionBoundPublicLookup(async () => [
      { address: "127.0.0.1", family: 4 },
    ]);
    const mixedLookup = createConnectionBoundPublicLookup(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);

    await expect(runLookup(privateLookup, "private.example")).rejects.toThrow("publicly routable");
    await expect(runLookup(mixedLookup, "mixed.example")).rejects.toThrow("publicly routable");
  });

  it("rejects loopback and private IP literals before dispatch", () => {
    expect(() => assertPublicHttpUrl("http://localhost:3000")).toThrow("publicly routable");
    expect(() => assertPublicHttpUrl("http://127.0.0.1")).toThrow("publicly routable");
    expect(() => assertPublicHttpUrl("http://[::1]")).toThrow("publicly routable");
  });
});
