/**
 * A synthetic workspace shaped like a mid-sized bilingual production workspace: a few
 * hundred short dated event pages in Italian and English, plus longer website pages split
 * into several chunks. The organisation's name is on every chunk, and numbers and month
 * names are common, so a query naming the organisation, a date, and a few request words
 * holds terms that sit on most chunks next to terms that sit on a few.
 *
 * `buildForeignEventsWorkspace` is for another workspace in the same hash partition. It makes words
 * the target workspace barely holds ("Europe", "events") frequent in the partition, which
 * is what can lead Postgres to read the workspace's chunks one by one instead of using
 * the full-text index.
 *
 * Every text is generated from the templates below; nothing comes from a real workspace.
 */

export const ORGANISATION = "Valmora";

/** The English page of the event the query in the integration test asks about. */
export const WEEK_OF_SILENCE_EN_KEY = "event_week_of_silence_2027_11_29_en";

export interface SyntheticChunk {
  key: string;
  title: string;
  chunkIndex: number;
  searchText: string;
}

export interface SyntheticDocument {
  key: string;
  title: string;
  chunks: SyntheticChunk[];
}

const MONTHS_EN = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTHS_IT = [
  "gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno",
  "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre",
];

const COURSES: ReadonlyArray<{ en: string; it: string }> = [
  { en: "Meditation retreat", it: "Ritiro di meditazione" },
  { en: "Beginners yoga course", it: "Corso di yoga per principianti" },
  { en: "Singing workshop", it: "Seminario di canto" },
  { en: "Residential breathing course", it: "Corso residenziale di respirazione" },
  { en: "Festival of light", it: "Festival della luce" },
  { en: "Silent walking days", it: "Giornate di cammino in silenzio" },
  { en: "Teacher training module", it: "Modulo di formazione insegnanti" },
];

const PLACES = ["Lago Sereno", "Monte Alto", "Casa Grande", "Borgo Antico"];

