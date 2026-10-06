# @archey347/osm-api-client

Unofficial typed client and [zod](https://zod.dev) validators for the
[Online Scout Manager](https://www.onlinescoutmanager.co.uk) (OSM) API, generated from the
[osm-api-docs](https://github.com/archey347/osm-api-docs) spec. Not affiliated with or endorsed by OSM.

> [!WARNING]
> OSM's API is undocumented and can change without notice. Many calls are **inferred** from OSM's client-side code
> rather than observed in real traffic; each call's `source` says which. Test against the live API before relying on
> anything here.

## Install

```sh
npm install @archey347/osm-api-client zod
```

`zod` (v4) is a peer dependency, so the validators work with your own schemas.

## Use

Every call is a definition in `OsmApi`: `OsmApi.<area>.<action>` for `/ext/` calls and
`OsmApi.v3.<route>.<get|post>` for `/v3/` routes, with path parameters as `$name`. You supply the HTTP side: base URL,
OAuth token, and form encoding (OSM expects `application/x-www-form-urlencoded`, not JSON).

```ts
import { OsmApi, call, type HttpClient } from "@archey347/osm-api-client";

const http: HttpClient = {
  async request({ method, path, query, form }) {
    const url = new URL(path, "https://www.onlinescoutmanager.co.uk");
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form ? new URLSearchParams(form as Record<string, string>) : undefined,
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
};

const patrols = await call(http, OsmApi.members.patrols.getPatrolsWithPeople, {
  query: { sectionid: "12345", termid: "67890" },
});

const ticket = await call(http, OsmApi.v3.helpcentre.tickets.$ticketId.get, {
  path: { ticketId: "42" },
});
```

Arguments are typed per call, and replies are validated. Validation is lenient: a field that doesn't match what the
spec expects comes back `undefined` instead of throwing, so an inaccurate guess in the spec doesn't break your code.
Calls marked `multipart/form-data` (file uploads) set `multipart: true` on the request; send those as `FormData`.

`buildRequest(call, args)` gives you the request without sending it, and `allCalls()` lists every call.

## Versioning

The package version matches the spec version (`OSM_API_VERSION`). See the
[changelog](https://github.com/archey347/osm-api-docs/blob/main/CHANGELOG.md).

## Licence

[MIT](LICENSE).
