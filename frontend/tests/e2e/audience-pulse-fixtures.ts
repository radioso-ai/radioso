import type {
  AudiencePulseAnswerSummary,
  AudiencePulseContentGap,
  AudiencePulseHydratedReport,
  AudiencePulseRecommendation,
  AudiencePulseTheme,
  AudiencePulseThemeEvidence,
} from "@/lib/api-audience-pulse";

/*
 * Busy and quiet Audience Pulse reports for a made-up yoga studio, shaped like the approved
 * design's two months: one with thousands of questions across four channels, one with a couple
 * of hundred on a single channel where most topics sit under the sample floor.
 */

const DAY_MS = 86_400_000;
const periodStart = Date.parse("2026-10-20T06:00:00.000Z");
const period = { start: "2026-10-20T06:00:00.000Z", end: "2026-11-19T06:00:00.000Z" };
const previousPeriod = { start: "2026-09-20T06:00:00.000Z", end: "2026-10-20T06:00:00.000Z" };
const generatedAt = "2026-11-19T06:00:00.000Z";
const previousGeneratedAt = "2026-11-12T06:00:00.000Z";

type ExampleStatus = NonNullable<AudiencePulseThemeEvidence["answerStatus"]>;

interface TopicSpec {
  id: string;
  title: string;
  description: string;
  questions: number;
  answered: number;
  noAnswer: number;
  /** Share change in points against the previous report; omitted for a new topic. */
  delta?: number;
  emerged?: boolean;
  examples?: Array<[question: string, asked: number, status: ExampleStatus]>;
}

const topicIds = new Map<string, string>();
/** The UUID a fixture topic is saved under, stable for its slug. */
export const fixtureTopicId = (slug: string): string => {
  if (!topicIds.has(slug)) {
    topicIds.set(slug, `ffffffff-ffff-4fff-8fff-${String(topicIds.size + 1).padStart(12, "0")}`);
  }
  return topicIds.get(slug)!;
};

let uuidCounter = 0;
const uuid = (prefix: string) => {
  uuidCounter += 1;
  return `${prefix}-${prefix.slice(0, 4)}-4${prefix.slice(0, 3)}-8${prefix.slice(0, 3)}-${String(uuidCounter).padStart(12, "0")}`;
};

/** Everything not answered and not the content gap, shared out across the other buckets. */
const answersFor = (spec: TopicSpec): AudiencePulseAnswerSummary => {
  const rest = spec.questions - spec.answered - spec.noAnswer;
  const outOfScope = Math.round(rest * 0.3);
  const notAssessed = Math.round(rest * 0.15);
  return {
    answered: spec.answered,
    partial: rest - outOfScope - notAssessed,
    unanswered: spec.noAnswer,
    unclear: 0,
    outOfScope,
    notAssessed,
  };
};

const weeklyFor = (spec: TopicSpec) => {
  const shape = spec.emerged
    ? [0.07, 0.2, 0.33, 0.4]
    : (spec.delta ?? 0) >= 2
      ? [0.21, 0.24, 0.26, 0.29]
      : (spec.delta ?? 0) <= -1 ? [0.28, 0.26, 0.24, 0.22] : [0.25, 0.26, 0.24, 0.25];
  return shape.map((part, index) => ({
    weekStart: new Date(periodStart + index * 7 * DAY_MS).toISOString(),
    count: Math.round(part * spec.questions),
  }));
};

