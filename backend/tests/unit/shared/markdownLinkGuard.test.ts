import { describe, expect, it } from "vitest";

import {
  guardMarkdownLinks,
  MarkdownLinkGuardStream,
  type LinkDestinationPolicy,
} from "../../../src/shared/text/markdownLinkGuard.js";

/** Keeps only the listed destinations; records every destination it was asked about. */
const keepOnly = (...kept: string[]) => {
  const asked: string[] = [];
  const policy: LinkDestinationPolicy<"rejected"> = (destination) => {
    asked.push(destination);
    return kept.includes(destination) ? { kind: "keep" } : { kind: "unwrap", reason: "rejected" };
  };
  return { policy, asked };
};

const streamed = (chunks: string[], policy: LinkDestinationPolicy<"rejected">) => {
  const stream = new MarkdownLinkGuardStream(policy);
  const released = chunks.map((chunk) => stream.push(chunk));
  released.push(stream.flush());
  return { released, text: released.join(""), unwrapped: stream.unwrapped };
};

describe("guardMarkdownLinks", () => {
  it("turns a link the policy rejects into its text and counts it", () => {
    const { policy } = keepOnly();

    const guarded = guardMarkdownLinks("Join [Il respiro consapevole](#) in November.", policy);

    expect(guarded).toEqual({ text: "Join Il respiro consapevole in November.", unwrapped: ["rejected"] });
  });

  it("leaves a link the policy keeps exactly as written", () => {
    const { policy } = keepOnly("https://school.example/breath");
    const answer = "Join [Breath](https://school.example/breath \"Breath course\") in November.";

    expect(guardMarkdownLinks(answer, policy)).toEqual({ text: answer, unwrapped: [] });
  });

  it("turns a rejected image into its alt text", () => {
    const { policy } = keepOnly();

    expect(guardMarkdownLinks("Our hall: ![the main hall](https://img.example/hall.png).", policy).text)
      .toBe("Our hall: the main hall.");
  });

  it("asks about the destination alone: no title, no angle brackets, parentheses kept", () => {
    const { policy, asked } = keepOnly();

    guardMarkdownLinks(
      [
        "[A](https://a.example/x 'Title')",
        "[B](<https://b.example/a b>)",
        "[C](https://c.example/wiki/Yoga_(practice))",
        "[D]( https://d.example )",
      ].join(" "),
      policy,
    );

    expect(asked).toEqual([
      "https://a.example/x",
      "https://b.example/a b",
      "https://c.example/wiki/Yoga_(practice)",
      "https://d.example",
    ]);
  });

  it("asks about a destination that is not one URL as written, so the policy can reject it", () => {
    const { policy, asked } = keepOnly();

    const guarded = guardMarkdownLinks("See [Plans and Pricing](Plans and Pricing) and [Contact]().", policy);

    expect(asked).toEqual(["Plans and Pricing", ""]);
    expect(guarded.text).toBe("See Plans and Pricing and Contact.");
  });

  it("leaves brackets that do not form an inline link alone", () => {
    const { policy, asked } = keepOnly();
    const answer = "Use arr[0], see [note] (below), [a]\n(b), [ref][1], and [x](\n\ny).";

    expect(guardMarkdownLinks(answer, policy).text).toBe(answer);
    expect(asked).toEqual([]);
  });

  it("leaves links inside inline code, fenced code, and escaped brackets alone", () => {
    const { policy, asked } = keepOnly();
    const answer = [
      "Write `[label](#)` for a link, or ``[x](#) with ` inside``.",
      "```markdown",
      "[Course](#)",
      "```",
      "~~~~",
      "[Course](#)",
      "~~~",
      "still code [x](#)",
      "~~~~",
      "An escaped \\[Course](#) stays.",
    ].join("\n");

    expect(guardMarkdownLinks(answer, policy).text).toBe(answer);
    expect(asked).toEqual([]);
  });

  it("guards a link after a backtick that never closes on its line", () => {
    const { policy } = keepOnly();

    expect(guardMarkdownLinks("A stray ` then [Course](#).\nNext `line`.", policy).text)
      .toBe("A stray ` then Course.\nNext `line`.");
  });

  it("guards the text of a link it keeps, and of one it unwraps", () => {
    const { policy } = keepOnly("https://school.example/");

    expect(guardMarkdownLinks("[![logo](https://img.example/logo.png)](https://school.example/)", policy).text)
      .toBe("[logo](https://school.example/)");
    expect(guardMarkdownLinks("[See [Course](#) now](#)", policy).text).toBe("See Course now");
  });

  it("reads a backtick with no partner within the bound as a literal backtick", () => {
    const { policy } = keepOnly();
    const answer = `Use \` then ${"x".repeat(1500)} [Course](#) and \`.`;

    expect(guardMarkdownLinks(answer, policy).text).toBe(`Use \` then ${"x".repeat(1500)} Course and \`.`);
  });

  it("checks the destination that closes link text longer than the bound, keeping the text", () => {
    const { policy, asked } = keepOnly("https://kept.example/");
    const longText = "x".repeat(2000);

    expect(guardMarkdownLinks(`[${longText}](https://invented.example/)`, policy))
      .toEqual({ text: `[${longText}]`, unwrapped: ["rejected"] });
    expect(guardMarkdownLinks(`[${longText}](https://kept.example/)`, policy).unwrapped).toEqual([]);
    expect(asked).toEqual(["https://invented.example/", "https://kept.example/"]);
  });

  it("counts every link it unwraps", () => {
    const { policy } = keepOnly("https://kept.example");

    const guarded = guardMarkdownLinks(
      "- [One](#) — 260 € · 3 days\n- [Two](/two) — 280 €\n- [Three](https://kept.example) — 200 €",
      policy,
    );

    expect(guarded.unwrapped).toHaveLength(2);
    expect(guarded.text).toBe("- One — 260 € · 3 days\n- Two — 280 €\n- [Three](https://kept.example) — 200 €");
  });
});

