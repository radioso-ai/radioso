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
