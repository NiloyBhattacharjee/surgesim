import { describe, expect, it } from "vitest";
import { loadModel, runModel } from "@surgesim/engine";
import { dist } from "@surgesim/sdk";
import { importKubernetes, parseManifests, parseOverlay, type KubernetesImportOptions } from "../src/index.js";

// What `kubectl get deploy,svc,hpa,cm -o yaml` prints: one List.
const CLUSTER = `
apiVersion: v1
kind: List
items:
  - apiVersion: apps/v1
    kind: Deployment
    metadata: { name: web-frontend }
    spec:
      replicas: 1
      selector: { matchLabels: { app: web } }
      template:
        metadata: { labels: { app: web, tier: front } }
        spec:
          containers:
            - name: web
              readinessProbe: { httpGet: { path: /healthz, port: 8080 }, initialDelaySeconds: 20 }
            - name: sidecar
              readinessProbe: { initialDelaySeconds: 5 }
  - apiVersion: apps/v1
    kind: Deployment
    metadata: { name: orders-api }
    spec:
      replicas: 3
      template: { metadata: { labels: { app: orders } }, spec: { containers: [{ name: api }] } }
  - apiVersion: apps/v1
    kind: Deployment
    metadata: { name: mailer }
    spec:
      template: { metadata: { labels: { app: mailer } }, spec: { containers: [{ name: mailer }] } }
  - apiVersion: v1
    kind: Service
    metadata: { name: web }
    spec: { selector: { app: web }, ports: [{ port: 80 }] }
  - apiVersion: v1
    kind: Service
    metadata: { name: orders }
    spec: { selector: { app: orders } }
  - apiVersion: autoscaling/v2
    kind: HorizontalPodAutoscaler
    metadata: { name: web-frontend }
    spec:
      scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: web-frontend }
      minReplicas: 2
      maxReplicas: 10
      metrics:
        - type: Resource
          resource: { name: cpu, target: { type: Utilization, averageUtilization: 50 } }
      behavior:
        scaleDown: { stabilizationWindowSeconds: 120 }
  - apiVersion: v1
    kind: ConfigMap
    metadata: { name: settings, namespace: shop }
`;

function objects(text = CLUSTER) {
  const p = parseManifests(text);
  if (!p.ok) throw new Error(p.message);
  return p.objects;
}
function imported(objs: unknown[] = objects(), options: KubernetesImportOptions = {}) {
  const r = importKubernetes(objs, options);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r;
}
const comp = (r: ReturnType<typeof imported>, name: string) => r.model.components.find((c) => c.name === name);
const out = (res: ReturnType<typeof runModel>, id: string) => res.outputs.find((o) => o.id === id)!;
function simulate(r: ReturnType<typeof imported>) {
  const loaded = loadModel(r.model);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  return runModel(loaded.model);
}
const hpa = (spec: object, name = "web-frontend") => ({
  apiVersion: "autoscaling/v2",
  kind: "HorizontalPodAutoscaler",
  metadata: { name },
  spec: { scaleTargetRef: { kind: "Deployment", name }, maxReplicas: 4, ...spec },
});
const deployment = (name: string, replicas?: number) => ({
  kind: "Deployment",
  metadata: { name },
  spec: { ...(replicas !== undefined ? { replicas } : {}), template: { metadata: { labels: { app: name } } } },
});

describe("parseManifests", () => {
  it("flattens a kubectl List into its items", () => {
    expect(objects().map((o) => o["kind"])).toEqual(["Deployment", "Deployment", "Deployment", "Service", "Service", "HorizontalPodAutoscaler", "ConfigMap"]);
  });

  it("reads multi-document YAML, skipping empty documents, and JSON", () => {
    const multi = "---\nkind: Deployment\nmetadata: { name: a }\n---\n---\nkind: Service\nmetadata: { name: b }\n";
    expect(objects(multi).map((o) => o["kind"])).toEqual(["Deployment", "Service"]);
    expect(objects(JSON.stringify({ kind: "DeploymentList", items: [deployment("a")] })).map((o) => o["kind"])).toEqual(["Deployment"]);
  });

  it("reports malformed YAML, duplicate keys and non-objects as errors instead of throwing", () => {
    expect(parseManifests("kind: [unclosed").ok).toBe(false);
    expect(parseManifests("kind: A\nkind: B\n").ok).toBe(false);
    expect(parseManifests("- 1\n- 2\n")).toEqual({ ok: false, message: "every document must be a Kubernetes object with a kind" });
  });
});

