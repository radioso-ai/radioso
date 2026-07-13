import type { EvalAssertion } from "../../../src/modules/eval/domain/types.js";
import { eventRetrievalFixtureDocuments } from "./event-corpus.js";

export { eventRetrievalFixtureDocuments } from "./event-corpus.js";

export interface EventRetrievalEvalCaseDefinition {
  id: string;
  name: string;
  query: string;
  assertions: EvalAssertion[];
}

export const eventRetrievalEvalCases: EventRetrievalEvalCaseDefinition[] = [
  {
    id: "event-date-cross-paragraph",
    name: "Named event date from a later paragraph",
    query: "When does the Summer Workshop take place?",
    assertions: [
      {
        type: "retrieval_includes_document",
        documentId: "11111111-1111-4111-8111-111111111101",
      },
      {
        type: "retrieval_chunk_metadata",
        documentId: "11111111-1111-4111-8111-111111111101",
        metadata: { dateFrom: "2026-08-10", dateTo: "2026-08-10" },
      },
    ],
  },
  {
    id: "event-next-events-listing",
    name: "Anchorless next events listing",
    query: "What are the next events?",
    assertions: [
      {
        type: "retrieval_excludes_document",
        documentId: "11111111-1111-4111-8111-111111111104",
      },
      {
        type: "retrieval_document_order",
        documentIds: [
          "11111111-1111-4111-8111-111111111102",
          "11111111-1111-4111-8111-111111111101",
          "11111111-1111-4111-8111-111111111103",
        ],
      },
    ],
  },
  {
    id: "event-actuality-sort",
    name: "Sort events by actuality",
    query: "Sort events by actuality.",
    assertions: [
      {
        type: "retrieval_document_order",
        documentIds: [
          "11111111-1111-4111-8111-111111111102",
          "11111111-1111-4111-8111-111111111101",
          "11111111-1111-4111-8111-111111111103",
        ],
      },
      {
        type: "retrieval_chunk_metadata",
        documentId: "11111111-1111-4111-8111-111111111103",
        metadata: { dateFrom: "2026-09-20", dateTo: "2026-09-21" },
      },
    ],
  },
];

export const eventRetrievalEvalFixtureDocumentIds = eventRetrievalFixtureDocuments.map((document) => document.id);
