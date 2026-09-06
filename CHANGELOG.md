# Changelog

Every release cut from `main`, newest first. Entries are generated from Conventional Commit
subjects by `scripts/release/cut-release.mjs`, so a subject that reaches main is the one an
operator reads here. The TypeScript SDK versions independently under its own
`typescript-sdk-v*` tags and is not listed below.

Cut a release with the **Cut Release** workflow. It reads the commits since the previous `v*`
tag, writes the entry above this line, tags the commit, and publishes a GitHub Release. A
deploy then ships a release that already exists; it never mints one.
