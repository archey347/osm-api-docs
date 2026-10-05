# Contributing

There are three ways to help: report a problem, check the spec against your own OSM traffic, or edit the spec
directly. All three are welcome.

## 1. Open an issue

If a call is missing or something in the spec is wrong, open an issue. Say which call, what's wrong, and what you
expect. Don't paste real data from OSM replies; describe the structure ("`data` is an array of objects with a
`sectionid` string") instead.

## 2. Contribute observations

Most calls are **inferred** from OSM's client-side code, so their parameters and replies are educated guesses. If you
use OSM, your own traffic can confirm or correct them.

1. In your browser's dev tools, open the Network tab, use the parts of OSM you want to check, and save the requests as
   a HAR file. Keep it outside this repo.
2. Scan it locally:

   ```
   bun install
   bun run scan -- my-capture.har
   ```

   This marks the calls it saw as **observed** in their call files, and writes a report of where real replies differ
   from the spec to `.cache/observation-scan.md`. The report holds structure only (field names and types), never
   values, and the capture itself never leaves your machine.

   I'd recommend using your favourite AI code editor to do this and the steps below for you, using the skill at
   [`.claude/skills/record-osm-observations/SKILL.md`](.claude/skills/record-osm-observations/SKILL.md).
3. Fix the differences the report lists in the call and schema files (see [Edit a call](#3-edit-a-call)), or, if you'd
   rather not edit them, open an issue describing them.
4. Open a PR with the updated call files, following [Before opening a PR](#before-opening-a-pr).

## 3. Edit a call

The spec is built from the files in `calls/`, `schemas/` and `templates/`. Edit those, not `openapi.yaml`. Layout and
fields are in [FORMAT.md](FORMAT.md). The `update-osm-api-spec` skill for Claude Code follows these steps.

- Never delete a call; set `deprecated` instead.
- Examples must use fictional data (invented names, ids like `1001`). Never copy values from real OSM traffic.

## Before opening a PR

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
