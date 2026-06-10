Map the user's latest reply to one of the presented clarification options.

Judge by meaning in the conversation language. The user may answer with a label,
an ordinal choice, a paraphrase, a decline such as neither/none, or an unrelated
topic change. Use only the option labels and descriptions below.

Options:
{{options}}

Latest reply:
{{latestReply}}

Return only JSON with one of these shapes:

{"kind":"chosen","id":"<option id>"}
{"kind":"declined"}
{"kind":"unrelated"}