const themeFor = (spec: TopicSpec, totalQuestions: number): AudiencePulseTheme => {
  const share = spec.questions / totalQuestions;
  return {
    id: fixtureTopicId(spec.id),
    title: spec.title,
    description: spec.description,
    memberCount: spec.questions,
    previousMemberCount: spec.emerged ? null : spec.questions,
    previousShare: spec.emerged || spec.delta === undefined ? null : share - spec.delta / 100,
    transition: spec.emerged
      ? { kind: "emerged", parentTopicIds: [], viaCentroidFallback: false }
      : { kind: "survived", parentTopicIds: [fixtureTopicId(spec.id)], viaCentroidFallback: false },
    share,
    distinctQuestionCount: Math.round(spec.questions * 0.6),
    weeklyPulse: weeklyFor(spec),
    grounding: { grounded: spec.answered, degraded: 0, noSupport: spec.noAnswer, unknown: 0, contentGapEligible: spec.noAnswer },
    answers: answersFor(spec),
    evidence: (spec.examples ?? []).map(([question, asked, status], index) => ({
      reference: `${spec.id}-ev-${index + 1}`,
      conversationId: uuid("aaaaaaaa"),
      messageId: uuid("bbbbbbbb"),
      question,
      questionPhotoCount: 0,
      occurrenceCount: asked,
      answerStatus: status,
    })),
  };
};

const sumAnswers = (all: AudiencePulseAnswerSummary[]): AudiencePulseAnswerSummary => ({
  answered: all.reduce((sum, a) => sum + a.answered, 0),
  partial: all.reduce((sum, a) => sum + a.partial, 0),
  unanswered: all.reduce((sum, a) => sum + a.unanswered, 0),
  unclear: all.reduce((sum, a) => sum + a.unclear, 0),
  outOfScope: all.reduce((sum, a) => sum + a.outOfScope, 0),
  notAssessed: all.reduce((sum, a) => sum + a.notAssessed, 0),
});

/** Thirty UTC days that add up to the window's totals, with a gentle weekly rhythm. */
const dailyVolumeFor = (questions: number, conversations: number, answered: number, noAnswer: number) => {
  const weights = Array.from({ length: 30 }, (_, day) => 1 + 0.25 * Math.sin(day / 1.3) + day * 0.01);
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const spread = (total: number, wobble: number) => {
    const values = weights.map((weight, day) => Math.round((total * weight * (1 + wobble * Math.cos(day * 2.1))) / weightSum));
    values[values.length - 1] += total - values.reduce((sum, value) => sum + value, 0);
    return values;
  };
  const questionDays = spread(questions, 0);
  const conversationDays = spread(conversations, 0.05);
  const answeredDays = spread(answered, 0.06).map((value, day) => Math.min(value, questionDays[day]));
  const noAnswerDays = spread(noAnswer, 0.2).map((value, day) => Math.min(value, questionDays[day] - answeredDays[day]));
  return questionDays.map((questionCount, day) => ({
    day: new Date(periodStart + day * DAY_MS).toISOString().slice(0, 10),
    questionCount,
    conversationCount: conversationDays[day],
    answeredCount: answeredDays[day],
    contentGapEligibleCount: Math.max(0, noAnswerDays[day]),
  }));
};

interface ReportSpec {
  summary: string;
  topics: TopicSpec[];
  unclassified: { questions: number; answers: AudiencePulseAnswerSummary; noAnswer: number };
  conversations: number;
  previous: { questions: number; conversations: number; answered: number; noAnswer: number };
  channels: Array<{ channel: string | null; share: number; answeredRate: number }>;
  gaps: Array<{ topicId: string; conversations: number; draftedAt?: string; dismissedAt?: string }>;
  recommendations: Array<Pick<AudiencePulseRecommendation, "themeId" | "title" | "rationale" | "questions">>;
  dissolved: string[];
}

