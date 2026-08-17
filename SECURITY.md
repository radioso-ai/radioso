# Security Policy

We take security issues in Radioso seriously and appreciate reports from the community.

## Reporting a vulnerability

Please report vulnerabilities privately. Do not open a public GitHub issue, pull request, or discussion for a security problem, because that discloses it before a fix is available.

Two private channels work:

- Email **security@radioso.ai**.
- Or open a [GitHub private security advisory](https://github.com/radioso-ai/radioso/security/advisories/new) for this repository.

A useful report includes:

- The affected component (backend API, worker, frontend, SDK, MCP server, or a package) and version or commit.
- Steps to reproduce, or a proof of concept.
- The impact you observed — what an attacker can read, change, or reach.
- Any suggested remediation, if you have one.

## What to expect

- We acknowledge your report within three business days.
- We investigate, confirm the issue, and keep you updated on progress toward a fix.
- We credit reporters who want credit once a fix ships. Let us know your preference.

Please give us reasonable time to release a fix before any public disclosure.

## Scope

This policy covers the code in this repository, including the open-source edition and the Enterprise Edition packages under [`ee/`](./ee). Radioso is self-hosted, so the security of a given deployment also depends on how it is configured and operated — the [readme](./readme.md) and the docs under [`docs/`](./docs) cover the authentication, token, and storage settings operators are expected to set.
