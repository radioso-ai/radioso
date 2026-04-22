# Website Embed

## Summary
Install a Radioso-owned launcher script that opens a hosted iframe assistant on approved websites.

## Details
Website Embed lets you place Radioso on your own site without shipping your own chat frontend.

- Turn it on for the workspace.
- Approve the website origins that are allowed to host it.
- Copy the generated script tag into the site.
- Rotate the embed token if the snippet is ever exposed somewhere you no longer trust.

The launcher script stays thin. The actual assistant runs inside a Radioso-hosted iframe so the browser trust boundary stays under Radioso control.

You can also add optional static attributes to the script tag on the host site:

- `data-radioso-locale="it-IT"` overrides common widget copy and the new-conversation bootstrap locale.
- `data-radioso-initial-state="open"` starts the widget expanded instead of collapsed.
- `data-radioso-avatar-url="https://cdn.example.com/avatar.gif"` uses an image or GIF for both the launcher and the assistant avatar inside the hosted chat.
- `data-radioso-copy='{"publicChatEmptyTitle":"Ask anything","startPrompt":"Type here..."}'` overrides any static chat text shown by the hosted UI.
- `data-radioso-theme='{"accent":"#112233","panelBackground":"#f8fafc","userBubbleBackground":"#112233"}'` overrides launcher, panel, input, and message colors so the hosted UI can match the customer theme.

Visitors can start a fresh conversation from the widget itself without re-installing the snippet.
