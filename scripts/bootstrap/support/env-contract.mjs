import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const examplePath = path.join(repoRoot, ".env.example");

const parseEnvLike = (source) => {
  const values = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1);
    values[key] = value;
  }
  return values;
};

const exampleValues = parseEnvLike(fs.readFileSync(examplePath, "utf8"));

const providerOptions = ["openai", "openai-compatible", "gemini", "claude"];

const keyOrder = [
  "PORT",
  "NODE_ENV",
  "GOOGLE_CLOUD_PROJECT",
  "DATABASE_URL",
  "INTEGRATION_DATABASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_CHAT_MODEL",
  "OPENAI_RERANK_MODEL",
  "OPENAI_VECTOR_MODEL",
  "OPENAI_COMPATIBLE_API_KEY",
  "OPENAI_COMPATIBLE_BASE_URL",
  "GEMINI_API_KEY",
  "ANTHROPIC_API_KEY",
  "LLM_PROVIDER",
  "LLM_CHAT_PROVIDER",
  "LLM_CHAT_MODEL",
  "LLM_REWRITE_PROVIDER",
  "LLM_REWRITE_MODEL",
  "LLM_RERANK_PROVIDER",
  "LLM_RERANK_MODEL",
  "LLM_EMBEDDING_PROVIDER",
  "LLM_EMBEDDING_MODEL",
  "SESSION_COOKIE_NAME",
  "SESSION_COOKIE_SECRET",
  "WORKSPACE_TOKEN_SECRET",
  "PUBLIC_CHAT_SESSION_SECRET",
  "SESSION_TTL_HOURS",
  "CONNECTOR_ENCRYPTION_KEY",
  "WEBHOOK_DESTINATIONS_ALLOW_HTTP_LOOPBACK",
  "DOCUMENT_STORAGE_DRIVER",
  "DOCUMENT_STORAGE_LOCAL_PATH",
  "DOCUMENT_STORAGE_BUCKET",
  "DOCUMENT_UPLOAD_MAX_BYTES",
  "WORKER_DISPATCH_DRIVER",
  "WORKER_TASKS_QUEUE_LOCATION",
  "WORKER_TASKS_QUEUE_NAME",
  "WORKER_TASKS_CRAWL_QUEUE_NAME",
  "WORKER_TASKS_SERVICE_URL",
  "WORKER_TASKS_INVOKER_SERVICE_ACCOUNT",
  "WORKER_AMQP_URL",
  "WORKER_AMQP_QUEUE_NAME",
  "WORKER_AMQP_CRAWL_QUEUE_NAME",
  "WORKER_AMQP_PREFETCH",
  "DOCUMENT_PROCESSING_JOB_LEASE_MS",
  "WEBSITE_CRAWL_JOB_LEASE_MS",
  "WEBSITE_CRAWL_WORKER_POLL_INTERVAL_MS",
  "APP_BASE_URL",
  "MAIL_DRIVER",
  "MAIL_FROM_EMAIL",
  "MAIL_FROM_NAME",
  "RESEND_MAIL_API_KEY",
  "PASSWORD_RESET_TOKEN_TTL_MINUTES",
  "EMAIL_VERIFICATION_TOKEN_TTL_MINUTES",
  "PUBLIC_CHAT_BASE_URL",
];

export const getEnvContract = () => ({
  examplePath,
  keyOrder,
  defaults: {
    ...exampleValues,
    SESSION_COOKIE_SECRET: "",
    WORKSPACE_TOKEN_SECRET: "",
    PUBLIC_CHAT_SESSION_SECRET: "",
    CONNECTOR_ENCRYPTION_KEY: "",
  },
  providerOptions,
});

// Keys offered during bootstrap for the chosen provider. The provider API key
// is optional here — it can be added later in the app under Settings →
// Credentials — so these are prompted but not enforced.
export const getProviderCredentialKeys = (provider) => {
  switch (provider) {
    case "openai-compatible":
      return ["OPENAI_COMPATIBLE_API_KEY", "OPENAI_COMPATIBLE_BASE_URL"];
    case "gemini":
      return ["GEMINI_API_KEY"];
    case "claude":
      return ["ANTHROPIC_API_KEY"];
    case "openai":
    default:
      return ["OPENAI_API_KEY"];
  }
};

// Provider keys that must be present for the deployment to function at all.
// API keys are intentionally excluded: a workspace can supply its own key in
// the app, so startup does not require one. The OpenAI-compatible base URL
// stays required because it is a deployment-level endpoint, not a per-workspace
// credential.
export const getProviderRequiredKeys = (provider) => {
  switch (provider) {
    case "openai-compatible":
      return ["OPENAI_COMPATIBLE_BASE_URL"];
    default:
      return [];
  }
};

export const getAlwaysRequiredKeys = () => [
  "PORT",
  "NODE_ENV",
  "DATABASE_URL",
  "INTEGRATION_DATABASE_URL",
  "OPENAI_CHAT_MODEL",
  "OPENAI_RERANK_MODEL",
  "OPENAI_VECTOR_MODEL",
  "LLM_PROVIDER",
  "SESSION_COOKIE_NAME",
  "SESSION_COOKIE_SECRET",
  "WORKSPACE_TOKEN_SECRET",
  "PUBLIC_CHAT_SESSION_SECRET",
  "SESSION_TTL_HOURS",
  "CONNECTOR_ENCRYPTION_KEY",
  "DOCUMENT_UPLOAD_MAX_BYTES",
  "WORKER_DISPATCH_DRIVER",
  "DOCUMENT_PROCESSING_JOB_LEASE_MS",
  "PUBLIC_CHAT_BASE_URL",
];

export const listRequiredKeys = (values, contract = getEnvContract()) => {
  const provider = values.LLM_PROVIDER || contract.defaults.LLM_PROVIDER || "openai";
  const storageDriver = values.DOCUMENT_STORAGE_DRIVER
    || (values.DOCUMENT_STORAGE_BUCKET ? "gcs" : contract.defaults.DOCUMENT_STORAGE_DRIVER || "local");
  const required = new Set(getAlwaysRequiredKeys());
  for (const key of getProviderRequiredKeys(provider)) {
    required.add(key);
  }
  if (!values.DOCUMENT_STORAGE_DRIVER) {
    required.add("DOCUMENT_STORAGE_DRIVER");
  }
  if (storageDriver === "gcs") {
    required.add("DOCUMENT_STORAGE_BUCKET");
  }
  const workerDispatchDriver = values.WORKER_DISPATCH_DRIVER || contract.defaults.WORKER_DISPATCH_DRIVER || "noop";
  if (workerDispatchDriver === "cloud-tasks") {
    required.add("GOOGLE_CLOUD_PROJECT");
    required.add("WORKER_TASKS_QUEUE_LOCATION");
    required.add("WORKER_TASKS_QUEUE_NAME");
    required.add("WORKER_TASKS_CRAWL_QUEUE_NAME");
    required.add("WORKER_TASKS_SERVICE_URL");
    required.add("WORKER_TASKS_INVOKER_SERVICE_ACCOUNT");
  }
  return [...required];
};
