import type { EngagementMode } from "../../src/modules/emailChannel/public.js";
import type {
  EmailAttentionKind,
  EmailBusinessOutcome,
  EmailBusinessOutcomeKind,
  EmailMailbox,
  EmailMailboxHarness,
  InboundReceipt,
  SettleReport,
} from "./emailMailboxHarness.js";

/**
 * The email channel's live behaviour suite: committed cases (`tests/fixtures/email-behaviour/`)
 * run against the mailbox harness, each on its own mailbox, and scored on business outcomes:
 * whether the customer got an email, a draft waits, the mail was set aside, or a person took the
 * conversation. Reply text is checked structurally and, where a case asks, by an LLM judge; the
 * judge lives here, in the eval layer, never in product code.
 */

// ── Case vocabulary ──────────────────────────────────────────────────

export interface ReplyChecks {
  /** Each pattern must match the reply. */
  mentions?: readonly RegExp[];
  /** No pattern may match the reply. */
  doesNotMention?: readonly RegExp[];
  /** Graded by the LLM judge against a reference reply, with criteria such as language or no promises. */
  judge?: { reference: string; criteria: string };
}

export interface OutcomeExpectation {
  kind: EmailBusinessOutcomeKind;
  /** Accepted reasons; any reason when left out. */
  reason?: string | readonly string[];
}

export interface StepExpectation {
  /** The step passes when the observed outcome matches any of these. */
  outcome: OutcomeExpectation | readonly OutcomeExpectation[];
  ownership?: "ai_owned" | "human_owned";
  attentionKind?: EmailAttentionKind;
  /** On a sent email: `true` when it must carry `Auto-Submitted: auto-generated`, `false` when it must carry none. */
  autoSubmitted?: boolean;
  /** On a held draft: whether its labels say grounded and fully answered. */
  groundedLabel?: boolean;
  /** Whether a review turn ran for the step. */
  turnRan?: boolean;
}

/** A customer's email; `thread` replies to the last email on the case's thread, threaded by headers. */
export interface CustomerStep {
  kind: "customer";
  text: string;
  subject?: string;
  replyTo?: "thread";
  headers?: Readonly<Record<string, string>>;
  expect?: StepExpectation;
  reply?: ReplyChecks;
}

export type CaseStep =
  | CustomerStep
  | { kind: "take_over" }
  | { kind: "operator_reply"; text: string }
  | { kind: "set_mode"; mode: EngagementMode }
  /** Releases the thread's held draft, then reads the outcome of the email it answers. */
  | { kind: "release"; editedText?: string; expect?: StepExpectation; reply?: ReplyChecks };

export interface EmailBehaviourCase {
  id: string;
  /** The business question, in one line. */
  title: string;
  mode: EngagementMode;
  customer: { name: string; address: string };
  /** `assert` gates the run; `record` reports what happened, for a product decision. */
  gate: "assert" | "record";
  steps: readonly CaseStep[];
}

// ── Results ──────────────────────────────────────────────────────────

export interface CheckResult {
  name: string;
  status: "pass" | "fail" | "skipped" | "error";
  detail: string;
}

export interface StepResult {
  index: number;
  kind: CaseStep["kind"];
  input: string | null;
  expected: string | null;
  observed: string | null;
  outcome: EmailBusinessOutcome | null;
  checks: CheckResult[];
  settle: SettleReport | null;
  /** Model calls the workspace recorded while the step ran. */
  modelCalls: number;
  newEmails: number;
}

export interface CaseResult {
  id: string;
  title: string;
  mode: EngagementMode;
  gate: EmailBehaviourCase["gate"];
  /** `pass`/`fail` gate asserted cases; a `record` case reports `recorded`, or `error` when it could not run. */
  status: "pass" | "fail" | "recorded" | "error";
  /** For a `record` case with expectations: whether what happened matched them. */
  matchedExpectation: boolean | null;
  steps: StepResult[];
  error: string | null;
  durationMs: number;
}

/** The LLM judge port: a verdict on one reply against a reference and criteria. */
export interface ReplyJudge {
  judge(input: { question: string; reply: string; reference: string; criteria: string }): Promise<{ verdict: "pass" | "fail" | "error"; reason: string }>;
}

// ── Running a case ───────────────────────────────────────────────────

interface ThreadState {
  subject: string | null;
  lastReceipt: InboundReceipt | null;
  /** The newest email on the thread either side sent, which a reply answers. */
  lastMessageId: string | null;
  references: string[];
  conversationId: string | null;
}

const isExpectationList = (outcome: StepExpectation["outcome"]): outcome is readonly OutcomeExpectation[] => Array.isArray(outcome);