const reportFor = (spec: ReportSpec): AudiencePulseHydratedReport => {
  const questionCount = spec.topics.reduce((sum, topic) => sum + topic.questions, 0) + spec.unclassified.questions;
  const themes = spec.topics.map((topic) => themeFor(topic, questionCount));
  const answers = sumAnswers([...themes.map((theme) => theme.answers!), spec.unclassified.answers]);
  const noAnswer = spec.topics.reduce((sum, topic) => sum + topic.noAnswer, 0) + spec.unclassified.noAnswer;

  let assignedQuestions = 0;
  let assignedAnswered = 0;
  const channels = spec.channels.map((channel, index) => {
    const last = index === spec.channels.length - 1;
    const channelQuestions = last ? questionCount - assignedQuestions : Math.round(questionCount * channel.share);
    const channelAnswered = last
      ? answers.answered - assignedAnswered
      : Math.round(channelQuestions * channel.answeredRate);
    assignedQuestions += channelQuestions;
    assignedAnswered += channelAnswered;
    return {
      channel: channel.channel,
      questionCount: channelQuestions,
      answeredCount: channelAnswered,
      contentGapEligibleCount: Math.round(noAnswer * channel.share),
    };
  });

  const contentGaps: AudiencePulseContentGap[] = spec.gaps.map((gap) => ({
    themeId: fixtureTopicId(gap.topicId),
    eligibleEvidenceCount: spec.topics.find((topic) => topic.id === gap.topicId)!.noAnswer,
    distinctConversationCount: gap.conversations,
    dismissedAt: gap.dismissedAt ?? null,
    latestDraft: gap.draftedAt ? { documentId: uuid("cccccccc"), createdAt: gap.draftedAt } : null,
  }));

  return {
    period,
    generatedAt,
    isFirstCensus: false,
    narrativeGeneratedAt: generatedAt,
    narrativeReuseCount: 0,
    narrativeReuseMaxDrift: 0.2,
    coverage: { populationSize: questionCount, sampleSize: questionCount, sampled: false, facetReadyQuestionCount: questionCount },
    weeklyVolume: [],
    summary: spec.summary,
    dissolvedTopics: spec.dissolved.map((title, index) => ({ id: `dissolved-${index + 1}`, title })),
    themes,
    contentGaps,
    recommendations: spec.recommendations.map((recommendation) => ({
      ...recommendation,
      themeId: fixtureTopicId(recommendation.themeId),
      id: `rec-${recommendation.themeId}`,
      evidenceReferences: [],
      startDraft: { title: recommendation.title, questions: recommendation.questions },
    })),
    caveats: [
      "Questions from test chats are left out.",
      "Answered means the reply covered the question from your documents or skills.",
      "Topics group questions by meaning across languages. Names can change between runs.",
    ],
    unclassifiedQuestionCount: spec.unclassified.questions,
    totals: {
      questionCount,
      conversationCount: spec.conversations,
      answers,
      contentGapEligibleCount: noAnswer,
      unclassified: {
        questionCount: spec.unclassified.questions,
        answers: spec.unclassified.answers,
        contentGapEligibleCount: spec.unclassified.noAnswer,
      },
    },
    dailyVolume: dailyVolumeFor(questionCount, spec.conversations, answers.answered, noAnswer),
    previousPeriod: {
      period: previousPeriod,
      questionCount: spec.previous.questions,
      conversationCount: spec.previous.conversations,
      answeredCount: spec.previous.answered,
      contentGapEligibleCount: spec.previous.noAnswer,
    },
    channels,
    previousGeneratedAt,
  };
};

