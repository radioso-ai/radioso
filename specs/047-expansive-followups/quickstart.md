# Quickstart: History-Aware Expansive Suggestions

## Scenario 1: Exploratory Suggestions Follow Multi-Turn Intent

1. Start a conversation in exploratory mode.
2. Ask an initial subject-setting question.
3. Ask one or two follow-up questions that narrow the topic.
4. Confirm the final turn returns at least one broader suggestion that still
   widens from the established subject or task rather than only echoing the last
   assistant sentence.

## Scenario 2: Grouped Suggestions Render Correctly

1. Trigger an exploratory answer with enough grounded material for both groups.
2. Confirm the dashboard chat renders distinct deeper and broader suggestion
   groups.
3. Repeat through public chat and confirm equivalent grouping behavior.

## Scenario 3: Unsupported Broader Suggestions Are Omitted

1. Trigger an exploratory turn with grounded support for the direct answer but
   insufficient material for honest broader discovery.
2. Confirm the response omits broader suggestions instead of inserting generic
   filler.

## Scenario 4: Click Provenance Still Works

1. Click a deeper or broader suggestion from an assistant turn.
2. Confirm the next user turn is sent as a suggestion click tied to the source
   assistant message.

## Scenario 5: Brevity Override Still Suppresses Optional Suggestions

1. In exploratory mode, ask a supported question containing a directness request
   such as "just the answer".
2. Confirm the direct answer is returned without optional grouped suggestions.
