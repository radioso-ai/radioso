/**
 * Which digit sequences of a text can be a phone number, and whether a `tel:` destination is
 * one of them.
 *
 * It knows how phone numbers are written: groups of digits set apart by a space, dot, slash,
 * dash, or parenthesis, with an optional country code, an optional `00` or `+` prefix, and a
 * trunk `0` that international form drops. It knows nothing about any country's numbering
 * plan: a country code is any prefix of one to three digits, so one rule serves every country.
 * Dates and times are not phone numbers and never join the digits around them.
 */

const MIN_PHONE_DIGITS = 6;
/** A number with a country code is at most 15 digits long (E.164). */
const MAX_PHONE_DIGITS = 15;
const MAX_COUNTRY_CODE_DIGITS = 3;
/** The shortest national number a country code may be added to or taken from. */
const MIN_NATIONAL_DIGITS = 7;
/** How many digit groups one number is read from: `+49 (0)30 123 45 67` has six. */
const MAX_GROUPS = 7;

// A date or a time: digits that count something else. A number's own groups, such as
// `123.45.67`, do not read as one: a day is 1 to 31 and a month 1 to 12. Replaced by a break
// before reading numbers. A date that digits continue across a separator, such as `06.12.34`
// inside `06.12.34.56.78`, is a number's own groups.
const DAY = "(?:0?[1-9]|[12]\\d|3[01])";
const MONTH = "(?:0?[1-9]|1[0-2])";
const DATE_OR_TIME = new RegExp(
  `(?<!\\d)(?<!\\d[./-])(?:\\d{4}[./-]${MONTH}[./-]${DAY}|${DAY}[./-]${MONTH}[./-](?:\\d{4}|\\d{2})|\\d{1,2}:\\d{2}(?::\\d{2})?)(?!\\d)(?![./-]\\d)`,
  "g",
);
// Digit groups, each set apart from the next by at most two separator characters.
const PHONE_CHAIN = /\d+(?:[ \t\u00a0()./-]{1,2}\d+)*/g;
const DIGIT_GROUP = /\d+/g;

/** Every digit sequence of `text` that can be one phone number, as digits only. */
export const phoneCandidates = (text: string): string[] => {
  const candidates = new Set<string>();
  for (const chain of text.replace(DATE_OR_TIME, "\n").matchAll(PHONE_CHAIN)) {
    const groups = chain[0].match(DIGIT_GROUP) ?? [];
    for (let first = 0; first < groups.length; first += 1) {
      let digits = "";
      for (let last = first; last < Math.min(groups.length, first + MAX_GROUPS); last += 1) {
        digits += groups[last];
        if (digits.length > MAX_PHONE_DIGITS) {
          break;
        }
        if (digits.length >= MIN_PHONE_DIGITS) {
          candidates.add(digits);
        }
      }
    }
  }
  return [...candidates];
};

const isCountryCodeLength = (length: number): boolean => length >= 1 && length <= MAX_COUNTRY_CODE_DIGITS;

/** `longer` is `shorter` with a country code added. */
const addsCountryCode = (longer: string, shorter: string): boolean =>
  longer.endsWith(shorter) && isCountryCodeLength(longer.length - shorter.length);

/**
 * Whether `international` is `national` with a country code added and its trunk `0` dropped:
 * `+49301234567` for `0301234567`.
 */
const dropsTrunkPrefix = (international: string, national: string): boolean =>
  national.startsWith("0") && addsCountryCode(international, national.slice(1));

/** `withTrunk` is `without` plus a trunk `0` after a country code: `490301234567`, written `+49 (0)30…`. */
const hasInnerTrunkPrefix = (withTrunk: string, without: string): boolean => {
  for (let code = 1; code <= MAX_COUNTRY_CODE_DIGITS; code += 1) {
    if (withTrunk[code] === "0" && withTrunk.slice(0, code) + withTrunk.slice(code + 1) === without) {
      return true;
    }
  }
  return false;
};

/**
 * Whether one number is the other written another way: with or without a country code, with a
 * trunk `0` kept or dropped. A country code is only added to or taken from a number long
 * enough to have a national part, so a short code or identifier is not a number with a
 * country code in front.
 */
const isSameNumber = (digits: string, given: string): boolean =>
  given === digits
  || (given.length >= MIN_NATIONAL_DIGITS && addsCountryCode(digits, given))
  || (digits.length >= MIN_NATIONAL_DIGITS && addsCountryCode(given, digits))
  || (given.length >= MIN_NATIONAL_DIGITS && dropsTrunkPrefix(digits, given))
  || (digits.length >= MIN_NATIONAL_DIGITS && dropsTrunkPrefix(given, digits))
  || hasInnerTrunkPrefix(given, digits)
  || hasInnerTrunkPrefix(digits, given);

/** Whether the digits of a `tel:` destination are one of the given numbers. */
export const isGivenPhoneNumber = (digits: string, candidates: readonly string[]): boolean =>
  candidates.some((given) => isSameNumber(digits, given));
