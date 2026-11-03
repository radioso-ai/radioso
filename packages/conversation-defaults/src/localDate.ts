import type { TurnContext } from "@radioso/conversation-contract";

/** The zone a turn reads "today" in when neither the turn nor its host names one. */
export const DEFAULT_TIME_ZONE = "UTC";

/** The zone `turn` reads "today" in: its own, else `fallback`. */
export const turnTimeZone = (turn: TurnContext, fallback: string = DEFAULT_TIME_ZONE): string =>
  turn.referenceTimeZone?.timeZone ?? fallback;

/** A calendar date, `YYYY-MM-DD`, and the zone it was read in. */
export interface LocalDate {
  isoDate: string;
  timeZone: string;
}

/**
 * The calendar date `now` falls on in `timeZone`. A zone `Intl` does not know reads UTC, so a bad
 * zone never fails a turn.
 */
export const localIsoDate = (now: Date, timeZone: string): LocalDate => {
  try {
    const parts = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((entry) => entry.type === type)?.value ?? "";
    return { isoDate: `${part("year")}-${part("month")}-${part("day")}`, timeZone };
  } catch {
    return { isoDate: now.toISOString().slice(0, 10), timeZone: DEFAULT_TIME_ZONE };
  }
};
