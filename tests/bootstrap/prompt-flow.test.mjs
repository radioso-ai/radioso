import test from "node:test";
import assert from "node:assert/strict";

import { planQuestions, collectAnswers } from "../../scripts/bootstrap/prompt-flow.mjs";

test("planQuestions asks for provider key on fresh setup", () => {
  const questions = planQuestions({});
  assert.equal(questions[0].key, "LLM_PROVIDER");
  assert.ok(questions.some((question) => question.key === "OPENAI_API_KEY"));
});

test("planQuestions asks for the selected provider requirements", () => {
  const compatibleQuestions = planQuestions({
    LLM_PROVIDER: "openai-compatible",
  }, undefined, { reconfigure: true });

  assert.ok(compatibleQuestions.some((question) => question.key === "OPENAI_COMPATIBLE_API_KEY"));
  assert.ok(compatibleQuestions.some((question) => question.key === "OPENAI_COMPATIBLE_BASE_URL"));
});

test("planQuestions marks the provider API key optional", () => {
  const questions = planQuestions({});
  const keyQuestion = questions.find((question) => question.key === "OPENAI_API_KEY");

  assert.ok(keyQuestion);
  assert.ok(!keyQuestion.required);
});

test("planQuestions keeps the OpenAI-compatible base URL required while its key stays optional", () => {
  const questions = planQuestions({ LLM_PROVIDER: "openai-compatible" }, undefined, { reconfigure: true });
  const baseUrl = questions.find((question) => question.key === "OPENAI_COMPATIBLE_BASE_URL");
  const apiKey = questions.find((question) => question.key === "OPENAI_COMPATIBLE_API_KEY");

  assert.ok(baseUrl?.required);
  assert.ok(apiKey && !apiKey.required);
});

test("collectAnswers allows skipping an optional provider key", async () => {
  const answers = await collectAnswers(
    [{ key: "OPENAI_API_KEY", prompt: "Enter OPENAI_API_KEY", defaultValue: "", secret: true, required: false }],
    false,
    { ask: async () => "" },
  );

  assert.equal(answers.OPENAI_API_KEY, "");
});

test("planQuestions defaults legacy bucket-only storage config to gcs", () => {
  const questions = planQuestions({
    LLM_PROVIDER: "openai",
    OPENAI_API_KEY: "sk-test",
    DOCUMENT_STORAGE_BUCKET: "legacy-bucket",
  });

  const driverQuestion = questions.find((question) => question.key === "DOCUMENT_STORAGE_DRIVER");
  assert.equal(driverQuestion?.defaultValue, "gcs");
});

test("planQuestions skips prompts for valid existing config", () => {
  const questions = planQuestions({
    LLM_PROVIDER: "openai",
    OPENAI_API_KEY: "sk-test",
    DOCUMENT_STORAGE_DRIVER: "local",
    DOCUMENT_STORAGE_LOCAL_PATH: "../.context/document-storage",
  });

  assert.equal(questions.length, 0);
});

test("planQuestions skips storage prompts for configured bucket on normal startup", () => {
  const questions = planQuestions({
    LLM_PROVIDER: "openai",
    OPENAI_API_KEY: "sk-test",
    DOCUMENT_STORAGE_DRIVER: "gcs",
    DOCUMENT_STORAGE_BUCKET: "bucket-name",
  });

  assert.equal(questions.length, 0);
});

test("collectAnswers clears gcs-only settings when local storage is selected", async () => {
  const answers = await collectAnswers(
    [
      { key: "DOCUMENT_STORAGE_DRIVER", prompt: "Driver", defaultValue: "local", choices: ["local", "gcs"] },
      { key: "DOCUMENT_STORAGE_LOCAL_PATH", prompt: "Path", defaultValue: "../.context/document-storage", dependsOn: { key: "DOCUMENT_STORAGE_DRIVER", value: "local" } },
    ],
    false,
    {
      ask: async (question) => (question.key === "DOCUMENT_STORAGE_DRIVER" ? "local" : "../.context/document-storage"),
    },
  );

  assert.equal(answers.DOCUMENT_STORAGE_DRIVER, "local");
  assert.equal(answers.DOCUMENT_STORAGE_LOCAL_PATH, "../.context/document-storage");
  assert.equal(answers.DOCUMENT_STORAGE_BUCKET, "");
});

test("collectAnswers requests storage bucket after switching fresh setup to gcs", async () => {
  const answers = await collectAnswers(
    [
      { key: "DOCUMENT_STORAGE_DRIVER", prompt: "Driver", defaultValue: "local", choices: ["local", "gcs"] },
      { key: "DOCUMENT_STORAGE_LOCAL_PATH", prompt: "Path", defaultValue: "../.context/document-storage", dependsOn: { key: "DOCUMENT_STORAGE_DRIVER", value: "local" } },
    ],
    false,
    {
      ask: async (question) => (question.key === "DOCUMENT_STORAGE_DRIVER" ? "gcs" : "bucket-name"),
    },
  );

  assert.equal(answers.DOCUMENT_STORAGE_DRIVER, "gcs");
  assert.equal(answers.DOCUMENT_STORAGE_BUCKET, "bucket-name");
  assert.equal(answers.DOCUMENT_STORAGE_LOCAL_PATH, "");
});

test("collectAnswers requests local path after switching reconfigure from gcs to local", async () => {
  const answers = await collectAnswers(
    [
      { key: "DOCUMENT_STORAGE_DRIVER", prompt: "Driver", defaultValue: "gcs", choices: ["local", "gcs"] },
      { key: "DOCUMENT_STORAGE_BUCKET", prompt: "Bucket", defaultValue: "bucket-name", dependsOn: { key: "DOCUMENT_STORAGE_DRIVER", value: "gcs" } },
    ],
    false,
    {
      ask: async (question) => (question.key === "DOCUMENT_STORAGE_DRIVER" ? "local" : "../.context/alt-storage"),
    },
  );

  assert.equal(answers.DOCUMENT_STORAGE_DRIVER, "local");
  assert.equal(answers.DOCUMENT_STORAGE_LOCAL_PATH, "../.context/alt-storage");
  assert.equal(answers.DOCUMENT_STORAGE_BUCKET, "");
});
