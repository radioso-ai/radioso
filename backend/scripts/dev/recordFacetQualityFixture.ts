/**
 * DEVELOPMENT TOOL. Not part of any production build, not invoked at runtime,
 * not compiled into `dist/` (tsconfig includes only `src/` and `tests/`).
 *
 * Records the facet-quality fixture for spec 956 (T011/T016). For every
 * hand-labelled question it extracts a facet with the real model, then embeds
 * both the facet and the raw question in the same reduced-dimension space, and
 * writes everything to a committed JSON file.
 *
 * Recording both vectors is the point: the eval scores facet clustering
 * against raw-question clustering, so the control has to come from the same
 * run and the same embedding model.
 *
 * Usage:
 *   cd backend && pnpm exec tsx scripts/dev/recordFacetQualityFixture.ts
 *
 * Options:
 *   --model <id>        extraction model, default gpt-5.4-mini
 *   --embedding <id>    embedding model, default text-embedding-3-small
 *   --dimensions <n>    embedding dimensions, default 256
 *   --concurrency <n>   parallel extraction calls, default 8
 *   --out <path>        output file, default the committed fixture
 *   --reuse <path>      take facets from an earlier recording and only re-embed
 *
 * Env vars required:
 *   OPENAI_API_KEY
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import OpenAI from "openai";

import {
  FACET_EXTRACTION_PROMPT_VERSION,
  FACET_EXTRACTION_RESPONSE_FORMAT,
  buildFacetExtractionPrompt,
} from "../../src/modules/facets/services/prompt.js";
import { normalizeOpenAIReasoningEffort } from "../../src/shared/infra/llm/knownModels.js";
import { facetQualityQuestions } from "../../tests/fixtures/facet-quality/questions.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDirectory, "../..");
const defaultOutputPath = path.join(backendRoot, "tests/fixtures/facet-quality/recorded.json");

for (const candidate of [path.join(backendRoot, ".env"), path.resolve(backendRoot, "../.env")]) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

const flag = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
};

const extractionModel = flag("model", "gpt-5.4-mini");
const embeddingModel = flag("embedding", "text-embedding-3-small");
const embeddingDimensions = Number(flag("dimensions", "256"));
const concurrency = Number(flag("concurrency", "8"));
const outputPath = flag("out", defaultOutputPath);
const reusePath = flag("reuse", "");

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  process.stderr.write("OPENAI_API_KEY is not set.\n");
  process.exit(1);
}

const client = new OpenAI({ apiKey });

const { type: _formatType, ...facetJsonSchema } = FACET_EXTRACTION_RESPONSE_FORMAT;

const extractFacet = async (question: string): Promise<string> => {
  const response = await client.chat.completions.create({
    model: extractionModel,
    reasoning_effort: normalizeOpenAIReasoningEffort(extractionModel, "minimal"),
    max_completion_tokens: 600,
    response_format: { type: "json_schema", json_schema: facetJsonSchema },
    messages: [{ role: "user", content: buildFacetExtractionPrompt(question) }],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error(`Empty completion for question: ${question.slice(0, 60)}`);
  }
  const parsed = JSON.parse(content) as { facet?: unknown };
  if (typeof parsed.facet !== "string" || parsed.facet.trim().length === 0) {
    throw new Error(`Malformed facet payload: ${content.slice(0, 120)}`);
  }
  return parsed.facet.trim();
};

/** Five decimals is far below the precision any cosine comparison here resolves. */
const round = (vector: readonly number[]): number[] =>
  vector.map((value) => Number(value.toFixed(5)));

const embedAll = async (texts: readonly string[]): Promise<number[][]> => {
  const vectors: number[][] = [];
  const batchSize = 64;
  for (let start = 0; start < texts.length; start += batchSize) {
    const batch = texts.slice(start, start + batchSize);
    const response = await client.embeddings.create({
      model: embeddingModel,
      dimensions: embeddingDimensions,
      input: [...batch],
    });
    const ordered = [...response.data].sort((left, right) => left.index - right.index);
    for (const item of ordered) {
      vectors.push(round(item.embedding));
    }
  }
  return vectors;
};

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

/** Reuses recorded facets so an embedding experiment does not re-pay for extraction. */
const reuseFacets = (): string[] => {
  const previous = JSON.parse(readFileSync(reusePath, "utf8")) as {
    entries: Array<{ id: string; facet: string }>;
  };
  const byId = new Map(previous.entries.map((entry) => [entry.id, entry.facet]));
  return facetQualityQuestions.map((entry) => {
    const facet = byId.get(entry.id);
    if (!facet) {
      throw new Error(`Reused recording has no facet for ${entry.id}`);
    }
    return facet;
  });
};

const main = async (): Promise<void> => {
  let facets: string[];
  if (reusePath) {
    process.stdout.write(`Reusing facets from ${reusePath}\n`);
    facets = reuseFacets();
  } else {
    process.stdout.write(
      `Extracting ${facetQualityQuestions.length} facets with ${extractionModel} (concurrency ${concurrency})\n`,
    );
    facets = await mapWithConcurrency(facetQualityQuestions, concurrency, async (entry, index) => {
      const facet = await extractFacet(entry.question);
      process.stdout.write(`  [${index + 1}/${facetQualityQuestions.length}] ${entry.id}: ${facet}\n`);
      return facet;
    });
  }

  process.stdout.write(`Embedding facets and raw questions with ${embeddingModel} @ ${embeddingDimensions}d\n`);
  const facetVectors = await embedAll(facets);
  const questionVectors = await embedAll(facetQualityQuestions.map((entry) => entry.question));

  const payload = {
    promptVersion: FACET_EXTRACTION_PROMPT_VERSION,
    extractionModel,
    embeddingModel,
    embeddingDimensions,
    recordedAt: new Date().toISOString(),
    entries: facetQualityQuestions.map((entry, index) => ({
      id: entry.id,
      facet: facets[index]!,
      facetVector: facetVectors[index]!,
      questionVector: questionVectors[index]!,
    })),
  };

  writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(`Wrote ${outputPath}\n`);
};

await main();
