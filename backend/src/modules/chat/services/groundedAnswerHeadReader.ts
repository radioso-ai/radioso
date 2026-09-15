import {
  classificationValues,
  REQUEST_FOCUS_MAX_LENGTH,
  type AnswerCoverageClassification,
} from "../../answerCoverage/public.js";
import {
  decodeJsonStringPrefix,
  findJsonStringEnd,
  findTopLevelStringFieldStart,
} from "./structuredAnswerFieldReader.js";
import type { GroundingEnvelopeOutcome } from "./groundedAnswerEnvelope.js";

const OUTCOME_VALUES: readonly GroundingEnvelopeOutcome[] = ["answer", "no_support", "out_of_scope"];

const isClassification = (value: string): value is AnswerCoverageClassification =>
  (classificationValues as readonly string[]).includes(value);

const isOutcome = (value: string): value is GroundingEnvelopeOutcome =>
  (OUTCOME_VALUES as readonly string[]).includes(value);

/** The envelope's head: the verdict fields the model commits to before `answer` (#1260). */
export interface GroundedAnswerHead {
  coverage: AnswerCoverageClassification;
  requestFocus: string;
  outcome: GroundingEnvelopeOutcome;
}

type GroundedAnswerHeadStatus =
  | { kind: "pending" }
  | { kind: "parsed"; head: GroundedAnswerHead }
  | { kind: "invalid" };

interface FieldReadResult {
  value: string;
  complete: boolean;
}

/**
 * Reads a bounded top-level JSON string field from a growing buffer. Bounding the
 * retained value (not just the value returned once complete) keeps a stalled or
 * runaway `requestFocus` from growing memory unbounded while streaming (FR-002).
 */
const readTopLevelStringField = (raw: string, field: string): FieldReadResult | null => {
  const start = findTopLevelStringFieldStart(raw, field);
  if (start === null) {
    return null;
  }
  const complete = findJsonStringEnd(raw, start - 1) !== -1;
  const decoded = decodeJsonStringPrefix(raw, start);
  return { value: decoded.slice(0, REQUEST_FOCUS_MAX_LENGTH), complete };
};

/**
 * Resolves the envelope head — `coverage`, `requestFocus`, `outcome` — from
 * partial JSON chunks, before any `answer` body text is safe to release (FR-003).
 *
 * `pending` while the head fields are still streaming in; `parsed` once all
 * three are complete and valid; `invalid` the moment either the response is not
 * a JSON object at all (the legacy free-text path) or the top-level `answer`
 * string opens before the head is complete (FR-004) — a violated key order or a
 * malformed classification/outcome. Once resolved, further chunks are ignored:
 * the caller is expected to stop feeding chunks in once it has acted on the
 * resolution, but a stray extra push must not change the outcome.
 */
export class GroundedAnswerHeadReader {
  private raw = "";
  private resolved: GroundedAnswerHeadStatus = { kind: "pending" };

  push(chunk: string): GroundedAnswerHeadStatus {
    if (this.resolved.kind !== "pending" || !chunk) {
      return this.resolved;
    }
    this.raw += chunk;
    this.resolved = this.evaluate();
    return this.resolved;
  }

  get current(): GroundedAnswerHeadStatus {
    return this.resolved;
  }

  private evaluate(): GroundedAnswerHeadStatus {
    const firstNonWhitespace = this.raw.match(/\S/)?.[0];
    if (firstNonWhitespace && firstNonWhitespace !== "{") {
      return { kind: "invalid" };
    }

    const coverage = readTopLevelStringField(this.raw, "coverage");
    const requestFocus = readTopLevelStringField(this.raw, "requestFocus");
    const outcome = readTopLevelStringField(this.raw, "outcome");

    if (coverage?.complete && requestFocus?.complete && outcome?.complete) {
      const focus = requestFocus.value.trim();
      if (!isClassification(coverage.value) || !isOutcome(outcome.value) || !focus) {
        return { kind: "invalid" };
      }
      return {
        kind: "parsed",
        head: { coverage: coverage.value, requestFocus: focus, outcome: outcome.value },
      };
    }

    if (findTopLevelStringFieldStart(this.raw, "answer") !== null) {
      return { kind: "invalid" };
    }

    return { kind: "pending" };
  }
}
