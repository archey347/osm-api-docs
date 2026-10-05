# OSM API Client (Unofficial)

Unofficial OpenAPI specification for the [Online Scout Manager](https://www.onlinescoutmanager.co.uk) (OSM) API,
built from a combination of statically analysing OSM's client-side code and checking it against real traffic.

This means that params are discovered by usage, so the structure of responses may not be perfect. I have verified some
endpoints against real traffic, so they are more likely to be complete; these are marked **observed** in the spec.

The sources and build tools are in this repo (the code that scans OSM's front-end is kept separately); see [CONTRIBUTING.md](CONTRIBUTING.md).

OSM doesn't publish a public API specification. This project fills that gap for developers building tools on top of
OSM, whether that's a badge tracker, a patrol planner, or anything else that helps leaders run their sections.

> [!WARNING]
> **Provided as-is with no guarantees.** OSM's API is undocumented and can change without notice. Calls, parameters
> and response shapes were observed or inferred at the time of writing and may drift. Test against the live API before
> relying on anything here. We are not affiliated with OSM; use at your own risk.

Credit to the City of Newcastle Scouts Digital Team in
[osm-api-docs](https://github.com/newcastlescouts/osm-api-docs), which this project builds on.

## Using the spec

Browse the docs at <https://scrapbook.archbar.me/osm-api>.

`openapi.yaml` is an OpenAPI 3.0.3 document. Open it in [Redoc](https://redocly.github.io/redoc/),
[Swagger Editor](https://editor.swagger.io/), Postman or Insomnia, or feed it to a client generator.

For TypeScript there's a typed client with zod validators in [`clients/typescript`](clients/typescript) (not yet on
npm).

Each call is labelled **observed** (seen in real traffic) or **inferred** (from static analysis of OSM's client-side
code). Treat inferred calls with more suspicion.

## Things to know

- **Authentication**: OAuth 2.0. You need a `client_id` and `client_secret` from OSM; the bearer token goes in the
  `Authorization` header and must be refreshed via `/oauth/token`.
- **Non-JSON responses**: some calls, notably `startup`, return JavaScript (`var data_holder = {...}`); strip the
  prefix before parsing.
- **POST bodies**: `application/x-www-form-urlencoded`, not JSON.
- **Rate limits**: watch the `X-RateLimit-*` headers and back off on `429`. Excessive requests can get your OAuth
  client banned.
- **Personal data**: these calls return data about young people and their families. Don't store what you don't need,
  don't log it, and follow your organisation's data protection policies.

## Contributing

PRs are welcome. The spec is built from the files in `calls/` and `schemas/`, so edit those and `openapi.yaml` is
regenerated from them (`bun run gen:openapi`). Issues are welcome too: open one for a missing call or a mistake. See
[CONTRIBUTING.md](CONTRIBUTING.md) and [FORMAT.md](FORMAT.md).

## Building

```
bun install
bun run gen:openapi
bun run check -- --examples
bun test
```

## Licence

[MIT](LICENSE). This covers this project's spec and code only: it grants no rights to the OSM API or service, and use
of OSM is subject to OSM's own terms. Not endorsed by or affiliated with Online Scout Manager, which owns the OSM API.
