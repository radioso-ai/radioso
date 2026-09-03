import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";

import { askHidden, planQuestions, collectAnswers } from "../../scripts/bootstrap/prompt-flow.mjs";

test("askHidden hides TTY input through Node readline without platform commands", async () => {
  const visibleWrites = [];
  const input = { isTTY: true };
  const output = {
    write: (chunk) => {
      visibleWrites.push(String(chunk));
      return true;
    },
  };
  let readlineOptions;
  let closed = false;

  const answer = await askHidden("Provider key: ", {
    input,
    output,
    createInterface: (options) => {
      readlineOptions = options;
      return {
        question: async () => {
          options.output.write("secret-that-must-not-echo");
          return "  secret-value  ";
        },
        close: () => {
          closed = true;
        },
      };
    },
  });

  assert.equal(answer, "secret-value");
  assert.equal(readlineOptions.input, input);
  assert.equal(readlineOptions.terminal, true);
  assert.notEqual(readlineOptions.output, output);
  assert.deepEqual(visibleWrites, ["Provider key: ", "\n"]);
  assert.equal(closed, true);
});

test("askHidden reads a secret through the real Node TTY interface", async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  const visibleWrites = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      visibleWrites.push(String(chunk));
      callback();
    },
  });

  const answerPromise = askHidden("Provider key: ", { input, output });
  input.write("secret-value\n");

  assert.equal(await answerPromise, "secret-value");
  assert.equal(visibleWrites.join(""), "Provider key: \n");
});

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

test("fresh setup persists Gemini as both the text and embedding provider", async () => {
  const questions = planQuestions({});
  const answers = await collectAnswers(questions, false, {
    ask: async (question) => {
      if (question.key === "LLM_PROVIDER") return "gemini";
      if (question.key === "GEMINI_API_KEY") return "";
      if (question.key === "DOCUMENT_STORAGE_DRIVER") return "local";
      return question.defaultValue || "";
    },
  });

  assert.equal(answers.LLM_PROVIDER, "gemini");
  assert.equal(answers.LLM_EMBEDDING_PROVIDER, "gemini");
  assert.ok(Object.hasOwn(answers, "GEMINI_API_KEY"));
  assert.ok(!Object.hasOwn(answers, "OPENAI_API_KEY"));
});

test("Claude setup asks for a supported embedding provider and its optional credentials", async () => {
  const questions = planQuestions({}, undefined, { reconfigure: true });
  const asked = [];
  const answers = await collectAnswers(questions, false, {
    ask: async (question) => {
      asked.push(question.key);
      if (question.key === "LLM_PROVIDER") return "claude";
      if (question.key === "LLM_EMBEDDING_PROVIDER") return "gemini";
      if (question.key === "DOCUMENT_STORAGE_DRIVER") return "local";
      return question.defaultValue || "";
    },
  });

  assert.equal(answers.LLM_EMBEDDING_PROVIDER, "gemini");
  assert.ok(asked.includes("ANTHROPIC_API_KEY"));
  assert.ok(asked.includes("GEMINI_API_KEY"));
  assert.ok(!asked.includes("OPENAI_API_KEY"));
});

test("reconfiguring OpenAI-compatible mirrors it for embeddings", async () => {
  const questions = planQuestions({
    LLM_PROVIDER: "openai-compatible",
    OPENAI_COMPATIBLE_BASE_URL: "https://models.example/v1",
  }, undefined, { reconfigure: true });
  const answers = await collectAnswers(questions, false, {
    ask: async (question) => question.defaultValue || "",
  });

  assert.equal(answers.LLM_PROVIDER, "openai-compatible");
  assert.equal(answers.LLM_EMBEDDING_PROVIDER, "openai-compatible");
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
