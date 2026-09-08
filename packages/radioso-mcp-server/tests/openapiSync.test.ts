import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("MCP OpenAPI generated types", () => {
  it("stay in sync with the backend OpenAPI JSON", () => {
    const packageRoot = fileURLToPath(new URL("..", import.meta.url));
    expect(() => execFileSync(process.execPath, ["./scripts/syncOpenApi.mjs", "--check"], {
      cwd: packageRoot,
      stdio: "pipe",
    })).not.toThrow();
  });
});
