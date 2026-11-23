import { parseAllDocuments } from "yaml";
import { Model, dist, type Component, type RateProfile, type Sampler } from "@surgesim/sdk";
import type { ImportResult, MappedResource } from "./import.js";
import { isRecord } from "./intrinsics.js";

/** What to assume where manifests are silent. Manifests describe structure (what runs, how it scales), not traffic or code. */
export interface KubernetesImportOptions {
  /** Model name (default "Imported Kubernetes manifests"). */
  name?: string;
  /** Arrivals per second at each entry point (default 10). Manifests cannot say how much traffic there is. */
  ratePerSecond?: number;
  /** Time-varying arrival rate at each entry point, `[[startSeconds, ratePerSecond], ...]`; replaces `ratePerSecond`. */
  rateProfile?: RateProfile;
  /** Service time per request (default exponential with mean 0.2 s). Manifests cannot say how long work takes. */
  serviceTime?: Sampler;
  /** Requests one pod serves at once (default 10). Beyond that, requests wait in the Deployment's queue. */
  concurrencyPerPod?: number;
  /** Seconds from a pod being created to it taking traffic (default: the largest readinessProbe `initialDelaySeconds`). */
  startupDelay?: number;
  /**
   * Names of the Services or Deployments (or `namespace/name`) that receive traffic. Default: every Deployment behind
   * a Service that no other Deployment calls, else every Deployment that no other calls.
   */
  entry?: readonly string[];
  /** Per-Deployment settings, keyed by Service or Deployment name (or `namespace/name`); they override the options above. */
  services?: Readonly<Record<string, KubernetesServiceOptions>>;
  /** Simulated seconds (default 600). */
  duration?: number;
  warmUp?: number;
  seed?: number;
  replications?: number;
}

/** What one Deployment does with a request: the behaviour manifests cannot describe. */
export interface KubernetesServiceOptions {
  serviceTime?: Sampler;
  concurrencyPerPod?: number;
  startupDelay?: number;
  /**
   * CPU cores one request uses while being served. Manifests give the limit and request per pod but not this. With it,
   * a pod that demands more than its `resources.limits.cpu` is throttled (requests take longer), and the HPA works
   * from CPU use against `resources.requests.cpu` instead of treating busy request slots as CPU.
   */
  cpuPerRequest?: number;
  /** Seconds into the run at which a deploy replaces this Deployment's pods, following its `spec.strategy`. */
  rollingUpdateAt?: number;
  /**
   * Where a request goes after this Deployment has served it: to `service` with `probability`, otherwise it
   * completes. The calls are exclusive alternatives (a request makes at most one), so the probabilities add up to at
   * most 1. A call is asynchronous unless `synchronous` is true: the pod is freed when its own work ends. A
   * synchronous call holds the caller's request slot until the response returns, through every synchronous hop below.
   */
  calls?: readonly { service: string; probability: number; synchronous?: boolean }[];
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
/** A Kubernetes CPU quantity (`500m`, `1.5`, `2`) in cores, or undefined if it is not a positive one. */
const cores = (v: unknown): number | undefined => {
  const m = /^(\d+(?:\.\d+)?)(m?)$/.exec(String(v));
  const value = m ? Number(m[1]) / (m[2] ? 1000 : 1) : 0;
  return value > 0 ? value : undefined;
};
/** `maxSurge` or `maxUnavailable` from a Deployment's strategy, as RollingUpdate inputs; Kubernetes defaults both to 25%. */
const rolloutLimit = (v: unknown, key: "maxSurge" | "maxUnavailable"): Record<string, number> | undefined => {
  if (v === undefined) return { [`${key}Fraction`]: 0.25 };
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return { [key]: v };
  const percent = typeof v === "string" ? /^(\d+)%$/.exec(v) : null;
  const fraction = percent ? Number(percent[1]) / 100 : NaN;
  return fraction <= (key === "maxUnavailable" ? 1 : Infinity) ? { [`${key}Fraction`]: fraction } : undefined;
};
/** A pod's total CPU limit and request. Undefined unless every container has one: one without a limit can use any spare CPU. */
const podCpu = (d: K8sObject): { limit?: number; request?: number; anyLimit: boolean } => {
  const containers = at(d.raw, "spec", "template", "spec", "containers");
  const list: unknown[] = Array.isArray(containers) ? containers : [];
  const limits = list.map((c) => cores(at(c, "resources", "limits", "cpu")));
  // Kubernetes defaults a container's request to its limit.
  const requests = list.map((c, i) => cores(at(c, "resources", "requests", "cpu")) ?? limits[i]);
  const total = (values: (number | undefined)[]) => (values.length > 0 && values.every((v) => v !== undefined) ? values.reduce<number>((a, v) => a + (v as number), 0) : undefined);
  const limit = total(limits);
  const request = total(requests);
  return { ...(limit !== undefined ? { limit } : {}), ...(request !== undefined ? { request } : {}), anyLimit: limits.some((v) => v !== undefined) };
};

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

