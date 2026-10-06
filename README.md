# OSM API Client (Unofficial)

Unofficial OpenAPI specification for the [Online Scout Manager](https://www.onlinescoutmanager.co.uk) (OSM) API,
built from a combination of statically analysing OSM's client-side code and checking it against real traffic.

This means request and response structures are discovered by usage, so may not be perfect. I have verified some
endpoints against real traffic, so they are more likely to be complete; these are marked **observed** in the spec.

Credit to the City of Newcastle Scouts Digital Team in
[osm-api-docs](https://github.com/newcastlescouts/osm-api-docs), which this project builds on. I ended up building an 
intermediary api spec which seems to more closely align with the design/primitives of their API framework, 
which the openapi spec is then built from.

There are some build tools in this repo, including the one that can parse HAR files; the code that scans OSM's front-end code 
I've kept in a private repo. I recommend reading [CONTRIBUTING.md](CONTRIBUTING.md) if you'd like to have a go at providing 
your own HAR captures (I can only provide ones for the features my group uses). 

An area I have yet to look into is a tool that can just call the API endpoints directly, and derive structure that way.

> [!WARNING]
> **Provided as-is with no guarantees.** OSM's API is undocumented and can change without notice. Calls, parameters
> and response shapes were observed or inferred at the time of writing and may drift. Test against the live API before
> relying on anything here. We are not affiliated with OSM; use at your own risk.

OSM doesn't publish a public API specification. This project fills that gap for developers building tools on top of
OSM, whether that's a badge tracker, a patrol planner, or anything else that helps leaders run their sections.

## Using the spec

Browse the docs at <https://scrapbook.archbar.me/osm-api>.

`openapi.yaml` is an OpenAPI 3.0.3 document. Open it in [Redoc](https://redocly.github.io/redoc/),
[Swagger Editor](https://editor.swagger.io/), Postman or Insomnia, or feed it to a client generator.

For TypeScript there's a typed client with zod validators in [`clients/typescript`](clients/typescript) (not yet on
npm).

Each call is labelled **observed** (seen in real traffic) or **inferred** (from static analysis of OSM's client-side
code). Treat inferred calls with more suspicion.

<!-- coverage:start -->
Label coverage of the 1118 operations in 0.6.0:

| | Observed | Inferred | Unknown |
|---|---|---|---|
| Request | 63 (6%) | 1055 (94%) | – |
| Response | 62 (6%) | 1035 (93%) | 21 (2%) |

62 (6%) are observed for both request and response. Unknown: the web app never reads the reply.
<!-- coverage:end -->

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

Issues and PRs are welcome. If you use OSM, the most useful thing you can do is check the spec against your own
traffic: save a HAR capture from your browser and run `bun run scan -- my-capture.har`. It reads the capture
automatically, marks the calls it saw as **observed**, and reports where real replies differ from the spec, without
the capture or any values leaving your machine.

The spec is built from the files in `calls/` and `schemas/`, so edit those and `openapi.yaml` is regenerated from them
(`bun run gen:openapi`). See [CONTRIBUTING.md](CONTRIBUTING.md) and [FORMAT.md](FORMAT.md).

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
