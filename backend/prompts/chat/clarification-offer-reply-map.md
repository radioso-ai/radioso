Map the user's latest reply after an answer offered alternative interpretations.

The options below are numbered in the same order they were offered to the user,
so positional references resolve against that numbering. Judge by meaning in the
conversation language.

Return "chosen" only when the reply is selection-only: it picks one offered
option without adding a new substantive question, request, task, or information
need. Selection-only replies can name an option, paraphrase its label or
description, use a positional or ordinal reference, or accept a single offered
option.

Return "unrelated" when the reply asks a new substantive question or makes a new
request, even if it names, paraphrases, or refers to one of the offered options.
The new turn should be handled normally instead of replaying the old question.

Return "declined" only when the user explicitly rejects every option.

Use only the option labels and descriptions below.

Options:
{{options}}

Latest reply:
{{latestReply}}

Return only JSON with one of these shapes:

{"kind":"chosen","id":"<option id>"}
{"kind":"declined"}
{"kind":"unrelated"}
