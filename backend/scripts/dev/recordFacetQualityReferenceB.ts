/**
 * DEVELOPMENT TOOL. Not part of any production build, not invoked at runtime,
 * not compiled into `dist/`.
 *
 * One-off calibration measurement for spec 956. `taxonomy.json` /
 * `questions.ts` hold the committed reference labelling ("reference A") that
 * `facet-quality.test.ts` scores clustering against. This script produces a
 * SECOND, independent reference labelling ("reference B") of the same 318
 * questions, so the agreement between A and B can stand in for the practical
 * ceiling any clustering could reach on this data — two competent labellers
 * disagree with each other by some amount even before a clustering algorithm
 * enters the picture.
 *
 * Independence from reference A is structural, not just "a different prompt":
 *   - this script never reads taxonomy.json or the `topic` field of
 *     questions.ts; only `question` text and `id` cross into the prompts
 *   - the question order shown during taxonomy proposal is shuffled with a
 *     fixed seed, so ordering effects on which themes register differ
 *   - the model picks its own topic count in [8, 12]; it is not steered to 12
 *   - the instructions below are original wording, not a replay of whatever
 *     produced taxonomy.json (that prompt was never committed)
 *
 * Two passes, same shape as reference A's documented methodology:
 *   1. propose a taxonomy from the whole (shuffled) question set
 *   2. classify each question in isolation against that taxonomy, or `none`
 *
 * Usage:
 *   cd backend && pnpm exec tsx scripts/dev/recordFacetQualityReferenceB.ts
 *
 * Env vars required: OPENAI_API_KEY (loaded from backend/.env or repo-root .env)
 */

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import OpenAI from "openai";

import { normalizeOpenAIReasoningEffort } from "../../src/shared/infra/llm/knownModels.js";
import { facetQualityQuestions } from "../../tests/fixtures/facet-quality/questions.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDirectory, "../..");
const repoRoot = path.resolve(backendRoot, "..");
const outputPath = path.join(repoRoot, "specs/956-audience-topic-census/reference-b.json");

for (const candidate of [path.join(backendRoot, ".env"), path.join(repoRoot, ".env")]) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  process.stderr.write("OPENAI_API_KEY is not set.\n");
  process.exit(1);
}

const client = new OpenAI({ apiKey });

const LABEL_MODEL = "gpt-5.2";
const SHUFFLE_SEED = "facet-quality/956/reference-b/shuffle";
const CONCURRENCY = 8;

// --- deterministic shuffle (mulberry32 + Fisher-Yates), independent of the
// eval's own seeded k-means so a change to one never silently affects the other.

const hashSeed = (seed: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
};

const createRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

const shuffled = <T>(items: readonly T[], seed: string): T[] => {
  const random = createRandom(hashSeed(seed));
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapWith = Math.floor(random() * (index + 1));
    [copy[index], copy[swapWith]] = [copy[swapWith]!, copy[index]!];
  }
  return copy;
};

const HTML_SENSITIVE_CHARACTERS: Record<string, string> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
};

/** Fences visitor text so adversarial/off-topic fixture content reads as data, not instructions. */
const fenceUntrustedText = (value: string): string =>
  JSON.stringify(value).replace(/[<>&]/g, (character) => HTML_SENSITIVE_CHARACTERS[character]!);

const mapWithConcurrency = async <Input, Output>(
  items: readonly Input[],
  limit: number,
  worker: (item: Input, index: number) => Promise<Output>,
): Promise<Output[]> => {
  const results = new Array<Output>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(runners);
  return results;
};

// --- pass 1: propose a taxonomy from the whole shuffled question set ---

interface Topic {
  slug: string;
  label: string;
  description: string;
}

const TAXONOMY_JSON_SCHEMA = {
  name: "topic_taxonomy",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["topics"],
    properties: {
      topics: {
        type: "array",
        minItems: 8,
        maxItems: 12,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["slug", "label", "description"],
          properties: {
            slug: { type: "string", pattern: "^[a-z][a-z0-9_]*$", maxLength: 60 },
            label: { type: "string", maxLength: 80 },
            description: { type: "string", maxLength: 400 },
          },
        },
      },
    },
  },
} as const;

const buildTaxonomyPrompt = (questions: readonly string[]): string => {
  const numbered = questions.map((question, index) => `${index + 1}. ${question.replaceAll("\n", " ")}`).join("\n");
  return [
    "You triage support volume for a chatbot that answers visitor questions on a yoga, meditation, and spiritual-community website. Below is a shuffled sample of real visitor questions it received.",
    "",
    "Design a topic taxonomy a triage team would actually use: each topic must be a distinct, recognizable kind of visitor intent, topics must not overlap with each other, and together they should cover the bulk of what is below. A meaningful minority of questions may not cleanly fit any topic — small talk, complaints, fragments, or truly one-off asks. Do not stretch a topic's definition to absorb those; a later step is allowed to leave a question unclassified.",
    "Pick however many topics genuinely separate this traffic, anywhere from 8 to 12. Do not default to the middle or the max just because the range allows it — use fewer if the data only supports fewer distinct groups, more if it supports more.",
    "For each topic give: a short lowercase_snake_case slug, a short human-readable label, and a one-sentence description precise enough that someone else could use it to classify a new question without asking you.",
    "",
    "Visitor questions (order carries no meaning):",
    numbered,
  ].join("\n");
};

