import { parseDocument } from "yaml";
import type { RateProfile, Sampler } from "@surgesim/sdk";
import { isRecord } from "./intrinsics.js";
import type { KubernetesImportOptions, KubernetesServiceOptions } from "./kubernetes.js";

export type ParseOverlayResult = { ok: true; options: KubernetesImportOptions } | { ok: false; errors: { message: string }[] };

/**
 * Parse an overlay file (YAML or JSON): the behaviour Kubernetes manifests cannot describe.
 *
 * ```yaml
 * traffic:
 *   entry: web                                   # or a list; Service or Deployment names
 *   rateProfile: [[0, 200], [300, 600], [900, 200]]   # or ratePerSecond: 200
 * services:
 *   web-frontend:
 *     concurrencyPerPod: 50
 *     startupDelay: 30
 *     serviceTime: { dist: lognormal, mean: 0.04, stdDev: 0.015 }
 *     calls: [{ service: orders-api, probability: 0.6 }]
 * ```
 *
 * Values use the model format's units (seconds, per second) and sampler JSON, so they pass to the model unchanged.
 * The shape is checked here; distribution parameters are checked by the engine when the model is loaded.
 */
export function parseOverlay(text: string): ParseOverlayResult {
  const doc = parseDocument(text, { uniqueKeys: true, prettyErrors: true });
  if (doc.errors[0]) return { ok: false, errors: [{ message: doc.errors[0].message }] };
  const root: unknown = doc.toJS() ?? {};
  const errors: { message: string }[] = [];
  const err = (path: string, message: string) => errors.push({ message: `${path}: ${message}` });
  const keys = (v: Record<string, unknown>, path: string, allowed: readonly string[]) => {
    for (const k of Object.keys(v)) if (!allowed.includes(k)) err(path ? `${path}.${k}` : k, `unknown key (expected one of ${allowed.join(", ")})`);
  };
  const number = (v: unknown, path: string, min: number, integer = false): number | undefined => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || (integer && !Number.isInteger(v))) {
      err(path, `must be ${integer ? "an integer" : "a number"} >= ${min}`);
      return undefined;
    }
    return v;
  };

  if (!isRecord(root)) return { ok: false, errors: [{ message: "the overlay must be a mapping with traffic and/or services" }] };
  keys(root, "", ["traffic", "services"]);
  const options: KubernetesImportOptions = {};

  const traffic = root["traffic"];
  if (traffic !== undefined) {
    if (!isRecord(traffic)) err("traffic", "must be a mapping");
    else {
      keys(traffic, "traffic", ["entry", "ratePerSecond", "rateProfile"]);
      const entry = traffic["entry"];
      const list = typeof entry === "string" ? [entry] : entry;
      if (entry !== undefined) {
        if (!Array.isArray(list) || list.length === 0 || !list.every((e) => typeof e === "string")) err("traffic.entry", "must be a name or a non-empty list of names");
        else options.entry = list;
      }
      if (traffic["ratePerSecond"] !== undefined && traffic["rateProfile"] !== undefined) err("traffic", "give ratePerSecond or rateProfile, not both");
      if (traffic["ratePerSecond"] !== undefined) {
        const rate = number(traffic["ratePerSecond"], "traffic.ratePerSecond", 0);
        if (rate !== undefined) options.ratePerSecond = rate;
      }
      const profile = traffic["rateProfile"];
      if (profile !== undefined) {
        const pairs = Array.isArray(profile) && profile.length > 0 && profile.every((p) => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0));
        if (!pairs) err("traffic.rateProfile", "must be a non-empty list of [startSeconds, ratePerSecond] pairs of numbers >= 0");
        else options.rateProfile = profile as RateProfile;
      }
    }
  }

  const services = root["services"];
  if (services !== undefined) {
    if (!isRecord(services)) err("services", "must be a mapping from Service or Deployment name to its settings");
    else {
      const out: Record<string, KubernetesServiceOptions> = {};
      for (const [name, s] of Object.entries(services)) {
        const path = `services.${name}`;
        if (!isRecord(s)) {
          err(path, "must be a mapping");
          continue;
        }
        keys(s, path, ["serviceTime", "concurrencyPerPod", "startupDelay", "calls"]);
        const o: KubernetesServiceOptions = {};
        const st = s["serviceTime"];
        if (st !== undefined) {
          if ((typeof st === "number" && Number.isFinite(st) && st >= 0) || (isRecord(st) && typeof st["dist"] === "string")) o.serviceTime = st as Sampler;
          else err(`${path}.serviceTime`, 'must be seconds (a number >= 0) or a distribution such as { dist: lognormal, mean: 0.04, stdDev: 0.015 }');
        }
        if (s["concurrencyPerPod"] !== undefined) {
          const c = number(s["concurrencyPerPod"], `${path}.concurrencyPerPod`, 1, true);
          if (c !== undefined) o.concurrencyPerPod = c;
        }
        if (s["startupDelay"] !== undefined) {
          const d = number(s["startupDelay"], `${path}.startupDelay`, 0);
          if (d !== undefined) o.startupDelay = d;
        }
        const calls = s["calls"];
        if (calls !== undefined) {
          if (!Array.isArray(calls)) err(`${path}.calls`, "must be a list of { service, probability }");
          else {
            const list: { service: string; probability: number }[] = [];
            calls.forEach((c, i) => {
              const cp = `${path}.calls[${i}]`;
              if (!isRecord(c)) return err(cp, "must be { service, probability }");
              keys(c, cp, ["service", "probability"]);
              if (typeof c["service"] !== "string") return err(`${cp}.service`, "must be a Service or Deployment name");
              const p = c["probability"];
              if (typeof p !== "number" || !(p >= 0 && p <= 1)) return err(`${cp}.probability`, "must be a number in [0, 1]");
              list.push({ service: c["service"], probability: p });
            });
            o.calls = list;
          }
        }
        out[name] = o;
      }
      options.services = out;
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, options };
}