const expectations = (expect: StepExpectation): readonly OutcomeExpectation[] =>
  isExpectationList(expect.outcome) ? expect.outcome : [expect.outcome];

const reasonsOf = (expectation: OutcomeExpectation): readonly string[] | null =>
  expectation.reason === undefined ? null : typeof expectation.reason === "string" ? [expectation.reason] : expectation.reason;

export const describeExpectation = (expect: StepExpectation | undefined): string | null => {
  if (!expect) return null;
  return expectations(expect)
    .map((expectation) => {
      const reasons = reasonsOf(expectation);
      return reasons ? `${expectation.kind}/${reasons.join("|")}` : expectation.kind;
    })
    .join(" or ");
};

export const describeOutcome = (outcome: EmailBusinessOutcome | null): string | null =>
  outcome ? `${outcome.kind}/${outcome.reason}` : null;

const matchesOutcome = (expectation: OutcomeExpectation, outcome: EmailBusinessOutcome): boolean => {
  const reasons = reasonsOf(expectation);
  return expectation.kind === outcome.kind && (reasons === null || reasons.includes(outcome.reason));
};

/** The structural checks of one step's expectation against what happened. */
export const checkExpectation = (
  expect: StepExpectation,
  observed: { outcome: EmailBusinessOutcome; turnRan: boolean; newEmails: number },
): CheckResult[] => {
  const { outcome } = observed;
  const checks: CheckResult[] = [];
  const check = (name: string, pass: boolean, detail: string) => checks.push({ name, status: pass ? "pass" : "fail", detail });
  const accepted = expectations(expect);
  check("outcome", accepted.some((expectation) => matchesOutcome(expectation, outcome)), `expected ${describeExpectation(expect)}, got ${describeOutcome(outcome)}`);
  if (!accepted.some((expectation) => expectation.kind === "sent")) {
    check("nothing_sent", observed.newEmails === 0, `${observed.newEmails} email(s) sent`);
  }
  if (expect.ownership) check("ownership", outcome.ownership.state === expect.ownership, `ownership ${outcome.ownership.state}`);
  if (expect.attentionKind) check("attention", outcome.attentionKind === expect.attentionKind, `attention ${outcome.attentionKind}`);
  if (expect.autoSubmitted !== undefined && outcome.sentEmail) {
    const marked = outcome.sentEmail.autoSubmitted === "auto-generated";
    check("auto_submitted", marked === expect.autoSubmitted, `Auto-Submitted: ${outcome.sentEmail.autoSubmitted ?? "absent"}`);
  }
  if (expect.groundedLabel !== undefined && outcome.heldReply) {
    const { grounding, coverage } = outcome.heldReply.labels;
    check("grounded_label", (grounding === "grounded" && coverage === "answered") === expect.groundedLabel, `labels ${grounding}/${coverage}`);
  }
  if (expect.turnRan !== undefined) check("turn_ran", observed.turnRan === expect.turnRan, observed.turnRan ? "a review turn ran" : "no review turn ran");
  return checks;
};

/** The text the customer got, or the draft a teammate would send. */
export const replyTextOf = (outcome: EmailBusinessOutcome): string | null => outcome.sentEmail?.text ?? outcome.heldReply?.draftText ?? null;

const checkReply = async (
  checks: ReplyChecks,
  input: { question: string; reply: string | null; judge: ReplyJudge | null },
): Promise<CheckResult[]> => {
  const { reply } = input;
  // A hand-off without a draft has no text; the step's outcome check decides whether that was right.
  if (reply === null) return [{ name: "reply", status: "skipped", detail: "no reply text" }];
  const results: CheckResult[] = [];
  for (const pattern of checks.mentions ?? []) {
    results.push({ name: "mentions", status: pattern.test(reply) ? "pass" : "fail", detail: String(pattern) });
  }
  for (const pattern of checks.doesNotMention ?? []) {
    results.push({ name: "does_not_mention", status: pattern.test(reply) ? "fail" : "pass", detail: String(pattern) });
  }
  if (checks.judge) {
    if (!input.judge) {
      results.push({ name: "judge", status: "skipped", detail: "judge disabled" });
    } else {
      const verdict = await input.judge.judge({ question: input.question, reply, reference: checks.judge.reference, criteria: checks.judge.criteria });
      results.push({ name: "judge", status: verdict.verdict, detail: verdict.reason });
    }
  }
  return results;
};

const threadHeaders = (thread: ThreadState): { inReplyTo?: string; references?: string[] } =>
  thread.lastMessageId ? { inReplyTo: thread.lastMessageId, references: [...thread.references] } : {};