describe("guardMarkdownLinks: bare addresses and autolinks", () => {
  it("removes a bare address the policy rejects, with the space that set it apart", () => {
    const { policy } = keepOnly();

    expect(guardMarkdownLinks("Visit https://invented.example/courses today.", policy))
      .toEqual({ text: "Visit today.", unwrapped: ["rejected"] });
    expect(guardMarkdownLinks("See www.invented.example, or ask.", policy).text).toBe("See , or ask.");
    expect(guardMarkdownLinks("https://invented.example\nNext line", policy).text).toBe("\nNext line");
  });

  it("keeps a bare address the policy keeps, asking about it without its trailing punctuation", () => {
    const { policy, asked } = keepOnly("https://kept.example/a", "http://www.kept.example");
    const answer = "See https://kept.example/a. Or (https://kept.example/a) and www.kept.example!";

    expect(guardMarkdownLinks(answer, policy)).toEqual({ text: answer, unwrapped: [] });
    expect(asked).toEqual(["https://kept.example/a", "https://kept.example/a", "http://www.kept.example"]);
  });

  it("asks about a Wikipedia style address with its balanced parenthesis", () => {
    const { policy, asked } = keepOnly();

    guardMarkdownLinks("Read https://w.example/wiki/Yoga_(practice).", policy);

    expect(asked).toEqual(["https://w.example/wiki/Yoga_(practice)"]);
  });

  it("leaves an address inside code, and one that is only the end of a word, alone", () => {
    const { policy, asked } = keepOnly();
    const answer = "Run `curl https://invented.example` or see nothttps://invented.example and xwww.invented.example.\n"
      + "```\nhttps://invented.example\n```";

    expect(guardMarkdownLinks(answer, policy).text).toBe(answer);
    expect(asked).toEqual([]);
  });

  it("leaves words that begin like an address but are not one", () => {
    const { policy, asked } = keepOnly();
    const answer = "Hello, we have www and http and https: nothing here, and wwwx.";

    expect(guardMarkdownLinks(answer, policy).text).toBe(answer);
    expect(asked).toEqual([]);
  });

  it("removes an autolink the policy rejects, and asks about an email autolink as mailto", () => {
    const { policy, asked } = keepOnly("mailto:info@kept.example");

    expect(guardMarkdownLinks("Write <info@kept.example> or <https://invented.example/x> or <ceo@invented.example>.", policy))
      .toEqual({ text: "Write <info@kept.example> or or .", unwrapped: ["rejected", "rejected"] });
    expect(asked).toEqual(["mailto:info@kept.example", "https://invented.example/x", "mailto:ceo@invented.example"]);
  });

  it("leaves angle brackets that are not an autolink alone", () => {
    const { policy, asked } = keepOnly();
    const answer = "If a < b and c > d, use <b>bold</b> or <br/> or < x >.";

    expect(guardMarkdownLinks(answer, policy).text).toBe(answer);
    expect(asked).toEqual([]);
  });

  it("guards an address shown as the text of a link", () => {
    const { policy } = keepOnly("https://kept.example/");

    expect(guardMarkdownLinks("[https://invented.example](https://kept.example/)", policy).text)
      .toBe("[](https://kept.example/)");
  });
});

