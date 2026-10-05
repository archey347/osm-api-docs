const RESERVED = /^(true|false|null|yes|no|on|off|y|n|~)$/i;
const PLAIN_KEY = /^[A-Za-z_$][\w$.-]*$/;
const PLAIN_STR = /^[A-Za-z_/][A-Za-z0-9 _/.,()'+=<>-]*$/;

const quote = (s: string) => JSON.stringify(s);

function key(k: string): string {
  return PLAIN_KEY.test(k) && !RESERVED.test(k) ? k : quote(k);
}

function plainOk(s: string): boolean {
  return PLAIN_STR.test(s) && !RESERVED.test(s) && !/\s$/.test(s) && !/ #/.test(s);
}

function literalOk(s: string): boolean {
  if (/[\r\t\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s)) return false;
  const body = s.replace(/\n+$/, "");
  if (!body || body.startsWith("\n") || /^ /.test(body)) return false;
  if (s.length - body.length > 1) return false;
  return body.split("\n").every((l) => !/[ \t]$/.test(l));
}

function scalar(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return plainOk(v as string) ? (v as string) : quote(v as string);
}

const isScalar = (v: unknown) => v === null || typeof v !== "object";

function flow(v: unknown[]): string | null {
  if (!v.every((x) => isScalar(x) && !(typeof x === "string" && x.includes("\n")))) return null;
  const s = `[ ${v.map(scalar).join(", ")} ]`;
  return s.length <= 100 ? s : null;
}

function block(item: unknown, indent: number, out: string[], dash: string, pad: string): void {
  if (item !== null && typeof item === "object") {
    const sub: string[] = [];
    node(item, indent + 2, sub);
    if (!sub.length) return void out.push(`${pad}- ${Array.isArray(item) ? "[ ]" : "{ }"}`);
    sub[0] = `${pad}- ${sub[0].slice(indent + 2)}`;
    out.push(...sub);
  } else {
    scalarLine(item, indent, out, `${pad}- `);
  }
}

function scalarLine(v: unknown, indent: number, out: string[], head: string): void {
  if (typeof v === "string" && v.includes("\n")) {
    if (literalOk(v)) {
      const chomp = v.endsWith("\n") ? "" : "-";
      out.push(`${head}|${chomp}`);
      const pad = " ".repeat(indent + 2);
      for (const l of v.replace(/\n$/, "").split("\n")) out.push(l ? pad + l : "");
      return;
    }
    return void out.push(`${head}${quote(v)}`);
  }
  out.push(`${head}${scalar(v)}`);
}

function node(v: unknown, indent: number, out: string[]): void {
  const pad = " ".repeat(indent);
  if (Array.isArray(v)) {
    const f = flow(v);
    if (f) return void out.push(`${pad}${f}`);
    for (const item of v) block(item, indent, out, "- ", pad);
    return;
  }
  if (v !== null && typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === undefined) continue;
      const head = `${pad}${key(k)}:`;
      if (val !== null && typeof val === "object") {
        if (Array.isArray(val)) {
          if (!val.length) out.push(`${head} [ ]`);
          else {
            const f = flow(val);
            if (f) out.push(`${head} ${f}`);
            else {
              out.push(head);
              node(val, indent + 2, out);
            }
          }
        } else if (!Object.keys(val).length) out.push(`${head} { }`);
        else {
          out.push(head);
          node(val, indent + 2, out);
        }
      } else scalarLine(val, indent, out, `${head} `);
    }
    return;
  }
  scalarLine(v, indent - 2, out, pad);
}

export function emitYaml(v: unknown): string {
  const out: string[] = [];
  node(v, 0, out);
  if (!out.length && v !== null && typeof v === "object") return Array.isArray(v) ? "[ ]\n" : "{ }\n";
  return out.join("\n") + "\n";
}

export function parseYaml(text: string): any {
  return Bun.YAML.parse(text);
}
