import test from "node:test";
import assert from "node:assert/strict";

import { planQuestions, collectAnswers, DEMO_MODE_API_KEY } from "../../scripts/bootstrap/prompt-flow.mjs";

test("planQuestions asks for provider key on fresh setup", () => {
  const questions = planQuestions({});
  assert.equal(questions[0].key, "LLM_PROVIDER");
  assert.ok(questions.some((question) => question.key === "__QUICK_EVAL_MODE__"));
  assert.ok(questions.some((question) => question.key === "OPENAI_API_KEY"));
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

test("collectAnswers injects a placeholder key for demo mode", async () => {
  const answers = await collectAnswers(
    [
      {
        key: "__QUICK_EVAL_MODE__",
        prompt: "Quick eval",
        defaultValue: "setup",
        choices: ["setup", "demo"],
      },
      {
        key: "OPENAI_API_KEY",
        prompt: "OpenAI key",
        defaultValue: "",
        secret: true,
        dependsOn: { key: "__QUICK_EVAL_MODE__", value: "setup" },
      },
    ],
    { enabled: false },
    {
      ask: async () => "demo",
    },
  );

  assert.equal(answers.OPENAI_API_KEY, DEMO_MODE_API_KEY);
});
