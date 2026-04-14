export interface ParsedQueryConstraint {
  signalKey: string;
  operator: string;
  confidence: number;
  summary: string;
  sourceText: string;
  value: Record<string, unknown>;
}

export interface ParsedQueryInterpretation {
  originalQuery?: string;
  semanticQuery: string;
  lexicalQuery: string;
  constraints: ParsedQueryConstraint[];
}

export interface AppliedConstraint {
  signalKey: string;
  mode: "boost_only" | "hard_filter";
  outcome: "applied" | "relaxed" | "skipped";
  summary: string;
}
