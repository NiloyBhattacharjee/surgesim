/** Helpers for reading CloudFormation values, which may be literals or intrinsic functions. */

export type Json = unknown;

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Every logical id a value refers to: `{"Ref": id}`, `{"Fn::GetAtt": [id, attr]}` or `"id.attr"`,
 * `{"Fn::Sub": "...${id}..."}`, searched recursively (so it also works inside `Fn::Join`, `Fn::If`...).
 */
export function collectRefs(value: Json, known?: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const add = (id: unknown) => {
    if (typeof id === "string" && (known === undefined || known.has(id)) && !out.includes(id)) out.push(id);
  };
  const walk = (v: Json): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!isRecord(v)) return;
    for (const [k, val] of Object.entries(v)) {
      if (k === "Ref") add(val);
      else if (k === "Fn::GetAtt") {
        if (Array.isArray(val)) add(val[0]);
        else if (typeof val === "string") add(val.split(".")[0]);
      } else if (k === "Fn::Sub") {
        const str = Array.isArray(val) ? val[0] : val;
        if (typeof str === "string") for (const m of str.matchAll(/\$\{([A-Za-z0-9]+)(?:\.[A-Za-z0-9.]+)?\}/g)) add(m[1]);
        if (Array.isArray(val)) walk(val[1]);
      } else walk(val);
    }
  };
  walk(value);
  return out;
}

/** Resolve a number from a literal, a numeric string, or a Ref to a parameter with a Default. */
export function resolveNumber(value: Json, parameters: Record<string, Json>): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  if (isRecord(value) && typeof value["Ref"] === "string") {
    const p = parameters[value["Ref"]];
    if (isRecord(p) && p["Default"] !== undefined) return resolveNumber(p["Default"], {});
  }
  return undefined;
}

/** Resolve a string from a literal or a Ref to a parameter with a Default. */
export function resolveString(value: Json, parameters: Record<string, Json>): string | undefined {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value["Ref"] === "string") {
    const p = parameters[value["Ref"]];
    if (isRecord(p) && typeof p["Default"] === "string") return p["Default"];
  }
  return undefined;
}

/** A CDK-synthesized id ends in an 8-character uppercase hex hash; strip it for a readable name. */
export function stripCdkHash(logicalId: string): string {
  const stripped = logicalId.replace(/[0-9A-F]{8}$/, "");
  return stripped.length >= 3 ? stripped : logicalId;
}
