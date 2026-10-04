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
  // pnpm's `--filter … run` executes with cwd set to the package directory; INIT_CWD is the
  // directory the operator actually invoked pnpm from, which is where a relative
  // --webhook-secret-file should land.
  cwd: process.env.INIT_CWD ?? process.cwd(),
  createAdmin: (secretKey) => new StripeSdkCatalogAdmin(secretKey),
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
