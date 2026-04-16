# Quickstart: Conversation Modes

## Scenario 1: Guided is the default for an unsaved workspace

1. Start the backend with a workspace that has no stored `conversationMode`.
2. Fetch retrieval settings.
3. Confirm the settings payload includes `conversationMode: "guided"`.
4. Ask a supported question.
5. Confirm the answer is direct but may include a small focused continuation.

## Scenario 2: Factual mode suppresses optional exploration

1. Save `conversationMode: "factual"` for a workspace.
2. Ask a supported question with clear adjacent grounded topics available.
3. Confirm the answer responds to the asked question directly.
4. Confirm no optional focused or expansive discovery block is added.

## Scenario 3: Guided mode adds focused continuations

1. Save `conversationMode: "guided"` for a workspace.
2. Ask a supported question whose retrieved contexts clearly support one or two
   adjacent grounded directions.
3. Confirm the answer includes the direct answer plus at most two focused
   continuations.
4. Confirm the continuations are clearly optional and grounded in the retrieved
   material.

## Scenario 4: Exploratory mode adds expansive continuations

1. Save `conversationMode: "exploratory"` for a workspace.
2. Ask a supported question whose retrieved contexts support several nearby
   grounded avenues.
3. Confirm the answer includes:
   - the direct answer
   - two or three grounded avenues for further exploration
   - at most one optional grounded follow-up prompt
4. Confirm the exploratory content is recognizably discovery-oriented rather
   than just a slightly longer version of the direct answer.

## Scenario 5: User brevity override wins for the turn

1. Keep the workspace in `guided` or `exploratory` mode.
2. Ask a supported question phrased as `Just answer briefly:` or
   `Give me only the answer`.
3. Confirm the answer stays concise for that turn.
4. Confirm the stored workspace setting remains unchanged after the turn.

## Scenario 6: Strict support policy still wins on unsupported content

1. Save `conversationMode: "exploratory"` and keep
   `answerSupportPolicy: "strict"`.
2. Force a partially unsupported or fully unsupported answer path.
3. Confirm unsupported substantive content is still handled by the strict
   support policy.
4. Confirm any remaining pivot, recovery, or exploration content stays grounded
   in retrieved workspace material only.

## Scenario 7: History/debug surfaces expose conversation mode

1. Generate one factual, one guided, and one exploratory turn.
2. Inspect chat history or debug output.
3. Confirm each turn records the active conversation mode.
4. Confirm turns that included optional exploration record whether expansion was
   applied.