describe("importKubernetes: the example cluster", () => {
  const r = imported(objects(), { concurrencyPerPod: 10 });

  it("maps Deployments to pools, the HPA to an autoscaler and Services to the Deployment they select", () => {
    expect(r.mapped.map((m) => [m.logicalId, m.component, m.componentType])).toEqual([
      ["Deployment/web-frontend", "web-frontend", "WorkerPool"],
      ["HorizontalPodAutoscaler/web-frontend", "web-frontend-hpa", "Autoscaler"],
      ["Deployment/orders-api", "orders-api", "WorkerPool"],
      ["Deployment/mailer", "mailer", "WorkerPool"],
      ["Service/web", "web-frontend", "WorkerPool"],
      ["Service/orders", "orders-api", "WorkerPool"],
    ]);
    expect(r.ignored).toEqual([{ logicalId: "shop/ConfigMap/settings", type: "ConfigMap" }]);
  });

  it("each Deployment is a queue feeding a pool of replicas x concurrencyPerPod, billed in pod-hours", () => {
    expect(comp(r, "orders-api")!.inputs).toMatchObject({ concurrency: 30, costPerProvisionedSecond: 1 / 36_000 });
    expect(comp(r, "orders-api")!.links).toEqual({ queue: "orders-api-queue", next: "completed" });
    expect(comp(r, "mailer")!.inputs!["concurrency"]).toBe(10); // replicas not set: Kubernetes default 1
    // replicas: 1 is below minReplicas: 2, and the HPA moves it into range straight away.
    expect(comp(r, "web-frontend")!.inputs!["concurrency"]).toBe(20);
  });

  it("the HPA becomes a 15 s autoscaler in whole pods, with the readiness delay and stabilisation window", () => {
    expect(comp(r, "web-frontend-hpa")!.inputs).toEqual({
      targetUtilisation: 0.5,
      evaluationInterval: 15,
      minConcurrency: 20,
      maxConcurrency: 100,
      step: 10,
      scaleUpDelay: 20, // the slowest container's readinessProbe.initialDelaySeconds
      scaleDownStabilisation: 120,
    });
    expect(comp(r, "web-frontend-hpa")!.links).toEqual({ target: "web-frontend" });
  });

  it("traffic arrives only at Deployments behind a Service", () => {
    const sources = r.model.components.filter((c) => c.type === "EntityGenerator").map((c) => c.links!["next"]);
    expect(sources).toEqual(["web-frontend-queue", "orders-api-queue"]);
  });

  it("states its assumptions and approximations", () => {
    expect(r.assumptions.join("\n")).toMatch(/Traffic: 10 requests\/second/);
    expect(r.assumptions.join("\n")).toMatch(/Service time: exponential with mean 0.2 s/);
    expect(r.assumptions.join("\n")).toMatch(/readinessProbe initialDelaySeconds;/);
    expect(r.assumptions.join("\n")).not.toMatch(/concurrencyPerPod/); // it was given
    expect(r.warnings.join("\n")).toMatch(/share one queue/);
    expect(r.warnings.join("\n")).toMatch(/busy request slots/);
  });

  it("produces a model the engine accepts, sampling pods over time", () => {
    expect(loadModel(r.model).ok).toBe(true);
    expect(r.model.settings.timeSeries!.outputs).toContain("web-frontend.Concurrency");
  });
});

describe("importKubernetes: simulation", () => {
  it("new pods take traffic only after the readiness delay (first decision at 15 s, pods ready at 35 s)", () => {
    // 100/s x 0.5 s offered to 2 pods x 10 slots: saturated, so 20 busy at 50% -> 4 pods.
    const r = imported(objects(), { concurrencyPerPod: 10, ratePerSecond: 100, serviceTime: dist.constant(0.5), entry: ["web"], duration: 60, replications: 1 });
    const res = simulate(r);
    const c = res.timeSeries!.replications[0]!.values["web-frontend.Concurrency"]!;
    expect(c[6]).toBe(20); // t = 30
    expect(c[8]).toBe(40); // t = 40
    // Overloaded requests wait in the Deployment's queue; none are rejected.
    expect(out(res, "web-frontend.NumberThrottled").mean).toBe(0);
    expect(out(res, "web-frontend-queue.MaxQueueLength").mean!).toBeGreaterThan(100);
  });

  it("scales in whole pods and reports pod-hours: Cost = average pods x hours", () => {
    const r = imported(objects(), { concurrencyPerPod: 10, ratePerSecond: 30, serviceTime: dist.exponential(0.5), entry: ["web"], duration: 3600, replications: 2, seed: 4 });
    const res = simulate(r);
    for (const rep of res.timeSeries!.replications) expect(rep.values["web-frontend.Concurrency"]!.every((v) => v !== null && v % 10 === 0)).toBe(true);
    // 15 busy at a 50% target -> about 3 pods, sometimes 4 while the window remembers a noisy peak.
    const pods = out(res, "web-frontend.AverageConcurrency").mean! / 10;
    expect(pods).toBeGreaterThan(2.5);
    expect(pods).toBeLessThan(4.5);
    expect(out(res, "web-frontend.Cost").mean!).toBeCloseTo(pods * 1, 6); // one hour
  });
});

