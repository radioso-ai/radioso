/**
 * Planner schema regression harness (legacy vs production).
 *
 * Isolates the fused turn planner (no DB, no worker): renders the production
 * prompt and response schema, calls the chat model directly, and scores
 * referential rewrite resolution per arm. `production` is exactly what
 * `buildTurnPlanResponseFormat` emits: the `resolutionNote` scratch field and
 * the derivation fields (turnKind, proposedActiveSubject) ordered before the
 * resolved query fields (rewrittenQuery, semanticQuery, lexicalQuery) they
 * depend on. `legacy` reproduces the pre-2026-09-17 schema — no
 * `resolutionNote`, resolved query fields emitted before the derivation
 * fields that explain them — so this harness can still demonstrate the
 * referential-rewrite regression that ordering caused, and catch a future
 * schema edit that reintroduces it. See `CHAT_BEHAVIOR.turnPlanning.
 * reasoningEffort` in `behaviorConfig.ts` for the full history.
 *
 *   node --env-file=../.env --import tsx ./scripts/plannerSchemaAb.ts --samples 10
 *
 * Flags: --samples N (per case per arm), --concurrency N, --model <id>,
 *        --efforts none,low, --orders legacy,production,
 *        --arms legacy/low,production/none (explicit pairs), --cases a,b,c
 */
import type { MessageRecord } from "../src/db/repositories/messageRepository.js";
import {
  buildTurnPlanResponseFormat,
  buildTurnPlanningPrompt,
  parseTurnPlan,
  type TurnPlan,
} from "../src/modules/chat/services/turnPlanService.js";
import { OpenAITextGenerationClient } from "../src/shared/infra/llm/openaiProvider.js";
import type {
  JsonSchemaResponseFormat,
  ReasoningEffort,
} from "../src/shared/infra/llm/providerTypes.js";
import { CHAT_BEHAVIOR } from "../src/shared/domain/behaviorConfig.js";

type SchemaOrder = "legacy" | "production";

interface Expectation {
  route?: "retrieval" | "direct";
  /** Every entry must appear in the resolved query text (lowercased). */
  allOf?: string[];
  /** At least one entry must appear. */
  anyOf?: string[];
  /** No entry may appear — catches vague placeholders like "the second option". */
  noneOf?: string[];
}

interface AbCase {
  id: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  query: string;
  expect: Expectation;
}

