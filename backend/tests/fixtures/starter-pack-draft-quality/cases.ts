import { z } from "zod";

import { defaultAnswerDirectives } from "../../../src/modules/directives/public.js";

/** A built-in directive name, which a drafted pack may never reuse. */
const reservedDirectiveName = defaultAnswerDirectives[0].name;

/**
 * Starter pack draft-quality cases. Each case replays recorded model completions through the real
 * draft path (language detector, pack generator, routine draft assist, draft service), so the
 * suite is deterministic and runs in normal CI. See README.md.
 */
export interface StarterPackDraftQualityCase {
  id: string;
  name: string;
  tags: string[];
  purpose: string;
  /** Raw completion of the language-detection call. */
  detectorAnswer: string;
  /** The language the draft must be written in, or null when detection gives no usable answer. */
  expectedLanguage: string | null;
  existingDirectiveNames?: string[];
  existingRoutineNames?: string[];
  /** Raw completions of the pack-drafting call, in call order (a second one is the JSON retry). */
  recordedDraftOutputs: string[];
  /** Raw completions of the routine draft-assist call, in call order. */
  recordedRoutineOutputs: string[];
  expectedOutcome: "draft" | "invalid_starter_pack_draft";
}

const caseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/u),
  name: z.string().min(1),
  tags: z.array(z.string().min(1)),
  purpose: z.string().min(1),
  detectorAnswer: z.string(),
  expectedLanguage: z.string().min(1).nullable(),
  existingDirectiveNames: z.array(z.string()).optional(),
  existingRoutineNames: z.array(z.string()).optional(),
  recordedDraftOutputs: z.array(z.string()).min(1).max(2),
  recordedRoutineOutputs: z.array(z.string()),
  expectedOutcome: z.enum(["draft", "invalid_starter_pack_draft"]),
}).strict();

export const parseStarterPackDraftQualityCases = (cases: unknown): StarterPackDraftQualityCase[] => {
  const parsed = z.array(caseSchema).parse(cases);
  const ids = parsed.map((entry) => entry.id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) {
    throw new Error(`Duplicate starter pack draft-quality case id: ${duplicate}`);
  }
  return parsed;
};

const pack = (directives: Array<{ name: string; action: string; when?: string }>, routine: { name: string; procedure: string }) =>
  JSON.stringify({
    directives: directives.map((directive) => ({
      name: directive.name,
      condition: directive.when ? { kind: "contextual", description: directive.when } : { kind: "always" },
      action: directive.action,
      tags: [],
      surfaces: [],
    })),
    routine,
  });

/** A routine draft-assist completion with one collected value, as the routine prompt asks for. */
const routineCompletion = (texts: { trigger: string; slot: string; ask: string; confirm: string; askLabel: string }) =>
  JSON.stringify({
    draft: {
      name: "assist-chosen-name",
      activation: { triggerDescription: texts.trigger, gateRef: null, priority: 0 },
      slots: [{ stableSlotId: "preferred_date", key: "preferred_date", type: "text", required: true, description: texts.slot, ordinal: 0 }],
      steps: [{
        stableStepId: "ask_date",
        kind: "chat",
        instruction: `${texts.ask} {{slot.preferred_date}}`,
        toolRef: null,
        actionType: null,
        ordinal: 0,
        metadata: { outlineLabel: texts.askLabel },
      }],
      transitions: [{ fromStep: "ask_date", toRef: "done", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 0 }],
      terminals: [{ stableStepId: "done", kind: "complete", instruction: `${texts.confirm} {{slot.preferred_date}}`, ordinal: 0 }],
    },
  });