describe("importKubernetes: options and edge cases", () => {
  it("entry picks Services or Deployments by name and warns about unknown ones", () => {
    const r = imported(objects(), { entry: ["orders", "mailer", "nope"] });
    expect(r.model.components.filter((c) => c.type === "EntityGenerator").map((c) => c.links!["next"])).toEqual(["orders-api-queue", "mailer-queue"]);
    expect(r.warnings.join("\n")).toMatch(/entry "nope" is not a Service or Deployment/);
  });

  it("with no Services, every Deployment gets traffic; startupDelay overrides the probes", () => {
    const r = imported([deployment("a", 2), deployment("b"), hpa({}, "a")], { startupDelay: 45 });
    expect(r.model.components.filter((c) => c.type === "EntityGenerator")).toHaveLength(2);
    expect(r.assumptions.join("\n")).toMatch(/Entry points \(each gets the full traffic\): a, b/);
    expect(comp(r, "a-hpa")!.inputs!["scaleUpDelay"]).toBe(45);
    expect(r.assumptions.join("\n")).not.toMatch(/readinessProbe/);
  });

  it("reads an autoscaling/v1 target, and defaults to 80% CPU and a 300 s window", () => {
    expect(comp(imported([deployment("web-frontend"), hpa({ targetCPUUtilizationPercentage: 65 })]), "web-frontend-hpa")!.inputs).toMatchObject({ targetUtilisation: 0.65, scaleDownStabilisation: 300 });
    const d = imported([deployment("web-frontend"), hpa({})]);
    expect(comp(d, "web-frontend-hpa")!.inputs!["targetUtilisation"]).toBe(0.8);
    expect(d.mapped.find((m) => m.componentType === "Autoscaler")!.notes).toContain("no utilisation target: Kubernetes default of 80% CPU");
  });

  it("flags what the autoscaler cannot represent", () => {
    const memory = { type: "Resource", resource: { name: "memory", target: { type: "Utilization", averageUtilization: 70 } } };
    const cpu = { type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: 150 } } };
    const r = imported([
      deployment("web-frontend"),
      hpa({ metrics: [memory, cpu], behavior: { scaleUp: { stabilizationWindowSeconds: 60, policies: [{ type: "Pods", value: 1, periodSeconds: 60 }] } } }),
    ]);
    const w = r.warnings.join("\n");
    expect(w).toMatch(/only one metric is modelled/);
    expect(w).toMatch(/150% target .* clamped to 100%/);
    expect(w).toMatch(/scale-up stabilisation window is not modelled/);
    expect(w).toMatch(/scaling rate policies/);
    expect(comp(r, "web-frontend-hpa")!.inputs!["targetUtilisation"]).toBe(1);
    const mem = imported([deployment("web-frontend"), hpa({ metrics: [memory] })]);
    expect(mem.warnings.join("\n")).toMatch(/memory utilisation target is approximated/);
    expect(comp(mem, "web-frontend-hpa")!.inputs!["targetUtilisation"]).toBe(0.7);
  });

  it("selectPolicy Disabled: scale-down off never scales in; scale-up off caps at the start; both off means no autoscaler", () => {
    const off = (dir: "scaleUp" | "scaleDown") => ({ [dir]: { selectPolicy: "Disabled", policies: [{ type: "Pods", value: 1, periodSeconds: 60 }] } });
    const down = imported([deployment("web-frontend", 3), hpa({ minReplicas: 1, maxReplicas: 10, behavior: off("scaleDown") })], { concurrencyPerPod: 10, duration: 900 });
    expect(comp(down, "web-frontend-hpa")!.inputs).toMatchObject({ minConcurrency: 30, maxConcurrency: 100, scaleDownStabilisation: 900 });
    expect(down.warnings.join("\n")).not.toMatch(/rate policies/); // only the disabled direction has policies
    // Idle for an hour: with scale-down allowed it drops to 1 pod; disabled, it keeps all 3.
    const idle = (behavior: object) => {
      const r = imported([deployment("web-frontend", 3), hpa({ minReplicas: 1, maxReplicas: 10, behavior })], { ratePerSecond: 0.001, duration: 3600, replications: 1 });
      return simulate(r).timeSeries!.replications[0]!.values["web-frontend.Concurrency"]!;
    };
    expect(new Set(idle(off("scaleDown")))).toEqual(new Set([30]));
    expect(idle({}).at(-1)).toBe(10);

    const up = imported([deployment("web-frontend", 3), hpa({ minReplicas: 1, maxReplicas: 10, behavior: off("scaleUp") })], { concurrencyPerPod: 10 });
    expect(comp(up, "web-frontend-hpa")!.inputs).toMatchObject({ minConcurrency: 10, maxConcurrency: 30, scaleDownStabilisation: 300 });
    expect(up.warnings.join("\n")).toMatch(/scaleUp selectPolicy Disabled is approximated by capping at the starting 3 pod/);

    const both = imported([deployment("web-frontend", 3), hpa({ behavior: { ...off("scaleUp"), ...off("scaleDown") } })]);
    expect(both.model.components.some((c) => c.type === "Autoscaler")).toBe(false);
    expect(both.mapped.find((m) => m.type === "HorizontalPodAutoscaler")!.notes[0]).toMatch(/replicas stay fixed/);
  });

  it("entry names that match in several namespaces are rejected as ambiguous; namespace/name picks one", () => {
    const inNs = (o: Record<string, any>, namespace: string) => ({ ...o, metadata: { ...o["metadata"], namespace } });
    const svc = { kind: "Service", metadata: { name: "api" }, spec: { selector: { app: "api" } } };
    const objs = [inNs(deployment("api"), "prod"), inNs(svc, "prod"), inNs(deployment("api"), "staging"), inNs(svc, "staging")];
    const r = imported(objs, { entry: ["api", "staging/api"] });
    expect(r.warnings.join("\n")).toMatch(/entry "api" is ambiguous \(prod\/Deployment\/api, staging\/Deployment\/api\); write it as namespace\/name/);
    expect(r.model.components.filter((c) => c.type === "EntityGenerator").map((c) => c.links!["next"])).toEqual(["staging-api-queue"]);
    // A Service and the Deployment it selects, sharing a name, are one match, not an ambiguity.
    expect(imported(objs, { entry: ["prod/api"] }).warnings.join("\n")).not.toMatch(/ambiguous/);
  });

  it("skips HPAs and Services it cannot connect, with a warning", () => {
    const r = imported([
      deployment("a"),
      hpa({}, "missing"),
      { ...hpa({}, "a"), spec: { scaleTargetRef: { kind: "Deployment", name: "a" } } },
      { kind: "Service", metadata: { name: "s" }, spec: { selector: { app: "other" } } },
    ]);
    const w = r.warnings.join("\n");
    expect(w).toMatch(/scale target Deployment\/missing is not a Deployment/);
    expect(w).toMatch(/maxReplicas is missing/);
    expect(w).toMatch(/Service\/s: its selector matches no Deployment/);
    expect(r.model.components.some((c) => c.type === "Autoscaler")).toBe(false);
  });

  it("same-named Deployments in two namespaces get distinct names", () => {
    const other = { ...deployment("api"), metadata: { name: "api", namespace: "staging" } };
    const r = imported([deployment("api"), other]);
    expect(r.mapped.map((m) => [m.logicalId, m.component])).toEqual([
      ["Deployment/api", "default-api"],
      ["staging/Deployment/api", "staging-api"],
    ]);
    expect(loadModel(r.model).ok).toBe(true);
  });

  it("rejects input with no Deployment, or objects without a name, with a structured error", () => {
    expect(importKubernetes([{ kind: "Service", metadata: { name: "s" } }])).toEqual({ ok: false, errors: [{ message: "no Deployment found (kinds seen: Service)" }] });
    expect(importKubernetes([{ kind: "Deployment" }]).ok).toBe(false);
  });
});

