import type { ChatCitation } from "../../../modules/chat/contracts/index.js";
import type {
  AgentConverseResourceDetail,
  AgentConverseResourceSummary,
} from "../../../modules/documents/contracts/index.js";
import type { AgentConverseGroundedAnswerResult } from "../../../modules/retrieval/public.js";

const toPublicCitation = (citation: ChatCitation): ChatCitation => ({
  documentId: "",
  chunkId: "",
  title: citation.title,
  ...(citation.sourceUrl ? { sourceUrl: citation.sourceUrl } : {}),
});

export const presentMcpConverseGroundedAnswer = (result: AgentConverseGroundedAnswerResult) => ({
  answer: result.answer,
  citations: Array.isArray(result.citations)
    ? (result.citations as ChatCitation[]).map(toPublicCitation)
    : [],
  retrieval: result.retrieval,
});

export const presentMcpConverseResourceList = (resources: AgentConverseResourceSummary[]) => ({
  resources: resources.map((resource) => ({
    uri: resource.uri,
    name: resource.name,
    mimeType: resource.mimeType,
  })),
});

export const presentMcpConverseResource = (resource: AgentConverseResourceDetail) => ({
  uri: resource.uri,
  name: resource.name,
  mimeType: resource.mimeType,
  text: resource.text,
});
