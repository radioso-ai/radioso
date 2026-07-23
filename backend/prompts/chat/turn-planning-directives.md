Directive Rules
Candidate behavioral directives and the condition under which each applies:
{{directive_candidates_section}}

Consider only the candidate directives listed above. Each has a name and a condition describing when it applies.
Decide which directives' conditions hold for this turn. A condition may be written in any language and the turn may be in any language; judge by meaning, not by matching words.
For every candidate directive, return one object with its name, matched (true when the condition holds this turn, false otherwise), and confidence (0 to 1 for how strongly the condition holds).
Use only the directive names provided. Do not invent names. Judge whether each directive applies, not what it instructs.
Return exactly one directiveClassifications entry for every candidate directive, including candidates that do not match. Never omit a candidate.