const OVERLAY = `
traffic:
  entry: web
  rateProfile: [[0, 50], [300, 150]]
services:
  web:                      # a Service name: means the web-frontend Deployment
    concurrencyPerPod: 50
    startupDelay: 30
    serviceTime: { dist: lognormal, mean: 0.04, stdDev: 0.015 }
    calls:
      - { service: orders, probability: 0.6 }
  orders-api:
    serviceTime: 0.12
    calls: [{ service: mailer, probability: 1 }]
`;

function overlay(text = OVERLAY) {
  const p = parseOverlay(text);
  if (!p.ok) throw new Error(JSON.stringify(p.errors));
  return p.options;
}
const overlayErrors = (text: string) => {
  const p = parseOverlay(text);
  return p.ok ? [] : p.errors.map((e) => e.message);
};

describe("parseOverlay", () => {
  it("reads traffic and per-service settings into import options, values unchanged", () => {
    expect(overlay()).toEqual({
      entry: ["web"],
      rateProfile: [[0, 50], [300, 150]],
      services: {
        web: { concurrencyPerPod: 50, startupDelay: 30, serviceTime: { dist: "lognormal", mean: 0.04, stdDev: 0.015 }, calls: [{ service: "orders", probability: 0.6 }] },
        "orders-api": { serviceTime: 0.12, calls: [{ service: "mailer", probability: 1 }] },
      },
    });
    expect(overlay('{ "traffic": { "entry": ["a", "b"], "ratePerSecond": 5 } }')).toEqual({ entry: ["a", "b"], ratePerSecond: 5 });
    expect(overlay("")).toEqual({});
  });

  it("reports every shape problem with its path", () => {
    expect(overlayErrors(`
nope: 1
traffic: { ratePerSecond: 5, rateProfile: [[0, 1]], entry: [] }
services:
  a: { concurrencyPerPod: 1.5, startupDelay: -1, serviceTime: fast, extra: 1 }
  b: { calls: [{ service: c, probability: 1.5 }, { probability: 0.1 }, 3] }
  c: 7
`)).toEqual([
      "nope: unknown key (expected one of traffic, services)",
      "traffic.entry: must be a name or a non-empty list of names",
      "traffic: give ratePerSecond or rateProfile, not both",
      "services.a.extra: unknown key (expected one of serviceTime, concurrencyPerPod, startupDelay, cpuPerRequest, rollingUpdateAt, calls)",
      "services.a.serviceTime: must be seconds (a number >= 0) or a distribution such as { dist: lognormal, mean: 0.04, stdDev: 0.015 }",
      "services.a.concurrencyPerPod: must be an integer >= 1",
      "services.a.startupDelay: must be a number >= 0",
      "services.b.calls[0].probability: must be a number in [0, 1]",
      "services.b.calls[1].service: must be a Service or Deployment name",
      "services.b.calls[2]: must be { service, probability, synchronous? }",
      "services.c: must be a mapping",
    ]);
    expect(overlayErrors("services: { a: { calls: [{ service: b, probability: 1, synchronous: yes, wait: 1 }] } }")).toEqual([
      "services.a.calls[0].wait: unknown key (expected one of service, probability, synchronous)",
      "services.a.calls[0].synchronous: must be true or false",
    ]);
    expect(overlayErrors("traffic: { rateProfile: [[0, -1]] }")[0]).toMatch(/rateProfile: must be a non-empty list/);
    expect(overlayErrors("- a\n- b\n")).toEqual(["the overlay must be a mapping with traffic and/or services"]);
    expect(overlayErrors("traffic: [unclosed")).toHaveLength(1);
    expect(overlayErrors("traffic: {}\ntraffic: {}\n")).toHaveLength(1);
  });
});