  const perPodDefault = options.concurrencyPerPod ?? 10;
  const duration = options.duration ?? 600;
  const errors: { message: string }[] = [];
  warnings.push("Each Deployment's pods share one queue (an ideal load balancer); per-pod round-robin queues would do somewhat worse.");

  // --- services: which Deployment each one routes to
  const services: { s: K8sObject; d: K8sObject }[] = [];
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
    services.push({ s, d });
  }
  const baseName = (d: K8sObject) => (deployments.some((x) => x !== d && x.name === d.name) ? `${d.namespace}-${d.name}` : d.name);
  /** The Deployment a Service or Deployment name (or `namespace/name`) means, or why it means none. */
  const resolve = (want: string): K8sObject | string => {
    const named = (o: K8sObject) => want === o.name || want === `${o.namespace}/${o.name}`;
    const found = [...new Set([...services.filter((x) => named(x.s)).map((x) => x.d), ...deployments.filter((x) => named(x) || baseName(x) === want)])];
    if (found.length > 1) return `"${want}" is ambiguous (${found.map((d) => d.id).join(", ")}); write it as namespace/name`;
    return found[0] ?? `"${want}" is not a Service or Deployment in these manifests`;
  };

  // --- per-Deployment settings and the call graph
  const settings = new Map<K8sObject, KubernetesServiceOptions>();
  for (const [key, s] of Object.entries(options.services ?? {})) {
    const d = resolve(key);
    if (typeof d === "string") errors.push({ message: `services: ${d}` });
    else if (settings.has(d)) errors.push({ message: `services: "${key}" is ${d.id} again` });
    else settings.set(d, s);
  }
  const calls = new Map<K8sObject, { to: K8sObject; probability: number; synchronous: boolean }[]>();
  for (const [d, s] of settings) {
    const list: { to: K8sObject; probability: number; synchronous: boolean }[] = [];
    for (const c of s.calls ?? []) {
      const to = resolve(c.service);
      if (typeof to === "string") errors.push({ message: `${d.id} calls ${to}` });
      else if (list.some((x) => x.to === to)) errors.push({ message: `${d.id} calls ${to.id} twice` });
      else list.push({ to, probability: c.probability, synchronous: c.synchronous === true });
    }
    const total = list.reduce((a, c) => a + c.probability, 0);
    if (total > 1 + 1e-9) errors.push({ message: `${d.id}: call probabilities add up to ${+total.toPrecision(12)}; a request makes at most one call, so they must add up to at most 1` });
    if (list.length > 0) calls.set(d, list);
  }
  // A cycle would pass requests around without bound (forever, at probability 1), so it is rejected.
  const state = new Map<K8sObject, "visiting" | "done">();
  const visit = (d: K8sObject, path: K8sObject[]): void => {
    if (state.get(d) === "done") return;
    if (state.get(d) === "visiting") {
      errors.push({ message: `the call graph has a cycle: ${[...path.slice(path.indexOf(d)), d].map((x) => x.id).join(" -> ")}` });
      return;
    }
    state.set(d, "visiting");
    for (const c of calls.get(d) ?? []) visit(c.to, [...path, d]);
    state.set(d, "done");
  };
  for (const d of calls.keys()) visit(d, []);
  if (errors.length > 0) return { ok: false, errors };

  const of = <K extends keyof KubernetesServiceOptions>(d: K8sObject, key: K) => settings.get(d)?.[key];
  const unset = (key: keyof KubernetesServiceOptions) => deployments.filter((d) => of(d, key) === undefined).map(baseName);
  if (options.ratePerSecond === undefined && options.rateProfile === undefined) {
    assumptions.push("Traffic: 10 requests/second at each entry point (manifests do not describe traffic; set ratePerSecond or rateProfile).");
  }
  if (options.serviceTime === undefined && unset("serviceTime").length > 0) {
    assumptions.push(`Service time: exponential with mean 0.2 s for ${unset("serviceTime").join(", ")} (manifests do not describe how long requests take; set serviceTime).`);
  }
  if (options.concurrencyPerPod === undefined && unset("concurrencyPerPod").length > 0) {
    assumptions.push(`Each pod of ${unset("concurrencyPerPod").join(", ")} serves ${perPodDefault} requests at once (set concurrencyPerPod).`);
  }
  const allCalls = [...calls.values()].flat();
  /** Deployments that hold a request slot while a synchronous call is out. */
  const holds = new Set([...calls].filter(([, list]) => list.some((c) => c.synchronous)).map(([d]) => d));
  if (allCalls.some((c) => !c.synchronous)) {
    warnings.push("Calls are asynchronous unless marked synchronous: a pod is freed when its own work ends, not when its downstream call returns, so upstream pods look less busy than they are when a downstream service is slow.");
  }
  if (holds.size > 0) {
    warnings.push("Synchronous calls hold the caller's request slot until the response returns; network latency and work after the response are not modelled. The HPA's CPU estimate does not count a waiting slot as busy, so a caller can run out of slots while its HPA sees low CPU.");
  }

  const model = new Model(options.name ?? "Imported Kubernetes manifests", {
    duration,
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
  /** Where a Deployment's requests arrive: its queue. Sending them to the pool itself would reject them when it is full. */
  const queues = new Map<K8sObject, Component<string>>();
  let probeDelays = false;
  let throttles = false;
  let rollouts = false;
  for (const d of deployments) {
    const name = baseName(d);
    const perPod = of(d, "concurrencyPerPod") ?? perPodDefault;
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
    const startup = of(d, "startupDelay") ?? options.startupDelay ?? Math.max(0, ...delays.map((x) => x ?? 0));

    const cpuPerRequest = of(d, "cpuPerRequest");
    const cpu = podCpu(d);
    const oversubscription = cpuPerRequest !== undefined && cpu.limit !== undefined ? (cpuPerRequest * perPod) / cpu.limit : undefined;
    if (oversubscription !== undefined && oversubscription > 1) {
      throttles = true;
      notes.push(`CPU limit ${cpu.limit} core(s) per pod; with every slot busy a pod demands ${+oversubscription.toPrecision(3)}x that, so requests slow down`);
    } else if (cpuPerRequest === undefined && cpu.anyLimit) {
      warnings.push(`${d.id}: its CPU limit is ignored; set cpuPerRequest in the overlay to model throttling.`);
    } else if (cpuPerRequest !== undefined && cpu.limit === undefined && cpu.anyLimit) {
      warnings.push(`${d.id}: not every container has a CPU limit, so the pod is modelled as never throttled.`);
    }
    const queue = model.queue(unique(`${name}-queue`));
    const pool = model.workerPool(unique(name), {
      concurrency: replicas * perPod,
      serviceTime: of(d, "serviceTime") ?? options.serviceTime ?? dist.exponential(0.2),
      costPerProvisionedSecond: 1 / (perPod * 3600),
      ...(holds.has(d) ? { holdUntilRelease: true } : {}),
      ...(oversubscription !== undefined && oversubscription > 1 ? { cpuOversubscription: oversubscription } : {}),
      queue,
    });
    pools.set(d, pool);
    queues.set(d, queue);
    if (holds.has(d)) notes.push("holds a request slot while a synchronous call is out");
    note(d, pool, [...notes, `${replicas} pod(s) x ${perPod} concurrent requests each`, "Cost is in pod-hours"]);

    const behavior = at(hpa?.raw, "spec", "behavior");
    const upOff = at(behavior, "scaleUp", "selectPolicy") === "Disabled";
    const downOff = at(behavior, "scaleDown", "selectPolicy") === "Disabled";
    if (hpa && upOff && downOff) {
      note(hpa, pool, ["scaling disabled in both directions (selectPolicy: Disabled): replicas stay fixed"]);
    } else if (hpa) {
      // selectPolicy: Disabled forbids one direction. Scale-down off is exact: never below the starting size, and a
      // window as long as the run always holds a recommendation at least as high as the current size.
      const lo = downOff ? replicas : min;
      const hi = upOff ? replicas : max;
      const window = downOff ? duration : (num(at(behavior, "scaleDown", "stabilizationWindowSeconds")) ?? 300);
      const hn: string[] = [`${lo} to ${hi} pods`];
      const target = hpaTarget(hpa, warnings, hn, cpuPerRequest !== undefined && cpu.request !== undefined ? (cpuPerRequest * perPod) / cpu.request : undefined);
      if (upOff) {
        warnings.push(`${hpa.id}: scaleUp selectPolicy Disabled is approximated by capping at the starting ${replicas} pod(s); after scaling in, the model can scale back up to that, which the HPA would not.`);
      } else if ((num(at(behavior, "scaleUp", "stabilizationWindowSeconds")) ?? 0) > 0) {
        warnings.push(`${hpa.id}: the scale-up stabilisation window is not modelled.`);
      }
      if ((!upOff && at(behavior, "scaleUp", "policies") !== undefined) || (!downOff && at(behavior, "scaleDown", "policies") !== undefined)) {
        warnings.push(`${hpa.id}: scaling rate policies (pods or percent per period) are not modelled; scaling is limited only by min/max.`);
      }
      hn.push(`new pods take traffic after ${startup} s`, downOff ? "scale-down disabled (selectPolicy: Disabled)" : `scale-down stabilisation ${window} s`);
      const scaler = model.autoscaler(unique(`${name}-hpa`), {
        targetUtilisation: target,
        evaluationInterval: 15,
        minConcurrency: lo * perPod,
        maxConcurrency: hi * perPod,
        step: perPod,
        scaleUpDelay: startup,
        scaleDownStabilisation: window,
        target: pool,
      });
      note(hpa, scaler, hn);
    }

    const rollingUpdateAt = of(d, "rollingUpdateAt");
    if (rollingUpdateAt !== undefined) {
      const strategy = at(d.raw, "spec", "strategy");
      const recreate = at(strategy, "type") === "Recreate";
      const surge = recreate ? { maxSurge: 0 } : rolloutLimit(at(strategy, "rollingUpdate", "maxSurge"), "maxSurge");
      const unavailable = recreate ? { maxUnavailableFraction: 1 } : rolloutLimit(at(strategy, "rollingUpdate", "maxUnavailable"), "maxUnavailable");
      if (!surge || !unavailable) warnings.push(`${d.id}: strategy.rollingUpdate has a value that is not a count or a percentage; its 25% default is used instead.`);
      if (rollingUpdateAt >= duration) warnings.push(`${d.id}: rollingUpdateAt ${rollingUpdateAt} s is not before the end of the ${duration} s run, so the update never starts.`);
      const readinessDelay = startup + (num(at(d.raw, "spec", "minReadySeconds")) ?? 0);
      const rollout = model.rollingUpdate(unique(`${name}-rollout`), {
        at: rollingUpdateAt,
        readinessDelay,
        podSize: perPod,
        ...(surge ?? { maxSurgeFraction: 0.25 }),
        ...(unavailable ?? { maxUnavailableFraction: 0.25 }),
        target: pool,
      });
      rollouts = true;
      note(d, rollout, [`${recreate ? "Recreate" : "rolling update"} at ${rollingUpdateAt} s; a new pod takes traffic after ${readinessDelay} s`]);
    }
  }
  if (hpaFor.size > 0) {
    const proxied = [...hpaFor.keys()].some((d) => of(d, "cpuPerRequest") === undefined || podCpu(d).request === undefined);
    warnings.push(`${proxied ? "HPA CPU utilisation is approximated as busy request slots / slots unless cpuPerRequest and a CPU request are given: a pod with every slot busy is at 100% of its CPU request. " : ""}The HPA's 10% tolerance is not modelled.`);
    const fromProbes = [...hpaFor.keys()].filter((d) => of(d, "startupDelay") === undefined).map(baseName);
    if (options.startupDelay === undefined && fromProbes.length > 0) {
      assumptions.push(`New pods of ${fromProbes.join(", ")} take traffic after their readinessProbe initialDelaySeconds${probeDelays ? "" : " (none set: 0 s)"}; scheduling, image pull and container start are not included (set startupDelay).`);
    }
  }
  if (throttles) {
    warnings.push("CPU throttling is a smooth slowdown fixed when each request starts, not 100 ms CFS periods, so latency percentiles under throttling are understated.");
  }
  if (rollouts) {
    warnings.push("A rolling update's new pods behave like the old ones, and pods that are not ready yet are not in Cost. An old pod finishes its running requests when removed, with no limit from terminationGracePeriodSeconds.");
  }
  for (const { s, d } of services) note(s, pools.get(d) as Component<string>, [`routes to ${d.id}`]);

  // --- where each Deployment sends a request it has served
  // With synchronous calls, a request frees every caller waiting on it when it completes or makes an asynchronous
  // call, so those paths go through a Release (one per destination). Without them the model has no Release at all.
  const releases = new Map<Component<string>, Component<string>>();
  const freeing = (to: Component<string>, name: string): Component<string> => {
    if (holds.size === 0) return to;
    let r = releases.get(to);
    if (!r) releases.set(to, (r = model.release(unique(name), { next: to })));
    return r;
  };
  const done = () => freeing(completed, "release");
  for (const d of deployments) {
    const pool = pools.get(d) as Component<string>;
    const list = calls.get(d);
    if (!list) {
      pool.link("next", done());
      continue;
    }
    const rest = 1 - list.reduce((a, c) => a + c.probability, 0);
    const callTarget = (c: { to: K8sObject; synchronous: boolean }) => {
      const queue = queues.get(c.to) as Component<string>;
      return c.synchronous ? queue : freeing(queue, `${baseName(c.to)}-release`);
    };
    const targets = [...list.map(callTarget), ...(rest > 1e-9 ? [done()] : [])];
    const probabilities = [...list.map((c) => c.probability), ...(rest > 1e-9 ? [rest] : [])];
    pool.link("next", model.branch(unique(`${pool.name}-calls`), { targets, probabilities }));
  }

  // --- entry points and traffic
  let entries: K8sObject[];
  if (options.entry) {
    entries = [];
    for (const want of options.entry) {
      const d = resolve(want);
      if (typeof d === "string") warnings.push(`entry ${d}; ignored.`);
      else entries.push(d);
    }
    if (entries.length === 0) warnings.push("no entry point found: the model has no traffic.");
  } else {
    const called = new Set([...calls.values()].flat().map((c) => c.to));
    const behindService = new Set(services.map((x) => x.d));
    const candidates = deployments.filter((d) => !called.has(d));
    entries = candidates.some((d) => behindService.has(d)) ? candidates.filter((d) => behindService.has(d)) : candidates;
    if (entries.length > 1) assumptions.push(`Entry points (each gets the full traffic): ${entries.map((d) => pools.get(d)?.name).join(", ")}. Pass entry to choose.`);
  }
  const rateProfile = options.rateProfile ?? [[0, options.ratePerSecond ?? 10]];
  for (const d of new Set(entries)) {
    const pool = pools.get(d) as Component<string>;
    model.entityGenerator(unique(`traffic-${pool.name}`), { mode: "rateProfile", rateProfile, next: queues.get(d) as Component<string> });
  }

  model.sampleEvery(5, deployments.flatMap((d) => {
    const pool = (pools.get(d) as Component<string>).name;
    return [`${pool}.Concurrency`, `${pool}.BusyWorkers`, ...(holds.has(d) ? [`${pool}.HeldWorkers`] : [])];
  }));
  return { ok: true, model: model.toJSON(), mapped, ignored, assumptions, warnings };
}

/**
 * The HPA's target as a fraction of busy request slots, which is what the Autoscaler measures. From v1
 * `targetCPUUtilizationPercentage` or a v2 Resource metric. `fullPodLoad` is the CPU a pod with every slot busy uses,
 * as a multiple of its CPU request; without it, every slot busy counts as 100% of the request.
 */
function hpaTarget(hpa: K8sObject, warnings: string[], notes: string[], fullPodLoad?: number): number {
  const spec = at(hpa.raw, "spec");
  let percent = num(at(spec, "targetCPUUtilizationPercentage"));
  let cpuMetric = true;
  const metrics = at(spec, "metrics");
  if (Array.isArray(metrics) && metrics.length > 0) {
    const utilisation = (m: unknown) => (at(m, "type") === "Resource" && at(m, "resource", "target", "type") === "Utilization" ? num(at(m, "resource", "target", "averageUtilization")) : undefined);
    const cpu = metrics.find((m) => at(m, "resource", "name") === "cpu" && utilisation(m) !== undefined);
    const other = metrics.find((m) => utilisation(m) !== undefined);
    percent = utilisation(cpu ?? other);
    if (!cpu && other) {
      cpuMetric = false;
      warnings.push(`${hpa.id}: the ${String(at(other, "resource", "name"))} utilisation target is approximated as busy request slots.`);
    }
    if (metrics.length > 1) warnings.push(`${hpa.id}: only one metric is modelled; Kubernetes scales on the highest recommendation across all ${metrics.length}.`);
    if (percent === undefined) warnings.push(`${hpa.id}: no Resource Utilization metric; assumed an 80% CPU target.`);
  }
  if (percent === undefined) {
    percent = 80;
    notes.push("no utilisation target: Kubernetes default of 80% CPU");
  }
  if (percent > 100 || percent < 5) warnings.push(`${hpa.id}: a ${percent}% target is outside what the model can represent; clamped to ${clamp(percent, 5, 100)}%.`);
  percent = clamp(percent, 5, 100);
  if (fullPodLoad === undefined || !cpuMetric) {
    notes.push(`target ${percent}% CPU, treated as ${percent}% busy request slots`);
    return percent / 100;
  }
  const slots = percent / 100 / fullPodLoad;
  if (slots > 1) warnings.push(`${hpa.id}: with every slot busy a pod uses ${+(fullPodLoad * 100).toPrecision(3)}% of its CPU request, below the ${percent}% target, so CPU never drives a scale-out.`);
  if (slots < 0.05) warnings.push(`${hpa.id}: the ${percent}% target is reached at ${+(slots * 100).toPrecision(3)}% busy slots, below what the model can represent; clamped to 5%.`);
  notes.push(`target ${percent}% CPU, reached at ${+(slots * 100).toPrecision(3)}% busy request slots`);
  return clamp(slots, 0.05, 1);
}