describe("guardMarkdownLinks: reference definitions", () => {
  it("removes a definition whose destination the policy rejects and leaves its uses as text", () => {
    const { policy } = keepOnly();

    const guarded = guardMarkdownLinks("See [the course][c] and [c].\n\n[c]: https://invented.example/course \"Course\"\n", policy);

    expect(guarded).toEqual({ text: "See [the course][c] and [c].\n\n\n", unwrapped: ["rejected"] });
  });

  it("keeps a definition the policy keeps, and reads its angle-bracket form", () => {
    const { policy, asked } = keepOnly("https://kept.example/a b");
    const answer = "[kept]: <https://kept.example/a b> 'Title'";

    expect(guardMarkdownLinks(answer, policy)).toEqual({ text: answer, unwrapped: [] });
    expect(asked).toEqual(["https://kept.example/a b"]);
  });

  it("reads a definition after an indent of up to three spaces, and only at the start of a line", () => {
    const { policy, asked } = keepOnly();

    expect(guardMarkdownLinks("   [c]: https://invented.example", policy).text).toBe("   ");
    expect(guardMarkdownLinks("Not at start [c]: plain words here", policy).text).toBe("Not at start [c]: plain words here");
    expect(asked).toEqual(["https://invented.example"]);
  });

  it("leaves a line whose remainder is not an address and a title as text", () => {
    const { policy, asked } = keepOnly();
    const answer = "[Note]: bring water and a mat\n[1]: Smith, 2020, p. 4";

    expect(guardMarkdownLinks(answer, policy).text).toBe(answer);
    expect(asked).toEqual([]);
  });
});

describe("guardMarkdownLinks: what a renderer reads as a link", () => {
  it("checks a link whose text breaks across a soft line break, and not one broken by a blank line", () => {
    const { policy, asked } = keepOnly();

    expect(guardMarkdownLinks("[Yoga\ncourse](https://invented.example)", policy).text).toBe("Yoga\ncourse");
    expect(asked).toEqual(["https://invented.example"]);
    // A blank line ends the paragraph: nothing links, but the address is still a bare address.
    expect(guardMarkdownLinks("[Yoga\n\ncourse](https://invented.example)", policy).text).toBe("[Yoga\n\ncourse]()");
  });

  it("checks a destination that continues on the next line", () => {
    const { policy, asked } = keepOnly();

    expect(guardMarkdownLinks("[Yoga](\nhttps://invented.example\n\"Title\")", policy).text).toBe("Yoga");
    expect(asked).toEqual(["https://invented.example"]);
  });

  it("reads backslash escapes and character references in a destination before asking", () => {
    const { policy, asked } = keepOnly();

    guardMarkdownLinks(
      "[a](tel:&#43;49301234567) [b](tel:\\+49301234567) [c](tel:&#x2B;49301234567) [d](https://x.example/?a=1&amp;b=2) [e](tel:&plus;49)",
      policy,
    );

    expect(asked).toEqual([
      "tel:+49301234567",
      "tel:+49301234567",
      "tel:+49301234567",
      "https://x.example/?a=1&b=2",
      "tel:+49",
    ]);
  });
});

