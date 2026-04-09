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

test("planQuestions skips prompts for valid existing config", () => {
  const questions = planQuestions({
    LLM_PROVIDER: "openai",
    OPENAI_API_KEY: "sk-test",
    DOCUMENT_STORAGE_BUCKET: "",
  });

  assert.equal(questions.length, 0);
});

test("planQuestions skips storage prompts for configured bucket on normal startup", () => {
  const questions = planQuestions({
    LLM_PROVIDER: "openai",
    OPENAI_API_KEY: "sk-test",
    DOCUMENT_STORAGE_BUCKET: "bucket-name",
  });

  assert.equal(questions.length, 0);
});

test("collectAnswers omits storage bucket when disabled", async () => {
  const answers = await collectAnswers(
    [
      { key: "__USE_DOCUMENT_STORAGE__", prompt: "Enable storage", defaultValue: "n" },
      { key: "DOCUMENT_STORAGE_BUCKET", prompt: "Bucket", defaultValue: "" },
    ],
    { enabled: false },
    {
      ask: async (question) => (question.key === "__USE_DOCUMENT_STORAGE__" ? "n" : "unused"),
    },
  );

  assert.deepEqual(answers, {});
});

test("collectAnswers requests storage bucket only after enabling storage", async () => {
  const answers = await collectAnswers(
    [{ key: "__USE_DOCUMENT_STORAGE__", prompt: "Enable storage", defaultValue: "n" }],
    { enabled: false },
    {
      ask: async (question) => (question.key === "__USE_DOCUMENT_STORAGE__" ? "y" : "bucket-name"),
    },
  );

  assert.equal(answers.DOCUMENT_STORAGE_BUCKET, "bucket-name");
});