const rememberSent = (thread: ThreadState, outcome: EmailBusinessOutcome): void => {
  if (outcome.conversationId) thread.conversationId = outcome.conversationId;
  const sent = outcome.sentEmail;
  if (sent && sent.messageId && !thread.references.includes(sent.messageId)) {
    thread.references.push(sent.messageId);
    thread.lastMessageId = sent.messageId;
  }
};

export interface RunCaseOptions {
  harness: EmailMailboxHarness;
  /** Makes each case's mailbox address unique to the run. */
  runTag: string;
  judge: ReplyJudge | null;
  log?: (line: string) => void;
}

/** Runs one case on a fresh mailbox and scores every step that states expectations or reply checks. */
export const runEmailBehaviourCase = async (testCase: EmailBehaviourCase, options: RunCaseOptions): Promise<CaseResult> => {
  const startedAt = Date.now();
  const steps: StepResult[] = [];
  const result = (status: CaseResult["status"], error: string | null, matchedExpectation: boolean | null): CaseResult => ({
    id: testCase.id,
    title: testCase.title,
    mode: testCase.mode,
    gate: testCase.gate,
    status,
    matchedExpectation,
    steps,
    error,
    durationMs: Date.now() - startedAt,
  });
  try {
    const mailbox = await options.harness.openMailbox({ mode: testCase.mode, local: `${testCase.id}-${options.runTag}`, displayName: "Fernhill Tea" });
    const thread: ThreadState = { subject: null, lastReceipt: null, lastMessageId: null, references: [], conversationId: null };
    for (const [index, step] of testCase.steps.entries()) {
      options.log?.(`  ${testCase.id} step ${index + 1}: ${step.kind}`);
      steps.push(await runStep(step, index, { testCase, mailbox, thread, ...options }));
    }
    const scored = steps.flatMap((step) => step.checks).filter((check) => check.status !== "skipped");
    const failed = scored.some((check) => check.status === "fail" || check.status === "error");
    if (testCase.gate === "record") {
      const expected = testCase.steps.some((step) => "expect" in step && step.expect !== undefined);
      return result("recorded", null, expected ? !failed : null);
    }
    return result(failed ? "fail" : "pass", null, null);
  } catch (error) {
    return result("error", error instanceof Error ? error.message : String(error), null);
  }
};

const runStep = async (
  step: CaseStep,
  index: number,
  context: { testCase: EmailBehaviourCase; mailbox: EmailMailbox; thread: ThreadState } & RunCaseOptions,
): Promise<StepResult> => {
  const { harness, mailbox, thread, testCase } = context;
  const since = new Date();
  const emailsBefore = (await mailbox.spool()).length;
  const finish = async (fields: Partial<StepResult>): Promise<StepResult> => ({
    index,
    kind: step.kind,
    input: null,
    expected: null,
    observed: null,
    outcome: null,
    checks: [],
    settle: null,
    ...fields,
    modelCalls: (await harness.modelUsage(since)).reduce((sum, usage) => sum + usage.calls, 0),
    newEmails: (await mailbox.spool()).length - emailsBefore,
  });

  switch (step.kind) {
    case "take_over":
      await mailbox.takeOver(thread.conversationId ?? undefined);
      return finish({});
    case "set_mode":
      await mailbox.setMode(step.mode);
      return finish({ input: step.mode });
    case "operator_reply": {
      await mailbox.operatorReply(step.text, thread.conversationId ?? undefined);
      const settle = await mailbox.settle();
      const sent = (await mailbox.spool()).filter((email) => email.to === testCase.customer.address).at(-1);
      if (sent?.messageId) {
        thread.references.push(sent.messageId);
        thread.lastMessageId = sent.messageId;
      }
      return finish({ input: step.text, settle });
    }
    case "release": {
      if (!thread.lastReceipt) throw new Error("release before any customer email");
      await mailbox.release({ conversationId: thread.conversationId ?? undefined, editedText: step.editedText });
      const settle = await mailbox.settle();
      const outcome = await mailbox.outcome(thread.lastReceipt);
      rememberSent(thread, outcome);
      return scoreStep({ step, outcome, settle, turnRan: settle.turnsRun > 0, question: thread.subject ?? "", context, finish, emailsBefore });
    }
    case "customer": {
      const subject = step.subject ?? (thread.subject ? `Re: ${thread.subject}` : "Question");
      thread.subject ??= step.subject ?? subject;
      const receipt = await mailbox.inbound({
        from: { address: testCase.customer.address, name: testCase.customer.name },
        subject,
        text: step.text,
        headers: step.headers,
        ...(step.replyTo === "thread" ? threadHeaders(thread) : {}),
      });
      thread.lastReceipt = receipt;
      thread.references.push(receipt.messageId);
      thread.lastMessageId = receipt.messageId;
      const settle = await mailbox.settle();
      const outcome = await mailbox.outcome(receipt);
      rememberSent(thread, outcome);
      return scoreStep({ step, outcome, settle, turnRan: settle.turnsRun > 0, question: step.text, context, finish, emailsBefore });
    }
  }
};

