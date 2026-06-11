import type { RetrievedCandidate } from "../../src/modules/retrieval/public.js";

export const yogaSenseMetadata = {
  hatha: {
    subject: "Hatha yoga",
    tradition: "physical posture and breath practice",
    language: "en",
  },
  raja: {
    subject: "Raja yoga",
    tradition: "meditation and mental discipline",
    language: "en",
  },
  spanishHatha: {
    subject: "Hatha yoga",
    tradition: "posturas fisicas y respiracion",
    language: "es",
  },
} as const;

const candidate = (input: {
  chunkId: string;
  documentId: string;
  title: string;
  similarity: number;
  metadata: Record<string, unknown>;
}): RetrievedCandidate => ({
  chunkId: input.chunkId,
  documentId: input.documentId,
  title: input.title,
  content: `Fixture content for ${input.title}`,
  similarity: input.similarity,
  retrievalSources: ["semantic_rewritten"],
  retrievalText: `${input.title} fixture retrieval text`,
  semanticScore: input.similarity,
  lexicalScore: 0,
  attributeMatchScore: 0,
  metadata: input.metadata,
});

export const hathaRajaYogaCandidates = (): RetrievedCandidate[] => [
  candidate({
    chunkId: "hatha-1",
    documentId: "doc-hatha",
    title: "Hatha Yoga Foundations",
    similarity: 0.94,
    metadata: yogaSenseMetadata.hatha,
  }),
  candidate({
    chunkId: "raja-1",
    documentId: "doc-raja",
    title: "Raja Yoga Meditation",
    similarity: 0.92,
    metadata: yogaSenseMetadata.raja,
  }),
  candidate({
    chunkId: "hatha-2",
    documentId: "doc-hatha",
    title: "Hatha Yoga Foundations",
    similarity: 0.89,
    metadata: yogaSenseMetadata.hatha,
  }),
  candidate({
    chunkId: "raja-2",
    documentId: "doc-raja",
    title: "Raja Yoga Meditation",
    similarity: 0.87,
    metadata: yogaSenseMetadata.raja,
  }),
  candidate({
    chunkId: "spanish-hatha-1",
    documentId: "doc-hatha-es",
    title: "Guia de Hatha Yoga",
    similarity: 0.52,
    metadata: yogaSenseMetadata.spanishHatha,
  }),
];

export const dominantHathaYogaCandidates = (): RetrievedCandidate[] => [
  candidate({
    chunkId: "hatha-1",
    documentId: "doc-hatha",
    title: "Hatha Yoga Foundations",
    similarity: 0.94,
    metadata: yogaSenseMetadata.hatha,
  }),
  candidate({
    chunkId: "hatha-2",
    documentId: "doc-hatha",
    title: "Hatha Yoga Foundations",
    similarity: 0.9,
    metadata: yogaSenseMetadata.hatha,
  }),
  candidate({
    chunkId: "hatha-3",
    documentId: "doc-hatha",
    title: "Hatha Yoga Foundations",
    similarity: 0.86,
    metadata: yogaSenseMetadata.hatha,
  }),
  candidate({
    chunkId: "raja-1",
    documentId: "doc-raja",
    title: "Raja Yoga Meditation",
    similarity: 0.81,
    metadata: yogaSenseMetadata.raja,
  }),
];
