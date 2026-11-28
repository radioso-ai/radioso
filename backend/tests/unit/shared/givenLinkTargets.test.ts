import { describe, expect, it } from "vitest";

import { givenLinkPolicy } from "../../../src/shared/text/givenLinkTargets.js";

const verdict = (given: string[], destination: string) => {
  const result = givenLinkPolicy(given)(destination);
  return result.kind === "keep" ? "keep" : result.reason;
};

const COURSE_RESULT = [
  "Result 1 (Il respiro consapevole): Source: https://school.example/courses/breath",
  "Three days of breath work. Call +39 06 1234 5678 or write to Info@School.example.",
].join("\n");

describe("givenLinkPolicy", () => {
  it.each([
    ["the address as given", "https://school.example/courses/breath"],
    ["a trailing slash", "https://school.example/courses/breath/"],
    ["another scheme and www", "http://www.school.example/courses/breath"],
    ["host case and a fragment", "https://SCHOOL.example/courses/breath#dates"],
    ["trailing punctuation", "https://school.example/courses/breath."],
    ["the given host's home page", "https://school.example"],
    ["a parent path of a given address", "https://school.example/courses"],
    ["an email address that is given", "mailto:info@school.example"],
    ["an email address with a subject", "mailto:INFO@school.example?subject=Breath"],
    ["a phone number with its country code", "tel:+390612345678"],
    ["a phone number written another way", "tel:06-1234-5678"],
  ])("keeps %s", (_label, destination) => {
    expect(verdict([COURSE_RESULT], destination)).toBe("keep");
  });

  it.each([
    ["a sibling path", "https://school.example/courses/silence", "not_given"],
    ["an invented site", "https://example.org", "not_given"],
    ["a host that only starts like a given one", "https://school.example.evil.example/courses/breath", "not_given"],
    ["a query the model added", "https://school.example/courses/breath?ref=chat", "not_given"],
    ["an email address that is not given", "mailto:sales@school.example", "not_given"],
    ["a phone number that is not given", "tel:+390699999999", "not_given"],
    ["another scheme that is not given", "whatsapp://send?phone=390612345678", "not_given"],
    ["a bare fragment", "#", "fragment"],
    ["a section fragment", "#dates", "fragment"],
    ["a site-relative path", "/courses/breath", "relative"],
    ["a page name", "Pricing", "relative"],
    ["an address without a scheme", "www.school.example/courses/breath", "relative"],
    ["a page title with spaces", "Plans and Pricing", "malformed"],
    ["an empty destination", "", "malformed"],
    ["an empty email address", "mailto:", "malformed"],
  ])("unwraps %s", (_label, destination, reason) => {
    expect(verdict([COURSE_RESULT], destination)).toBe(reason);
  });

  it("reads an email domain as a mailbox, never as the website of that domain", () => {
    const given = ["Result 1: Write to corsi@example.org or to visitor.name@mail.example."];

    expect(verdict(given, "https://example.org")).toBe("not_given");
    expect(verdict(given, "https://www.example.org/")).toBe("not_given");
    expect(verdict(given, "https://mail.example")).toBe("not_given");
    expect(verdict(given, "mailto:corsi@example.org")).toBe("keep");
    expect(verdict(given, "mailto:visitor.name@mail.example")).toBe("keep");
  });

  it("reads an address written without a scheme in any given text", () => {
    const given = ["Instructions: send visitors to www.retreat.example/book for bookings.", "Result 1: nothing"];

    expect(verdict(given, "https://retreat.example/book")).toBe("keep");
    expect(verdict(given, "https://www.retreat.example/book/")).toBe("keep");
  });

  it("reads an address inside a Markdown link of a finding", () => {
    expect(verdict(["See [Booking](https://retreat.example/book) to reserve."], "https://retreat.example/book"))
      .toBe("keep");
  });

  it("reads a longer path segment as a different address", () => {
    expect(verdict(["Source: https://retreat.example/book.html"], "https://retreat.example/book")).toBe("not_given");
    expect(verdict(["Source: https://retreat.example/booking"], "https://retreat.example/book")).toBe("not_given");
  });

  it("keeps a query only as given, or left off", () => {
    const given = ["Source: https://shop.example/item?id=5&lang=it"];

    expect(verdict(given, "https://shop.example/item?id=5")).toBe("keep");
    expect(verdict(given, "https://shop.example/item")).toBe("keep");
    expect(verdict(given, "https://shop.example/item?id=50")).toBe("not_given");
  });

  it("matches percent-encoded and decoded paths either way round", () => {
    expect(verdict(["Source: https://cafe.example/caf%C3%A9/menu"], "https://cafe.example/café/menu")).toBe("keep");
    expect(verdict(["Source: https://cafe.example/café/menu"], "https://cafe.example/caf%C3%A9/menu")).toBe("keep");
  });

  it("matches an internationalised host written either way round", () => {
    expect(verdict(["Source: https://bücher.example/kurse"], "https://xn--bcher-kva.example/kurse")).toBe("keep");
    expect(verdict(["Source: https://xn--bcher-kva.example/kurse"], "https://bücher.example/kurse")).toBe("keep");
  });

  it("matches a query whose ampersand the given text wrote as an HTML entity", () => {
    expect(verdict(["Source: https://shop.example/item?id=5&amp;lang=it"], "https://shop.example/item?id=5&lang=it"))
      .toBe("keep");
  });

  it("reads a host with no dot only as the whole address, never as a word in the given text", () => {
    const given = ["Our pricing page explains every plan. Local preview: http://localhost:3000/book"];

    expect(verdict(given, "https://pricing")).toBe("not_given");
    expect(verdict(given, "http://localhost:3000/book")).toBe("keep");
  });

  it("keeps another scheme only when its address is given as written", () => {
    expect(verdict(["Message us on whatsapp://send?phone=390612345678"], "whatsapp://send?phone=390612345678"))
      .toBe("keep");
  });

  it("unwraps every absolute address when nothing was given", () => {
    expect(verdict([], "https://school.example")).toBe("not_given");
    expect(verdict([""], "mailto:info@school.example")).toBe("not_given");
  });
  describe("phone numbers", () => {
    it.each([
      ["a country code added and the trunk 0 dropped", ["Call 030 1234567."], "tel:+49301234567"],
      ["the same with another country", ["Ring 01 23 45 67 89 anytime."], "tel:+33123456789"],
      ["a number written with a bracketed trunk 0", ["Call +49 (0)30 1234567."], "tel:+49301234567"],
      ["an international number written nationally", ["Call +49 30 1234567."], "tel:0301234567"],
      ["a number given with a 00 prefix", ["Call 0049 30 1234567."], "tel:+49301234567"],
      ["a number written with dots and slashes", ["Call 030/123.45.67."], "tel:+49301234567"],
      ["a French number written with dots", ["Appelez le 06.12.34.56.78."], "tel:+33612345678"],
      ["a French number with a country code", ["Appelez le +33 6 12 34 56 78."], "tel:0612345678"],
    ])("keeps %s", (_label, given, destination) => {
      expect(verdict(given, destination)).toBe("keep");
    });

    it("still reads a date written beside a dotted number as a date", () => {
      expect(verdict(["Le 06.12.34 à 10:30."], "tel:061234")).toBe("not_given");
      expect(verdict(["Le 06.12.34 à 10:30, appelez le 06.12.34.56.78."], "tel:0612345678")).toBe("keep");
    });

    it("keeps a number given after a date and a time, with neither joined to it", () => {
      const given = ["Workshop on 12.03.2026 at 10:30, call 030 1234567 to book."];

      expect(verdict(given, "tel:+49301234567")).toBe("keep");
      expect(verdict(given, "tel:0301234567")).toBe("keep");
    });

    it.each([
      ["the digits of a date", "tel:12032026"],
      ["the digits of a date and a time joined", "tel:120320261030"],
      ["a country code in front of a 6-digit code", "tel:+49481516"],
      ["a country code in front of the digits of a date", "tel:+4912032026"],
      ["a number inside a longer run of given figures", "tel:301234"],
    ])("unwraps %s", (_label, destination) => {
      const given = ["Workshop on 12.03.2026 at 10:30, order 481516, call 030 1234567 to book."];

      expect(verdict(given, destination)).toBe("not_given");
    });

    it("does not read digits across a long run of dates, prices, and ids as one number", () => {
      const given = ["Open 9 10 11 2026 4567 12345 6789 and ids 1111 2222 3333 4444 5555."];

      expect(verdict(given, "tel:112812")).toBe("not_given");
      expect(verdict(given, "tel:11112222333344445555")).toBe("not_given");
    });
  });
});