// A small deterministic generator, so the corpus and every term count are the same on
// every run.
const seededRandom = (seed: number) => {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

const pick = <T>(random: () => number, values: readonly T[]): T => values[Math.floor(random() * values.length)];

const dayOf = (date: Date): number => date.getUTCDate();

interface EventSpec {
  key: string;
  course: { en: string; it: string };
  place: string;
  start: Date;
  end: Date;
  level: number;
  price: number;
  arrivalHour: number;
}

const eventPages = (event: EventSpec): SyntheticDocument[] => {
  const { course, place, start, end, level, price, arrivalHour } = event;
  const year = start.getUTCFullYear();
  const startMonth = start.getUTCMonth();
  const endMonth = end.getUTCMonth();
  const titleEn = `${course.en}, ${ORGANISATION} ${place}`;
  const titleIt = `${course.it}, ${ORGANISATION} ${place}`;
  const en = [
    `Title: ${titleEn}`,
    `${ORGANISATION} ${place}. ${course.en} from ${dayOf(start)} ${MONTHS_EN[startMonth]} to ${dayOf(end)} ${MONTHS_EN[endMonth]} ${end.getUTCFullYear()}.`,
    `Course calendar ${year}: level ${level}, price € ${price}, arrival at ${arrivalHour}:30.`,
    `Rooms, meals and the programme are arranged by the ${ORGANISATION} reception.`,
    `Month: ${MONTHS_EN[startMonth]} ${year}. Label: ${course.en}.`,
  ].join("\n");
  const it = [
    `Title: ${titleIt}`,
    `${ORGANISATION} ${place}. ${course.it} dal ${dayOf(start)} ${MONTHS_IT[startMonth]} al ${dayOf(end)} ${MONTHS_IT[endMonth]} ${end.getUTCFullYear()}.`,
    `Calendario corsi ${year}: livello ${level}, prezzo € ${price}, arrivo alle ore ${arrivalHour}:30.`,
    `Camere, pasti e programma sono organizzati dalla reception di ${ORGANISATION}.`,
    `Mese: ${MONTHS_IT[startMonth]} ${year}. Etichetta: ${course.it}.`,
  ].join("\n");
  return [
    { key: `${event.key}_en`, title: titleEn, chunks: [{ key: `${event.key}_en`, title: titleEn, chunkIndex: 0, searchText: en }] },
    { key: `${event.key}_it`, title: titleIt, chunks: [{ key: `${event.key}_it`, title: titleIt, chunkIndex: 0, searchText: it }] },
  ];
};

const WEBSITE_SENTENCES_EN = [
  `${ORGANISATION} welcomes guests all year, with courses on meditation, yoga and singing.`,
  "The house sits above the lake, 12 km from the nearest station, and a shuttle runs at 9:00 and 17:00.",
  "Rooms are single or double; meals are vegetarian and served at 8:00, 13:00 and 19:30.",
  "Booking opens 3 months ahead; a deposit of 30 percent confirms a place.",
  `The ${ORGANISATION} community has hosted retreats since 1998 and trains teachers every spring.`,
  "Volunteers help in the garden and the kitchen in exchange for board and lodging.",
  "Parking is free; electric cars can charge at the two points near the entrance.",
  "Children under 12 stay free when they share a room with their parents.",
];
const WEBSITE_SENTENCES_IT = [
  `${ORGANISATION} accoglie ospiti tutto l'anno, con corsi di meditazione, yoga e canto.`,
  "La casa si trova sopra il lago, a 12 km dalla stazione, e una navetta parte alle 9:00 e alle 17:00.",
  "Le camere sono singole o doppie; i pasti sono vegetariani e serviti alle 8:00, 13:00 e 19:30.",
  "Le prenotazioni aprono 3 mesi prima; un acconto del 30 per cento conferma il posto.",
  `La comunità di ${ORGANISATION} ospita ritiri dal 1998 e forma insegnanti ogni primavera.`,
  "I volontari aiutano nell'orto e in cucina in cambio di vitto e alloggio.",
  "Il parcheggio è gratuito; le auto elettriche si ricaricano ai due punti vicino all'ingresso.",
  "I bambini sotto i 12 anni non pagano se dormono in camera con i genitori.",
];

const websitePages = (random: () => number, count: number, chunksPerPage: number): SyntheticDocument[] =>
  Array.from({ length: count }, (_, page) => {
    const sentences = page % 2 === 0 ? WEBSITE_SENTENCES_EN : WEBSITE_SENTENCES_IT;
    const title = `${ORGANISATION}: ${page % 2 === 0 ? "about us" : "chi siamo"} ${page + 1}`;
    const key = `website_${page}`;
    return {
      key,
      title,
      chunks: Array.from({ length: chunksPerPage }, (_, chunkIndex) => ({
        key: `${key}_${chunkIndex}`,
        title,
        chunkIndex,
        searchText: [
          `Title: ${title}`,
          ...Array.from({ length: 12 }, () => pick(random, sentences)),
        ].join("\n"),
      })),
    };
  });

const addDays = (date: Date, days: number): Date => new Date(date.getTime() + days * 86_400_000);

/** About 370 dated event pages and 160 website chunks. */
export const buildMidSizedBilingualWorkspace = (): SyntheticDocument[] => {
  const random = seededRandom(1634);
  const events: EventSpec[] = [];
  // One event a week from January 2026 to the end of 2027, with a second one on most
  // weeks, so dates, month names and years recur across the corpus.
  for (let week = 0; week < 104; week += 1) {
    const monday = addDays(new Date(Date.UTC(2026, 0, 5)), week * 7);
    const perWeek = week % 5 === 0 ? 1 : 2;
    for (let slot = 0; slot < perWeek; slot += 1) {
      const start = addDays(monday, slot * 3);
      events.push({
        key: `event_${week}_${slot}`,
        course: pick(random, COURSES),
        place: pick(random, PLACES),
        start,
        end: addDays(start, 2 + Math.floor(random() * 4)),
        level: 1 + Math.floor(random() * 3),
        price: 150 + 10 * Math.floor(random() * 40),
        arrivalHour: 14 + Math.floor(random() * 5),
      });
    }
  }
  // The event the query asks about: the week from 29 November 2027.
  events.push({
    key: "event_week_of_silence_2027_11_29",
    course: { en: "Week of silence", it: "Settimana del silenzio" },
    place: "Lago Sereno",
    start: new Date(Date.UTC(2027, 10, 29)),
    end: new Date(Date.UTC(2027, 11, 5)),
    level: 2,
    price: 540,
    arrivalHour: 16,
  });
  return [...events.flatMap(eventPages), ...websitePages(random, 40, 4)];
};

/**
 * Another workspace's chunks, about European events, in which "Europe", "events", "week",
 * "of", "November" and "2027" are all frequent.
 */
export const buildForeignEventsWorkspace = (chunkCount: number): SyntheticDocument[] => {
  const random = seededRandom(4361);
  const cities = ["Lisbon", "Vienna", "Ghent", "Turin", "Krakow", "Tallinn", "Porto", "Lyon"];
  return Array.from({ length: chunkCount }, (_, index) => {
    const city = pick(random, cities);
    const month = MONTHS_EN[Math.floor(random() * 12)];
    const title = `Events in Europe: ${city} ${index}`;
    const key = `foreign_${index}`;
    const searchText = [
      `Title: ${title}`,
      `Week ${1 + (index % 52)} of 2027: ${3 + Math.floor(random() * 20)} events across Europe, from ${1 + Math.floor(random() * 28)} ${month} 2027.`,
      `The ${city} events office lists concerts, fairs and markets for the week of ${1 + Math.floor(random() * 28)} November 2027.`,
      `Tickets for events in Europe open ${1 + Math.floor(random() * 9)} weeks ahead.`,
    ].join("\n");
    return { key, title, chunks: [{ key, title, chunkIndex: 0, searchText }] };
  });
};