describe("guardMarkdownLinks: what surrounds an address", () => {
  it.each([
    ["German quotes", "Buchen Sie unter „https://given.example/book“."],
    ["curly quotes", "Book at “https://given.example/book”."],
    ["a CJK full stop", "詳しくは https://given.example/book。"],
    ["a CJK comma and prose", "预订请访问 https://given.example/book，谢谢"],
    ["prose in another script with no mark", "预订请访问 https://given.example/book谢谢"],
    ["square brackets", "Site: [https://given.example/book]"],
    ["a table cell", "|Site|https://given.example/book|"],
    ["guillemets", "Réservez sur «https://given.example/book»."],
  ])("keeps a given address inside %s", (_name, answer) => {
    const { policy } = keepOnly("https://given.example/book");

    expect(guardMarkdownLinks(answer, policy)).toEqual({ text: answer, unwrapped: [] });
  });

  it("removes an invented address in the same places, and nothing around it", () => {
    const { policy } = keepOnly("https://given.example/book");

    expect(guardMarkdownLinks("Buchen Sie unter „https://invented.example/x“.", policy).text)
      .toBe("Buchen Sie unter „“.");
    expect(guardMarkdownLinks("詳しくは https://invented.example/x。", policy).text).toBe("詳しくは 。");
  });

  it.each([
    ["after CJK text", "詳しくはhttps://invented.example/book", "詳しくは"],
    ["after Chinese text", "请访问https://invented.example/book", "请访问"],
    ["after a backslash that escapes nothing", "\\https://invented.example", "\\"],
    ["after a digit", "7https://invented.example/x", "7"],
  ])("removes an invented address %s, where a renderer links it", (_name, answer, expected) => {
    const { policy } = keepOnly();

    expect(guardMarkdownLinks(answer, policy).text).toBe(expected);
  });

  it("leaves www. that follows a letter, and an https:// that follows an ASCII letter", () => {
    const { policy, asked } = keepOnly();
    const answer = "see xwww.invented.example and nothttps://invented.example";

    expect(guardMarkdownLinks(answer, policy).text).toBe(answer);
    expect(asked).toEqual([]);
    expect(guardMarkdownLinks("(www.invented.example) *www.invented.example*", policy).text).toBe("() **");
  });

  it("removes an email address the policy rejects and keeps one it keeps, read as mailto", () => {
    const { policy, asked } = keepOnly("mailto:info@given.example");

    expect(guardMarkdownLinks("Write to info@invented.example now, or info@given.example.", policy).text)
      .toBe("Write to now, or info@given.example.");
    expect(asked).toEqual(["mailto:info@invented.example", "mailto:info@given.example"]);
  });

  it("leaves an @ that is not an email address", () => {
    const { policy, asked } = keepOnly();
    const answer = "Follow @school or write a@b, or user@host_ and @@x.y.";

    expect(guardMarkdownLinks(answer, policy).text).toBe(answer);
    expect(asked).toEqual([]);
  });
});

