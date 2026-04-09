import readline from "node:readline/promises";
import { execFileSync } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";

import { formatMessage } from "./terminal-theme.mjs";
import { getEnvContract, getProviderRequiredKeys } from "./support/env-contract.mjs";

const asBool = (value) => String(value ?? "").trim().toLowerCase().startsWith("y");

export const planQuestions = (existingValues = {}, contract = getEnvContract(), options = {}) => {
  const reconfigure = Boolean(options.reconfigure);
  const questions = [];
  const provider = existingValues.LLM_PROVIDER || contract.defaults.LLM_PROVIDER || "openai";

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

  if (reconfigure || existingValues.DOCUMENT_STORAGE_BUCKET === undefined) {
    questions.push({
      key: "__USE_DOCUMENT_STORAGE__",
      prompt: "Enable external document storage bucket? (y/N)",
      defaultValue: existingValues.DOCUMENT_STORAGE_BUCKET ? "y" : "n",
    });
  }

  if (reconfigure && existingValues.DOCUMENT_STORAGE_BUCKET) {
    questions.push({
      key: "DOCUMENT_STORAGE_BUCKET",
      prompt: "Document storage bucket name",
      defaultValue: existingValues.DOCUMENT_STORAGE_BUCKET || "",
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
      if (question.key === "__USE_DOCUMENT_STORAGE__" && asBool(answer)) {
        const bucketAnswer = await ask({
          key: "DOCUMENT_STORAGE_BUCKET",
          prompt: "Document storage bucket name",
          defaultValue: answers.DOCUMENT_STORAGE_BUCKET || "",
        });
        answers.DOCUMENT_STORAGE_BUCKET = bucketAnswer.trim();
      }
      break;
    }
  }

  if ("__USE_DOCUMENT_STORAGE__" in answers && !asBool(answers.__USE_DOCUMENT_STORAGE__)) {
    delete answers.DOCUMENT_STORAGE_BUCKET;
  }

  delete answers.__USE_DOCUMENT_STORAGE__;
  return answers;
};