export const starterPackDraftQualityCases: StarterPackDraftQualityCase[] = [
  {
    id: "en-dental-booking",
    name: "English purpose drafts English directives and a booking routine",
    tags: ["english"],
    purpose: "Help visitors of our dental clinic book, move, or cancel appointments and answer questions about opening hours.",
    detectorAnswer: '{"responseLanguage":"English"}',
    expectedLanguage: "English",
    recordedDraftOutputs: [pack(
      [
        { name: "confirm-appointment-details", when: "The visitor is booking, moving, or cancelling an appointment.", action: "Repeat the date, time, and treatment back and ask the visitor to confirm before finishing." },
        { name: "no-medical-diagnosis", action: "Do not diagnose symptoms. Offer to book an appointment with a dentist instead." },
      ],
      { name: "book-appointment", procedure: "Ask for the preferred date, then confirm the booking." },
    )],
    recordedRoutineOutputs: [routineCompletion({
      trigger: "The visitor wants to book an appointment.",
      slot: "Preferred appointment date",
      ask: "Ask for the preferred date:",
      confirm: "Confirm the booking for",
      askLabel: "Ask for date",
    })],
    expectedOutcome: "draft",
  },
  {
    id: "de-dental-booking",
    name: "German purpose drafts German directives and a German routine",
    tags: ["german"],
    purpose: "Hilf Besuchern unserer Zahnarztpraxis, Termine zu buchen, zu verschieben oder abzusagen.",
    detectorAnswer: '{"responseLanguage":"German"}',
    expectedLanguage: "German",
    recordedDraftOutputs: [pack(
      [
        { name: "termindetails-bestaetigen", action: "Wiederhole Datum und Uhrzeit und bitte um Bestätigung, bevor du abschließt." },
        { name: "keine-diagnosen", action: "Stelle keine Diagnosen, sondern biete einen Termin an." },
      ],
      { name: "termin-buchen", procedure: "Frage nach dem Wunschtermin und bestätige die Buchung." },
    )],
    recordedRoutineOutputs: [routineCompletion({
      trigger: "Der Besucher möchte einen Termin buchen.",
      slot: "Wunschtermin",
      ask: "Frage nach dem Wunschtermin:",
      confirm: "Bestätige die Buchung für",
      askLabel: "Termin erfragen",
    })],
    expectedOutcome: "draft",
  },
  {
    id: "ja-restaurant-reservation",
    name: "Japanese purpose drafts Japanese text with ASCII identifiers",
    tags: ["japanese"],
    purpose: "レストランの予約受付を手伝い、営業時間についての質問に答えてください。",
    detectorAnswer: '{"responseLanguage":"Japanese"}',
    expectedLanguage: "Japanese",
    recordedDraftOutputs: [pack(
      [{ name: "confirm-reservation", action: "予約の日時と人数を復唱し、確定する前に確認してください。" }],
      { name: "reserve-table", procedure: "希望の日付を尋ね、予約を確定します。" },
    )],
    recordedRoutineOutputs: [routineCompletion({
      trigger: "訪問者が予約をしたいとき。",
      slot: "希望の日付",
      ask: "希望の日付を尋ねてください:",
      confirm: "次の日付で予約を確定してください:",
      askLabel: "日付を尋ねる",
    })],
    expectedOutcome: "draft",
  },
  {
    id: "es-retry-after-prose",
    name: "A prose answer is retried once and the JSON retry is accepted",
    tags: ["spanish", "retry"],
    purpose: "Ayuda a los clientes de nuestra tienda a seguir sus pedidos y a solicitar devoluciones.",
    detectorAnswer: '{"responseLanguage":"Spanish"}',
    expectedLanguage: "Spanish",
    recordedDraftOutputs: [
      "Claro, aquí tienes un paquete inicial para tu asistente.",
      pack(
        [{ name: "verificar-pedido", action: "Pide el número de pedido antes de dar información de seguimiento." }],
        { name: "solicitar-devolucion", procedure: "Pregunta la fecha de compra y confirma la solicitud de devolución." },
      ),
    ],
    recordedRoutineOutputs: [routineCompletion({
      trigger: "El cliente quiere devolver un pedido.",
      slot: "Fecha de compra",
      ask: "Pregunta la fecha de compra:",
      confirm: "Confirma la devolución del pedido comprado el",
      askLabel: "Preguntar fecha",
    })],
    expectedOutcome: "draft",
  },
  {
    id: "reserved-name-retry",
    name: "A pack that reuses a built-in directive name is retried, not accepted",
    tags: ["english", "retry", "names"],
    purpose: "Answer questions about our library's opening hours and help visitors reserve a study room.",
    detectorAnswer: '{"responseLanguage":"English"}',
    expectedLanguage: "English",
    recordedDraftOutputs: [
      pack(
        [{ name: reservedDirectiveName, action: "Answer from the library's documents." }],
        { name: "reserve-study-room", procedure: "Ask for the preferred date and confirm the reservation." },
      ),
      pack(
        [{ name: "confirm-room-details", action: "Repeat the room, date, and time back before confirming." }],
        { name: "reserve-study-room", procedure: "Ask for the preferred date and confirm the reservation." },
      ),
    ],
    recordedRoutineOutputs: [routineCompletion({
      trigger: "The visitor wants to reserve a study room.",
      slot: "Preferred date",
      ask: "Ask for the preferred date:",
      confirm: "Confirm the reservation for",
      askLabel: "Ask for date",
    })],
    expectedOutcome: "draft",
  },
  {
    id: "existing-names-avoided",
    name: "Names already on the agent reach the prompt and the pack avoids them",
    tags: ["english", "names"],
    purpose: "Help visitors book a haircut and answer questions about prices.",
    detectorAnswer: '{"responseLanguage":"English"}',
    expectedLanguage: "English",
    existingDirectiveNames: ["confirm-details"],
    existingRoutineNames: ["book-appointment"],
    recordedDraftOutputs: [pack(
      [{ name: "confirm-haircut-details", action: "Repeat the service, date, and time before confirming." }],
      { name: "book-haircut", procedure: "Ask for the preferred date and confirm the booking." },
    )],
    recordedRoutineOutputs: [routineCompletion({
      trigger: "The visitor wants to book a haircut.",
      slot: "Preferred date",
      ask: "Ask for the preferred date:",
      confirm: "Confirm the haircut on",
      askLabel: "Ask for date",
    })],
    expectedOutcome: "draft",
  },
  {
    id: "undetected-language-fallback",
    name: "An unusable detection answer falls back to mirroring the purpose's language",
    tags: ["fallback"],
    purpose: "Aide les visiteurs à réserver une visite guidée du musée.",
    detectorAnswer: "not json",
    expectedLanguage: null,
    recordedDraftOutputs: [pack(
      [{ name: "confirmer-visite", action: "Répète la date et l'heure de la visite avant de confirmer." }],
      { name: "reserver-visite", procedure: "Demande la date souhaitée et confirme la réservation." },
    )],
    recordedRoutineOutputs: [routineCompletion({
      trigger: "Le visiteur veut réserver une visite.",
      slot: "Date souhaitée",
      ask: "Demande la date souhaitée :",
      confirm: "Confirme la visite du",
      askLabel: "Demander la date",
    })],
    expectedOutcome: "draft",
  },
  {
    id: "invalid-twice-rejected",
    name: "A pack without a routine is rejected after the retry, never returned",
    tags: ["english", "rejection"],
    purpose: "Help visitors find our store's opening hours.",
    detectorAnswer: '{"responseLanguage":"English"}',
    expectedLanguage: "English",
    recordedDraftOutputs: [
      JSON.stringify({ directives: [{ name: "state-hours", condition: { kind: "always" }, action: "State the opening hours." }] }),
      JSON.stringify({ directives: [], routine: null }),
    ],
    recordedRoutineOutputs: [],
    expectedOutcome: "invalid_starter_pack_draft",
  },
];
