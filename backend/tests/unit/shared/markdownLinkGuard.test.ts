import { describe, expect, it } from "vitest";

import {
  guardMarkdownLinks,
  MarkdownLinkGuardStream,
  type LinkDestinationPolicy,
  type MarkdownRange,
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
    const answer = "Use arr[0], see [note] (below), [a]\n(b), [ref][1], and [x](\ny).";

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

  it("reads declared ranges as opaque text, inside a link or after one", () => {
    const { policy, asked } = keepOnly();
    const answer = "[Course [[1]]](#)[[2]] costs 260 euro[[3]](room included).";
    const anchors: MarkdownRange[] = [...answer.matchAll(/\[\[\d\]\]/g)].map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
    }));

    const guarded = guardMarkdownLinks(answer, policy, { ignoredRanges: anchors });

    expect(guarded.text).toBe("Course [[1]][[2]] costs 260 euro[[3]](room included).");
    expect(asked).toEqual(["#"]);
  });

  it("leaves a link whose text runs past the bound unread", () => {
    const { policy, asked } = keepOnly();
    const answer = `[${"x".repeat(2000)}](#)`;

    expect(guardMarkdownLinks(answer, policy).text).toBe(answer);
    expect(asked).toEqual([]);
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

    expect(released).toEqual(["Join ", "", "", "Il respiro consapevole in November.", ""]);
  });

  it("releases a bracket as soon as it cannot become a link", () => {
    const { policy } = keepOnly();
    const stream = new MarkdownLinkGuardStream(policy);

    expect(stream.push("Index arr[0]")).toBe("Index arr");
    expect(stream.push(" is first")).toBe("[0] is first");
    expect(stream.flush()).toBe("");
  });

  it("releases a held candidate as literal text when the stream ends inside it", () => {
    const { policy } = keepOnly();
    const stream = new MarkdownLinkGuardStream(policy);

    expect(stream.push("See [Course](https://unfinished")).toBe("See ");
    expect(stream.flush()).toBe("[Course](https://unfinished");
    expect(stream.unwrapped).toEqual([]);
  });
});
