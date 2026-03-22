export interface RetrievalFixtureDocument {
  title: string;
  content: string;
}

export interface RetrievalFixtureQuery {
  query: string;
  expectedTitles: string[];
}

export const retrievalFixtureDocuments: Record<string, RetrievalFixtureDocument> = {
  rateLimits: {
    title: "Rate Limits",
    content:
      "The Hivec API allows 60 requests per minute per account token. If a client exceeds the limit, it should wait 30 seconds before retrying. Burst traffic should be smoothed with a queue.",
  },
  sessionCookie: {
    title: "Session Cookie",
    content:
      "Browser sessions use an HTTP-only cookie named radioso_session. The session cookie is used for registration, login, and token retrieval.",
  },
  vectorSearch: {
    title: "Vector Search",
    content:
      "The backend uses PostgreSQL 16 with the pgvector extension. Embeddings are stored with chunks and queried with vector similarity.",
  },
  retrievalSettings: {
    title: "Retrieval Settings",
    content:
      "Retrieval settings are account scoped. Defaults include vectorTopK 10, similarityThreshold 0.2, rerankTopK 5, query rewrite disabled, and rerank disabled.",
  },
  noisyNeighbor: {
    title: "Troubleshooting",
    content:
      "If chat cannot find relevant information, likely causes include no ingested documents, an overly strict similarity threshold, or a poor query match.",
  },
  exactIdentifier: {
    title: "Feature Flags",
    content:
      "Flag HVC-42-ALPHA enables the hybrid retrieval rollout path for internal testing environments.",
  },
  retreatEstonia: {
    title: "Summer Retreat Estonia",
    content:
      "Title: Summer Retreat Estonia. Summary: Four-day meditation retreat with lodging. Start date: 2026-06-12. End date: 2026-06-15. Price: 290 EUR. Location: Estonia.",
  },
  retreatLatvia: {
    title: "Summer Retreat Latvia",
    content:
      "Title: Summer Retreat Latvia. Summary: Four-day meditation retreat with lodging. Start date: 2026-06-12. End date: 2026-06-15. Price: 340 EUR. Location: Latvia.",
  },
};

export const directAnswerQueries: RetrievalFixtureQuery[] = [
  {
    query: "What is the API rate limit and how long should a client wait before retrying?",
    expectedTitles: ["Rate Limits"],
  },
  {
    query: "Which cookie name is used for browser sessions?",
    expectedTitles: ["Session Cookie"],
  },
  {
    query: "What does flag HVC-42-ALPHA enable?",
    expectedTitles: ["Feature Flags"],
  },
];

export const followUpQueries: RetrievalFixtureQuery[] = [
  {
    query: "What is it used for?",
    expectedTitles: ["Session Cookie"],
  },
];

export const noisyCorpusQueries: RetrievalFixtureQuery[] = [
  {
    query: "Which database extension is used for vector similarity search?",
    expectedTitles: ["Vector Search"],
  },
];

export const fallbackQueries: RetrievalFixtureQuery[] = [
  {
    query: "What is the capital of France?",
    expectedTitles: [],
  },
];

export const constraintQueries: RetrievalFixtureQuery[] = [
  {
    query: "Find retreats in Estonia under 300 EUR after 2026-06-10",
    expectedTitles: ["Summer Retreat Estonia"],
  },
];
