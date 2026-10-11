/**
 * Live mailbox behaviour suite for the email channel (spec 1403): business outcomes of real email
 * through the real pipeline and the real model.
 *
 *   pnpm run evals:email -- --env-file ../.context/email-behaviour/.env            # every case, one sample
 *   pnpm run evals:email -- --env-file <path> --case auto-covered-question         # one case (repeatable)
 *   pnpm run evals:email -- --env-file <path> --migrate --no-judge --out <dir>
 *
 * It boots the application composition in-process with the email channel's local provider, seeds a
 * workspace, operator, agent and the corpus in `tests/fixtures/email-behaviour/corpus/` (processing
 * the documents in-process, so no separate worker is needed), and runs each case in
 * `tests/fixtures/email-behaviour/cases.ts` on its own mailbox: inbound raw mail through the signed
 * webhook, the coalesced review turn with the configured model, the publication decision, and the
 * outbound spool. It prints a table (case, expected, observed, result, evidence) on stderr, writes
 * the results as JSON and Markdown to `--out`, and exits non-zero when an asserted case fails.
 *
 * REQUIREMENTS (a live path, not a unit test):
 *   - DATABASE_URL to a disposable Postgres database with pgvector; its name must contain
 *     `email_behaviour` or end in `_test`, unless `--allow-database <name>` names it.
 *   - A mini-class chat model (LLM_CHAT_MODEL or OPENAI_CHAT_MODEL) and its API key; a larger
 *     model needs `--allow-model <name>`.
 *   - EMAIL_CHANNEL_PROVIDER=local, EMAIL_CHANNEL_WORKERS_ENABLED=true, an inbound domain and a
 *     webhook secret. The local spool is `<out>/spool`, and the coalescing window is shortened to
 *     `BEHAVIOUR_COALESCE_SECONDS`.
 *
 * Application logs (pino, debug level outside production) go to stdout; redirect them to a file.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getEnv, type Env } from "../src/app/config/env.js";
import { buildLlmRegistry } from "../src/app/server/builders/integrations.js";
import { runMigrations } from "../src/db/runMigrations.js";
import { ChatGatewayLlmJudge } from "../src/modules/eval/composition.js";
import { resolveLlmConfig } from "../src/shared/infra/llm/providerConfig.js";
import { createLogger } from "../src/shared/observability/logger.js";
import { EMAIL_BEHAVIOUR_AGENT, EMAIL_BEHAVIOUR_COMPANY, emailBehaviourCases } from "../tests/fixtures/email-behaviour/cases.js";
import {
  formatResultsTable,
  gateFailures,
  runEmailBehaviourCase,
  type CaseResult,
  type ReplyJudge,
} from "../tests/support/emailBehaviourSuite.js";
import { EmailMailboxHarness } from "../tests/support/emailMailboxHarness.js";

const CORPUS_DIR = fileURLToPath(new URL("../tests/fixtures/email-behaviour/corpus/", import.meta.url));
const DEFAULT_OUT_DIR = fileURLToPath(new URL("../../.context/email-behaviour/", import.meta.url));
/** Database names a live run may write to without `--allow-database`. */
const DISPOSABLE_DATABASE = /email_behaviour|_test$/u;
/** Model names cheap enough to run on demand without `--allow-model`. */
const MINI_CLASS_MODEL = /mini|nano/u;
/** Long enough for a case's burst of mail to share one review, short enough to keep a run quick. */
const BEHAVIOUR_COALESCE_SECONDS = 2;

interface Flags {
  envFile: string | null;
  migrate: boolean;
  cases: string[];
  samples: number;
  judge: boolean;
  outDir: string;
  allowDatabase: string | null;
  allowModel: string | null;
}

const parseFlags = (argv: readonly string[]): Flags => {
  const flags: Flags = {
    envFile: null,
    migrate: false,
    cases: [],
    samples: 1,
    judge: true,
    outDir: DEFAULT_OUT_DIR,
    allowDatabase: null,
    allowModel: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => argv[++index] ?? "";
    if (arg === "--env-file") flags.envFile = value();
    else if (arg === "--migrate") flags.migrate = true;
    else if (arg === "--case") flags.cases.push(value());
    else if (arg === "--samples") flags.samples = Math.max(1, Number.parseInt(value(), 10) || 1);
    else if (arg === "--no-judge") flags.judge = false;
    else if (arg === "--out") flags.outDir = resolve(value());
    else if (arg === "--allow-database") flags.allowDatabase = value();
    else if (arg === "--allow-model") flags.allowModel = value();
    else if (arg !== "--") throw new Error(`Unknown flag ${arg}`);
  }
  return flags;
};

const print = (line = ""): void => {
  process.stderr.write(`${line}\n`);
};

