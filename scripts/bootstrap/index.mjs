import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  attachComposeStack,
  startComposeStack,
} from "./compose-runner.mjs";
import { buildEnvValues, renderEnvFile, writeEnvFileAtomic } from "./env-file.mjs";
import { collectAnswers, DEMO_MODE_API_KEY, planQuestions } from "./prompt-flow.mjs";
import { detectEnvState, runPreflightChecks } from "./preflight.mjs";
import { getEnvContract } from "./support/env-contract.mjs";
import { detectAnsiSupport } from "./support/ansi-capabilities.mjs";
import { formatMessage, renderHeader } from "./terminal-theme.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const envPath = path.join(repoRoot, "backend/.env");

const generatedValues = () => ({
  SESSION_COOKIE_SECRET: crypto.randomBytes(24).toString("base64"),
  CONNECTOR_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"),
});

const resolveGeneratedValues = (existingValues) => ({
  SESSION_COOKIE_SECRET: existingValues.SESSION_COOKIE_SECRET || crypto.randomBytes(24).toString("base64"),
  CONNECTOR_ENCRYPTION_KEY: existingValues.CONNECTOR_ENCRYPTION_KEY || crypto.randomBytes(32).toString("base64"),
});

const installStdoutGuard = () => {
  process.stdout.on("error", (error) => {
    if (error?.code === "EPIPE") {
      process.exit(0);
    }
    throw error;
  });
};

const printPreflightResults = (results, ansi) => {
  for (const result of results) {
    const kind = result.status === "fail" ? "error" : "helper";
    process.stdout.write(`${formatMessage(kind, `- ${result.summary}\n`, ansi)}`);
    if (result.recoveryAction) {
      process.stdout.write(`${formatMessage("helper", `  ${result.recoveryAction}\n`, ansi)}`);
    }
  }
};

const renderPostStartGuide = (report, ansi) => {
  const [frontendUrl = "http://127.0.0.1:3000", backendUrl = "http://127.0.0.1:8080"] = report.applicationUrls;

  process.stdout.write(`${formatMessage("helper", `\nFrontend: ${frontendUrl}\n`, ansi)}`);
  process.stdout.write(`${formatMessage("helper", `Backend:  ${backendUrl}\n`, ansi)}`);
};

const summarizeStartup = (report, ansi, options = {}) => {
  if (report.ok) {
    process.stdout.write(`${formatMessage("success", "\nRadioso is ready.\n", ansi)}`);
    renderPostStartGuide(report, ansi);
    if (options.demoModeEnabled) {
      process.stdout.write(
        `${formatMessage(
          "warning",
          "- Limited demo mode: the UI can be explored, but chat answers require a real provider key. Re-run with --reconfigure when ready.\n",
          ansi,
        )}`,
      );
    }
    return null;
  }

  process.stdout.write(`${formatMessage("error", "\nStartup did not complete.\n", ansi)}`);
  for (const failed of report.failedServices) {
    process.stdout.write(`${formatMessage("helper", `- Failing service: ${failed}\n`, ansi)}`);
  }
  if (report.logHint) {
    process.stdout.write(`${formatMessage("helper", `- ${report.logHint}\n`, ansi)}`);
  }
  return 1;
};

export const main = async (argv = process.argv.slice(2)) => {
  const ansi = detectAnsiSupport();
  const contract = getEnvContract();
  const attach = argv.includes("--attach");
  const reconfigure = argv.includes("--reconfigure");

  process.stdout.write(`${renderHeader(ansi)}\n\n`);
  process.stdout.write(`${formatMessage("helper", "Checking local prerequisites...\n", ansi)}`);

  const preflightResults = await runPreflightChecks();
  printPreflightResults(preflightResults, ansi);
  if (preflightResults.some((result) => result.isBlocking)) {
    return 1;
  }

  const envState = await detectEnvState(envPath, contract);
  let values = envState.values ?? {};

  if (reconfigure || envState.state !== "valid") {
    process.stdout.write(`\n${formatMessage("helper", "Collecting local configuration...\n", ansi)}`);
    const questions = planQuestions(values, contract, { reconfigure });
    const answers = await collectAnswers(questions, ansi);
    values = buildEnvValues(values, {
      ...resolveGeneratedValues(values),
      ...answers,
    }, contract);
    await writeEnvFileAtomic(envPath, renderEnvFile(values, contract));
    process.stdout.write(`${formatMessage("success", "Updated backend/.env\n", ansi)}`);
  } else {
    process.stdout.write(`${formatMessage("helper", "Using existing backend/.env\n", ansi)}`);
  }

  process.stdout.write(`\n${formatMessage("helper", attach ? "Starting Docker services in attached mode...\n" : "Starting Docker services...\n", ansi)}`);
  if (attach) {
    const result = await attachComposeStack();
    if (result.signal === "SIGINT" || result.signal === "SIGTERM") {
      return 0;
    }

    return result.code ?? 1;
  }

  const report = await startComposeStack();
  const result = summarizeStartup(report, ansi, {
    demoModeEnabled: values.OPENAI_API_KEY === DEMO_MODE_API_KEY,
  });
  if (typeof result === "number") {
    return result;
  }

  return 0;
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  installStdoutGuard();
  try {
    const code = await main();
    process.exit(code);
  } catch (error) {
    const ansi = detectAnsiSupport();
    const message = error instanceof Error ? error.message : "Unexpected bootstrap failure";
    process.stderr.write(formatMessage("error", `${message}\n`, ansi));
    process.exit(1);
  }
}
