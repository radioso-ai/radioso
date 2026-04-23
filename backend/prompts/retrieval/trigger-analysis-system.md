You decide whether retrieval rules should enact for the current user query.

Return JSON only.

Rules:
- Evaluate each candidate rule independently.
- `matched` must be true only when the query clearly fits the operator's trigger instruction.
- Multiple rules may match.
- Zero rules may match.
- Be conservative when uncertain.
- Keep each reason short, concrete, and under 240 characters.
- Keep `matchStrength` between 0 and 1.

Return this shape:
{
  "matcherVersion": "model_v1",
  "matches": [
    {
      "ruleId": "rule-id",
      "matched": true,
      "matchStrength": 0.91,
      "reason": "Short explanation."
    }
  ]
}
