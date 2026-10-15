/** One difference between two models. Values are compact JSON; null means absent from that model. */
export interface ModelChange {
  /** A component name, `"settings"` or `"assertions"`. */
  where: string;
  /** What differs there: `"component"` (added or removed), `"type"`, `"stream"`, an input key, `"link <key>"`, a settings key, or an assertion. */
  what: string;
  a: string | null;
  b: string | null;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Rec) : {});
const show = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));
/** JSON with object keys sorted, so `{"mean":1,"dist":"x"}` equals `{"dist":"x","mean":1}`. */
const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    typeof x === "object" && x !== null && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => (p < q ? -1 : p > q ? 1 : 0))) : x,
  ) ?? "";

function fields(out: ModelChange[], where: string, prefix: string, a: Rec, b: Rec): void {
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
    if (stable(a[key]) !== stable(b[key])) out.push({ where, what: prefix + key, a: show(a[key]), b: show(b[key]) });
}

/**
 * What changed from model `a` to model `b` (both in the JSON model format): settings, components added or removed,
 * and each shared component's type, stream, inputs and links, matched by name, then assertions. A renamed component
 * shows as one removed and one added. Names and descriptions are ignored: they do not change results.
 */
export function diffModels(a: unknown, b: unknown): ModelChange[] {
  const out: ModelChange[] = [];
  fields(out, "settings", "", rec(rec(a)["settings"]), rec(rec(b)["settings"]));

  const components = (m: unknown): Map<string, Rec> => {
    const list = rec(m)["components"];
    return new Map((Array.isArray(list) ? list : []).map((c) => [String(rec(c)["name"]), rec(c)]));
  };
  const ca = components(a);
  const cb = components(b);
  for (const [name, c] of ca) if (!cb.has(name)) out.push({ where: name, what: "component", a: show(c["type"]), b: null });
  for (const [name, c] of cb) if (!ca.has(name)) out.push({ where: name, what: "component", a: null, b: show(c["type"]) });
  for (const [name, x] of ca) {
    const y = cb.get(name);
    if (!y) continue;
    fields(out, name, "", { type: x["type"], stream: x["stream"] }, { type: y["type"], stream: y["stream"] });
    fields(out, name, "", rec(x["inputs"]), rec(y["inputs"]));
    fields(out, name, "link ", rec(x["links"]), rec(y["links"]));
  }

  const assertions = (m: unknown): Map<string, unknown> => {
    const list = rec(m)["assertions"];
    return new Map((Array.isArray(list) ? list : []).map((x) => [stable(x), x]));
  };
  const aa = assertions(a);
  const ab = assertions(b);
  const label = (x: unknown): string => String(rec(x)["name"] ?? rec(x)["output"] ?? "assertion");
  for (const [k, x] of aa) if (!ab.has(k)) out.push({ where: "assertions", what: label(x), a: show(x), b: null });
  for (const [k, x] of ab) if (!aa.has(k)) out.push({ where: "assertions", what: label(x), a: null, b: show(x) });
  return out;
}
