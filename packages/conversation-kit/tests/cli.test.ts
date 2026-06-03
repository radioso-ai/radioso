import { describe, expect, it } from "vitest";

import { parseCliArgs } from "../src/cliArgs.js";

describe("conversation kit CLI", () => {
  it("parses server startup options without touching the network", () => {
    expect(parseCliArgs(["serve", "--host", "127.0.0.1", "--port", "8787", "--directive", "Be brief."])).toEqual({
      command: "serve",
      host: "127.0.0.1",
      port: 8787,
      directive: "Be brief.",
    });
  });
});
