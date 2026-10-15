import { parseDocument, type ScalarTag, type CollectionTag, YAMLMap, YAMLSeq } from "yaml";

/** CloudFormation functions with a YAML short form `!Name`, which means `{"Fn::Name": value}`. */
const FUNCTIONS = ["And", "Base64", "Cidr", "Equals", "FindInMap", "GetAZs", "If", "ImportValue", "Join", "Not", "Or", "Select", "Split", "Sub", "Transform", "Length", "ToJsonString"];

/** The long (JSON) form of a short-form intrinsic. `!GetAtt A.B` becomes `["A", "B"]`, as CloudFormation reads it. */
function longForm(name: string, value: unknown): Record<string, unknown> {
  if (name === "Ref" || name === "Condition") return { [name]: value };
  if (name === "GetAtt" && typeof value === "string") {
    const dot = value.indexOf(".");
    return { "Fn::GetAtt": dot < 0 ? [value] : [value.slice(0, dot), value.slice(dot + 1)] };
  }
  return { [`Fn::${name}`]: value };
}

const TAGS: (ScalarTag | CollectionTag)[] = ["Ref", "Condition", "GetAtt", ...FUNCTIONS].flatMap((name) => [
  { tag: `!${name}`, resolve: (str: string) => longForm(name, str) } satisfies ScalarTag,
  { tag: `!${name}`, collection: "seq", nodeClass: YAMLSeq, resolve: (seq) => longForm(name, (seq as YAMLSeq).toJSON()) } as CollectionTag,
  { tag: `!${name}`, collection: "map", nodeClass: YAMLMap, resolve: (map) => longForm(name, (map as YAMLMap).toJSON()) } as CollectionTag,
]);

export type ParseTemplateResult = { ok: true; template: unknown } | { ok: false; message: string };

/**
 * Parse a CloudFormation template written in JSON or YAML. YAML short-form intrinsics (`!Ref`, `!GetAtt`,
 * `!Sub`, `!Join`, ...) become their JSON long forms, so the result is what the equivalent JSON template parses to.
 */
export function parseTemplate(text: string): ParseTemplateResult {
  try {
    return { ok: true, template: JSON.parse(text) };
  } catch (e) {
    // A JSON template (CDK's output) gets the JSON error; anything else is read as YAML.
    if (text.trimStart().startsWith("{")) return { ok: false, message: `not valid JSON: ${(e as Error).message}` };
  }
  const doc = parseDocument(text, { customTags: TAGS, uniqueKeys: true, prettyErrors: true });
  // An unknown `!Tag` is only a warning to the YAML library, but read as a plain string it would misstate the template.
  const problem = doc.errors[0] ?? doc.warnings.find((w) => w.code === "TAG_RESOLVE_FAILED");
  if (problem) return { ok: false, message: problem.message };
  return { ok: true, template: doc.toJS() };
}
