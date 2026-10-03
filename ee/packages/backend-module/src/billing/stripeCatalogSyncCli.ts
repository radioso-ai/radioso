/**
 * Entry point for `pnpm --filter @radioso/enterprise-backend-module run stripe:sync`. Wires the
 * process (argv, env, stdout/stderr) and the `stripe` SDK adapter into the command; all behavior
 * lives in `stripeCatalogSyncCommand.ts`.
 */
import { runStripeCatalogSyncCommand } from "./stripeCatalogSyncCommand.js";
import { StripeSdkCatalogAdmin } from "./stripeSdkCatalogAdmin.js";

process.exitCode = await runStripeCatalogSyncCommand({
  argv: process.argv.slice(2),
  env: process.env,
  createAdmin: (secretKey) => new StripeSdkCatalogAdmin(secretKey),
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
