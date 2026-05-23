export interface WizardAnalysisResult {
  suggestedName: string;
  suggestedCustomInstruction: string;
  suggestedGreetingMessage: string;
  suggestedChunkingStrategy: {
    strategy: "fixed_window" | "structured_semantic";
    reasoning: string;
  };
  screenshotBase64: string | null;
  screenshotUnavailableReason: string | null;
  faviconUrl: string | null;
  pagesAnalyzed: Array<{ url: string; title: string | null }>;
  sourceUrl: string;
}

export type WizardProgressStep = "crawling" | "analyzing" | "generating" | "complete";

export interface WizardProgressEvent {
  type: "progress";
  step: WizardProgressStep;
  page?: number;
  total?: number;
  url?: string;
  title?: string | null;
}

export interface WizardCreateInput {
  websiteUrl: string;
  name: string;
  customInstruction?: string;
  greetingInstruction?: string;
  chunkingStrategy?: "fixed_window" | "structured_semantic";
  faviconUrl?: string | null;
}

export interface WizardCreateResult {
  agentId: string;
  crawlJobId: string | null;
}

export type WizardStep = "url-input" | "analyzing" | "creating";