const CORPUS = [
  "Join [Il respiro consapevole](#) in November[[1]].",
  "See [Plans and Pricing](Plans and Pricing), or [Our site](https://kept.example/).",
  "Plain text with arr[0] and [note] (later) and a [ref][1].",
  "Write `[label](#)` or ``[x](#)``; then ` stray [y](/y).",
  "Intro\n```md\n[Course](#)\n```\nAfter [Course](#).\n~~~~\nx\n~~~\n[z](#)\n~~~~\nend",
  "An escaped \\[Course](#) and a trailing backslash \\",
  "Nested [See [Course](#) now](#) and image ![alt](https://img.example/a.png).",
  "Parens [W](https://w.example/a_(b)) and title [T](https://kept.example/ \"T\").",
  "Unclosed [label that never ends",
  "Unclosed destination [label](https://kept.example/",
  "  ```\n[a](#)\n  ```\n[b](#)",
  "`` ` `` [c](#) ```not a fence``` [d](#)",
  "```md`x\n[e](#)\n~~~ info [f](#)\n[g](#)\n  ~~~\n[h](#)",
  `\` unmatched ${"y".repeat(1200)} [i](#) \` [j](#)`,
  "Visit https://invented.example/x, www.invented.example. And https://kept.example/. Done htt and ww",
  "Mail <ceo@invented.example> or <https://kept.example/> or <https://invented.example/>, < not > this.",
  "See [the course][c].\n\n[c]: https://invented.example/course \"T\"\n  [d]: https://kept.example/\n[e]: words here",
  "[Yoga\ncourse](https://invented.example) and [Soft\n](https://kept.example/) then [Blank\n\nbreak](#)",
  `[${"x".repeat(1500)}](https://invented.example/) then [${"y".repeat(1100)}](https://kept.example/) end`,
  "[a](\nhttps://invented.example \"T\") and [b](tel:&#43;4930) and [c](https://kept.example/a\\_b)",
  "wwww.invented.example and a-https://invented.example/x and (www.invented.example/a_(b)).",
  "Buchen Sie unter „https://kept.example/“. Book at “https://kept.example/”. 詳しくは https://kept.example/。",
  "预订请访问 https://kept.example/，谢谢 and https://invented.example/x，谢谢 and 詳しくはhttps://invented.example/y",
  "Site: [https://kept.example/] and [https://invented.example/z] and |https://kept.example/|https://invented.example/|",
  "Write to info@invented.example or info@kept.example. Also a@b and user@host_ and x@y.z. 7https://invented.example",
  "\\https://invented.example and \\\\https://invented.example and xwww.invented.example and (www.invented.example)",
  `[${"x".repeat(1100)}\n\nfoo](https://invented.example) then [${"y".repeat(1100)}\n \nbar](https://kept.example/)`,
];

