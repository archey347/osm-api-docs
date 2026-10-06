import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseYaml } from "./lib/yaml.ts";

const ROOT = join(import.meta.dir, "..");
const callYaml = (rel: string) => parseYaml(readFileSync(join(ROOT, "calls", rel), "utf8"));

let api: typeof import("../clients/typescript/src/index.ts");
beforeAll(async () => {
  const r = Bun.spawnSync(["bun", join(import.meta.dir, "gen-typescript.ts")], { cwd: ROOT });
  expect(r.exitCode).toBe(0);
  api = await import("../clients/typescript/src/index.ts");
});

test("client package version matches the spec version", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "clients/typescript/package.json"), "utf8"));
  expect(pkg.version).toBe(api.OSM_API_VERSION);
});

const successExamples = (doc: any) =>
  Object.entries<any>(doc.response?.examples ?? {}).filter(([k, ex]) => ex.value?.status !== false && !/error|fail/i.test(k));

describe("generated validators", () => {
  test("getProgrammeSummary: bare ext reply", () => {
    const doc = callYaml("ext/programme/getProgrammeSummary.yaml");
    const c = api.OsmApi.programme.getProgrammeSummary;
    expect(c.id).toBe("GET /ext/programme/?action=getProgrammeSummary");
    expect(c.response.envelope).toBe(false);
    for (const [, ex] of successExamples(doc)) {
      const out = c.response.body.parse(ex.value) as any;
      expect(out.items[0].eveningid).toBe("9500001");
      expect(out.items[0].title).toBe("Camp Skills Night");
    }
  });

  test("editEveningParts: POST with a flat reply", () => {
    const doc = callYaml("ext/programme/editEveningParts.yaml");
    const c = api.OsmApi.programme.editEveningParts;
    expect(c.method).toBe("POST");
    for (const [, ex] of successExamples(doc)) {
      const out = c.response.body.parse(ex.value) as any;
      expect(out.eveningid).toBe("910303");
    }
    const req = api.buildRequest(c, { body: doc.body.example });
    expect(req.form).toEqual(doc.body.example);
    expect(req.query).toEqual({ action: "editEveningParts" });
  });

  test("v3 route: enveloped reply and path params", () => {
    const doc = callYaml("v3/group_hub/dashboard/{workspaceId}/get.yaml");
    const c = api.OsmApi.v3.group_hub.dashboard.$workspaceId.get;
    expect(c.response.envelope).toBe(true);
    const req = api.buildRequest(c, { path: { workspaceId: "ws 1" } });
    expect(req.path).toBe("/v3/group_hub/dashboard/ws%201");
    for (const [, ex] of successExamples(doc)) {
      const body = c.response.body.parse({ status: true, error: null, data: ex.value, meta: null }) as any;
      expect(body.status).toBe(true);
      expect(body.data.section_ids).toEqual([45001, 45002]);
      expect(c.response.data.parse(ex.value)).toBeDefined();
    }
  });

  test("upload-widget template expands per prefix", () => {
    const c = api.OsmApi.events.event.eventAttachmentsPut;
    expect(c.method).toBe("POST");
    expect(c.action).toBe("eventAttachmentsPut");
    expect(c.contentType).toBe("multipart/form-data");
    const body = c.response.body.parse({ status: true, data: { config: { max: 5 }, manifest: [] } }) as any;
    expect(body.data.manifest).toEqual({});
    const commit = api.buildRequest(api.OsmApi.events.event.eventAttachmentsCommitTemp, { body: { id: "7" } });
    expect(commit.form).toEqual({ id: "7" });
    const cfg = api.buildRequest(api.OsmApi.events.event.eventAttachmentsConfig, { query: { id: "7" } });
    expect(cfg.query).toEqual({ action: "eventAttachmentsConfig", id: "7" });
  });

  test("lenient validators never throw on odd shapes", () => {
    const c = api.OsmApi.programme.getMeetingNames;
    expect(c.source.response).toBe("inferred");
    const seen = String(callYaml("ext/programme/getProgrammeSummary.yaml").source.observed_on);
    expect(api.OsmApi.programme.getProgrammeSummary.source).toEqual({ request: "observed", response: "observed", observedOn: { request: seen, response: seen } });
    for (const v of [null, true, "x", 5, [], [1], { items: "nope" }, { items: [1, null, { eveningid: 5 }] }]) {
      expect(() => c.response.body.parse(v)).not.toThrow();
    }
    expect((c.response.body.parse({ items: "nope" }) as any)?.items).toBeUndefined();
  });

  test("every success example in calls/ parses without throwing", () => {
    const calls = api.allCalls();
    expect(calls.length).toBeGreaterThan(1000);
    for (const f of new Bun.Glob("**/*.yaml").scanSync({ cwd: join(ROOT, "calls") })) {
      if (f.split("/").pop()!.startsWith("_")) continue;
      const doc = callYaml(f);
      if (doc.uses) continue;
      const id = `${doc.method} ${doc.path}${doc.action ? `?action=${doc.action}` : ""}`;
      const c = calls.find((x) => x.id === id);
      expect(c, id).toBeDefined();
      for (const [, ex] of successExamples(doc)) {
        const wrapped = c!.response.envelope ? { status: true, data: ex.value } : ex.value;
        expect(() => c!.response.body?.parse(wrapped)).not.toThrow();
      }
    }
  });

  describe("strict validators accept the structure seen in captured traffic", () => {
    const strict = (id: string) => {
      const c = api.allCalls().find((x) => x.id === id);
      expect(c, id).toBeDefined();
      expect(c!.source.response).toBe("observed");
      return (c!.response as any).data as { safeParse(v: unknown): { success: boolean } };
    };

    test("getNextThings: null widgets and empty-array maps", () => {
      const v = strict("GET /ext/dashboard/?action=getNextThings");
      const shape = {
        conf: { birthdays: 1 },
        is_full_admin: true,
        patrols: [],
        members: null,
        shop_orders_to_dispatch: null,
        deletable_members: null,
        outstandingpayments: null,
        pending_applicant_count: null,
        meetings_needing_badge_updates: [],
        badge_supplier_review_prompt: [],
        chat_highlights: null,
      };
      expect(v.safeParse(shape).success).toBe(true);
      expect(v.safeParse({ ...shape, meetings_needing_badge_updates: { eveningid: "1" }, members: { scouts: [] } }).success).toBe(true);
      expect(v.safeParse({ ...shape, patrols: "x" }).success).toBe(false);
    });

    test("notifications, config, data, meeting and patrol replies", () => {
      expect(strict("GET /ext/users/notifications/?action=get").safeParse([{ name: "n", title: "t", hide_dismiss: false, skip_if_dialogs_shown: true, data: [], actions: [] }]).success).toBe(true);
      const config = strict("POST /ext/generic/startup/?action=getConfigPayload");
      expect(config.safeParse({ siteConfig: { default_currency: "GBP", some_new_flag: true, event_approvals_config: {}, beta: [{ key: "k", requires_reload: false }] } }).success).toBe(true);
      expect(strict("POST /ext/generic/startup/?action=getDataPayload").safeParse({ config_hash: "h", globals: { userid: 1 } }).success).toBe(true);
      const meeting = strict("POST /ext/programme/?action=editEveningParts");
      expect(meeting.safeParse({ eveningid: "1", games: "g", prenotes: "p", postnotes: "p", soft_deleted: "0", config: {}, help: [], unavailableleaders: [], badgelinks: [], seasonal_suggestions: [] }).success).toBe(true);
      expect(strict("GET /ext/members/patrols/?action=getPatrolsWithPeople").safeParse({ "12001": { patrolid: "12001", name: "Blue", members: [] } }).success).toBe(true);
    });
  });
});
