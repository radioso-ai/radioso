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
    expect(dockerfile).toContain("WORKDIR /app/backend");
  });

  it("can launch the standalone MCP HTTP entrypoint from the production backend image", async () => {
    const repoRoot = path.resolve(new URL("../../..", import.meta.url).pathname);
    const [dockerfile, compute] = await Promise.all([
      readFile(path.join(repoRoot, "infra/backend.Dockerfile"), "utf8"),
      readFile(path.join(repoRoot, "infra/terraform/compute.tf"), "utf8"),
    ]);

    expect(dockerfile).toContain(
      "COPY --chown=node:node --from=build /app/packages/radioso-mcp-server/dist ./packages/radioso-mcp-server/dist",
    );
    expect(compute).toContain('command = ["node"]');
    expect(compute).toContain('args    = ["../packages/radioso-mcp-server/dist/src/cli/http.js"]');
  });

  it("packages the shared MCP source-proof workspace for install, build, and runtime", async () => {
    const repoRoot = path.resolve(new URL("../../..", import.meta.url).pathname);
    const dockerfile = await readFile(path.join(repoRoot, "infra/backend.Dockerfile"), "utf8");
    const manifestCopy = "COPY packages/mcp-source-proof/package.json ./packages/mcp-source-proof/package.json";
    const sourceCopy = "COPY packages/mcp-source-proof ./packages/mcp-source-proof";
    const runtimeCopy = "COPY --chown=node:node --from=build /app/packages/mcp-source-proof/dist ./packages/mcp-source-proof/dist";

    expect(dockerfile.match(new RegExp(manifestCopy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(2);
    expect(dockerfile).toContain(sourceCopy);
    expect(dockerfile).toContain(runtimeCopy);
    expect(dockerfile.indexOf(sourceCopy)).toBeLessThan(dockerfile.indexOf("RUN pnpm --dir backend run build"));
    expect(dockerfile.indexOf(runtimeCopy)).toBeGreaterThan(dockerfile.indexOf("FROM base AS runtime"));
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
