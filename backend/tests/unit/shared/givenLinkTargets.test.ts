import { describe, expect, it } from "vitest";

import { GivenLinkTargets } from "../../../src/shared/text/givenLinkTargets.js";

const verdict = (given: string[], destination: string) => {
  const result = new GivenLinkTargets(given).verdictFor(destination);
  return result.kind === "keep" ? "keep" : result.reason;
};

const COURSE_RESULT = [
  "Result 1 (Il respiro consapevole): Source: https://school.example/courses/breath",
  "Three days of breath work. Call +39 06 1234 5678 or write to Info@School.example.",
].join("\n");

describe("GivenLinkTargets", () => {
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
});
