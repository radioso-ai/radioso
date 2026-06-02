import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  attachComposeStack,
  startComposeStack,
} from "./compose-runner.mjs";
import { buildEnvValues, renderEnvFile, writeEnvFileAtomic } from "./env-file.mjs";
import { collectAnswers, planQuestions } from "./prompt-flow.mjs";
import { detectEnvState, runPreflightChecks } from "./preflight.mjs";
import { getEnvContract, getProviderCredentialKeys, getProviderRequiredKeys } from "./support/env-contract.mjs";
import { detectAnsiSupport } from "./support/ansi-capabilities.mjs";
import { formatMessage, renderHeader } from "./terminal-theme.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const envPath = path.join(repoRoot, ".env");

const generatedValues = () => ({
  SESSION_COOKIE_SECRET: crypto.randomBytes(24).toString("base64"),
  WORKSPACE_TOKEN_SECRET: crypto.randomBytes(24).toString("base64"),
  PUBLIC_CHAT_SESSION_SECRET: crypto.randomBytes(24).toString("base64"),
  CONNECTOR_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"),
});

const resolveGeneratedValues = (existingValues) => ({
  SESSION_COOKIE_SECRET: existingValues.SESSION_COOKIE_SECRET || crypto.randomBytes(24).toString("base64"),
  WORKSPACE_TOKEN_SECRET: existingValues.WORKSPACE_TOKEN_SECRET || crypto.randomBytes(24).toString("base64"),
  PUBLIC_CHAT_SESSION_SECRET:
    existingValues.PUBLIC_CHAT_SESSION_SECRET ||
    existingValues.WEBSITE_EMBED_SECRET ||
    crypto.randomBytes(24).toString("base64"),
  CONNECTOR_ENCRYPTION_KEY:
    existingValues.CONNECTOR_ENCRYPTION_KEY ||
    existingValues.SECRETS_ENCRYPTION_KEY ||
    crypto.randomBytes(32).toString("base64"),
});

const installStdoutGuard = () => {
  process.stdout.on("error", (error) => {
    if (error?.code === "EPIPE") {
      process.exit(0);
    }
    throw error;
  });
};

const printPreflightResults = (results, ansi, out = process.stdout) => {
  for (const result of results) {
    const kind = result.status === "fail" ? "error" : "helper";
    out.write(`${formatMessage(kind, `- ${result.summary}\n`, ansi)}`);
    if (result.recoveryAction) {
      out.write(`${formatMessage("helper", `  ${result.recoveryAction}\n`, ansi)}`);
    }
  }
};

const validateProviderConfig = (values, contract = getEnvContract()) => {
  const provider = values.LLM_PROVIDER || contract.defaults.LLM_PROVIDER || "openai";
  const missingKeys = getProviderRequiredKeys(provider).filter((key) => {
    const value = values[key];
    return value === undefined || value === null || value === "";
  });

  if (missingKeys.length > 0) {
    throw new Error(`Missing required provider configuration: ${missingKeys.join(", ")}`);
  }
};

const isInteractiveTerminal = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

const hasProviderApiKey = (values) => {
  const provider = values.LLM_PROVIDER || "openai";
  return getProviderCredentialKeys(provider)
    .filter((key) => key.includes("KEY"))
    .some((key) => typeof values[key] === "string" && values[key].trim().length > 0);
};

const printConfigurationSummary = (values, ansi, out = process.stdout) => {
  out.write(`${formatMessage("helper", "\nConfiguration summary:\n", ansi)}`);
  out.write(`${formatMessage("helper", `- AI provider: ${values.LLM_PROVIDER}\n`, ansi)}`);
  out.write(
    `${formatMessage(
      "helper",
      values.DOCUMENT_STORAGE_DRIVER === "gcs"
        ? `- Document storage: GCS bucket ${values.DOCUMENT_STORAGE_BUCKET}\n`
        : `- Document storage: local filesystem at ${values.DOCUMENT_STORAGE_LOCAL_PATH}\n`,
      ansi,
    )}`,
  );
  out.write(
    `${formatMessage(
      "helper",
      hasProviderApiKey(values)
        ? "- Document processing and chat will use the configured provider credentials.\n"
        : "- No provider API key set yet. Add one in the app under Settings -> Credentials to enable chat and document processing.\n",
      ansi,
    )}`,
  );
};

