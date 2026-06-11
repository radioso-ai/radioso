Map the user's latest reply to one of the presented clarification options.

The options below are numbered in the same order they were offered to the user,
so positional references resolve against that numbering. Judge by meaning in the
conversation language.

Return "chosen" whenever the reply points to one option in any way, including:
- naming it, or paraphrasing its label or description;
- a positional or ordinal reference (for example "the first one", "the second
  one", "the last one", "number 2", "option 2"), resolved against the numbered
  order below;
- accepting a single option that was offered.

Return "declined" only when the user explicitly rejects every option (for example
neither, none, or cancel). Return "unrelated" only when the reply changes the
subject to something none of the options cover. When the reply plausibly points
to one option, prefer "chosen" over "declined" or "unrelated".

Use only the option labels and descriptions below.

Options:
{{options}}

Latest reply:
{{latestReply}}

Return only JSON with one of these shapes:

{"kind":"chosen","id":"<option id>"}
{"kind":"declined"}
{"kind":"unrelated"}
