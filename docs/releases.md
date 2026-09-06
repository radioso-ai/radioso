---
title: "Cutting a Release"
description: "How Radioso versions itself: what a release names, how to cut one from main, and where the changelog comes from."
last_updated: 2026-09-06
---

# Cutting a Release

A release is a name for a commit on `main`. It is not a name for a deployment, and the difference matters here: Radioso serves more than one production stack, so a version minted at deploy time would either give one commit two numbers or quietly hide that one stack is three releases behind another. The tag comes first. A deploy then ships a release that already exists.

That gives you one thing you can point at in an incident — `v1.4.0` — and read the same answer from the tag, the changelog, the container image, and the running service.

## Cut one

Run the **Cut Release** workflow from `main` in GitHub Actions.

| Input | What it does |
|---|---|
| `bump` | `auto` reads the commit subjects since the last tag: a breaking change bumps major, a `feat` bumps minor, anything else bumps patch. Override with `patch`, `minor`, or `major` when you disagree. |
| `version` | An explicit version such as `1.0.0`. Overrides `bump`. |
| `since` | The commit or tag the release starts after. Defaults to the previous `v*` tag. |
| `dry_run` | On by default. Renders the notes into the run summary and changes nothing. |

Run it once with `dry_run` on, read the notes in the run summary, then run it again with `dry_run` off. The second run commits `CHANGELOG.md` and the workspace version, tags `v<version>`, and publishes a GitHub Release carrying the same notes.

To see the notes locally before you go near Actions:

```bash
node scripts/release/cut-release.mjs --dry-run
```

## What lands in the notes

`main` is squash-merged, and GitHub seeds each squashed commit subject from the pull request title. So the title you write on a pull request is the line an operator reads in the release that ships it. That is why CI checks it.

Subjects are filed by their Conventional Commit type:

- `feat` → **Added**
- `fix` → **Fixed**
- `perf` → **Performance**
- `revert` → **Reverted**
- `docs` → **Documentation**
- `refactor`, `chore`, `build`, `ci`, `style`, `test` → **Internal**

A subject marked `!`, or carrying a `BREAKING CHANGE:` footer, moves to **Breaking changes** at the top of the entry and forces a major bump. It appears there and nowhere else, so a reader skimming the section that exists to stop them cannot skim past it.

A subject the parser cannot read lands under **Other**. Nothing is dropped: a release that shipped a change lists it, even when the subject was written by hand.

When a release adds migrations under `backend/src/db/migrations/`, the entry lists them and reminds you to deploy one stack at a time. Migrations run at service startup, and overlapping deploys contend on the same DDL lock.

## Ship it

`Deploy Live (EU)` and `Deploy Live (US Legacy)` take a release tag and require one. That is the discipline the tag buys: production ships a version you can name, not whatever `main` happened to be when someone opened the Actions tab.

The input is free text, so the deploy checks it before it believes it. The value has to read as `v<major>.<minor>.<patch>`, name a tag that exists on `origin`, and resolve to the commit that was checked out — a branch sharing a tag's name wins a checkout, so the name alone proves nothing. The commit then has to be on `main`. A branch name, a bare SHA, or a tag someone cut off `main` fails all the way through rather than shipping as a release.

The deploy builds from the tag — so a release deployed a week after it was cut still ships the code it was cut from. Images are pushed under both the commit and the version:

```
europe-west1-docker.pkg.dev/<project>/radioso-live-eu/backend:5434e0eb6f2c1d...
europe-west1-docker.pkg.dev/<project>/radioso-live-eu/backend:v1.4.0
```

The release is stamped into the image, so the running service can tell you what it is:

```bash
curl https://api.radioso.ai/health
{"status":"ok","version":"1.4.0","commit":"5434e0eb6f2c1d..."}
```

Staging takes the same input and leaves it empty on a push, so a staging build reports `1.4.0+a1b2c3d` — the last release, plus the commit it actually runs. The same value reaches OpenTelemetry as `service.version`, so a span or metric can be attributed to the release that produced it.

Reading `/health` on each stack is the drift check. Two stacks are supposed to run the same release; when they don't, this is where you see it first.

## The first release

The generator reads commits between the previous `v*` tag and `HEAD`. Before the first tag exists there is no starting point, so give it one:

```
version: 1.0.0
since:   <the commit the first release starts after>
```

Every release after that needs neither input.

## The SDK versions separately

`@radioso/typescript-sdk` publishes on its own `typescript-sdk-v*` tags and its own cadence, because it tracks the API contract rather than the product. The product generator reads `v*` tags only, so the two never collide and SDK releases stay out of the product changelog. See `docs/api-contract-workflow.md` for how the SDK snapshot stays in step with the backend.
