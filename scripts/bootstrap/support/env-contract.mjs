import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const examplePath = path.join(repoRoot, "backend/.env.example");

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
  "SESSION_TTL_HOURS",
  "CONNECTOR_ENCRYPTION_KEY",
  "DOCUMENT_STORAGE_BUCKET",
  "DOCUMENT_UPLOAD_MAX_BYTES",
  "PUBLIC_CHAT_BASE_URL",
];

export const getEnvContract = () => ({
  examplePath,
  keyOrder,
  defaults: {
    ...exampleValues,
    SESSION_COOKIE_SECRET: "",
    CONNECTOR_ENCRYPTION_KEY: "",
  },
  providerOptions,
});

export const getProviderRequiredKeys = (provider) => {
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
  "SESSION_TTL_HOURS",
  "CONNECTOR_ENCRYPTION_KEY",
  "DOCUMENT_UPLOAD_MAX_BYTES",
  "PUBLIC_CHAT_BASE_URL",
];

export const listRequiredKeys = (values, contract = getEnvContract()) => {
  const provider = values.LLM_PROVIDER || contract.defaults.LLM_PROVIDER || "openai";
  const required = new Set(getAlwaysRequiredKeys());
  for (const key of getProviderRequiredKeys(provider)) {
    required.add(key);
  }
  return [...required];
};