const proposeTaxonomy = async (questions: readonly string[]): Promise<Topic[]> => {
  const response = await client.chat.completions.create({
    model: LABEL_MODEL,
    reasoning_effort: normalizeOpenAIReasoningEffort(LABEL_MODEL, "medium"),
    max_completion_tokens: 4000,
    response_format: { type: "json_schema", json_schema: TAXONOMY_JSON_SCHEMA },
    messages: [{ role: "user", content: buildTaxonomyPrompt(questions) }],
  });
  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("Empty completion for taxonomy proposal.");
  }
  const parsed = JSON.parse(content) as { topics: Topic[] };
  if (!Array.isArray(parsed.topics) || parsed.topics.length < 8) {
    throw new Error(`Malformed or too-small taxonomy: ${content.slice(0, 200)}`);
  }
  return parsed.topics;
};

// --- pass 2: classify each question in isolation against the proposed taxonomy ---

const NONE_SENTINEL = "none";

const buildAssignmentJsonSchema = (topics: readonly Topic[]) =>
  ({
    name: "topic_assignment",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["topic"],
      properties: {
        topic: { type: "string", enum: [...topics.map((topic) => topic.slug), NONE_SENTINEL] },
      },
    },
  }) as const;

const buildAssignmentPrompt = (topics: readonly Topic[], question: string): string => {
  const catalog = topics.map((topic) => `- ${topic.slug}: ${topic.label} — ${topic.description}`).join("\n");
  return [
    "Here is a fixed catalog of topics for classifying visitor questions to a yoga/meditation/spiritual-community chatbot:",
    catalog,
    "",
    "You will now see exactly one visitor question, delimited below. Assign it to the single best-fitting topic slug from the catalog above. If it genuinely fits none of them well, answer with \"none\" rather than forcing the closest match. Judge this question entirely on its own; you have no information about any other question.",
    "",
    `<visitor-question>${fenceUntrustedText(question)}</visitor-question>`,
  ].join("\n");
};

const classifyOne = async (topics: readonly Topic[], question: string): Promise<string | null> => {
  const response = await client.chat.completions.create({
    model: LABEL_MODEL,
    reasoning_effort: normalizeOpenAIReasoningEffort(LABEL_MODEL, "low"),
    max_completion_tokens: 600,
    response_format: { type: "json_schema", json_schema: buildAssignmentJsonSchema(topics) },
    messages: [{ role: "user", content: buildAssignmentPrompt(topics, question) }],
  });
  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error(`Empty completion classifying: ${question.slice(0, 60)}`);
  }
  const parsed = JSON.parse(content) as { topic?: unknown };
  if (typeof parsed.topic !== "string") {
    throw new Error(`Malformed assignment payload: ${content.slice(0, 120)}`);
  }
  return parsed.topic === NONE_SENTINEL ? null : parsed.topic;
};

const main = async (): Promise<void> => {
  const shuffledQuestions = shuffled(
    facetQualityQuestions.map((entry) => entry.question),
    SHUFFLE_SEED,
  );

  process.stdout.write(`Proposing taxonomy from ${shuffledQuestions.length} shuffled questions with ${LABEL_MODEL}\n`);
  const topics = await proposeTaxonomy(shuffledQuestions);
  process.stdout.write(`Proposed ${topics.length} topics:\n`);
  for (const topic of topics) {
    process.stdout.write(`  ${topic.slug}: ${topic.label}\n`);
  }

  process.stdout.write(`Classifying ${facetQualityQuestions.length} questions in isolation (concurrency ${CONCURRENCY})\n`);
  const assignments = await mapWithConcurrency(facetQualityQuestions, CONCURRENCY, async (entry, index) => {
    const topic = await classifyOne(topics, entry.question);
    process.stdout.write(`  [${index + 1}/${facetQualityQuestions.length}] ${entry.id}: ${topic ?? "(none)"}\n`);
    return { id: entry.id, topic };
  });

  const counts = new Map<string, number>();
  for (const { topic } of assignments) {
    const key = topic ?? "(none)";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const payload = {
    purpose:
      "Independent second reference labelling ('reference B') of backend/tests/fixtures/facet-quality/questions.ts, produced without access to taxonomy.json or the topic field in questions.ts, for spec 956 eval-gate calibration.",
    labellingModel: LABEL_MODEL,
    generatedAt: new Date().toISOString(),
    shuffleSeed: SHUFFLE_SEED,
    methodology: [
      "Pass 1: gpt-5.2 was given all 318 questions (text only), presented in an order shuffled with a fixed seed distinct from any other seed in this repo, and asked in its own wording to propose 8-12 mutually exclusive topics — its own choice of count within that range, not steered to 12.",
      "Pass 2: gpt-5.2 was given each question in isolation (one call per question, no other question visible) plus the pass-1 taxonomy, and asked to assign one topic slug or 'none'.",
    ],
    topics,
    topicCounts: Object.fromEntries(counts),
    labels: Object.fromEntries(assignments.map(({ id, topic }) => [id, topic])),
  };

  writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(`\nWrote ${outputPath}\n`);
  process.stdout.write("\nTopic counts:\n");
  for (const [topic, count] of counts) {
    process.stdout.write(`  ${topic.padEnd(45)} ${count}\n`);
  }
};

await main();