const CASES: AbCase[] = [
  {
    id: "ordinal-en",
    history: [
      { role: "user", content: "What plans do you offer?" },
      {
        role: "assistant",
        content:
          "We offer three plans: 1. Starter, for individuals; 2. Pro, for growing teams; 3. Enterprise, for large organisations. Which one would you like to know more about?",
      },
    ],
    query: "the second one",
    expect: { route: "retrieval", anyOf: ["pro"], noneOf: ["second one", "second option", "second plan"] },
  },
  {
    id: "ordinal-it",
    history: [
      { role: "user", content: "Quali piani offrite?" },
      {
        role: "assistant",
        content:
          "Offriamo tre piani: 1. Starter, per singoli utenti; 2. Pro, per team in crescita; 3. Enterprise, per grandi organizzazioni. Quale ti interessa?",
      },
    ],
    query: "il secondo",
    expect: { route: "retrieval", anyOf: ["pro"], noneOf: ["secondo"] },
  },
  {
    id: "ordinal-de",
    history: [
      { role: "user", content: "Welche Pläne bietet ihr an?" },
      {
        role: "assistant",
        content:
          "Wir bieten drei Pläne an: 1. Starter für Einzelpersonen, 2. Pro für wachsende Teams, 3. Enterprise für große Organisationen. Zu welchem möchtest du mehr wissen?",
      },
    ],
    query: "das dritte bitte",
    expect: { route: "retrieval", anyOf: ["enterprise"], noneOf: ["dritte"] },
  },
  {
    id: "ordinal-inline-fr",
    history: [
      { role: "user", content: "Quelles offres proposez-vous ?" },
      {
        role: "assistant",
        content:
          "Nous proposons Starter, Pro et Enterprise. Je peux détailler celle qui vous intéresse.",
      },
    ],
    query: "la deuxième",
    expect: { route: "retrieval", anyOf: ["pro"], noneOf: ["deuxième"] },
  },
  {
    id: "ordinal-relative-last",
    history: [
      { role: "user", content: "Which integrations are available?" },
      {
        role: "assistant",
        content:
          "Currently: Slack, HubSpot, and Zendesk. I can go into the setup steps for any of them.",
      },
    ],
    query: "the last one please",
    expect: { route: "retrieval", anyOf: ["zendesk"], noneOf: ["last one", "last option"] },
  },
  {
    id: "acceptance-offer",
    history: [
      { role: "user", content: "How do refunds work?" },
      {
        role: "assistant",
        content:
          "Refunds are available within 30 days of purchase. Would you like me to walk you through how to request one?",
      },
    ],
    query: "yes please",
    expect: { route: "retrieval", anyOf: ["refund"] },
  },
  {
    id: "acceptance-both",
    history: [
      { role: "user", content: "I'm evaluating your product for my team." },
      {
        role: "assistant",
        content:
          "Happy to help. I can explain the pricing tiers or walk you through the onboarding steps — which would you prefer?",
      },
    ],
    query: "both please",
    expect: { route: "retrieval", allOf: ["pricing", "onboarding"] },
  },
  {
    id: "continuation",
    history: [
      { role: "user", content: "Tell me about your SOC 2 certification." },
      {
        role: "assistant",
        content:
          "We hold a SOC 2 Type II report covering security, availability, and confidentiality, renewed annually.",
      },
    ],
    query: "tell me more",
    expect: { route: "retrieval", anyOf: ["soc 2", "soc2"] },
  },
  {
    id: "self-correction",
    history: [
      { role: "user", content: "How much does the Pro plan cost?" },
      { role: "assistant", content: "The Pro plan costs €49 per month per seat." },
    ],
    query: "wait, I meant the Starter plan, not Pro",
    expect: { route: "retrieval", anyOf: ["starter"] },
  },
  {
    id: "fresh-subject",
    history: [],
    query: "Do you support SSO with Okta?",
    expect: { route: "retrieval", anyOf: ["okta"] },
  },
  {
    id: "direct-thanks",
    history: [
      { role: "user", content: "How do refunds work?" },
      { role: "assistant", content: "Refunds are available within 30 days of purchase." },
    ],
    query: "great, thanks!",
    expect: { route: "direct" },
  },
];

const LEGACY_REWRITE_ORDER = [
  "rewrittenQuery",
  "semanticQuery",
  "lexicalQuery",
  "queryShape",
  "temporalQueryMode",
  "retrievalSubqueries",
  "turnKind",
  "proposedActiveSubject",
  "relatedEntities",
  "unresolved",
  "confidence",
] as const;

/**
 * Reproduces the pre-2026-09-17 production schema: no `resolutionNote`, and
 * `rewrite.properties` keyed with the resolved query fields (rewrittenQuery,
 * semanticQuery, lexicalQuery) before the derivation fields (turnKind,
 * proposedActiveSubject) that explain them. Under strict structured output,
 * property order is emission order, so this re-key is the only byte that
 * differs from the `production` arm.
 */
const toLegacySchema = (format: JsonSchemaResponseFormat): JsonSchemaResponseFormat => {
  const schema = structuredClone(format.schema) as {
    properties: { rewrite: { properties: Record<string, unknown>; required: string[] } };
  };
  const rewrite = schema.properties.rewrite;
  const { resolutionNote: _resolutionNote, ...remaining } = rewrite.properties;
  const missing = LEGACY_REWRITE_ORDER.filter((key) => !(key in remaining));
  if (missing.length > 0) {
    throw new Error(`rewrite schema is missing keys the legacy order expects: ${missing.join(", ")}`);
  }
  rewrite.properties = Object.fromEntries(
    LEGACY_REWRITE_ORDER.map((key) => [key, remaining[key]]),
  );
  rewrite.required = [...LEGACY_REWRITE_ORDER];
  return { ...format, schema };
};

const toHistory = (turns: AbCase["history"]): MessageRecord[] =>
  turns.map((turn, index) => ({
    id: `m${index}`,
    conversationId: "ab",
    workspaceId: "ab",
    role: turn.role,
    content: turn.content,
    createdAt: new Date(),
  }));

