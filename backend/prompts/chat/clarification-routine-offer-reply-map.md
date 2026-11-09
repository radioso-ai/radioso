Map the user's latest reply after an answer that ended by offering to start something for them.

The offer is listed below. Judge by meaning in the conversation language.

Return "chosen" with the offer's id when the reply accepts the offer: it agrees to go ahead,
asks to start, or answers the offer with details for it. A reply that accepts and adds a
detail or a small related question still accepts.

Return "declined" when the reply turns the offer down.

Return "unrelated" when the reply neither accepts nor declines: it asks about something
else, keeps exploring, or leaves the offer unanswered.

Use only the offer's label and description below.

Offer:
{{options}}

Latest reply:
{{latestReply}}

Return only JSON with one of these shapes:

{"kind":"chosen","id":"<option id>"}
{"kind":"declined"}
{"kind":"unrelated"}
