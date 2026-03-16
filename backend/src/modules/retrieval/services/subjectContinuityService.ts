import type {
  SubjectConvergenceMetrics,
  SubjectReference,
  SubjectReuseState,
} from "../domain/retrievalPipelineTypes.js";

const matches = (left: SubjectReference | null | undefined, right: SubjectReference | null | undefined): boolean =>
  Boolean(left && right && left.normalizedKey === right.normalizedKey);

export class SubjectContinuityService {
  decide(input: {
    previous: SubjectReuseState | null;
    raw: SubjectConvergenceMetrics;
    biased: SubjectConvergenceMetrics;
    explicitCurrentSubject?: SubjectReference | null;
    selfContained: boolean;
    turnId: string;
  }): SubjectReuseState {
    if (input.raw.isComparative || input.biased.isComparative) {
      return {
        resolvedSubject: null,
        resolutionOutcome: input.previous ? "cleared" : "unresolved",
        resolutionConfidence: 0,
        resolutionSourceTurnId: input.turnId,
        resolutionEvidence: {
          ...input.raw,
          agreementAcrossPaths: false,
          isAmbiguous: true,
        },
        stateVersion: 1,
      };
    }

    const disagreement =
      input.raw.winningSubject &&
      input.biased.winningSubject &&
      !matches(input.raw.winningSubject, input.biased.winningSubject);

    const explicit = input.explicitCurrentSubject ?? null;
    const previousSubject = input.previous?.resolvedSubject ?? null;
    const chosen =
      explicit ??
      input.raw.winningSubject ??
      (!input.selfContained && !disagreement ? input.biased.winningSubject : null) ??
      null;

    const resolutionOutcome = this.outcome({
      previous: previousSubject,
      chosen,
      rawAmbiguous: input.raw.isAmbiguous,
      selfContained: input.selfContained,
      disagreement,
    });

    const evidence = {
      ...(chosen && matches(chosen, input.biased.winningSubject) && input.biased.scoreMass > input.raw.scoreMass
        ? input.biased
        : input.raw),
      agreementAcrossPaths: !disagreement && Boolean(input.raw.winningSubject || input.biased.winningSubject),
    };

    return {
      resolvedSubject: resolutionOutcome === "cleared" || resolutionOutcome === "unresolved" ? null : chosen,
      resolutionOutcome,
      resolutionConfidence: Math.max(0, Math.min(1, evidence.scoreMass)),
      resolutionSourceTurnId: input.turnId,
      resolutionEvidence: evidence,
      stateVersion: 1,
    };
  }

  private outcome(input: {
    previous: SubjectReference | null;
    chosen: SubjectReference | null;
    rawAmbiguous: boolean;
    selfContained: boolean;
    disagreement: boolean;
  }): SubjectReuseState["resolutionOutcome"] {
    if (!input.chosen) {
      return input.previous && (input.rawAmbiguous || input.selfContained || input.disagreement) ? "cleared" : "unresolved";
    }

    if (!input.previous) {
      return "newly_established";
    }

    if (matches(input.previous, input.chosen)) {
      return "reused";
    }

    return "replaced";
  }
}
