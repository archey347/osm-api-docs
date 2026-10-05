---
name: update-osm-api-spec
description: Add, fix or deprecate calls in the OSM API spec sources (calls/, schemas/), check them, and build openapi.yaml. For contributors opening a PR and for the maintainer versioning a release. Also takes a list of calls found in OSM's front-end code, or observation results, as input.
---

# Update the OSM API spec

`calls/`, `schemas/`, `templates/` and `kinds.yaml` are the source of truth; `openapi.yaml` is built from them. Edit the sources, never `openapi.yaml`.

## Rules

- **No live requests to OSM** (`www.onlinescoutmanager.co.uk`, `/ext/`, `/v3/`, OAuth) unless the user explicitly asks in this session.
- **No personal data** in sources, examples, issues or PRs: never copy values from captures. Examples use invented values (names like "Alex Example", ids like `1001`).
- **Never delete a call.** Set `deprecated: "not found in the web app's code as of <date>"` and let the maintainer decide.
- Follow `FORMAT.md` for layout, kinds and source labels. Reuse `schemas/` where a shape exists.
- Never bypass commit signing (`--no-gpg-sign` etc.). Don't push or open a PR unless asked.
- Keep docs terse.

## Input

One of:

- A contributor's request: add a call, fix a call, fix a schema.
- A list of calls found in OSM's front-end code: calls "to document" (new, with method, path, action, params), calls "gone" (no longer found), and changed params.
- Observation results from `record-osm-observations`: label changes, schema disagreements, unmatched calls.

With none, stop and say "no API changes".

## 1. Branch

`git switch -c api-update/<YYYY-MM-DD>` (or `fix/<short-name>`). Run `bun install` if `node_modules` is missing.

## 2. Edit

- **New call:** create the `calls/...` file (kind, method, path, action, summary, tags, params, response) with `source: {request: inferred, response: inferred|unknown}`. Add `sources` only if known. If it came from a capture, re-run the scan on that capture afterwards so it's labelled `observed` from the traffic.
- **Changed params:** edit the existing file.
- **Gone:** deprecate (see rules).
- **Labels:** the scan sets `observed`. Set it by hand only for a part you've seen in traffic yourself, with that date, request and response separately; calls found in OSM's code are `inferred`. Labels describe the current docs: if you change a part from the code in a way that conflicts with what was observed, set that part back to `inferred` and drop its `observed_on` (see `FORMAT.md`, "Source labels").
- **Schema disagreement:** widen the schema (add seen fields and types, `nullable`, alternative types); never remove documented fields.
- Large updates: split across subagents by path prefix, each owning its own `calls/` subtree, briefed with these rules.

## 3. Check

```
bun run check -- --examples
bun run gen:openapi
bun run lint
bun test
```

All must pass with 0 errors and 0 warnings. Commit `openapi.yaml` with the sources it was built from.

## 4. Open a PR (contributors)

Commit with a short message with counts, e.g. `Update API docs: 3 new, 2 changed, 1 deprecated`. Push and open a PR only when asked. The description lists new, changed and deprecated calls by name and states whether each is inferred or observed. No captures or real values.

## 5. Release (maintainer)

Skip unless the user is the maintainer and asks for a release.

```
bun run changelog -- --base <ref>
bun run gen:openapi
bun run lint
bun run gen:ts
bun run coverage
bun test
```

`<ref>` is the previous release tag or commit to diff against (default `main` before merging). The changelog script diffs `calls/`, `schemas/`, `templates/` and `kinds.yaml` against it, bumps `spec-header.yaml` and `package.json` (breaking: major, additive: minor, else patch; pre-1.0 one level lower) and prepends an entry to `CHANGELOG.md`. Rerunning against the same ref replaces its entry. No changes: no bump, no entry; say so. If it says the baseline has no `calls/`, write the entry by hand.

Regenerate after the bump so the version reaches `openapi.yaml`. `coverage` counts observed and inferred labels in it and rewrites the table between the `coverage` markers in `README.md`. Then commit and tag. Don't push unless asked.
