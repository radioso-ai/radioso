import { describe, expect, it } from "vitest";

import { AnswerLinkGuard } from "../../../src/modules/chat/services/answerLinkGuard.js";
import { stripCitationAnchorSyntax } from "../../../src/modules/chat/services/citationAnchorSyntax.js";
import { StreamedAnswerText } from "../../../src/modules/chat/services/streamedAnswerText.js";

const guard = new AnswerLinkGuard({
  systemPrompt: "Speak for the school. Send visitors with questions to https://school.example/contact.",
  prompt: [
    "Result 1 (Il respiro consapevole): Source: https://school.example/courses/breath",
    "Three days of breath work, 260 euro.",
    "",
    "USER: and is there a silence course?",
  ].join("\n"),
});

const streamed = (chunks: string[]) => {
  const text = new StreamedAnswerText(guard.stream());
  return [...chunks.map((chunk) => text.push(chunk)), text.flush()];
};

describe("AnswerLinkGuard", () => {
  it("keeps links to addresses the prompt gave and unwraps the rest", () => {
    const guarded = guard.apply(
      "Join [Il respiro consapevole](https://school.example/courses/breath)[[1]]; [Il silenzio](#) is not listed[[?]]. "
        + "Ask via [our contact page](https://school.example/contact), not [Plans and Pricing](Plans and Pricing).",
    );

    expect(guarded.text).toBe(
      "Join [Il respiro consapevole](https://school.example/courses/breath)[[1]]; Il silenzio is not listed[[?]]. "
        + "Ask via [our contact page](https://school.example/contact), not Plans and Pricing.",
    );
    expect(guarded.unwrapped).toEqual(["fragment", "malformed"]);
  });

  it("unwraps an address the model made up", () => {
    expect(guard.apply("See [Il silenzio](https://example.org/silence)[[1]].")).toEqual({
      text: "See Il silenzio[[1]].",
      unwrapped: ["not_given"],
    });
  });

  it("keeps citation markers whole, inside an unwrapped link and before a parenthesis", () => {
    expect(guard.apply("[Il silenzio [[2]]](#)[[1]](dates to follow)").text)
      .toBe("Il silenzio [[2]][[1]](dates to follow)");
    expect(guard.apply("The fee is not listed[?](ask reception).").text)
      .toBe("The fee is not listed[[?]](ask reception).");
  });
});

describe("StreamedAnswerText", () => {
  const ANSWER =
    "Join [Il respiro consapevole](https://school.example/courses/breath)[[1]] or [Il silenzio](#)[[?]] this autumn[[1]].";

  it("releases the finished answer's guarded text with its markers removed, however it is split", () => {
    const expected = stripCitationAnchorSyntax(guard.apply(ANSWER).text, { endsAnswer: true });
    expect(expected).toBe("Join [Il respiro consapevole](https://school.example/courses/breath) or Il silenzio this autumn.");

    for (let split = 0; split <= ANSWER.length; split += 1) {
      expect(streamed([ANSWER.slice(0, split), ANSWER.slice(split)]).join(""), `split at ${split}`).toBe(expected);
    }
    expect(streamed(Array.from(ANSWER)).join("")).toBe(expected);
  });

  it("never releases any part of a link to an address the model was not given", () => {
    const released = streamed(["Ask about [Il sil", "enzio](https://exa", "mple.org/silence) today."]);

    expect(released).toEqual(["Ask about ", "", "Il silenzio today.", ""]);
  });
});
