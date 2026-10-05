# Contributing

There are three ways to help.

## 1. Open an issue

If a call is missing or something in the spec is wrong, open an issue. Say which call, what's wrong, and what you
expect. Don't paste real data from OSM replies; describe the structure ("`data` is an array of objects with a
`sectionid` string") instead.

## 2. Contribute observations

If you use OSM, you can improve the spec from your own traffic. Save a HAR capture from your browser's dev tools and
scan it locally:

```
bun run scan -- my-capture.har
```

This marks the calls you saw as **observed** and writes a report of how real replies differ from the docs
(`.cache/observation-scan.md`, structure only). Fix the differences in the call and schema files (see
[Edit a call](#3-edit-a-call)), then open a PR. See the `record-osm-observations` skill.

## 3. Edit a call

The spec is built from the files in `calls/`, `schemas/` and `templates/`. Edit those, not `openapi.yaml`. Layout and
fields are in [FORMAT.md](FORMAT.md). There is also an `update-osm-api-spec` skill for Claude Code that follows these
steps.

- Never delete a call; set `deprecated` instead.
- Examples must use fictional data (invented names, ids like `1001`). Never copy values from real OSM traffic.

Before opening a PR:

```
bun install
bun run check -- --examples
bun run gen:openapi
bun run lint
bun test
```

Commit the rebuilt `openapi.yaml` with your changes.

## Never submit captures or personal data

OSM replies contain data about young people and their families. Never commit a HAR file or shape log, attach one to
an issue or PR, or paste real names, emails, phone numbers, addresses or ids anywhere. Captures stay on your machine.