const scoreStep = async (input: {
  step: CustomerStep | Extract<CaseStep, { kind: "release" }>;
  outcome: EmailBusinessOutcome;
  settle: SettleReport;
  turnRan: boolean;
  question: string;
  context: { mailbox: EmailMailbox; judge: ReplyJudge | null };
  finish: (fields: Partial<StepResult>) => Promise<StepResult>;
  emailsBefore: number;
}): Promise<StepResult> => {
  const { step, outcome } = input;
  const newEmails = (await input.context.mailbox.spool()).length - input.emailsBefore;
  const checks = [
    ...(step.expect ? checkExpectation(step.expect, { outcome, turnRan: input.turnRan, newEmails }) : []),
    ...(step.reply ? await checkReply(step.reply, { question: input.question, reply: replyTextOf(outcome), judge: input.context.judge }) : []),
  ];
  return input.finish({
    input: step.kind === "customer" ? step.text : step.editedText ?? null,
    expected: describeExpectation(step.expect),
    observed: describeOutcome(outcome),
    outcome,
    checks,
    settle: input.settle,
  });
};

// ── Reporting ────────────────────────────────────────────────────────

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** One line of evidence for a case: the last scored step's facts, its failed checks, and its reply. */
export const evidenceOf = (result: CaseResult): string => {
  if (result.error) return `error: ${oneLine(result.error, 160)}`;
  const scored = result.steps.filter((step) => step.outcome !== null);
  const last = scored.at(-1);
  if (!last?.outcome) return "no outcome";
  const { outcome } = last;
  const facts = [
    outcome.sentEmail ? `AS=${outcome.sentEmail.autoSubmitted ?? "none"}` : null,
    outcome.heldReply && outcome.kind !== "sent"
      ? `labels ${outcome.heldReply.labels.outcome}/${outcome.heldReply.labels.grounding}/${outcome.heldReply.labels.coverage}${outcome.heldReply.labels.handoffReason ? ` handoff=${outcome.heldReply.labels.handoffReason}` : ""}`
      : null,
    `owner=${outcome.ownership.state}${outcome.ownership.reason ? `(${outcome.ownership.reason})` : ""}`,
    `turn=${last.settle && last.settle.turnsRun > 0 ? "yes" : "no"}`,
  ].filter((fact): fact is string => fact !== null);
  const problems = result.steps.flatMap((step) => step.checks.filter((check) => check.status === "fail" || check.status === "error")
    .map((check) => `step${step.index + 1} ${check.name}: ${oneLine(check.detail, 80)}`));
  const judged = last.checks.find((check) => check.name === "judge" && check.status !== "fail");
  const reply = replyTextOf(outcome);
  return [
    facts.join(" "),
    ...problems,
    judged ? `judge ${judged.status}: ${oneLine(judged.detail, 80)}` : null,
    reply ? `"${oneLine(reply, 110)}"` : null,
  ].filter((part): part is string => part !== null).join("; ");
};

const statusLabel = (result: CaseResult): string => {
  if (result.status !== "recorded") return result.status.toUpperCase();
  if (result.matchedExpectation === null) return "RECORDED";
  return result.matchedExpectation ? "RECORDED (as expected)" : "RECORDED (differs)";
};

const stepsSummary = (result: CaseResult, pick: (step: StepResult) => string | null): string => {
  const parts = result.steps.filter((step) => step.outcome !== null || step.expected !== null).map((step) => pick(step) ?? "-");
  return parts.length === 0 ? "-" : parts.join(" → ");
};

/** The run's table, as Markdown: case, expected, observed, status, one-line evidence. */
export const formatResultsTable = (results: readonly CaseResult[]): string => {
  const escape = (cell: string) => cell.replaceAll("|", "\\|");
  const rows = results.map((result) => [
    result.id,
    stepsSummary(result, (step) => step.expected),
    stepsSummary(result, (step) => step.observed),
    statusLabel(result),
    evidenceOf(result),
  ].map(escape));
  return [
    "| Case | Expected | Observed | Result | Evidence |",
    "|---|---|---|---|---|",
    ...rows.map((cells) => `| ${cells.join(" | ")} |`),
  ].join("\n");
};

/** Asserted cases that failed or errored; recorded cases never gate. */
export const gateFailures = (results: readonly CaseResult[]): CaseResult[] =>
  results.filter((result) => result.gate === "assert" && result.status !== "pass");
