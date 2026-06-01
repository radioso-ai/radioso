import { describe, expect, it } from "vitest";

import { AnswerPresentationService } from "../../src/modules/chat/services/answerPresentationService.js";

describe("answer presentation service", () => {
  it("normalize() retains citation evidence and segments", () => {
    const service = new AnswerPresentationService();

    const normalized = service.normalize({
      answer: "Arudra is a leader[[1]].",
      citations: [
        {
          documentId: "doc-1",
          chunkId: "chunk-1",
          title: "Arudra",
          content: "Arudra is a leader.",
        },
      ],
    });

    expect(normalized).toEqual({
      answer: "Arudra is a leader.",
      citationEvidence: [
        {
          documentId: "doc-1",
          chunkId: "chunk-1",
          title: "Arudra",
          content: "Arudra is a leader.",
        },
      ],
      answerSegments: [
        {
          text: "Arudra is a leader",
          citationIndices: [0],
        },
        {
          text: ".",
        },
      ],
    });
  });

  it("present() emits citations for resolved anchors", () => {
    const service = new AnswerPresentationService();

    const result = service.present({
      answer: "Arudra is a leader[[1]].",
      citations: [
        {
          documentId: "doc-1",
          chunkId: "chunk-1",
          title: "Arudra",
          content: "Arudra is a leader.",
        },
      ],
    });

    expect(result).toEqual({
      answer: "Arudra is a leader.",
      citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Arudra" }],
      answerSegments: [
        { text: "Arudra is a leader", citationIndices: [0] },
        { text: "." },
      ],
    });
  });

  it("removes spaces left between stripped citation anchors and punctuation", () => {
    const service = new AnswerPresentationService();

    const result = service.present({
      answer: "Ananda Yoga can lead naturally into meditation[[1]] . It also supports inner silence[[1]] .",
      citations: [
        {
          documentId: "doc-1",
          chunkId: "chunk-1",
          title: "Ananda Yoga",
          content: "Ananda Yoga can lead naturally into meditation and supports inner silence.",
        },
      ],
    });

    expect(result.answer).toBe(
      "Ananda Yoga can lead naturally into meditation. It also supports inner silence.",
    );
  });

  it("adds punctuation when a terminal markdown link is followed by a new sentence", () => {
    const service = new AnswerPresentationService();

    const result = service.present({
      answer:
        "You can explore the main overview here: [Meditation and Kriya Yoga](https://anandaeurope.org/meditation-and-kriya-yoga) \nIf you want to look at course options, here are the residential pages: [Il sentiero del Kriya Yoga 4 giorni](https://corsi.ananda.it/corso/0007963-corso-residenziale-il-sentiero-del-kriya-yoga-4-giorni) and [Il sentiero del Kriya Yoga 5 giorni](https://corsi.ananda.it/en/course/0007995-corso-residenziale-il-sentiero-del-kriya-yoga-5-days) ",
      citations: [],
    });

    expect(result).toEqual({
      answer:
        "You can explore the main overview here: [Meditation and Kriya Yoga](https://anandaeurope.org/meditation-and-kriya-yoga).\nIf you want to look at course options, here are the residential pages: [Il sentiero del Kriya Yoga 4 giorni](https://corsi.ananda.it/corso/0007963-corso-residenziale-il-sentiero-del-kriya-yoga-4-giorni) and [Il sentiero del Kriya Yoga 5 giorni](https://corsi.ananda.it/en/course/0007995-corso-residenziale-il-sentiero-del-kriya-yoga-5-days)",
    });
  });

  it("uses explicit anchors for exact citation placement", () => {
    const service = new AnswerPresentationService();

    const result = service.present({
      answer:
        "Arudra is a leader/facilitator featured by Ananda Europe[[1]], leads morning meditations and Purification ceremonies[[2]], and events are offered in Italian and English[[3]].",
      citations: [
        {
          documentId: "doc-1",
          chunkId: "chunk-1",
          title: "Profile",
          content: "Arudra is a leader/facilitator featured by Ananda Europe.",
        },
        {
          documentId: "doc-2",
          chunkId: "chunk-2",
          title: "Program",
          content: "Arudra leads morning meditations and Purification ceremonies.",
        },
        {
          documentId: "doc-3",
          chunkId: "chunk-3",
          title: "Languages",
          content: "Events are offered in Italian and English.",
        },
      ],
    });

    expect(result.answer).toBe(
      "Arudra is a leader/facilitator featured by Ananda Europe, leads morning meditations and Purification ceremonies, and events are offered in Italian and English.",
    );
    expect(result.citations).toEqual([
      { documentId: "doc-1", chunkId: "chunk-1", title: "Profile" },
      { documentId: "doc-2", chunkId: "chunk-2", title: "Program" },
      { documentId: "doc-3", chunkId: "chunk-3", title: "Languages" },
    ]);
    expect(result.answerSegments).toEqual([
      {
        text: "Arudra is a leader/facilitator featured by Ananda Europe",
        citationIndices: [0],
      },
      {
        text: ", leads morning meditations and Purification ceremonies",
        citationIndices: [1],
      },
      {
        text: ", and events are offered in Italian and English",
        citationIndices: [2],
      },
      {
        text: ".",
      },
    ]);
  });

  it("keeps all distinct cited documents at a claim boundary", () => {
    const service = new AnswerPresentationService();

    const result = service.present({
      answer: "Narayani's books are available from Ananda Edizioni[[1]][[2]].",
      citations: [
        {
          documentId: "doc-1",
          chunkId: "chunk-1",
          title: "Narayani Anaya",
          content: "Narayani's books are available from Ananda Edizioni.",
        },
        {
          documentId: "doc-2",
          chunkId: "chunk-2",
          title: "Ananda Edizioni",
          content: "The author page lists several books and bundles.",
        },
      ],
    });

    expect(result.answer).toBe("Narayani's books are available from Ananda Edizioni.");
    expect(result.citations).toEqual([
      { documentId: "doc-1", chunkId: "chunk-1", title: "Narayani Anaya" },
      { documentId: "doc-2", chunkId: "chunk-2", title: "Ananda Edizioni" },
    ]);
    expect(result.answerSegments).toEqual([
      {
        text: "Narayani's books are available from Ananda Edizioni",
        citationIndices: [0, 1],
      },
      {
        text: ".",
      },
    ]);
  });

  it("preserves natural single-bracket numeric text", () => {
    const service = new AnswerPresentationService();

    const result = service.present({
      answer: "Read [1](https://example.com), inspect arr[0], and keep the [2024] label.",
      citations: [],
    });

    expect(result).toEqual({
      answer: "Read [1](https://example.com), inspect arr[0], and keep the [2024] label.",
    });
  });

  it("falls through to later valid anchors and keeps all distinct cited documents", () => {
    const service = new AnswerPresentationService();

    const result = service.present({
      answer: "The retreat is offered in Assisi[[9]][[2]][[3]].",
      citations: [
        {
          documentId: "doc-1",
          chunkId: "chunk-1",
          title: "Placeholder",
          content: "Unused context.",
        },
        {
          documentId: "doc-2",
          chunkId: "chunk-2",
          title: "Retreat Calendar",
          content: "The retreat is offered in Assisi.",
        },
        {
          documentId: "doc-3",
          chunkId: "chunk-3",
          title: "Venue Guide",
          content: "The retreat venue is in Assisi.",
        },
      ],
    });

    expect(result.answer).toBe("The retreat is offered in Assisi.");
    expect(result.citations).toEqual([
      { documentId: "doc-2", chunkId: "chunk-2", title: "Retreat Calendar" },
      { documentId: "doc-3", chunkId: "chunk-3", title: "Venue Guide" },
    ]);
    expect(result.answerSegments).toEqual([
      {
        text: "The retreat is offered in Assisi",
        citationIndices: [0, 1],
      },
      {
        text: ".",
      },
    ]);
  });

  it("deduplicates repeated documents within a grouped anchor", () => {
    const service = new AnswerPresentationService();

    const result = service.present({
      answer: "Narayani's books are available from Ananda Edizioni[[1]][[2]][[3]].",
      citations: [
        {
          documentId: "doc-1",
          chunkId: "chunk-1",
          title: "Narayani Anaya",
          content: "Narayani's books are available from Ananda Edizioni.",
        },
        {
          documentId: "doc-1",
          chunkId: "chunk-2",
          title: "Narayani Anaya",
          content: "The author page lists several books and bundles.",
        },
        {
          documentId: "doc-2",
          chunkId: "chunk-3",
          title: "Ananda Edizioni",
          content: "Narayani's books are available from Ananda Edizioni.",
        },
      ],
    });

    expect(result.answer).toBe("Narayani's books are available from Ananda Edizioni.");
    expect(result.citations).toEqual([
      { documentId: "doc-1", chunkId: "chunk-1", title: "Narayani Anaya" },
      { documentId: "doc-2", chunkId: "chunk-3", title: "Ananda Edizioni" },
    ]);
    expect(result.answerSegments).toEqual([
      {
        text: "Narayani's books are available from Ananda Edizioni",
        citationIndices: [0, 1],
      },
      {
        text: ".",
      },
    ]);
  });

  it("drops invalid anchors and removes malformed placeholder syntax from the final answer", () => {
    const service = new AnswerPresentationService();

    const result = service.present({
      answer: "Author page: https://anandaedizioni.it/autore/narayani-anaya[[1]]. Price: EUR 18,00[[9]]. Broken [[abc]] token and dangling [[ marker.",
      citations: [
        {
          documentId: "doc-1",
          chunkId: "chunk-1",
          title: "Narayani Anaya",
          content: "Author page: https://anandaedizioni.it/autore/narayani-anaya.",
        },
      ],
    });

    expect(result.answer).toBe(
      "Author page: https://anandaedizioni.it/autore/narayani-anaya. Price: EUR 18,00. Broken  token and dangling  marker.",
    );
    expect(result.citations).toEqual([
      { documentId: "doc-1", chunkId: "chunk-1", title: "Narayani Anaya" },
    ]);
    expect(result.answerSegments).toEqual([
      {
        text: "Author page: https://anandaedizioni.it/autore/narayani-anaya",
        citationIndices: [0],
      },
      {
        text: ". Price: EUR 18,00. Broken  token and dangling  marker.",
      },
    ]);
  });

  it("collapses consecutive claims that cite the same document into one visible citation", () => {
    const service = new AnswerPresentationService();

    const result = service.present({
      answer: "Arudra leads morning meditations[[1]]. He also leads Purification ceremonies[[1]].",
      citations: [
        {
          documentId: "doc-1",
          chunkId: "chunk-1",
          title: "Program",
          content: "Arudra leads morning meditations and Purification ceremonies.",
        },
      ],
    });

    expect(result.answer).toBe(
      "Arudra leads morning meditations. He also leads Purification ceremonies.",
    );
    expect(result.citations).toEqual([
      { documentId: "doc-1", chunkId: "chunk-1", title: "Program" },
    ]);
    expect(result.answerSegments).toEqual([
      {
        text: "Arudra leads morning meditations. He also leads Purification ceremonies",
        citationIndices: [0],
      },
      {
        text: ".",
      },
    ]);
  });

  it("keeps separate citation markers when the same source spans multiple paragraphs", () => {
    const service = new AnswerPresentationService();

    const result = service.present({
      answer: "First grounded paragraph[[1]].\n\nSecond grounded paragraph[[1]].",
      citations: [
        {
          documentId: "doc-1",
          chunkId: "chunk-1",
          title: "Guide",
          content: "First grounded paragraph. Second grounded paragraph.",
        },
      ],
    });

    expect(result.answerSegments).toEqual([
      {
        text: "First grounded paragraph",
        citationIndices: [0],
      },
      {
        text: ".\n\nSecond grounded paragraph",
        citationIndices: [0],
      },
      {
        text: ".",
      },
    ]);
  });

  it("reflows orphaned punctuation when an anchor sat on its own line after a paragraph break", () => {
    const service = new AnswerPresentationService();

    const result = service.present({
      answer:
        "It is a science that releases karma when practiced consistently\n\n[[1]].\n\nAnanda Europe teaches Kriya.",
      citations: [
        {
          documentId: "doc-1",
          chunkId: "chunk-1",
          title: "Kriya Yoga",
          content: "It is a science that releases karma when practiced consistently.",
        },
      ],
    });

    expect(result.answer).toBe(
      "It is a science that releases karma when practiced consistently.\n\nAnanda Europe teaches Kriya.",
    );
    expect(result.answerSegments).toEqual([
      {
        text: "It is a science that releases karma when practiced consistently",
        citationIndices: [0],
      },
      {
        text: ".\n\nAnanda Europe teaches Kriya.",
      },
    ]);
  });

  it("reattaches a trailing link list that followed a standalone citation anchor", () => {
    const service = new AnswerPresentationService();

    const result = service.present({
      answer:
        "See our course pages for details\n\n[[1]] ; [Kriya Yoga intro and practice](https://example.com/intro).",
      citations: [
        {
          documentId: "doc-1",
          chunkId: "chunk-1",
          title: "Kriya Yoga intro",
          content: "See our course pages for details.",
        },
      ],
    });

    expect(result.answer).toBe(
      "See our course pages for details; [Kriya Yoga intro and practice](https://example.com/intro).",
    );
  });

  it("present() preserves sourceUrl on emitted citations", () => {
    const service = new AnswerPresentationService();

    const result = service.present({
      answer: "Radioso is self-hosted[[1]].",
      citations: [
        {
          documentId: "doc-1",
          chunkId: "chunk-1",
          title: "Radioso overview",
          content: "Radioso is self-hosted.",
          sourceUrl: "https://example.com/overview",
        },
      ],
    });

    expect(result.citations).toEqual([
      {
        documentId: "doc-1",
        chunkId: "chunk-1",
        title: "Radioso overview",
        sourceUrl: "https://example.com/overview",
      },
    ]);
  });

  it("present() omits sourceUrl when the evidence has none", () => {
    const service = new AnswerPresentationService();

    const result = service.present({
      answer: "Radioso is self-hosted[[1]].",
      citations: [
        {
          documentId: "doc-1",
          chunkId: "chunk-1",
          title: "Radioso overview",
          content: "Radioso is self-hosted.",
        },
      ],
    });

    expect(result.citations).toEqual([
      {
        documentId: "doc-1",
        chunkId: "chunk-1",
        title: "Radioso overview",
      },
    ]);
  });
});
