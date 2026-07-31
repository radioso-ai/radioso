import { resolveContextSourceUrl } from "../../retrieval/public.js";
import type { CitationEvidence } from "../contracts/answerTypes.js";
import type { PreparedSession } from "./chatSessionPreparer.js";

/**
 * Maps a prepared session's retrieved contexts into citation evidence, resolving
 * each context's source URL from its metadata. Shared by the presenter (final
 * citation display) and the grounded-answer support check so both reason over the
 * same evidence shape.
 */
export const toCitationEvidence = (session: PreparedSession): CitationEvidence[] =>
  session.retrieval.contexts.map((context) => {
    const sourceUrl = resolveContextSourceUrl(context.metadata);
    const evidence: CitationEvidence = {
      documentId: context.documentId,
      chunkId: context.chunkId,
      title: context.title,
      content: context.content,
    };
    if (sourceUrl) {
      evidence.sourceUrl = sourceUrl;
    }
    return evidence;
  });
