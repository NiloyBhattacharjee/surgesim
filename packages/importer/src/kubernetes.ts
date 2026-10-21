import { parseAllDocuments } from "yaml";
import { Model, dist, type Component, type Sampler } from "@surgesim/sdk";
import type { ImportResult, MappedResource } from "./import.js";
import { isRecord } from "./intrinsics.js";

/** What to assume where manifests are silent. Manifests describe structure (what runs, how it scales), not traffic or code. */
export interface KubernetesImportOptions {
  /** Model name (default "Imported Kubernetes manifests"). */
  name?: string;
  /** Arrivals per second at each entry point (default 10). Manifests cannot say how much traffic there is. */
  ratePerSecond?: number;
  /** Service time per request (default exponential with mean 0.2 s). Manifests cannot say how long work takes. */
  serviceTime?: Sampler;
  /** Requests one pod serves at once (default 10). Beyond that, requests wait in the Deployment's queue. */
  concurrencyPerPod?: number;
  /** Seconds from a pod being created to it taking traffic (default: the largest readinessProbe `initialDelaySeconds`). */
  startupDelay?: number;
  /** Names of the Services or Deployments that receive traffic. Default: every Deployment behind a Service, else every Deployment. */
  entry?: readonly string[];
  /** Simulated seconds (default 600). */
  duration?: number;
  warmUp?: number;
  seed?: number;
  replications?: number;
}

export type ParseManifestsResult = { ok: true; objects: Record<string, unknown>[] } | { ok: false; message: string };

/**
 * Parse Kubernetes manifests: multi-document YAML (`---`), JSON, or a `List` such as
 * `kubectl get deploy,svc,hpa -o yaml` prints. Lists are flattened into their items.
 */
export function parseManifests(text: string): ParseManifestsResult {
  const objects: Record<string, unknown>[] = [];
  for (const doc of parseAllDocuments(text, { uniqueKeys: true, prettyErrors: true })) {
    const problem = doc.errors[0];
    if (problem) return { ok: false, message: problem.message };
    const value: unknown = doc.toJS();
    if (value === null || value === undefined) continue;
    const items = isRecord(value) && typeof value["kind"] === "string" && value["kind"].endsWith("List") && Array.isArray(value["items"]) ? value["items"] : [value];
    for (const o of items) {
      if (!isRecord(o) || typeof o["kind"] !== "string") return { ok: false, message: "every document must be a Kubernetes object with a kind" };
      objects.push(o);
    }
  }
  return { ok: true, objects };
}

interface K8sObject {
  kind: string;
  name: string;
  namespace: string;
  /** `Kind/name`, prefixed with the namespace when it is not "default". */
  id: string;
  raw: Record<string, unknown>;
}

