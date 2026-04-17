import readline from "node:readline/promises";
import { execFileSync } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";

import { formatMessage } from "./terminal-theme.mjs";
import { getEnvContract, getProviderRequiredKeys } from "./support/env-contract.mjs";

export const planQuestions = (existingValues = {}, contract = getEnvContract(), options = {}) => {
  const reconfigure = Boolean(options.reconfigure);
  const questions = [];
  const provider = existingValues.LLM_PROVIDER || contract.defaults.LLM_PROVIDER || "openai";
  const defaultStorageDriver = existingValues.DOCUMENT_STORAGE_DRIVER
    || (existingValues.DOCUMENT_STORAGE_BUCKET ? "gcs" : contract.defaults.DOCUMENT_STORAGE_DRIVER || "local");

  if (reconfigure || !existingValues.LLM_PROVIDER) {
    questions.push({
      key: "LLM_PROVIDER",
      prompt: "Choose your default AI provider",
      defaultValue: provider,
      kind: "choice",
      choices: contract.providerOptions,
    });
  }

  const providerValue = reconfigure ? provider : existingValues.LLM_PROVIDER || provider;
  const providerRequiredKeys = getProviderRequiredKeys(providerValue);

  for (const key of providerRequiredKeys) {
    if (reconfigure || !existingValues[key]) {
      questions.push({
        key,
        prompt: key === "OPENAI_COMPATIBLE_BASE_URL" ? "OpenAI-compatible base URL" : `Enter ${key}`,
        defaultValue: existingValues[key] || contract.defaults[key] || "",
        secret: key.includes("KEY"),
      });
    }
  }

  if (reconfigure || !existingValues.DOCUMENT_STORAGE_DRIVER) {
    questions.push({
      key: "DOCUMENT_STORAGE_DRIVER",
      prompt: "Choose document storage for uploaded files",
      defaultValue: defaultStorageDriver,
      kind: "choice",
      choices: ["local", "gcs"],
    });
  }

  const storageDriver = reconfigure
    ? defaultStorageDriver
    : defaultStorageDriver;

  if (reconfigure || (storageDriver === "local" && !existingValues.DOCUMENT_STORAGE_LOCAL_PATH)) {
    questions.push({
      key: "DOCUMENT_STORAGE_LOCAL_PATH",
      prompt: "Local document storage path",
      defaultValue: existingValues.DOCUMENT_STORAGE_LOCAL_PATH || contract.defaults.DOCUMENT_STORAGE_LOCAL_PATH || "../.context/document-storage",
      dependsOn: { key: "DOCUMENT_STORAGE_DRIVER", value: "local" },
    });
  }

  if (reconfigure || (storageDriver === "gcs" && !existingValues.DOCUMENT_STORAGE_BUCKET)) {
    questions.push({
      key: "DOCUMENT_STORAGE_BUCKET",
      prompt: "Document storage bucket name",
      defaultValue: existingValues.DOCUMENT_STORAGE_BUCKET || "",
      dependsOn: { key: "DOCUMENT_STORAGE_DRIVER", value: "gcs" },
    });
  }

  return questions;
};

const validateAnswer = (question, value) => {
  if (question.key.endsWith("_BASE_URL") && value && !/^https?:\/\//.test(value)) {
    return "Enter a full URL starting with http:// or https://";
  }
  if (question.key.includes("KEY") && !value) {
    return "This value is required.";
  }
  if (question.key === "DOCUMENT_STORAGE_BUCKET" && !value) {
    return "This value is required.";
  }
  return null;
};

const askHidden = async (promptText) => {
  output.write(promptText);
  if (!input.isTTY) {
    const rl = readline.createInterface({ input, output });
    const answer = await rl.question("");
    rl.close();
    return answer.trim();
  }

  execFileSync("stty", ["-echo"]);
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question("");
    output.write("\n");
    return answer.trim();
  } finally {
    rl.close();
    execFileSync("stty", ["echo"]);
  }
};

export const collectAnswers = async (questions, ansi, io = {}) => {
  const answers = {};
  const plannedKeys = new Set(questions.map((question) => question.key));
  const ask = io.ask ?? (async ({ prompt, defaultValue, secret, choices }) => {
    const label = choices
      ? `${prompt} [${choices.join("/")}] (${defaultValue}): `
      : `${prompt}${defaultValue ? ` (${defaultValue})` : ""}: `;

    if (secret) {
      return askHidden(formatMessage("prompt", label, ansi));
    }

    const rl = readline.createInterface({ input, output });
    try {
      const answer = await rl.question(formatMessage("prompt", label, ansi));
      return answer.trim();
    } finally {
      rl.close();
    }
  });

  const askFollowUp = async (question) => {
    while (true) {
      const answer = (await ask(question)) || question.defaultValue || "";
      const validationError = validateAnswer(question, answer);
      if (validationError) {
        output.write(`${formatMessage("warning", `${validationError}\n`, ansi)}`);
        continue;
      }
      answers[question.key] = answer;
      return;
    }
  };

  for (const question of questions) {
    if (question.dependsOn && answers[question.dependsOn.key] !== question.dependsOn.value) {
      continue;
    }

    while (true) {
      const answer = (await ask(question)) || question.defaultValue || "";
      const validationError = validateAnswer(question, answer);
      if (validationError) {
        output.write(`${formatMessage("warning", `${validationError}\n`, ansi)}`);
        continue;
      }
      answers[question.key] = answer;
      if (question.key === "DOCUMENT_STORAGE_DRIVER") {
        if (answer === "gcs" && !plannedKeys.has("DOCUMENT_STORAGE_BUCKET")) {
          await askFollowUp({
            key: "DOCUMENT_STORAGE_BUCKET",
            prompt: "Document storage bucket name",
            defaultValue: answers.DOCUMENT_STORAGE_BUCKET || "",
          });
        }
        if (answer === "local" && !plannedKeys.has("DOCUMENT_STORAGE_LOCAL_PATH")) {
          await askFollowUp({
            key: "DOCUMENT_STORAGE_LOCAL_PATH",
            prompt: "Local document storage path",
            defaultValue: answers.DOCUMENT_STORAGE_LOCAL_PATH || "../.context/document-storage",
          });
        }
      }
      break;
    }
  }

  if (answers.DOCUMENT_STORAGE_DRIVER === "local") {
    answers.DOCUMENT_STORAGE_BUCKET = "";
  }
  if (answers.DOCUMENT_STORAGE_DRIVER === "gcs") {
    answers.DOCUMENT_STORAGE_LOCAL_PATH = "";
  }
  return answers;
};