export const busyReport: AudiencePulseHydratedReport = reportFor({
  summary:
    "Visitors asked mostly about class times, retreat dates and prices. Getting to the retreat centre is a new topic, and 37% of its questions had no answer in your content.",
  conversations: 4480,
  previous: { questions: 10203, conversations: 4110, answered: 7020, noAnswer: 1180 },
  topics: [
    {
      id: "schedule", title: "Class schedule and timetable", description: "When classes run, at which studio, and with which teacher.",
      questions: 1848, answered: 1626, noAnswer: 21, delta: -1,
      examples: [
        ["What time is the Saturday morning vinyasa class?", 64, "answered"],
        ["Ci sono lezioni la sera dopo le 19?", 41, "answered"],
        ["Is the Thursday yin class still on in December?", 22, "partial"],
        ["Gibt es Kurse am Sonntagvormittag?", 18, "answered"],
        ["Do you have lunchtime classes on weekdays?", 12, "answered"],
        ["Is there a class on bank holidays?", 9, "unanswered"],
        ["Can I see next month's timetable?", 7, "answered"],
      ],
    },
    { id: "retreat-dates", title: "Retreat dates and availability", description: "Upcoming retreat dates, how long they run, and whether places are left.", questions: 1563, answered: 1157, noAnswer: 41, delta: 3 },
    { id: "prices", title: "Prices and memberships", description: "Class passes, monthly memberships and retreat prices.", questions: 1421, answered: 1151, noAnswer: 38, delta: -1 },
    {
      id: "training", title: "Teacher training", description: "The 200-hour training: curriculum, schedule, certification and fees.",
      questions: 1137, answered: 659, noAnswer: 233, delta: 2,
      examples: [
        ["Is the 200-hour training Yoga Alliance certified?", 48, "unanswered"],
        ["What does a typical training day look like?", 33, "partial"],
        ["Il corso insegnanti è in inglese o in italiano?", 27, "unanswered"],
      ],
    },
    { id: "booking", title: "Booking and cancellation", description: "Booking classes and retreats, changing a booking, and refunds.", questions: 995, answered: 786, noAnswer: 44, delta: -2 },
    {
      id: "getting-there", title: "Getting to the retreat centre", description: "Transfers, directions and parking at the retreat centre.",
      questions: 853, answered: 350, noAnswer: 318, emerged: true,
      examples: [
        ["Is there a shuttle from the airport to the retreat centre?", 46, "unanswered"],
        ["Come arrivo al centro dalla stazione?", 31, "unanswered"],
        ["Gibt es Parkplätze am Retreat-Zentrum?", 22, "partial"],
      ],
    },
    { id: "beginners", title: "Beginners and levels", description: "Which classes suit beginners and how levels work.", questions: 711, answered: 640, noAnswer: 9, delta: -2 },
    { id: "rooms", title: "Accommodation and rooms", description: "Room types at the retreat centre and what's included.", questions: 569, answered: 353, noAnswer: 142, delta: 1 },
    { id: "food", title: "Food and dietary needs", description: "Meals during retreats and dietary requirements.", questions: 426, answered: 234, noAnswer: 121, delta: 0 },
    { id: "vouchers", title: "Gift vouchers", description: "Buying and redeeming gift vouchers.", questions: 412, answered: 346, noAnswer: 12, delta: -1 },
    { id: "visas", title: "Visas and travel documents", description: "Visas and invitation letters for trainees coming from abroad.", questions: 284, answered: 119, noAnswer: 98, delta: 1 },
    { id: "online", title: "Online classes and replays", description: "Live-streamed classes, replays and how long access lasts.", questions: 210, answered: 126, noAnswer: 24, delta: 2 },
    { id: "kids", title: "Kids and family classes", description: "Ages, times and prices for children and families.", questions: 196, answered: 114, noAnswer: 34, delta: 1 },
    { id: "parking", title: "Parking near the city studio", description: "Where to park and what it costs.", questions: 118, answered: 59, noAnswer: 22, emerged: true },
  ],
  unclassified: {
    questions: 711,
    answers: { answered: 448, partial: 90, unanswered: 80, unclear: 13, outOfScope: 50, notAssessed: 30 },
    noAnswer: 20,
  },
  channels: [
    { channel: "website_embed", share: 0.58, answeredRate: 0.745 },
    { channel: "slack", share: 0.24, answeredRate: 0.7 },
    { channel: "anonymous", share: 0.11, answeredRate: 0.67 },
    // The last channel takes what is left, about 56% answered against 71% overall.
    { channel: "voice", share: 0.07, answeredRate: 0 },
  ],
  gaps: [
    { topicId: "getting-there", conversations: 204 },
    { topicId: "training", conversations: 171 },
    { topicId: "rooms", conversations: 118, draftedAt: "2026-11-12T09:30:00.000Z" },
    { topicId: "food", conversations: 97 },
    { topicId: "visas", conversations: 80 },
    { topicId: "kids", conversations: 29 },
    { topicId: "parking", conversations: 19 },
  ],
  recommendations: [
    {
      themeId: "getting-there",
      title: "Directions and transfers to the retreat centre",
      rationale: "New this month. Visitors ask how to get there from the airport and the station, and your documents say nothing about transfers.",
      questions: [
        "Is there a shuttle from the airport?",
        "How do I get there from the train station?",
        "Is there parking at the centre?",
        "How long is the taxi ride from the nearest town?",
        "Can I arrive the evening before the retreat starts?",
      ],
    },
    {
      themeId: "training",
      title: "Teacher training: curriculum and certification",
      rationale: "The training page gives dates and price, but not certification, teaching language, or what a training day looks like.",
      questions: ["Is the training Yoga Alliance certified?", "Which language is it taught in?", "What does a training day look like?"],
    },
    {
      themeId: "rooms",
      title: "Room types and what's included",
      rationale: "Visitors ask about single rooms, private bathrooms and linen.",
      questions: ["Are there single rooms?", "Do rooms have a private bathroom?", "Are towels and bed linen provided?"],
    },
    {
      themeId: "food",
      title: "Meals, allergies and dietary options",
      rationale: "The menu is described, but not allergies or gluten-free meals.",
      questions: ["Can the kitchen cater for a nut allergy?", "Are there gluten-free meals?"],
    },
    {
      themeId: "visas",
      title: "Visas and invitation letters for trainees",
      rationale: "Trainees from abroad ask whether they need a visa and whether you send invitation letters.",
      questions: ["Do I need a visa for the training?", "Can you send an invitation letter?"],
    },
  ],
  dissolved: ["Summer workshop series", "Studio reopening"],
});

