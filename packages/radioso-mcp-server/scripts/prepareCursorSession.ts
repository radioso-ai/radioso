import { execFileSync } from "node:child_process";
import { cwd } from "node:process";

import { exchangeAccessToken, parseExchangeArgs, usage } from "./exchangeAccessTokenCore.ts";

const cursorUsage = `Usage:
  RADIOSO_WORKSPACE_TOKEN=radioso_... pnpm --dir packages/radioso-mcp-server run -s cursor:prepare

What it does:
  1. Exchanges your Radioso workspace token for a short-lived MCP access token.
  2. Installs RADIOSO_MCP_ACCESS_TOKEN into the macOS GUI app environment with launchctl.
  3. Optionally opens a fresh Cursor instance for this repo.

Flags:
  --open         Open a new Cursor instance for the current repo after setting the token.
  --repo PATH    Open Cursor at a specific repo path when used with --open.
  --help

Token exchange flags:
${usage
  .split("\n")
  .filter((line) => line.startsWith("  --") || line.startsWith("  RADIOSO_") || line.startsWith("Usage:"))
  .join("\n")}

Examples:
  RADIOSO_WORKSPACE_TOKEN=radioso_... pnpm --dir packages/radioso-mcp-server run -s cursor:prepare
  RADIOSO_WORKSPACE_TOKEN=radioso_... pnpm --dir packages/radioso-mcp-server run -s cursor:prepare -- --open
`;

const main = async (): Promise<void> => {
  if (process.platform !== "darwin") {
    throw new Error("cursor:prepare currently supports macOS only.");
  }

  let openCursor = false;
  let repoPath = cwd();
  const exchangeArgv: string[] = [];
  const argv = process.argv.slice(2);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help") {
      process.stdout.write(`${cursorUsage}\n`);
      process.exit(0);
    }

    if (arg === "--open") {
      openCursor = true;
      continue;
    }

    if (arg === "--repo") {
      const next = argv[index + 1]?.trim();
      if (!next) {
        throw new Error("Expected a value after --repo.");
      }
      repoPath = next;
      index += 1;
      continue;
    }

    exchangeArgv.push(arg);
    const next = argv[index + 1];
    if (arg === "--format" || arg === "--mcp-url" || arg === "--client-name" || arg === "--requested-tools") {
      if (!next) {
        throw new Error(`Expected a value after ${arg}.`);
      }
      exchangeArgv.push(next);
      index += 1;
    }
  }

  const exchangeArgs = parseExchangeArgs(exchangeArgv);
  const result = await exchangeAccessToken({
    ...exchangeArgs,
    clientName: exchangeArgs.clientName ?? "cursor-local",
    format: "token",
  });

  execFileSync("launchctl", ["setenv", "RADIOSO_MCP_ACCESS_TOKEN", result.accessToken], {
    stdio: "inherit",
  });

  process.stdout.write("Installed RADIOSO_MCP_ACCESS_TOKEN into the macOS GUI app environment.\n");
  process.stdout.write("If Cursor is already open, fully quit it before reopening so it picks up the new token.\n");
  process.stdout.write("To clear the token later, run: launchctl unsetenv RADIOSO_MCP_ACCESS_TOKEN\n");
  process.stdout.write(`Token expires at: ${result.expiresAt ?? "unknown"}\n`);

  if (!openCursor) {
    process.stdout.write("To open a fresh Cursor instance for this repo, rerun with --open.\n");
    return;
  }

  execFileSync("open", ["-na", "Cursor", repoPath], {
    stdio: "inherit",
  });
  process.stdout.write(`Opened a new Cursor instance for ${repoPath}\n`);
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n\n${cursorUsage}\n`);
  process.exit(1);
});
