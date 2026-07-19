import { hasValidSourcedAssertion } from "./groundingAssertions.js";

export type GroundingStreamGateDecision =
  | { kind: "hold" }
  | { kind: "release"; text: string }
  | { kind: "bound" };

export type GroundingStreamGateFinishDecision =
  | { kind: "closed" }
  | { kind: "open" };

export interface BoundedGroundingStreamGateOptions {
  contextCount: number;
  maxRetainedCodePoints: number;
  now?: () => number;
}

/**
 * Holds a candidate answer until one complete, in-range sourced assertion is
 * present. The only admission bound is retained Unicode code points: elapsed
 * time is measured for tracing but never changes the decision.
 */
export class BoundedGroundingStreamGate {
  private retained = "";
  private opened = false;
  private bounded = false;
  private startedAtMs: number | undefined;
  private settledAtMs: number | undefined;
  private maxRetained = 0;
  private trailingHighSurrogate = "";
  private readonly now: () => number;

  constructor(private readonly options: BoundedGroundingStreamGateOptions) {
    if (!Number.isInteger(options.maxRetainedCodePoints) || options.maxRetainedCodePoints <= 0) {
      throw new Error("grounding_stream_gate_bound_invalid");
    }
    this.now = options.now ?? Date.now;
  }

  get retainedCodePoints(): number {
    return Array.from(this.retained).length;
  }

  get maxObservedRetainedCodePoints(): number {
    return this.maxRetained;
  }

  get waitDurationMs(): number {
    if (this.startedAtMs === undefined) {
      return 0;
    }
    return Math.max(0, (this.settledAtMs ?? this.now()) - this.startedAtMs);
  }

  push(text: string): GroundingStreamGateDecision {
    if (this.bounded) {
      return { kind: "bound" };
    }
    if (text) {
      this.startedAtMs ??= this.now();
    }
    let completeText = this.trailingHighSurrogate + text;
    this.trailingHighSurrogate = "";
    const trailingCodeUnit = completeText.charCodeAt(completeText.length - 1);
    if (trailingCodeUnit >= 0xD800 && trailingCodeUnit <= 0xDBFF) {
      this.trailingHighSurrogate = completeText.slice(-1);
      completeText = completeText.slice(0, -1);
    }
    if (this.opened) {
      return { kind: "release", text: completeText };
    }
    if (!completeText) {
      return { kind: "hold" };
    }

    const available = this.options.maxRetainedCodePoints - this.retainedCodePoints;
    const incomingCodePoints = Array.from(completeText);
    const admitted = incomingCodePoints.slice(0, available).join("");
    const unadmitted = incomingCodePoints.slice(available).join("");
    this.retained += admitted;
    this.maxRetained = Math.max(this.maxRetained, this.retainedCodePoints);

    // Admission wins at the exact boundary. An assertion whose final code point
    // lies beyond the admitted prefix is deliberately invisible to this check.
    if (hasValidSourcedAssertion(this.retained, this.options.contextCount)) {
      this.opened = true;
      this.settledAtMs = this.now();
      const released = this.retained;
      this.retained = "";
      return { kind: "release", text: released + unadmitted };
    }

    if (this.retainedCodePoints >= this.options.maxRetainedCodePoints) {
      this.bounded = true;
      this.settledAtMs = this.now();
      this.retained = "";
      this.trailingHighSurrogate = "";
      return { kind: "bound" };
    }
    return { kind: "hold" };
  }

  finish(): GroundingStreamGateFinishDecision {
    if (!this.opened && !this.bounded) {
      this.settledAtMs = this.now();
    }
    this.retained = "";
    this.trailingHighSurrogate = "";
    return this.opened ? { kind: "open" } : { kind: "closed" };
  }
}
