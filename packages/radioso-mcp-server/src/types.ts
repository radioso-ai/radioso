export type JsonPrimitive = string | number | boolean | null;
export type JsonRecord = Record<string, JsonPrimitive>;

export interface DocumentListResult {
  documents?: unknown[];
  [key: string]: unknown;
}

export interface RetrievalSettingsRecord {
  queryRewriteEnabled: boolean;
  semanticRewriteInstructions: string;
  lexicalRewriteInstructions: string;
  answerSupportPolicy: "strict" | "warn" | "off";
  conversationMode: "factual" | "guided" | "exploratory";
  suggestedQuestionsEnabled: boolean;
  suggestedQuestionsCount: number;
  rerankEnabled: boolean;
  vectorTopK: number;
  similarityThreshold: number;
  rerankTopK: number;
  citationDisplayEnabled: boolean;
  metadataRules: Array<{
    id: string;
    field: string;
    valueType: "string" | "number" | "date" | "boolean";
    operator: "equals" | "not_equals" | "contains" | "not_contains" | "lt" | "lte" | "gt" | "gte";
    value: string;
    effect: "boost" | "filter";
    enabled: boolean;
  }>;
  customInstruction: string;
  [key: string]: unknown;
}

export interface ToolExecutionResult {
  summary: string;
  data: unknown;
}

export interface ToolDefinition<TArgs = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: any;
  execute: (args: TArgs) => Promise<ToolExecutionResult>;
}