const at = (v: unknown, ...path: string[]): unknown => path.reduce<unknown>((x, k) => (isRecord(x) ? x[k] : undefined), v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Convert Kubernetes manifests (parsed with {@link parseManifests}) into a Surgesim model.
 *
 * Mapped: `Deployment` to a `Queue` feeding a `WorkerPool` with `replicas × concurrencyPerPod` workers;
 * `HorizontalPodAutoscaler` (v1 or v2, CPU utilisation target) to an `Autoscaler` that evaluates every 15 s,
 * scales in whole pods, waits the readiness delay before new pods take traffic, and applies the scale-down
 * stabilisation window; `Service` to the Deployment its selector matches (used to find entry points).
 * Each pool's `Cost` is in pod-hours.
 *
 * Manifests say nothing about traffic or how long requests take, so those come from
 * {@link KubernetesImportOptions} and every such number is listed in `assumptions`.
 */
export function importKubernetes(objects: readonly unknown[], options: KubernetesImportOptions = {}): ImportResult {
  const warnings: string[] = [];
  const assumptions: string[] = [];
  const ignored: { logicalId: string; type: string }[] = [];
  const all: K8sObject[] = [];
  for (const raw of objects) {
    const name = at(raw, "metadata", "name");
    if (!isRecord(raw) || typeof raw["kind"] !== "string" || typeof name !== "string") {
      return { ok: false, errors: [{ message: "not a Kubernetes object: expected a kind and metadata.name" }] };
    }
    const namespace = typeof at(raw, "metadata", "namespace") === "string" ? (at(raw, "metadata", "namespace") as string) : "default";
    const id = `${namespace === "default" ? "" : `${namespace}/`}${raw["kind"]}/${name}`;
    all.push({ kind: raw["kind"], name, namespace, id, raw });
  }
  const ofKind = (kind: string) => all.filter((o) => o.kind === kind);
  for (const o of all) if (!["Deployment", "Service", "HorizontalPodAutoscaler"].includes(o.kind)) ignored.push({ logicalId: o.id, type: o.kind });
  const deployments = ofKind("Deployment");
  if (deployments.length === 0) {
    return { ok: false, errors: [{ message: `no Deployment found (kinds seen: ${[...new Set(all.map((o) => o.kind))].join(", ") || "none"})` }] };
  }

  const rate = options.ratePerSecond ?? 10;
  const serviceTime: Sampler = options.serviceTime ?? dist.exponential(0.2);
  const perPod = options.concurrencyPerPod ?? 10;
  if (options.ratePerSecond === undefined) assumptions.push(`Traffic: ${rate} requests/second at each entry point (manifests do not describe traffic; set ratePerSecond).`);
  if (options.serviceTime === undefined) assumptions.push("Service time: exponential with mean 0.2 s for every Deployment (manifests do not describe how long requests take; set serviceTime).");
  if (options.concurrencyPerPod === undefined) assumptions.push(`Each pod serves ${perPod} requests at once (set concurrencyPerPod).`);
  warnings.push("Each Deployment's pods share one queue (an ideal load balancer); per-pod round-robin queues would do somewhat worse.");

  const model = new Model(options.name ?? "Imported Kubernetes manifests", {
    duration: options.duration ?? 600,
    warmUp: options.warmUp ?? 0,
    seed: options.seed ?? 1,
    replications: options.replications ?? 5,
  });
  const mapped: MappedResource[] = [];
  const note = (o: K8sObject, c: Component<string>, notes: string[] = []) => mapped.push({ logicalId: o.id, type: o.kind, component: c.name, componentType: c.type, notes });
  const taken = new Set<string>();
  const unique = (base: string) => {
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
    taken.add(name);
    return name;
  };
  const completed = model.entitySink(unique("completed"));

  // --- which HPA scales which Deployment
  const hpaFor = new Map<K8sObject, K8sObject>();
  for (const h of ofKind("HorizontalPodAutoscaler")) {
    const ref = at(h.raw, "spec", "scaleTargetRef");
    const d = at(ref, "kind") === "Deployment" ? deployments.find((x) => x.name === at(ref, "name") && x.namespace === h.namespace) : undefined;
    if (!d) warnings.push(`${h.id}: scale target ${String(at(ref, "kind"))}/${String(at(ref, "name"))} is not a Deployment in these manifests; skipped.`);
    else if (num(at(h.raw, "spec", "maxReplicas")) === undefined) warnings.push(`${h.id}: maxReplicas is missing; skipped.`);
    else if (hpaFor.has(d)) warnings.push(`${h.id}: ${d.id} already has an HPA; skipped.`);
    else hpaFor.set(d, h);
  }

  // --- deployments
  const pools = new Map<K8sObject, Component<string>>();
  let probeDelays = false;
  for (const d of deployments) {
    const name = deployments.some((x) => x !== d && x.name === d.name) ? `${d.namespace}-${d.name}` : d.name;
    const notes: string[] = [];
    let replicas = num(at(d.raw, "spec", "replicas"));
    if (replicas === undefined) {
      replicas = 1;
      notes.push("replicas not set: Kubernetes default of 1");
    }
    const hpa = hpaFor.get(d);
    const min = Math.max(1, num(at(hpa?.raw, "spec", "minReplicas")) ?? 1);
    const max = Math.max(min, num(at(hpa?.raw, "spec", "maxReplicas")) ?? replicas);
    if (hpa) replicas = clamp(replicas, min, max); // the HPA moves replicas into [min, max] straight away
    if (replicas < 1) {
      warnings.push(`${d.id}: ${replicas} replicas cannot serve traffic; modelled as 1.`);
      replicas = 1;
    }
    const containers = at(d.raw, "spec", "template", "spec", "containers");
    const delays = (Array.isArray(containers) ? containers : []).map((c) => num(at(c, "readinessProbe", "initialDelaySeconds")));
    if (delays.some((x) => x !== undefined)) probeDelays = true;
    const startup = options.startupDelay ?? Math.max(0, ...delays.map((x) => x ?? 0));

    const queue = model.queue(unique(`${name}-queue`));
    const pool = model.workerPool(unique(name), {
      concurrency: replicas * perPod,
      serviceTime,
      costPerProvisionedSecond: 1 / (perPod * 3600),
      queue,
      next: completed,
    });
    pools.set(d, pool);
    note(d, pool, [...notes, `${replicas} pod(s) x ${perPod} concurrent requests each`, "Cost is in pod-hours"]);

    if (hpa) {
      const hn: string[] = [`${min} to ${max} pods`];
      const target = hpaTarget(hpa, warnings, hn);
      const behavior = at(hpa.raw, "spec", "behavior");
      const window = num(at(behavior, "scaleDown", "stabilizationWindowSeconds")) ?? 300;
      if ((num(at(behavior, "scaleUp", "stabilizationWindowSeconds")) ?? 0) > 0) warnings.push(`${hpa.id}: the scale-up stabilisation window is not modelled.`);
      if (at(behavior, "scaleUp", "policies") !== undefined || at(behavior, "scaleDown", "policies") !== undefined) {
        warnings.push(`${hpa.id}: scaling rate policies (pods or percent per period) are not modelled; scaling is limited only by min/max.`);
      }
      hn.push(`new pods take traffic after ${startup} s`, `scale-down stabilisation ${window} s`);
      const scaler = model.autoscaler(unique(`${name}-hpa`), {
        targetUtilisation: target,
        evaluationInterval: 15,
        minConcurrency: min * perPod,
        maxConcurrency: max * perPod,
        step: perPod,
        scaleUpDelay: startup,
        scaleDownStabilisation: window,
        target: pool,
      });
      note(hpa, scaler, hn);
    }
  }
  if (hpaFor.size > 0) {
    warnings.push("HPA CPU utilisation is approximated as busy request slots / slots: a pod with every slot busy is at 100% of its CPU request. The HPA's 10% tolerance is not modelled.");
    if (options.startupDelay === undefined) {
      assumptions.push(`New pods take traffic after their readinessProbe initialDelaySeconds${probeDelays ? "" : " (none set: 0 s)"}; scheduling, image pull and container start are not included (set startupDelay).`);
    }
  }

  // --- services: which Deployment each one routes to
  const behindService = new Set<K8sObject>();
  const byServiceName = new Map<string, K8sObject>();
  for (const s of ofKind("Service")) {
    const selector = at(s.raw, "spec", "selector");
    const matches = isRecord(selector) && Object.keys(selector).length > 0
      ? deployments.filter((d) => d.namespace === s.namespace && Object.entries(selector).every(([k, v]) => at(d.raw, "spec", "template", "metadata", "labels", k) === v))
      : [];
    const d = matches[0];
    if (!d) {
      warnings.push(`${s.id}: its selector matches no Deployment in these manifests; skipped.`);
      continue;
    }
    if (matches.length > 1) warnings.push(`${s.id}: its selector matches ${matches.length} Deployments; only ${d.id} is modelled behind it.`);
    behindService.add(d);
    byServiceName.set(s.name, d);
    note(s, pools.get(d) as Component<string>, [`routes to ${d.id}`]);
  }

  // --- entry points and traffic
  let entries: K8sObject[];
  if (options.entry) {
    entries = [];
    for (const want of options.entry) {
      const d = byServiceName.get(want) ?? deployments.find((x) => x.name === want || pools.get(x)?.name === want);
      if (d) entries.push(d);
      else warnings.push(`entry "${want}" is not a Service or Deployment in these manifests; ignored.`);
    }
    if (entries.length === 0) warnings.push("no entry point found: the model has no traffic.");
  } else {
    entries = behindService.size > 0 ? deployments.filter((d) => behindService.has(d)) : deployments;
    if (entries.length > 1) assumptions.push(`Entry points (each gets ${rate}/s): ${entries.map((d) => pools.get(d)?.name).join(", ")}. Pass entry to choose.`);
  }
  for (const d of new Set(entries)) {
    const pool = pools.get(d) as Component<string>;
    model.entityGenerator(unique(`traffic-${pool.name}`), { mode: "rateProfile", rateProfile: [[0, rate]], next: pool });
  }

  model.sampleEvery(5, deployments.flatMap((d) => {
    const pool = (pools.get(d) as Component<string>).name;
    return [`${pool}.Concurrency`, `${pool}.BusyWorkers`];
  }));
  return { ok: true, model: model.toJSON(), mapped, ignored, assumptions, warnings };
}

/** The HPA's CPU utilisation target as a fraction (v1 `targetCPUUtilizationPercentage` or a v2 Resource metric). */
function hpaTarget(hpa: K8sObject, warnings: string[], notes: string[]): number {
  const spec = at(hpa.raw, "spec");
  let percent = num(at(spec, "targetCPUUtilizationPercentage"));
  const metrics = at(spec, "metrics");
  if (Array.isArray(metrics) && metrics.length > 0) {
    const utilisation = (m: unknown) => (at(m, "type") === "Resource" && at(m, "resource", "target", "type") === "Utilization" ? num(at(m, "resource", "target", "averageUtilization")) : undefined);
    const cpu = metrics.find((m) => at(m, "resource", "name") === "cpu" && utilisation(m) !== undefined);
    const other = metrics.find((m) => utilisation(m) !== undefined);
    percent = utilisation(cpu ?? other);
    if (!cpu && other) warnings.push(`${hpa.id}: the ${String(at(other, "resource", "name"))} utilisation target is approximated as busy request slots.`);
    if (metrics.length > 1) warnings.push(`${hpa.id}: only one metric is modelled; Kubernetes scales on the highest recommendation across all ${metrics.length}.`);
    if (percent === undefined) warnings.push(`${hpa.id}: no Resource Utilization metric; assumed an 80% CPU target.`);
  }
  if (percent === undefined) {
    percent = 80;
    notes.push("no utilisation target: Kubernetes default of 80% CPU");
  }
  if (percent > 100 || percent < 5) warnings.push(`${hpa.id}: a ${percent}% target is outside what the model can represent; clamped to ${clamp(percent, 5, 100)}%.`);
  percent = clamp(percent, 5, 100);
  notes.push(`target ${percent}% CPU, treated as ${percent}% busy request slots`);
  return percent / 100;
}
