export interface ParsedQueryInterpretation {
  originalQuery?: string;
  semanticQuery: string;
  lexicalQuery: string;
}

export interface AppliedConstraint {
  signalKey: string;
  mode: "boost_only" | "hard_filter";
  outcome: "applied" | "relaxed" | "skipped";
  summary: string;
}