export const quietReport: AudiencePulseHydratedReport = reportFor({
  summary:
    "Most visitors asked about class times and prices. Parking and getting to the studio is new this month, and 8 of its 26 questions had no answer in your content.",
  conversations: 84,
  previous: { questions: 183, conversations: 74, answered: 139, noAnswer: 13 },
  topics: [
    { id: "q-schedule", title: "Class schedule and timetable", description: "When classes run and with which teacher.", questions: 52, answered: 47, noAnswer: 1, delta: 2 },
    { id: "q-prices", title: "Prices and memberships", description: "Class passes and monthly memberships.", questions: 38, answered: 32, noAnswer: 1, delta: -1 },
    { id: "q-beginners", title: "Beginners and levels", description: "Which classes suit beginners.", questions: 30, answered: 26, noAnswer: 0, delta: 0 },
    {
      id: "q-parking", title: "Parking and getting to the studio", description: "Where to park and how to find the entrance.",
      questions: 26, answered: 13, noAnswer: 8, emerged: true,
      examples: [
        ["Where can I park near the studio?", 6, "unanswered"],
        ["Which door is the studio entrance?", 4, "unanswered"],
        ["Is there a bus stop close by?", 3, "partial"],
      ],
    },
    { id: "q-booking", title: "Booking and cancellation", description: "Booking, changing and cancelling a class.", questions: 22, answered: 17, noAnswer: 2, delta: 1 },
    { id: "q-private", title: "Private sessions", description: "One-to-one classes and their prices.", questions: 16, answered: 11, noAnswer: 1, delta: -1 },
    { id: "q-vouchers", title: "Gift vouchers", description: "Buying and redeeming gift vouchers.", questions: 12, answered: 10, noAnswer: 0, delta: -1 },
    { id: "q-training", title: "Teacher training", description: "The teacher training course.", questions: 6, answered: 3, noAnswer: 0, delta: -2 },
  ],
  unclassified: {
    questions: 10,
    answers: { answered: 6, partial: 2, unanswered: 0, unclear: 0, outOfScope: 1, notAssessed: 1 },
    noAnswer: 0,
  },
  channels: [{ channel: "website_embed", share: 1, answeredRate: 0.78 }],
  gaps: [{ topicId: "q-parking", conversations: 6 }],
  recommendations: [
    {
      themeId: "q-parking",
      title: "Parking and directions to the studio",
      rationale: "New this month. Visitors ask where to park and how to find the entrance.",
      questions: ["Where can I park near the studio?", "Which door is the studio entrance?", "Is there a bus stop close by?"],
    },
  ],
  dissolved: ["Summer timetable"],
});
