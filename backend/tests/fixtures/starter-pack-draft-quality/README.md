# Starter pack draft-quality fixtures

Recorded model completions for the agent starter pack draft (`POST /api/v1/agents/{agentId}/starter-pack/draft`, issue #1158). The eval at `backend/tests/unit/eval-suite/starter-pack-draft-quality.test.ts` replays each case through the real draft path: the response-language detector, the pack generator, the routine draft assist, and the draft service. Only the model call is replaced, so the eval is deterministic and runs in normal CI.

Each case in `cases.ts` holds a purpose, the detector's raw answer, the pack completions in call order (a second one is the JSON retry), and the routine draft-assist completions. Every case must pass these checks:

- the output language matches the detected language, and both the pack prompt and the routine prompt carry its instruction
- exactly one routine, and it validates
- one to six directives, with unique names, none reserved by a built-in directive, and none already used on the agent
- every directive passes the apply contract
- a pack the model never gets right is rejected with `invalid_starter_pack_draft`, not returned

There is no baseline file. A baseline absorbs sampling noise in a live run, and replaying recorded completions has none.

To add a case, record the raw completions a real model gave for a purpose, add them to `cases.ts` with tags for what the case covers, and run:

```bash
cd backend
pnpm exec vitest run tests/unit/eval-suite/starter-pack-draft-quality.test.ts
```
