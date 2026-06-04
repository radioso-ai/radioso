import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("backend Dockerfile", () => {
  it("includes MCP server workspace inputs for backend build and runtime", async () => {
    const repoRoot = path.resolve(new URL("../../..", import.meta.url).pathname);
    const dockerfile = await readFile(path.join(repoRoot, "infra/backend.Dockerfile"), "utf8");

    expect(dockerfile).toContain("COPY backend/openapi.json ./backend/openapi.json");
    expect(dockerfile).toContain("COPY packages/radioso-mcp-server/package.json ./packages/radioso-mcp-server/package.json");
    expect(dockerfile).toContain("--filter @radioso/mcp-server...");
    expect(dockerfile).toContain("COPY packages/radioso-mcp-server ./packages/radioso-mcp-server");
    expect(dockerfile).toContain(
      "COPY --chown=node:node --from=build /app/packages/radioso-mcp-server/dist ./packages/radioso-mcp-server/dist",
    );
  });
});

describe("frontend Dockerfiles", () => {
  it("includes the enterprise workspace manifest for Cloud Run frontend builds", async () => {
    const repoRoot = path.resolve(new URL("../../..", import.meta.url).pathname);
    const dockerfile = await readFile(path.join(repoRoot, "infra/frontend.Dockerfile"), "utf8");

    expect(dockerfile).toContain("COPY ee/package.json ./ee/package.json");
    expect(dockerfile).toContain("RUN pnpm --dir frontend run build");
  });

  it("include shared UI workspace inputs for isolated frontend builds", async () => {
    const repoRoot = path.resolve(new URL("../../..", import.meta.url).pathname);
    const dockerfile = await readFile(path.join(repoRoot, "frontend/Dockerfile"), "utf8");

    expect(dockerfile).toContain("COPY packages/ui/package.json ./packages/ui/package.json");
    expect(dockerfile).toContain("COPY packages/ui ./packages/ui");
    expect(dockerfile).toContain("COPY --from=builder /app/packages/ui ./packages/ui");
  });

  // The docs portal is built as a static export and deployed to Firebase Hosting
  // (.github/workflows/deploy-docs.yml); it has no isolated Docker build, so there
  // is intentionally no docs-portal/Dockerfile to assert on here.
});
