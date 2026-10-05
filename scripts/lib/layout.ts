export type CallId = { method?: string; path: string; action?: string; uses?: { template: string; prefix?: string } };

export const segments = (path: string) => path.split("/").filter(Boolean);

export function callDir(path: string): string {
  return ["calls", ...segments(path)].join("/");
}

export function baseNames(c: CallId): string[] {
  const m = (c.method ?? "").toLowerCase();
  if (c.uses) return [c.uses.prefix ? `${c.uses.template}.${c.uses.prefix}` : c.uses.template];
  if (c.action) return [c.action, `${c.action}.${m}`];
  return [m];
}

export const callId = (c: CallId) =>
  c.uses ? `USES ${c.path} ${c.uses.template}${c.uses.prefix ? ":" + c.uses.prefix : ""}` : `${c.method} ${c.path}${c.action ? " " + c.action : ""}`;
