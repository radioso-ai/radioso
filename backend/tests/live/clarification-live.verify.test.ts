/**
 * LIVE verification (not part of CI). Drives the real retrieval-sense detection and
 * clarification decision path with real OpenAI embeddings and real model calls, using
 * the actual production document content that triggered the incident.
 *
 * Run with:
 *   cd backend && pnpm exec vitest run tests/live/clarification-live.verify.test.ts
 *
 * Requires OPENAI_API_KEY in the repo-root .env. Skips itself when absent.
 */
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ModelSenseLabelGateway,
  SenseGroupingService,
  type SenseEmbeddingReader,
} from "../../src/modules/retrieval/services/senseGroupingService.js";
import { evaluateRetrievalSenseClarification } from "../../src/modules/retrieval/services/retrievalSenseClarification.js";
import type { ModelInferencePipeline } from "../../src/shared/infra/llm/modelInferencePipeline.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

const apiKey = (() => {
  try {
    return /OPENAI_API_KEY=(\S+)/.exec(readFileSync(path.join(repoRoot, ".env"), "utf8"))?.[1];
  } catch {
    return undefined;
  }
})();

const promptTemplate = readFileSync(
  path.join(repoRoot, "backend/prompts/chat/clarification-sense-labels.md"),
  "utf8",
);

/** Production policy values from dependencyBuilders.ts. */
const POLICY = { minGroupShare: 0.3, separationThreshold: 0.4, maxOptions: 4 };
const ASK_POLICY = { floor: 0, margin: 0.15, askMargin: 0.01, maxOptions: 4 };

const openai = async (body: unknown): Promise<Record<string, unknown>> => {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Record<string, unknown>;
};

/** Minimal real-provider pipeline so the REAL ModelSenseLabelGateway is exercised. */
const livePipeline: ModelInferencePipeline = {
  metadata: { provider: "openai", model: "gpt-4.1-mini" } as never,
  async complete(input) {
    const json = await openai({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: input.prompt }],
      temperature: 0,
    });
    const choices = json.choices as Array<{ message: { content: string } }> | undefined;
    if (!choices) throw new Error(`openai error: ${JSON.stringify(json).slice(0, 300)}`);
    return { text: choices[0].message.content };
  },
  stream() {
    throw new Error("not used");
  },
};

const embed = async (texts: string[]): Promise<number[][]> => {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "text-embedding-3-small", input: texts }),
  });
  const json = (await response.json()) as { data?: Array<{ embedding: number[] }>; error?: unknown };
  if (!json.data) throw new Error(`embed error: ${JSON.stringify(json.error).slice(0, 200)}`);
  return json.data.map((d) => d.embedding);
};

const chunkText = (content: string, count: number): string[] => {
  const size = Math.ceil(content.length / count);
  return Array.from({ length: count }, (_, i) => content.slice(i * size, (i + 1) * size)).filter(
    (c) => c.trim().length > 0,
  );
};

interface DocSpec {
  documentId: string;
  title: string;
  metadata: Record<string, unknown>;
  content: string;
  chunks: number;
}

/** Builds ranked candidates + a real-embedding reader for the given documents. */
const buildScenario = async (docs: DocSpec[]) => {
  const candidates: Array<Record<string, unknown>> = [];
  const texts: string[] = [];
  const chunkIds: string[] = [];
  for (const doc of docs) {
    chunkText(doc.content, doc.chunks).forEach((content, index) => {
      const chunkId = `${doc.documentId}-c${index}`;
      chunkIds.push(chunkId);
      texts.push(content);
      candidates.push({
        chunkId,
        documentId: doc.documentId,
        title: doc.title,
        metadata: doc.metadata,
        content,
        similarity: 0.8 - index * 0.01,
        score: 0.8 - index * 0.01,
      });
    });
  }
  const vectors = await embed(texts);
  const byId = new Map(chunkIds.map((id, i) => [id, vectors[i]]));
  const embeddingReader: SenseEmbeddingReader = {
    async readChunkEmbeddings({ chunkIds: ids }) {
      return new Map(ids.flatMap((id) => (byId.has(id) ? [[id, byId.get(id)!] as const] : [])));
    },
  };
  return { candidates, embeddingReader };
};