const renderPostStartGuide = (report, ansi, out = process.stdout) => {
  const [frontendUrl = "http://127.0.0.1:3000", backendUrl = "http://127.0.0.1:8080"] = report.applicationUrls;

  out.write(`${formatMessage("helper", `\nFrontend: ${frontendUrl}\n`, ansi)}`);
  out.write(`${formatMessage("helper", `Backend:  ${backendUrl}\n`, ansi)}`);
};

const summarizeStartup = (report, ansi, options = {}) => {
  const out = options.stdout ?? process.stdout;
  if (report.ok) {
    out.write(`${formatMessage("success", "\nRadioso is ready.\n", ansi)}`);
    renderPostStartGuide(report, ansi, out);
    return null;
  }

  out.write(`${formatMessage("error", "\nStartup did not complete.\n", ansi)}`);
  for (const failed of report.failedServices) {
    out.write(`${formatMessage("helper", `- Failing service: ${failed}\n`, ansi)}`);
  }
  if (report.logHint) {
    out.write(`${formatMessage("helper", `- ${report.logHint}\n`, ansi)}`);
  }
  return 1;
};

export const main = async (argv = process.argv.slice(2), dependencies = {}) => {
  const ansi = detectAnsiSupport();
  const contract = getEnvContract();
  const attach = argv.includes("--attach");
  const reconfigure = argv.includes("--reconfigure");
  const interactive = isInteractiveTerminal();
  const out = dependencies.stdout ?? process.stdout;
  const detectEnv = dependencies.detectEnvState ?? detectEnvState;
  const preflight = dependencies.runPreflightChecks ?? runPreflightChecks;
  const writeEnv = dependencies.writeEnvFileAtomic ?? writeEnvFileAtomic;
  const startCompose = dependencies.startComposeStack ?? startComposeStack;
  const attachCompose = dependencies.attachComposeStack ?? attachComposeStack;
  const targetEnvPath = dependencies.envPath ?? envPath;

  out.write(`${renderHeader(ansi)}\n\n`);
  out.write(`${formatMessage("helper", "Checking local prerequisites...\n", ansi)}`);

  const preflightResults = await preflight();
  printPreflightResults(preflightResults, ansi, out);
  if (preflightResults.some((result) => result.isBlocking)) {
    return 1;
  }

  const envState = await detectEnv(targetEnvPath, contract);
  let values = envState.values ?? {};

  if (reconfigure || envState.state !== "valid") {
    const generated = resolveGeneratedValues(values);

    if (!reconfigure && !interactive) {
      values = buildEnvValues(values, generated, contract);
      validateProviderConfig(values, contract);
      await writeEnv(targetEnvPath, renderEnvFile(values, contract));
      out.write(`${formatMessage("helper", "Auto-completed .env for non-interactive startup\n", ansi)}`);
    } else {
      out.write(`\n${formatMessage("helper", "Collecting local configuration...\n", ansi)}`);
      const questions = planQuestions(values, contract, { reconfigure });
      const answers = await collectAnswers(questions, ansi);
      values = buildEnvValues(values, {
        ...generated,
        ...answers,
      }, contract);
      await writeEnv(targetEnvPath, renderEnvFile(values, contract));
      out.write(`${formatMessage("success", "Updated .env\n", ansi)}`);
    }
  } else {
    out.write(`${formatMessage("helper", "Using existing .env\n", ansi)}`);
  }

  validateProviderConfig(values, contract);
  printConfigurationSummary(values, ansi, out);

  out.write(`\n${formatMessage("helper", attach ? "Starting Docker services in attached mode...\n" : "Starting Docker services...\n", ansi)}`);
  if (attach) {
    const result = await attachCompose();
    if (result.signal === "SIGINT" || result.signal === "SIGTERM") {
      return 0;
    }

    return result.code ?? 1;
  }

  const report = await startCompose();
  const result = summarizeStartup(report, ansi, { stdout: out });
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