const resolvedText = (plan: TurnPlan): string => {
  const rewrite = plan.rewriteProposal;
  if (!rewrite) return "";
  return [
    rewrite.rewrittenQuery,
    rewrite.semanticQuery ?? "",
    rewrite.lexicalQuery ?? "",
    rewrite.proposedActiveSubject ?? "",
    ...(rewrite.retrievalSubqueries ?? []).flatMap((s) => [s.semanticQuery, s.lexicalQuery]),
  ]
    .join(" \n ")
    .toLowerCase();
};

const score = (plan: TurnPlan | null, expectation: Expectation): { ok: boolean; why: string } => {
  if (!plan) return { ok: false, why: "parse_failed" };
  if (expectation.route && plan.route !== expectation.route) {
    return { ok: false, why: `route=${plan.route}` };
  }
  if (plan.route === "direct") return { ok: true, why: "" };
  const text = resolvedText(plan);
  for (const needle of expectation.allOf ?? []) {
    if (!text.includes(needle)) return { ok: false, why: `missing "${needle}"` };
  }
  if (expectation.anyOf && !expectation.anyOf.some((needle) => text.includes(needle))) {
    return { ok: false, why: `none of [${expectation.anyOf.join("|")}]` };
  }
  for (const needle of expectation.noneOf ?? []) {
    if (text.includes(needle)) return { ok: false, why: `placeholder "${needle}"` };
  }
  return { ok: true, why: "" };
};

interface Sample {
  arm: string;
  caseId: string;
  ok: boolean;
  why: string;
  ms: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  rewritten: string;
}

const parseArgs = () => {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback: string): string => {
    const index = args.indexOf(flag);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };
  return {
    samples: Number(get("--samples", "10")),
    concurrency: Number(get("--concurrency", "4")),
    model: get("--model", process.env.OPENAI_CHAT_MODEL ?? "gpt-5.4-mini"),
    efforts: get("--efforts", "none,low").split(",") as ReasoningEffort[],
    orders: get("--orders", "legacy,production").split(",") as SchemaOrder[],
    cases: get("--cases", "").split(",").filter(Boolean),
    arms: get("--arms", "").split(",").filter(Boolean),
    verbose: args.includes("--verbose"),
  };
};

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

const runPool = async <T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> => {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
};