describe("MarkdownLinkGuardStream", () => {
  it("joins to the whole-text result however the text is split", () => {
    const { policy } = keepOnly("https://kept.example/", "https://img.example/a.png");
    for (const text of CORPUS) {
      const whole = guardMarkdownLinks(text, policy);
      for (let split = 0; split <= text.length; split += 1) {
        const result = streamed([text.slice(0, split), text.slice(split)], policy);
        expect(result.text, `${JSON.stringify(text)} split at ${split}`).toBe(whole.text);
        expect(result.unwrapped).toEqual(whole.unwrapped);
      }
      expect(streamed(Array.from(text), policy).text, `${JSON.stringify(text)} one character at a time`)
        .toBe(whole.text);
    }
  });

  it("never releases part of a link before its destination is checked", () => {
    const { policy } = keepOnly();

    const { released } = streamed(["Join [Il respiro", " consapevole](", "#", ") in November."], policy);

    expect(released).toEqual(["Join ", "", "", "Il respiro consapevole in ", "November."]);
  });

  it("releases a bracket as soon as it cannot become a link", () => {
    const { policy } = keepOnly();
    const stream = new MarkdownLinkGuardStream(policy);

    expect(stream.push("Index arr[0]")).toBe("Index arr");
    expect(stream.push(" is first")).toBe("[0] is ");
    expect(stream.flush()).toBe("first");
  });

  it("holds no more than its bound behind a backtick that never closes", () => {
    const { policy } = keepOnly();
    const stream = new MarkdownLinkGuardStream(policy);
    const line = `Run \`${"z".repeat(20_000)}`;

    const released = [];
    for (let offset = 0; offset < line.length; offset += 100) {
      released.push(stream.push(line.slice(offset, offset + 100)));
    }

    expect(released.join("").length).toBeGreaterThan(line.length - 1200);
    expect(released.join("") + stream.flush()).toBe(line);
  });

  it("releases fenced code as it arrives, without waiting for the line to end", () => {
    const { policy } = keepOnly();
    const stream = new MarkdownLinkGuardStream(policy);

    expect(stream.push("```js\nconst link = ")).toBe("```js\nconst link = ");
    expect(stream.push("\"[x](#)\";\n```\n[y](#)")).toBe("\"[x](#)\";\n```\ny");
    expect(stream.flush()).toBe("");
  });

  it("releases a held candidate as literal text when the stream ends inside it", () => {
    const { policy } = keepOnly();
    const stream = new MarkdownLinkGuardStream(policy);

    expect(stream.push("See [Course](unfinished")).toBe("See ");
    expect(stream.flush()).toBe("[Course](unfinished");
    expect(stream.unwrapped).toEqual([]);
  });
  it("holds a bare address until its end is known, and never releases part of a rejected one", () => {
    const { policy } = keepOnly();

    const { released } = streamed(["Visit htt", "ps://inv", "ented.exam", "ple/x and more"], policy);

    expect(released).toEqual(["Visit ", "", "", "and ", "more"]);
  });

  it("releases text that only begins like an address as soon as it cannot become one", () => {
    const { policy } = keepOnly();
    const stream = new MarkdownLinkGuardStream(policy);

    expect(stream.push("We went to w")).toBe("We went to ");
    expect(stream.push("here and h")).toBe("where and ");
    // The last word waits: an `@` after it would make it the start of an email address.
    expect(stream.push("ello")).toBe("");
    expect(stream.flush()).toBe("hello");
  });

  describe("reading what it holds", () => {
    const drip = (text: string, size: number, stream: MarkdownLinkGuardStream<"rejected">): string => {
      let released = "";
      for (let offset = 0; offset < text.length; offset += size) {
        released += stream.push(text.slice(offset, offset + size));
      }
      return released + stream.flush();
    };

    const scannedFor = (build: (size: number) => string, size: number): number => {
      const { policy } = keepOnly();
      const stream = new MarkdownLinkGuardStream(policy);
      drip(build(size), 4, stream);
      return stream.scannedCharacters;
    };

    it.each([
      ["a stray bracket", (size: number) => `Use [ then ${"z".repeat(size)}`, 20_000],
      ["a stray backtick", (size: number) => `Run \` then ${"z".repeat(size)}`, 20_000],
      ["an unclosed destination", (size: number) => `See [x](${"z".repeat(size)}`, 1_500],
      ["a long address", (size: number) => `See https://kept.example/${"z".repeat(size)}`, 1_500],
    ])("reads %s in time linear in its length, token by token", (_name, build, size) => {
      // Rereading the held text on every token would make doubling the text quadruple the reads.
      expect(scannedFor(build, size * 2) / scannedFor(build, size)).toBeLessThan(2.3);
    });

    it("releases text held behind a stray bracket once the bound is passed, and the same text as a whole", () => {
      const { policy } = keepOnly();
      const stream = new MarkdownLinkGuardStream(policy);
      const text = `Use [ then ${"z".repeat(20_000)} end`;

      let released = "";
      for (let offset = 0; offset < text.length; offset += 50) {
        released += stream.push(text.slice(offset, offset + 50));
      }

      expect(released.length).toBeGreaterThan(text.length - 1100);
      expect(released + stream.flush()).toBe(guardMarkdownLinks(text, policy).text);
    });

    it("still checks the address that closes text abandoned at the bound", () => {
      const { policy } = keepOnly();
      const stream = new MarkdownLinkGuardStream(policy);
      const text = `[${"z".repeat(1500)}](https://invented.example/) after`;

      expect(drip(text, 7, stream)).toBe(`[${"z".repeat(1500)}] after`);
      expect(stream.unwrapped).toEqual(["rejected"]);
    });
  });
});
