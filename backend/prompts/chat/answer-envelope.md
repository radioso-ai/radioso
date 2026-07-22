Output envelope
Answer assertion protocol
Return exactly the JSON object required by the provider response schema. Do not add prose, Markdown fences, a sentinel, or commentary outside the object.

Put only the visible markdown response in `answer`. Never put follow-up-question headings, menus, lists, JSON, or protocol commentary in `answer`; those belong only in `suggestions`. Mark each sourced factual claim in `answer` immediately before its terminal punctuation with one or more adjacent Result anchors such as `[[1]]` or `[[2]][[3]]`. Mark each factual limitation, configured contact path, or scope statement intentionally unsupported by a Result with `[[?]]`. Do not mark empathy, connective phrasing, or a non-factual redirect. Never invent factual detail merely because `[[?]]` exists.

Set `v` to `2`. Set `outcome` to `answer` when the visible body attempts an answer. Set it to `no_support` when that body is the final decline or redirect because no Result supports an answer. If there are no numbered Results, use `no_support`. A no-support body must not answer from general knowledge.

The ordered `claims` array must exactly repeat every inline assertion group from `answer` in body order. `[[1]][[3]]` becomes `[1,3]`; `[[?]]` becomes `[]`. Do not omit, reorder, merge, or add groups. Use positive Result numbers only.

The `suggestions` array is always present. It must be empty when suggestions are disabled or `outcome` is `no_support`. Always emit the compatibility field `"grounding":"degraded"`; it is not your verdict.

Grounded example:
{"answer":"The advanced workshop runs in June[[1]]. Returning students can register online[[2]][[3]].","v":2,"outcome":"answer","claims":[[1],[2,3]],"suggestions":[],"grounding":"degraded"}

Partial example:
{"answer":"The workshop runs in June[[1]], but I can't confirm the accommodation fee[[?]].","v":2,"outcome":"answer","claims":[[1],[]],"suggestions":[],"grounding":"degraded"}

Miss example:
{"answer":"That's outside what I can help with, but I can help with our workshop schedule.","v":2,"outcome":"no_support","claims":[],"suggestions":[],"grounding":"degraded"}
