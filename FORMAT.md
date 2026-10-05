# Per-call source format

One YAML file per call, grouped by what they share. `calls/`, `schemas/` and `templates/` are the source of truth:
`bun run gen:openapi` builds `openapi.yaml`, and `bun run gen:ts` builds the git-ignored TypeScript client, `clients/typescript/src/index.ts`, from them. `bun run check` validates them
(`-- --examples` also checks response examples against their schemas).

| Path | Holds |
|------|-------|
| `kinds.yaml` | The two call kinds, defined once: `ext-action` (`/ext/<module>/?action=X`) and `v3-route` (REST-style). Encoding, `X-CSRF`, envelope, error shape, rate-limit headers. |
| `calls/<path segments>/<action>.yaml` | One call: ext = `<action>.yaml` (`<action>.get.yaml` when GET and POST share it); v3 = `get.yaml` / `post.yaml` in the route's directory. |
| `calls/.../_get.yaml`, `_post.yaml` | Text shared by every action of one path+method (original summary, description, response note, examples no action claimed). |
| `schemas/<Name>.yaml` | Shared response shapes, JSON Schema (OpenAPI 3.0 `nullable` allowed). `$ref: Name` is a bare file name. |
| `templates/<name>.yaml` | Shared protocols. `upload-widget` has the Config/Manifest/Put/PartPut/PutTemp/CommitTemp/RevertTemp actions. |
| `format.schema.json` | JSON Schema for all of the above except `schemas/`. |

## Call file

```yaml
kind: ext-action            # or v3-route
method: GET                 # GET | POST
path: /ext/programme/       # v3 keeps {named} segments
action: getProgrammeSummary # ext only
summary: ...
description: ...           # optional
notes: ...                 # optional, e.g. a GET that changes data
tags: [ Programme ]
source:                     # required; see below
  request: inferred         # observed | inferred
  response: inferred        # observed | inferred | unknown
deprecated: ...            # optional, true or text
removed: { http: 410, note: ... }
path_params: { name: { type, description } }
query: { name: { type, enum, required, description } }
body:
  content_type: multipart/form-data   # only when not form-urlencoded
  params: { name: { type, required, description } }   # or schema: for non-flat bodies
  example: { ... }
response:
  schema: { $ref: ProgrammeSummary }  # or inline; v3: describes `data` only
  envelope: true            # overrides the kind: ext reply uses the wrapper / v3 reply does not
  document: true            # file download; content_type says which
  description: ...
  examples: { name: { summary, value } }   # value is the data payload; error examples are whole bodies
sources: [ front-end bundle names the call was found in ]
```

## Source labels

`observed`: seen in captured traffic (HAR files or shape logs, below). `inferred`: worked out from the web app's JS. `unknown` (response only): the code never reads the reply. `observed_on` (YYYY-MM-DD) is required for each observed part: one date for all observed parts, `{ request, response }` when they differ, or `unknown` when the date is lost. `bun run scan -- file.har|file.jsonl ...` sets `observed` and the date from your captures and reports how observed replies differ from the schemas (`--dry-run` writes nothing; `--json` prints a summary; report in `.cache/observation-scan.md`). With no arguments it reads the files listed in a git-ignored `scan.local.json`, `{ "inputs": ["path/or/*.har", ...] }`. Captures are read locally and never committed. The scan exits non-zero when an observed call's structure is rejected by its strict validator (type errors only for shape logs, which hold no values). Template actions are always `inferred`.

An upload-widget path is one file per prefix, with no `method`:

```yaml
kind: ext-action
path: /ext/events/event/
uses: { template: upload-widget, prefix: eventAttachments, params: { id: ..., path: ... } }
```

## Shape logs

A shape log is a structure-only record of OSM replies, for people who would rather not share captures. One JSON line per OSM request, no values, headers or tokens:

```json
{"date":"2026-10-05","method":"GET","path":"/ext/dashboard/","action":"memberSearch","query_keys":["sections","v"],"body_keys":[],"status":200,"ok":true,"shape":{"t":["object"],"k":{"status":{"t":["boolean"]},"data":{"t":["array"],"i":{"t":["integer","null"]}}}}}
```

`ok` is false when the reply was `status: false`. `action` is left out of the key lists. Path segments and parameter names that look like ids become `{id}`. A `shape` node is `t` (sorted JSON types: `object array string integer number boolean null`), `k` (object keys to nodes) and `i` (array items, merged across all items). Object keys that look like data (all digits, dates, emails, UUIDs, hex ids, or containing a space or `@`) become `{key}`, as do all keys of an object where most do; their nodes merge. `scripts/lib/shape.ts` implements this and `scripts/fixtures/shape-cases.json` holds its test cases.
