import { importKubernetes, parseManifests, parseOverlay, type MappedResource } from "@surgesim/importer";

export type KubernetesImport =
  | {
      ok: true;
      /** The model, ready for the JSON editor and the worker. */
      json: unknown;
      mapped: MappedResource[];
      ignored: { logicalId: string; type: string }[];
      assumptions: string[];
      warnings: string[];
    }
  | { ok: false; errors: string[] };

/**
 * Turn pasted Kubernetes manifests and an overlay into a model, on the page (the importer is pure and fast, so
 * the worker only ever sees model JSON). An empty overlay is allowed: the importer then states its defaults.
 */
export function importForDemo(manifests: string, overlay: string, duration: number): KubernetesImport {
  const parsed = parseManifests(manifests);
  if (!parsed.ok) return { ok: false, errors: [`Manifests: ${parsed.message}`] };
  const options = parseOverlay(overlay);
  if (!options.ok) return { ok: false, errors: options.errors.map((e) => `Overlay: ${e.message}`) };
  const r = importKubernetes(parsed.objects, { duration, ...options.options });
  if (!r.ok) return { ok: false, errors: r.errors.map((e) => e.message) };
  return { ok: true, json: r.model, mapped: r.mapped, ignored: r.ignored, assumptions: r.assumptions, warnings: r.warnings };
}