/** Refuses a database that does not look disposable: the run registers an organization and writes mail. */
const requireDisposableDatabase = (databaseUrl: string, allowed: string | null): string => {
  const name = new URL(databaseUrl).pathname.replace(/^\//u, "");
  if (name !== allowed && !DISPOSABLE_DATABASE.test(name)) {
    throw new Error(`Refusing to run against database "${name}": use a disposable database whose name contains "email_behaviour" or ends in "_test", or pass --allow-database ${name}.`);
  }
  return name;
};

const requireMiniModel = (env: Env, allowed: string | null): string => {
  const { model } = resolveLlmConfig(env).chat;
  if (model !== allowed && !MINI_CLASS_MODEL.test(model)) {
    throw new Error(`Refusing to run on chat model "${model}": live runs use a mini-class model; pass --allow-model ${model} to override.`);
  }
  return model;
};

/** The eval layer's LLM judge on the configured chat model, adapted to the suite's port. */
const createJudge = (env: Env, workspaceId: string): ReplyJudge & { calls: () => number } => {
  const judge = new ChatGatewayLlmJudge(buildLlmRegistry(env, createLogger("silent")).createChatGateway());
  let calls = 0;
  return {
    calls: () => calls,
    async judge(input) {
      calls += 1;
      const verdict = await judge.judge({
        workspaceId,
        runId: `email-behaviour-${calls}`,
        assertionIndex: calls,
        assertion: { type: "llm_judge", expectedAnswer: input.reference, criteria: input.criteria },
        observedAnswer: input.reply,
        question: input.question,
      });
      return { verdict: verdict.status, reason: verdict.reason ?? "" };
    },
  };
};

const main = async (): Promise<void> => {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.envFile) process.loadEnvFile(resolve(flags.envFile));
  const env = getEnv();
  const databaseName = requireDisposableDatabase(env.DATABASE_URL, flags.allowDatabase);
  const model = requireMiniModel(env, flags.allowModel);
  const unknown = flags.cases.filter((id) => !emailBehaviourCases.some((candidate) => candidate.id === id));
  if (unknown.length > 0) throw new Error(`Unknown case(s): ${unknown.join(", ")}`);
  const cases = flags.cases.length === 0 ? emailBehaviourCases : emailBehaviourCases.filter((candidate) => flags.cases.includes(candidate.id));

  if (flags.migrate) {
    print("Applying migrations…");
    await runMigrations(env.DATABASE_URL, createLogger("silent"));
  }
  print(`Booting the mailbox harness on database ${databaseName}, chat model ${model}…`);
  const harness = await EmailMailboxHarness.boot({
    env,
    emailChannel: { localSpoolDir: join(flags.outDir, "spool"), coalesceSeconds: BEHAVIOUR_COALESCE_SECONDS },
    company: EMAIL_BEHAVIOUR_COMPANY,
    agent: EMAIL_BEHAVIOUR_AGENT,
    corpusDir: CORPUS_DIR,
  });
  try {
    const judge = flags.judge ? createJudge(env, harness.workspaceId) : null;
    const runTag = Date.now().toString(36);
    const startedAt = new Date();
    const results: CaseResult[] = [];
    for (const testCase of cases) {
      for (let sample = 1; sample <= flags.samples; sample += 1) {
        print(`Running ${testCase.id}${flags.samples > 1 ? ` (sample ${sample})` : ""}…`);
        const result = await runEmailBehaviourCase(testCase, {
          harness,
          runTag: flags.samples > 1 ? `${runTag}s${sample}` : runTag,
          judge,
          log: print,
        });
        results.push(flags.samples > 1 ? { ...result, id: `${result.id}#${sample}` } : result);
        print(`  → ${result.status}${result.error ? `: ${result.error}` : ""}`);
      }
    }
    const finishedAt = new Date();
    const usage = await harness.modelUsage(startedAt);
    const table = formatResultsTable(results);
    const failures = gateFailures(results);
    const summary = {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      database: databaseName,
      chatModel: model,
      workspaceId: harness.workspaceId,
      samples: flags.samples,
      modelUsage: usage,
      modelCalls: usage.reduce((sum, row) => sum + row.calls, 0),
      judgeCalls: judge?.calls() ?? 0,
      asserted: results.filter((result) => result.gate === "assert").length,
      passed: results.filter((result) => result.status === "pass").length,
      failed: failures.length,
      recorded: results.filter((result) => result.status === "recorded").length,
    };
    await mkdir(flags.outDir, { recursive: true });
    await writeFile(join(flags.outDir, "email-behaviour-results.json"), `${JSON.stringify({ ...summary, results }, null, 2)}\n`);
    await writeFile(join(flags.outDir, "email-behaviour-table.md"), `${table}\n`);

    print();
    print(table);
    print();
    print(`Model usage (workspace, this run): ${usage.map((row) => `${row.model} ${row.operation} ×${row.calls}`).join(", ") || "none"}`);
    print(`Judge calls: ${summary.judgeCalls} (${model})`);
    print(`Asserted ${summary.asserted}: ${summary.passed} passed, ${summary.failed} failed; ${summary.recorded} recorded.`);
    print(`Results: ${join(flags.outDir, "email-behaviour-results.json")}`);
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    await harness.close();
  }
};

main().catch((error: unknown) => {
  print(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
