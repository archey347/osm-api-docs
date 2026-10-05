---
name: record-osm-observations
description: Scan your own HAR captures (or shape logs) for OSM API calls actually seen, review how observed replies differ from the docs, and hand observed labels and schema fixes to update-osm-api-spec.
---

# Record OSM observations

Rules are in `update-osm-api-spec`: no live OSM requests from here, structure only, no push. Observed beats inferred.

**Captures never leave your machine.** HAR files hold personal data: never commit them, attach them to issues or PRs, or paste values from them. Only structure (field names and types) goes into the repo.

## Inputs

- HAR captures you made yourself (browser dev tools, "Save all as HAR").
- Shape logs: JSONL of key paths and JSON types per request, no values (format in `FORMAT.md`, "Shape logs").

## 1. Scan

```
bun run scan -- <capture.har> [<shapes.jsonl> ...] --json
```

Or list inputs once in a git-ignored `scan.local.json`, `{ "inputs": ["path/or/*.har"] }`, and run `bun run scan -- --json`. `--dry-run` writes nothing.

It marks calls seen in traffic `source: observed` with `observed_on` (latest date) in `calls/`, writes `.cache/observation-scan.md` (structure only), and prints `labelChanges`, `rejected`, `structuralDifferences`, `unmatched`.

## 2. Review

- `labelChanges`: sanity-check; a call is observed only when every seen parameter name is documented.
- `structuralDifferences`: seen-but-undocumented fields, type mismatches, documented-but-never-seen. Fix the docs to match what was seen, but a field never seen in a small sample is not evidence it is wrong.
- `rejected` (scan exits non-zero): the observed structure fails the strict validator. Widen the schema: add seen fields and types, `nullable`, alternative types; never remove documented fields, never copy values.
- `unmatched`: possibly undocumented calls; add as new `inferred`/`unknown` calls via `update-osm-api-spec`, or mention in an issue.

## 3. Hand off

Invoke `update-osm-api-spec` with the label changes, schema fixes and unmatched calls. Don't include the scan report in a PR unless you have read it for personal data first.
