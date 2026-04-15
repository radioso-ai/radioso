# Quickstart: Assistant Bootstrap

## Scenario 1: Configure assistant bootstrap in General Settings

1. Start the app and open the dashboard for a workspace.
2. Open `Settings -> General`.
3. Save:
   - assistant name
   - assistant role
   - greeting instruction
   - default locale fallback
   - proactive greeting enabled
4. Reload the page.
5. Confirm the saved values round-trip for the same workspace only.

## Scenario 2: New authenticated chat greets in request locale

1. Configure assistant bootstrap with proactive greeting enabled.
2. Open a fresh authenticated chat with no existing conversation.
3. Trigger chat startup with `userExpectedLocale: "it-IT"`.
4. Confirm the first assistant turn appears before any user message.
5. Confirm the greeting reflects the configured persona and is written in Italian.

## Scenario 3: Existing conversation does not get duplicate greeting

1. Use the fresh chat from Scenario 2.
2. Send a normal user message.
3. Refresh the chat view or reopen the existing conversation.
4. Confirm no second bootstrap greeting is inserted.

## Scenario 4: Public chat uses the same persona with a different locale

1. Enable public chat for the same workspace.
2. Open the public chat link in a clean browser session.
3. Trigger startup with `userExpectedLocale: "en"`.
4. Confirm the first assistant turn appears and uses the same persona as the authenticated chat, but in English.

## Scenario 5: Invalid locale falls back safely

1. Start a fresh chat with an invalid locale hint such as `bad_locale_value`.
2. Confirm the request does not break chat startup.
3. Confirm the system either uses the workspace fallback locale or starts silently if no safe locale can be applied.

## Scenario 6: Greeting generation failure does not block manual chat

1. Configure proactive greeting for a workspace.
2. Simulate provider failure for greeting generation.
3. Open a fresh chat.
4. Confirm the user can still send a manual first message successfully.