const runDetection = async (docs: DocSpec[], question: string, policy = POLICY) => {
  const { candidates, embeddingReader } = await buildScenario(docs);
  const service = new SenseGroupingService({
    embeddingReader,
    labelGateway: new ModelSenseLabelGateway(livePipeline, promptTemplate),
    policy,
  });
  const detected = await service.detect({
    workspaceId: "ws-live",
    question,
    rankedCandidates: candidates as never,
  });
  const effect = await evaluateRetrievalSenseClarification({
    detector: { async detect() { return detected; } },
    workspaceId: "ws-live",
    rankedCandidates: candidates as never,
    conversationId: "conv-live",
    messageId: "msg-live",
    originalQuery: question,
    policy: ASK_POLICY,
    suppressAsk: false,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return { detected, effect };
};

const report = (name: string, detected: unknown[], effect: unknown) => {
  const e = effect as { kind?: string; stage?: { outputs?: Record<string, unknown> } } | null;
  appendFileSync("/tmp/live-verify.txt", `\n===== ${name}
  detected(${detected.length}): ${JSON.stringify(
    (detected as Array<Record<string, unknown>>).map((c) => ({
      label: c.label, relationship: c.relationship, confidence: c.confidence,
    })), null, 1)}
  effect.kind: ${e?.kind ?? "null (no clarification candidates)"}
  stage.outputs: ${JSON.stringify(e?.stage?.outputs ?? null)}\n`);
};

describe.skipIf(!apiKey)("LIVE retrieval-sense clarification", () => {
  it("S1: the production repro ANSWERS instead of asking", async () => {
    const prod = JSON.parse(
      readFileSync(path.join(repoRoot, ".context/verify/ananda-docs.json"), "utf8"),
    ) as Record<string, { title: string; content: string; metadata: Record<string, unknown> }>;

    const { detected, effect } = await runDetection(
      [
        { documentId: "doc-new", title: prod.new_ananda_yoga.title, metadata: prod.new_ananda_yoga.metadata, content: prod.new_ananda_yoga.content, chunks: 4 },
        { documentId: "doc-live", title: prod.ananda_yoga.title, metadata: prod.ananda_yoga.metadata, content: prod.ananda_yoga.content, chunks: 4 },
      ],
      "what ananda yoga types exist?",
    );
    report("S1 production repro (duplicate WordPress pages)", detected, effect);

    // The incident behaviour was effect.kind === "ask".
    expect(effect?.kind ?? "none").not.toBe("ask");

    // Which guard actually protected us? Re-run with the separation filter disabled so
    // the labelling path is forced to run. If detection above returned nothing, the
    // pre-existing separation threshold caught it and the new `redundant` path was
    // never reached — that distinction matters and must not be hidden by a green test.
    const forced = await runDetection(
      [
        { documentId: "doc-new", title: prod.new_ananda_yoga.title, metadata: prod.new_ananda_yoga.metadata, content: prod.new_ananda_yoga.content, chunks: 4 },
        { documentId: "doc-live", title: prod.ananda_yoga.title, metadata: prod.ananda_yoga.metadata, content: prod.ananda_yoga.content, chunks: 4 },
      ],
      "what ananda yoga types exist?",
      { ...POLICY, separationThreshold: 0 },
    );
    report("S1b separation filter disabled (forces the labelling path)", forced.detected, forced.effect);

    // With the labelling path forced, the duplicate pair must be judged redundant and
    // answered — this is what protects workspaces whose duplicates separate above 0.4.
    expect(forced.detected.length).toBeGreaterThanOrEqual(2);
    expect(forced.detected.every((c) => (c as { relationship?: string }).relationship === "redundant")).toBe(true);
    expect(forced.effect?.kind).toBe("proceed");
    expect((forced.effect as { stage?: { outputs?: { reason?: string } } })?.stage?.outputs?.reason).toBe("redundant_sources");
  }, 180_000);

  it("S2: genuine ambiguity STILL asks a clarifying question", async () => {
    const { detected, effect } = await runDetection(
      [
        {
          documentId: "doc-planet", title: "Mercury", metadata: { source: "wordpress", wp_slug: "mercury-planet" },
          content:
            "Mercury is the smallest planet in the Solar System and the closest to the Sun. Its orbital period is 88 Earth days, the shortest of any planet. " +
            "The planet has virtually no atmosphere to retain heat, so surface temperatures swing from about 430 C in daylight to -180 C at night. " +
            "Mercury has a large iron core relative to its size and a heavily cratered surface resembling that of the Moon. " +
            "Two spacecraft have visited Mercury: Mariner 10 in the 1970s and MESSENGER, which orbited the planet from 2011 to 2015.",
          chunks: 4,
        },
        {
          documentId: "doc-element", title: "Mercury", metadata: { source: "wordpress", wp_slug: "mercury-element" },
          content:
            "Mercury is a chemical element with the symbol Hg and atomic number 80. It is the only metallic element that is liquid at standard temperature and pressure. " +
            "Mercury is highly toxic; exposure to its vapour can damage the nervous system, kidneys and lungs, and it bioaccumulates as methylmercury in fish. " +
            "Historically mercury was used in thermometers, barometers and dental amalgam, though most of these uses are now restricted. " +
            "The element is obtained chiefly by roasting cinnabar ore, and its use is regulated internationally under the Minamata Convention.",
          chunks: 4,
        },
      ],
      "tell me about mercury",
    );
    report("S2 genuine ambiguity (planet vs element)", detected, effect);

    expect(detected.length).toBeGreaterThanOrEqual(2);
    expect(detected.every((c) => (c as { relationship?: string }).relationship === undefined)).toBe(true);
    expect(effect?.kind).toBe("ask");
    const labels = (effect as { candidates: Array<{ label: string }> }).candidates.map((c) => c.label);
    expect(labels.length).toBeGreaterThanOrEqual(2);
    expect(new Set(labels).size).toBe(labels.length); // distinct, not two bare copies of a title
  }, 120_000);
});
