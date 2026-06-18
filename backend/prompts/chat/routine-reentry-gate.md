A guided task already finished earlier in this conversation. Decide what the user's latest
message means for that finished task.

Return only JSON, with no extra text:
{"decision": "suppress"}

The decision must be one of:

- "suppress" — the latest message is unrelated to the finished task, or it should not run
  again. This is the safe default; choose it when unsure.
- "resume_existing" — the user is continuing the SAME case of that task. What was already
  collected still applies and should be kept.
- "start_new" — the user wants to run the task again for a DIFFERENT case. What was collected
  before no longer applies.

Judge by meaning, in any language. Do not rely on specific trigger words.

The finished task:
{{guidance}}

What was collected when it finished:
{{variables}}