const main = async () => {
  const opts = parseArgs();
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const client = new OpenAITextGenerationClient({
    capability: "chat",
    provider: "openai",
    model: opts.model,
    apiKey,
  });
  const cases = opts.cases.length > 0 ? CASES.filter((c) => opts.cases.includes(c.id)) : CASES;
  const baseFormat = buildTurnPlanResponseFormat({ routineIds: [], directiveNames: [] });
  const formats: Record<SchemaOrder, JsonSchemaResponseFormat> = {
    production: baseFormat,
    legacy: toLegacySchema(baseFormat),
  };

  const tasks: Array<() => Promise<Sample>> = [];
  const armPairs: Array<[SchemaOrder, ReasoningEffort]> =
    opts.arms.length > 0
      ? opts.arms.map((arm) => arm.split("/") as [SchemaOrder, ReasoningEffort])
      : opts.orders.flatMap((order) => opts.efforts.map((effort): [SchemaOrder, ReasoningEffort] => [order, effort]));
  for (const [order, effort] of armPairs) {
    {
      const arm = `${order}/${effort}`;
      for (const abCase of cases) {
        const prompt = buildTurnPlanningPrompt({
          query: abCase.query,
          history: toHistory(abCase.history),
          routineCandidates: [],
          directiveCandidates: [],
        });
        for (let i = 0; i < opts.samples; i += 1) {
          tasks.push(async () => {
            const started = performance.now();
            let text = "";
            let usage: Record<string, number | undefined> = {};
            try {
              const result = await client.complete({
                prompt,
                responseFormat: formats[order],
                reasoningEffort: effort,
                maxOutputTokens: CHAT_BEHAVIOR.turnPlanning.maxOutputTokens,
              });
              text = result.text;
              usage = {
                inputTokens: result.usage?.inputTokens,
                outputTokens: result.usage?.outputTokens,
                reasoningTokens: result.usage?.reasoningTokens,
                cachedInputTokens: result.usage?.cachedInputTokens,
              };
            } catch (error) {
              return {
                arm, caseId: abCase.id, ok: false, why: `error: ${(error as Error).message.slice(0, 80)}`,
                ms: performance.now() - started, inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
                cachedInputTokens: 0, rewritten: "",
              };
            }
            const ms = performance.now() - started;
            // The production parser accepts `resolutionNote` natively (optional field), and
            // the legacy schema never emits it, so no per-arm stripping is needed here.
            const plan = parseTurnPlan(text, {
              routineIds: new Set(),
              directiveNames: new Set(),
            });
            const verdict = score(plan, abCase.expect);
            return {
              arm, caseId: abCase.id, ok: verdict.ok, why: verdict.why, ms,
              inputTokens: usage.inputTokens ?? 0,
              outputTokens: usage.outputTokens ?? 0,
              reasoningTokens: usage.reasoningTokens ?? 0,
              cachedInputTokens: usage.cachedInputTokens ?? 0,
              rewritten: plan?.rewriteProposal?.rewrittenQuery ?? `(route ${plan?.route ?? "?"})`,
            };
          });
        }
      }
    }
  }

  // Interleave arms so machine/API load drifts affect every arm equally.
  const interleaved: typeof tasks = [];
  const perArm = cases.length * opts.samples;
  const armCount = tasks.length / perArm;
  for (let i = 0; i < perArm; i += 1) {
    for (let a = 0; a < armCount; a += 1) interleaved.push(tasks[a * perArm + i]);
  }

  console.log(`model=${opts.model} samples=${opts.samples} cases=${cases.length} arms=${armCount} calls=${tasks.length} concurrency=${opts.concurrency}`);
  const samples = await runPool(interleaved, opts.concurrency);

  const arms = [...new Set(samples.map((s) => s.arm))];
  console.log("\nPer case (pass/N):");
  const header = ["case".padEnd(24), ...arms.map((a) => a.padEnd(24))].join("");
  console.log(header);
  for (const abCase of cases) {
    const cells = arms.map((arm) => {
      const rows = samples.filter((s) => s.arm === arm && s.caseId === abCase.id);
      const pass = rows.filter((r) => r.ok).length;
      return `${pass}/${rows.length}`.padEnd(24);
    });
    console.log([abCase.id.padEnd(24), ...cells].join(""));
  }

  console.log("\nPer arm:");
  console.log(["arm".padEnd(26), "pass".padEnd(10), "p50 ms".padEnd(10), "mean ms".padEnd(10), "out tok".padEnd(10), "reason tok".padEnd(12), "in tok".padEnd(10), "cached"].join(""));
  for (const arm of arms) {
    const rows = samples.filter((s) => s.arm === arm);
    const pass = rows.filter((r) => r.ok).length;
    console.log([
      arm.padEnd(26),
      `${pass}/${rows.length}`.padEnd(10),
      Math.round(median(rows.map((r) => r.ms))).toString().padEnd(10),
      Math.round(mean(rows.map((r) => r.ms))).toString().padEnd(10),
      Math.round(mean(rows.map((r) => r.outputTokens))).toString().padEnd(10),
      Math.round(mean(rows.map((r) => r.reasoningTokens))).toString().padEnd(12),
      Math.round(mean(rows.map((r) => r.inputTokens))).toString().padEnd(10),
      Math.round(mean(rows.map((r) => r.cachedInputTokens))).toString(),
    ].join(""));
  }

  const failures = samples.filter((s) => !s.ok);
  if (failures.length > 0) {
    console.log("\nFailures (arm | case | why | rewrittenQuery):");
    const shown = opts.verbose ? failures : failures.slice(0, 40);
    for (const f of shown) {
      console.log(`${f.arm} | ${f.caseId} | ${f.why} | ${f.rewritten.slice(0, 100)}`);
    }
    if (!opts.verbose && failures.length > shown.length) {
      console.log(`… ${failures.length - shown.length} more (use --verbose)`);
    }
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