describe("importKubernetes with an overlay", () => {
  const r = imported(objects(), overlay());

  it("wires the call graph with Branches: called share, and the rest completes", () => {
    expect(comp(r, "web-frontend")!.links!["next"]).toBe("web-frontend-calls");
    expect(comp(r, "web-frontend-calls")).toMatchObject({ type: "Branch", inputs: { probabilities: [0.6, expect.closeTo(0.4, 12)] }, links: { targets: ["orders-api-queue", "completed"] } });
    // probability 1: no share left to complete here
    expect(comp(r, "orders-api-calls")).toMatchObject({ inputs: { probabilities: [1] }, links: { targets: ["mailer-queue"] } });
    expect(comp(r, "mailer")!.links!["next"]).toBe("completed");
  });

  it("per-service settings override the defaults, keyed by Service or Deployment name", () => {
    expect(comp(r, "web-frontend")!.inputs).toMatchObject({ concurrency: 100, serviceTime: { dist: "lognormal", mean: 0.04, stdDev: 0.015 }, costPerProvisionedSecond: 1 / (50 * 3600) });
    expect(comp(r, "web-frontend-hpa")!.inputs).toMatchObject({ step: 50, minConcurrency: 100, maxConcurrency: 500, scaleUpDelay: 30 });
    expect(comp(r, "orders-api")!.inputs).toMatchObject({ concurrency: 30, serviceTime: 0.12 });
  });

  it("traffic follows the overlay's rate profile, at the entry it names", () => {
    const gens = r.model.components.filter((c) => c.type === "EntityGenerator");
    expect(gens.map((g) => [g.links!["next"], g.inputs!["rateProfile"]])).toEqual([["web-frontend-queue", [[0, 50], [300, 150]]]]);
  });

  it("assumes only what the overlay leaves out, and says calls are asynchronous", () => {
    const a = r.assumptions.join("\n");
    expect(a).not.toMatch(/Traffic:/);
    expect(a).toMatch(/Service time: exponential with mean 0.2 s for mailer \(/);
    expect(a).toMatch(/Each pod of orders-api, mailer serves 10 requests/);
    expect(a).not.toMatch(/readinessProbe/); // the only HPA'd Deployment has a startupDelay
    expect(r.warnings.join("\n")).toMatch(/Calls are asynchronous/);
    expect(loadModel(r.model).ok).toBe(true);
  });

  it("without an entry, Deployments that others call get no traffic of their own", () => {
    const { entry, ...rest } = overlay();
    const gens = imported(objects(), rest).model.components.filter((c) => c.type === "EntityGenerator");
    expect(gens.map((g) => g.links!["next"])).toEqual(["web-frontend-queue"]); // orders-api is behind a Service, but called
  });

  it("simulates the call graph: latency = 0.04 + 0.6 x (0.12 + 0.01) s with ample capacity", () => {
    const text = `
traffic: { entry: web, ratePerSecond: 20 }
services:
  web-frontend: { serviceTime: 0.04, calls: [{ service: orders-api, probability: 0.6 }] }
  orders-api: { serviceTime: 0.12, calls: [{ service: mailer, probability: 1 }] }
  mailer: { serviceTime: 0.01 }
`;
    const res = simulate(imported(objects(), { ...overlay(text), concurrencyPerPod: 100, duration: 600, replications: 3, seed: 2 }));
    const served = out(res, "web-frontend.NumberSucceeded").mean!;
    // binomial: sd of the called fraction ~ sqrt(0.24 / 12000) ~ 0.0045; allow 4 sd
    expect(Math.abs(out(res, "orders-api.NumberSucceeded").mean! / served - 0.6)).toBeLessThan(0.018);
    expect(out(res, "mailer.NumberSucceeded").mean).toBe(out(res, "orders-api.NumberSucceeded").mean);
    expect(out(res, "completed.mean").mean!).toBeCloseTo(0.04 + 0.6 * 0.13, 2);
  });

  describe("synchronous calls", () => {
    const text = `
traffic: { entry: web, ratePerSecond: 20 }
services:
  web-frontend: { serviceTime: 0.04, calls: [{ service: orders-api, probability: 0.6, synchronous: true }] }
  orders-api: { serviceTime: 0.12, calls: [{ service: mailer, probability: 1 }] }
  mailer: { serviceTime: 0.01 }
`;
    const sync = imported(objects(), { ...overlay(text), concurrencyPerPod: 100, duration: 600, replications: 3, seed: 2 });

    it("hold the caller's slot; completions and asynchronous calls go through a Release", () => {
      expect(overlay(text).services!["web-frontend"]!.calls).toEqual([{ service: "orders-api", probability: 0.6, synchronous: true }]);
      expect(comp(sync, "web-frontend")!.inputs).toMatchObject({ holdUntilRelease: true });
      expect(comp(sync, "orders-api")!.inputs!["holdUntilRelease"]).toBeUndefined();
      expect(comp(sync, "web-frontend-calls")!.links!["targets"]).toEqual(["orders-api-queue", "release"]);
      expect(comp(sync, "orders-api-calls")!.links!["targets"]).toEqual(["mailer-release"]);
      expect(comp(sync, "mailer-release")).toMatchObject({ type: "Release", links: { next: "mailer-queue" } });
      expect(comp(sync, "mailer")!.links!["next"]).toBe("release");
      expect(comp(sync, "release")).toMatchObject({ type: "Release", links: { next: "completed" } });
      expect(sync.model.settings.timeSeries!.outputs).toContain("web-frontend.HeldWorkers");
      expect(sync.warnings.join("\n")).toMatch(/Calls are asynchronous unless marked synchronous/);
      expect(sync.warnings.join("\n")).toMatch(/Synchronous calls hold the caller's request slot/);
      // asynchronous only: no Release, so existing models are unchanged
      expect(r.model.components.some((c) => c.type === "Release")).toBe(false);
    });

    it("simulate: by Little's law the caller's busy slots are 20/s x (0.04 + 0.6 x 0.12) s; latency is unchanged", () => {
      const res = simulate(sync);
      // mailer is asynchronous, so web-frontend waits for orders-api's work only, not mailer's
      expect(out(res, "web-frontend.AverageBusyWorkers").mean!).toBeCloseTo(20 * (0.04 + 0.6 * 0.12), 1);
      expect(out(res, "completed.mean").mean!).toBeCloseTo(0.04 + 0.6 * 0.13, 2);
    });
  });

  describe("CPU limits and requests (cpuPerRequest)", () => {
    const podWith = (containers: object[], name = "api") => ({
      kind: "Deployment",
      metadata: { name },
      spec: { replicas: 1, template: { metadata: { labels: { app: name } }, spec: { containers } } },
    });
    const pod = (resources: object) => podWith([{ name: "api", resources }]);
    const cpuOptions = (cpuPerRequest?: number, extra: object = {}): KubernetesImportOptions => ({
      ratePerSecond: 20,
      serviceTime: 0.1,
      concurrencyPerPod: 10,
      services: { api: cpuPerRequest !== undefined ? { cpuPerRequest } : {} },
      ...extra,
    });

    it("the overlay reads cpuPerRequest and rejects a non-positive one", () => {
      expect(overlay("services: { web: { cpuPerRequest: 0.2 } }").services!["web"]).toEqual({ cpuPerRequest: 0.2 });
      expect(overlayErrors("services: { web: { cpuPerRequest: 0 } }")).toEqual(["services.web.cpuPerRequest: must be a number >= 0.001"]);
    });

    it("the oversubscription is cpuPerRequest x slots per pod / the limit, reading millicores and summing containers", () => {
      expect(comp(imported([pod({ limits: { cpu: "500m" } })], cpuOptions(0.2)), "api")!.inputs!["cpuOversubscription"]).toBeCloseTo(4, 9);
      const two = podWith([{ resources: { limits: { cpu: "1.5" } } }, { resources: { limits: { cpu: 1 } } }]);
      expect(comp(imported([two], cpuOptions(0.5)), "api")!.inputs!["cpuOversubscription"]).toBeCloseTo(2, 9);
    });

    it("no throttling when the limit is never reached, or is unknown, and it says so", () => {
      expect(comp(imported([pod({ limits: { cpu: "4" } })], cpuOptions(0.2)), "api")!.inputs!["cpuOversubscription"]).toBeUndefined();
      const noOverlay = imported([pod({ limits: { cpu: "1" } })], cpuOptions());
      expect(comp(noOverlay, "api")!.inputs!["cpuOversubscription"]).toBeUndefined();
      expect(noOverlay.warnings.join("\n")).toMatch(/CPU limit is ignored; set cpuPerRequest/);
      const partial = imported([podWith([{ resources: { limits: { cpu: "100m" } } }, {}])], cpuOptions(0.2));
      expect(comp(partial, "api")!.inputs!["cpuOversubscription"]).toBeUndefined();
      expect(partial.warnings.join("\n")).toMatch(/not every container has a CPU limit/);
    });

    it("a too-low limit caps throughput at limit / (cpuPerRequest x service time) = 1 / (0.2 x 0.1) = 50/s", () => {
      const run = (limit: string) => simulate(imported([pod({ limits: { cpu: limit } })], cpuOptions(0.2, { ratePerSecond: 80, duration: 300, replications: 2, seed: 4 })));
      const low = run("1");
      expect(Math.abs(out(low, "api.NumberSucceeded").mean! / 300 - 50)).toBeLessThan(1);
      expect(out(low, "api.AverageCpuStretch").mean!).toBeGreaterThan(1.9);
      expect(out(run("4"), "api.AverageCpuStretch").mean!).toBe(1); // 2 cores demanded at most
      expect(imported([pod({ limits: { cpu: "1" } })], cpuOptions(0.2)).warnings.join("\n")).toMatch(/not 100 ms CFS periods/);
    });

    describe("the HPA works from CPU use against the request", () => {
      const scaled = (resources: object, target = 50) => [pod(resources), hpa({ maxReplicas: 20, metrics: [{ type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: target } } }] }, "api")];
      const targetOf = (r: ReturnType<typeof imported>) => comp(r, "api-hpa")!.inputs!["targetUtilisation"];

      it("target slots = target x request / (cpuPerRequest x slots per pod)", () => {
        expect(targetOf(imported(scaled({ requests: { cpu: "250m" } }), cpuOptions(0.05)))).toBeCloseTo((0.5 * 0.25) / 0.5, 9);
        expect(targetOf(imported(scaled({ requests: { cpu: "250m" } }), cpuOptions()))).toBe(0.5);
        expect(targetOf(imported(scaled({}), cpuOptions(0.05)))).toBe(0.5); // no request: the slot proxy
        expect(targetOf(imported(scaled({ limits: { cpu: "250m" } }), cpuOptions(0.05)))).toBeCloseTo(0.25, 9); // the request defaults to the limit
      });

      it("warns when the target cannot be reached, or cannot be represented", () => {
        const never = imported(scaled({ requests: { cpu: "4" } }), cpuOptions(0.05));
        expect(targetOf(never)).toBe(1);
        expect(never.warnings.join("\n")).toMatch(/uses 12.5% of its CPU request, below the 50% target/);
        const tiny = imported(scaled({ requests: { cpu: "10m" } }), cpuOptions(0.1));
        expect(targetOf(tiny)).toBe(0.05);
        expect(tiny.warnings.join("\n")).toMatch(/clamped to 5%/);
      });

      it("a memory target stays on the slot proxy", () => {
        const memory = [pod({ requests: { cpu: "250m" } }), hpa({ metrics: [{ type: "Resource", resource: { name: "memory", target: { type: "Utilization", averageUtilization: 50 } } }] }, "api")];
        expect(targetOf(imported(memory, cpuOptions(0.05)))).toBe(0.5);
      });

      it("simulates the HPA formula: 20/s x 0.1 s x 0.1 cores = 0.2 cores; at 0.1 cores per pod and a 50% target that is 4 pods", () => {
        const run = (cpuPerRequest?: number) => simulate(imported(scaled({ requests: { cpu: "100m" } }), cpuOptions(cpuPerRequest, { concurrencyPerPod: 5, duration: 900, warmUp: 300, replications: 2, seed: 5 })));
        const pods = out(run(0.1), "api.AverageConcurrency").mean! / 5;
        expect(pods).toBeGreaterThanOrEqual(3.9);
        expect(pods).toBeLessThan(7); // the HPA rounds up and holds its noisy peak for the 300 s window
        expect(out(run(), "api.AverageConcurrency").mean! / 5).toBeLessThan(3); // on the proxy: 2 busy slots / 50% = 4 slots, 1 pod
      });

      it("a throttled pod's CPU use stops at its limit: 1 pod at limit = request and a 50% target asks for 1 x 100% / 50% = 2 pods", () => {
        const objs = scaled({ requests: { cpu: "1" }, limits: { cpu: "1" } });
        const at = (duration: number) => out(simulate(imported(objs, cpuOptions(0.5, { ratePerSecond: 1000, duration, replications: 1 }))), "api-hpa.DesiredConcurrency").mean;
        expect(at(14)).toBe(10); // no decision before 15 s
        expect(at(16)).toBe(20);
      });
    });
  });

  describe("rolling updates (rollingUpdateAt)", () => {
    const withStrategy = (replicas: number, strategy?: object, extra: object = {}) => ({
      kind: "Deployment",
      metadata: { name: "api" },
      spec: { replicas, ...(strategy ? { strategy } : {}), ...extra, template: { metadata: { labels: { app: "api" } }, spec: { containers: [{ readinessProbe: { initialDelaySeconds: 30 } }] } } },
    });
    const rolling = (replicas: number, strategy?: object, extra: object = {}, at = 100, options: object = {}) =>
      imported([withStrategy(replicas, strategy, extra)], { concurrencyPerPod: 10, services: { api: { rollingUpdateAt: at } }, ...options });
    const inputsOf = (r: ReturnType<typeof imported>) => comp(r, "api-rollout")!.inputs!;

    it("the overlay reads rollingUpdateAt", () => {
      expect(overlay("services: { web: { rollingUpdateAt: 300 } }").services!["web"]).toEqual({ rollingUpdateAt: 300 });
      expect(overlayErrors("services: { web: { rollingUpdateAt: -1 } }")).toEqual(["services.web.rollingUpdateAt: must be a number >= 0"]);
    });

    it("defaults to Kubernetes' 25% / 25%, with the readiness delay and pod size", () => {
      expect(comp(rolling(4), "api-rollout")).toMatchObject({
        type: "RollingUpdate",
        inputs: { at: 100, readinessDelay: 30, podSize: 10, maxSurgeFraction: 0.25, maxUnavailableFraction: 0.25 },
        links: { target: "api" },
      });
    });

    it("reads counts and percentages, Recreate and minReadySeconds", () => {
      expect(inputsOf(rolling(4, { rollingUpdate: { maxSurge: 2, maxUnavailable: "50%" } }))).toMatchObject({ maxSurge: 2, maxUnavailableFraction: 0.5 });
      expect(inputsOf(rolling(4, { rollingUpdate: { maxUnavailable: 0 } }))).toMatchObject({ maxSurgeFraction: 0.25, maxUnavailable: 0 });
      expect(inputsOf(rolling(4, { type: "Recreate" }))).toMatchObject({ maxSurge: 0, maxUnavailableFraction: 1 });
      expect(inputsOf(rolling(4, undefined, { minReadySeconds: 15 }))).toMatchObject({ readinessDelay: 45 });
    });

    it("warns about a bad strategy value and an update after the run, and adds no component without rollingUpdateAt", () => {
      const bad = rolling(4, { rollingUpdate: { maxSurge: "lots" } });
      expect(inputsOf(bad)).toMatchObject({ maxSurgeFraction: 0.25 });
      expect(bad.warnings.join("\n")).toMatch(/not a count or a percentage/);
      expect(rolling(4, undefined, {}, 600).warnings.join("\n")).toMatch(/so the update never starts/);
      expect(r.model.components.some((c) => c.type === "RollingUpdate")).toBe(false);
    });

    it("simulates: at 25% of 4 pods the deploy takes two readiness delays, and 3 pods serve throughout", () => {
      const res = simulate(rolling(4, undefined, {}, 100, { ratePerSecond: 1, serviceTime: 0.01, duration: 300, replications: 1 }));
      expect(out(res, "api-rollout.RolloutSeconds").mean).toBe(60);
      expect(out(res, "api-rollout.PodsReplaced").mean).toBe(4);
      expect(out(res, "api.AverageConcurrency").mean!).toBeCloseTo(40 - (10 * 60) / 300, 9);
    });

    it("under load, a deploy with no spare capacity builds a backlog that maxUnavailable: 0 avoids", () => {
      // 3 pods x 10 slots at 0.1 s serve 300/s; 270/s leaves 90% busy. One pod out is 200/s, below the traffic.
      const load = { ratePerSecond: 270, serviceTime: 0.1, duration: 400, replications: 3, seed: 6 };
      const backlog = (rollingUpdate: object) => out(simulate(rolling(3, { rollingUpdate }, {}, 100, load)), "api-queue.MaxQueueLength").mean!;
      expect(backlog({ maxSurge: 0, maxUnavailable: 1 })).toBeGreaterThan(70 * 60); // (270 - 200)/s through the 90 s deploy
      expect(backlog({ maxSurge: 1, maxUnavailable: 0 })).toBeLessThan(200);
    });
  });

  it("rejects overlays that do not fit the manifests, with every problem listed", () => {
    const bad = (services: KubernetesImportOptions["services"]) => {
      const res = importKubernetes(objects(), { services });
      return res.ok ? [] : res.errors.map((e) => e.message);
    };
    expect(bad({ nope: {}, web: { calls: [{ service: "ghost", probability: 0.5 }, { service: "mailer", probability: 0.3 }, { service: "mailer", probability: 0.3 }] } })).toEqual([
      'services: "nope" is not a Service or Deployment in these manifests',
      'Deployment/web-frontend calls "ghost" is not a Service or Deployment in these manifests',
      "Deployment/web-frontend calls Deployment/mailer twice",
    ]);
    expect(bad({ web: { calls: [{ service: "orders", probability: 0.7 }, { service: "mailer", probability: 0.4 }] } })[0]).toBe(
      "Deployment/web-frontend: call probabilities add up to 1.1; a request makes at most one call, so they must add up to at most 1",
    );
    expect(bad({ web: {}, "web-frontend": {} })).toEqual(['services: "web-frontend" is Deployment/web-frontend again']);
    expect(bad({ web: { calls: [{ service: "orders", probability: 0.5 }] }, orders: { calls: [{ service: "web-frontend", probability: 0.5 }] } })).toEqual([
      "the call graph has a cycle: Deployment/web-frontend -> Deployment/orders-api -> Deployment/web-frontend",
    ]);
  });
});
