export type EventRetrievalFixtureShape = "event" | "article" | "profile" | "reference" | "generic";

export interface EventRetrievalFixtureChunk {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
}

export interface EventRetrievalFixtureDocument {
  id: string;
  title: string;
  shape: EventRetrievalFixtureShape;
  content: string;
  chunks: EventRetrievalFixtureChunk[];
}

export const eventRetrievalFixtureDocuments: EventRetrievalFixtureDocument[] = [
  {
    id: "11111111-1111-4111-8111-111111111101",
    title: "Summer Workshop",
    shape: "event",
    content: [
      "The Summer Workshop introduces practical repair skills for neighborhood volunteers.",
      "Participants should bring a notebook and comfortable shoes.",
      "The workshop takes place on August 10, 2026, at the civic hall.",
    ].join("\n\n"),
    chunks: [
      {
        id: "event-workshop-intro",
        content: "The Summer Workshop introduces practical repair skills for neighborhood volunteers.",
        metadata: { dateFrom: "2026-08-10", dateTo: "2026-08-10", shape: "event" },
      },
      {
        id: "event-workshop-date",
        content: "The workshop takes place on August 10, 2026, at the civic hall.",
        metadata: { dateFrom: "2026-08-10", dateTo: "2026-08-10", shape: "event" },
      },
    ],
  },
  {
    id: "11111111-1111-4111-8111-111111111102",
    title: "July Community Clinic",
    shape: "event",
    content: "The July Community Clinic is scheduled for July 5, 2026.",
    chunks: [
      {
        id: "event-clinic",
        content: "The July Community Clinic is scheduled for July 5, 2026.",
        metadata: { dateFrom: "2026-07-05", dateTo: "2026-07-05", shape: "event" },
      },
    ],
  },
  {
    id: "11111111-1111-4111-8111-111111111103",
    title: "September Open Studio",
    shape: "event",
    content: "The September Open Studio runs from September 20 to September 21, 2026.",
    chunks: [
      {
        id: "event-studio",
        content: "The September Open Studio runs from September 20 to September 21, 2026.",
        metadata: { dateFrom: "2026-09-20", dateTo: "2026-09-21", shape: "event" },
      },
    ],
  },
  {
    id: "11111111-1111-4111-8111-111111111104",
    title: "May Maker Fair",
    shape: "event",
    content: "The May Maker Fair happened on May 3, 2026.",
    chunks: [
      {
        id: "event-maker-fair",
        content: "The May Maker Fair happened on May 3, 2026.",
        metadata: { dateFrom: "2026-05-03", dateTo: "2026-05-03", shape: "event" },
      },
    ],
  },
  {
    id: "11111111-1111-4111-8111-111111111105",
    title: "Program Director Profile",
    shape: "profile",
    content: "A profile of the program director and their community work.",
    chunks: [
      {
        id: "profile-director",
        content: "A profile of the program director and their community work.",
        metadata: { shape: "profile" },
      },
    ],
  },
  {
    id: "11111111-1111-4111-8111-111111111106",
    title: "Volunteer Handbook",
    shape: "generic",
    content: "Reference material for volunteers without a date-bound event.",
    chunks: [
      {
        id: "generic-handbook",
        content: "Reference material for volunteers without a date-bound event.",
        metadata: { shape: "generic" },
      },
    ],
  },
];
