import { Component, Model, dist, type ModelJson, type Sampler } from "@chronon-sim/sdk";
import { collectRefs, isRecord, resolveNumber, resolveString, stripCdkHash, type Json } from "./intrinsics.js";

/** What to assume where a template is silent. A template describes infrastructure, not traffic or code. */
export interface ImportOptions {
  /** Model name (default: derived from the template's Description, or "Imported stack"). */
  name?: string;
  /** Arrivals per second at each entry point (default 10). The template cannot say how much traffic there is. */
  ratePerSecond?: number;
  /** Service time per request (default exponential with mean 0.2 s). The template cannot say how long work takes. */
  serviceTime?: Sampler;
  /** Extra time when a Lambda invocation has to start a new instance (default none). */
  coldStartTime?: Sampler;
  /** Concurrency for Lambda functions with no reserved concurrency (default 1000, the usual account limit). */
  defaultLambdaConcurrency?: number;
  /** Requests one ECS task handles concurrently (default 10). */
  concurrencyPerTask?: number;
  /** Logical ids or names of the entry points that receive traffic. Default: queues that are not dead-letter targets, plus web-style services and functions with no queue trigger. */
  entry?: readonly string[];
  /** Simulated seconds (default 600). */
  duration?: number;
  warmUp?: number;
  seed?: number;
  replications?: number;
}

/** How one template resource was modelled. */
export interface MappedResource {
  logicalId: string;
  type: string;
  /** The component it became. */
  component: string;
  componentType: string;
  notes: string[];
}

export type ImportResult =
  | {
      ok: true;
      /** The model, in the JSON model format. */
      model: ModelJson;
      mapped: MappedResource[];
      /** Resources the importer does not understand; they are not in the model. */
      ignored: { logicalId: string; type: string }[];
      /** Numbers the template did not provide, which the importer filled in. Review these. */
      assumptions: string[];
      /** Things in the template that the model could not represent faithfully. */
      warnings: string[];
    }
  | { ok: false; errors: { message: string }[] };

const SUPPORTED = new Set([
  "AWS::SQS::Queue",
  "AWS::Lambda::Function",
  "AWS::Lambda::EventSourceMapping",
  "AWS::ECS::Service",
  "AWS::ApplicationAutoScaling::ScalableTarget",
  "AWS::ApplicationAutoScaling::ScalingPolicy",
  "AWS::ApiGateway::UsagePlan",
  "AWS::ApiGateway::Stage",
]);

interface Resource {
  id: string;
  type: string;
  props: Record<string, Json>;
  raw: Record<string, Json>;
}

/** Component names must be unique and readable: prefer a literal name, then the CDK construct id, then the logical id. */
function allocateNames(resources: readonly Resource[], parameters: Record<string, Json>): Map<string, string> {
  const taken = new Set<string>();
  const names = new Map<string, string>();
  const preferred = (r: Resource): string[] => {
    const literal = resolveString(r.props["QueueName"] ?? r.props["FunctionName"], parameters);
    const out: string[] = [];
    if (literal) out.push(literal);
    const meta = r.raw["Metadata"];
    if (isRecord(meta) && typeof meta["aws:cdk:path"] === "string") out.push(stripCdkHash(r.id));
    out.push(r.id);
    return out;
  };
  for (const r of resources) {
    const choice = preferred(r).find((n) => !taken.has(n)) ?? `${r.id}-${taken.size}`;
    taken.add(choice);
    names.set(r.id, choice);
  }
  return names;
}

function parseJsonish(v: Json): Json {
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return undefined;
    }
  }
  return v;
}

/**
 * Convert a CloudFormation template (JSON, as `cdk synth` writes to `cdk.out/*.template.json`) into a
 * Chronon Sim model.
 *
 * Mapped: `AWS::SQS::Queue` (visibility timeout, redrive policy and dead-letter queue) to MessageQueue;
 * `AWS::Lambda::Function` (reserved concurrency) to WorkerPool, wired to its queue through
 * `AWS::Lambda::EventSourceMapping`; `AWS::ECS::Service` (desired count) to WorkerPool;
 * `AWS::ApplicationAutoScaling` target tracking to Autoscaler; API Gateway throttling to RateLimiter.
 *
 * A template says nothing about traffic or how long work takes, so those come from {@link ImportOptions}
 * and every such number is listed in `assumptions`.
 */
export function importCloudFormation(template: unknown, options: ImportOptions = {}): ImportResult {
  if (!isRecord(template) || !isRecord(template["Resources"])) {
    return { ok: false, errors: [{ message: 'not a CloudFormation template: expected a JSON object with a "Resources" section' }] };
  }
  const parameters = isRecord(template["Parameters"]) ? (template["Parameters"] as Record<string, Json>) : {};
  const warnings: string[] = [];
  const assumptions: string[] = [];
  const ignored: { logicalId: string; type: string }[] = [];

  const resources: Resource[] = [];
  for (const [id, raw] of Object.entries(template["Resources"])) {
    if (!isRecord(raw) || typeof raw["Type"] !== "string") continue;
    const type = raw["Type"];
    if (!SUPPORTED.has(type)) {
      if (!type.startsWith("AWS::CDK::") && !type.startsWith("AWS::IAM::") && type !== "AWS::Logs::LogGroup") ignored.push({ logicalId: id, type });
      continue;
    }
    resources.push({ id, type, props: isRecord(raw["Properties"]) ? (raw["Properties"] as Record<string, Json>) : {}, raw });
  }
  const byType = (t: string) => resources.filter((r) => r.type === t);
  const ids = new Set(resources.map((r) => r.id));
  const names = allocateNames(
    resources.filter((r) => ["AWS::SQS::Queue", "AWS::Lambda::Function", "AWS::ECS::Service"].includes(r.type)),
    parameters,
  );

  const rate = options.ratePerSecond ?? 10;
  const serviceTime: Sampler = options.serviceTime ?? dist.exponential(0.2);
  const defaultLambdaConcurrency = options.defaultLambdaConcurrency ?? 1000;
  const concurrencyPerTask = options.concurrencyPerTask ?? 10;
  if (options.ratePerSecond === undefined) assumptions.push(`Traffic: ${rate} requests/second at each entry point (templates do not describe traffic; set ratePerSecond).`);
  if (options.serviceTime === undefined) assumptions.push("Service time: exponential with mean 0.2 s for every function/service (templates do not describe how long work takes; set serviceTime).");

  const model = new Model(options.name ?? (typeof template["Description"] === "string" ? template["Description"] : "Imported stack"), {
    duration: options.duration ?? 600,
    warmUp: options.warmUp ?? 0,
    seed: options.seed ?? 1,
    replications: options.replications ?? 5,
  });
  const mapped: MappedResource[] = [];
  const note = (r: Resource, c: Component<string>, notes: string[] = []) =>
    mapped.push({ logicalId: r.id, type: r.type, component: c.name, componentType: c.type, notes });

  const completed = model.entitySink("completed");
  const components = new Map<string, Component<string>>();

  // --- queues
  const queueResources = byType("AWS::SQS::Queue");
  const queueIds = new Set(queueResources.map((q) => q.id));
  const deadLetterTargets = new Set<string>();
  const redrive = new Map<string, { target: string; max: number | undefined }>();
  for (const q of queueResources) {
    const policy = parseJsonish(q.props["RedrivePolicy"]);
    if (isRecord(policy)) {
      const target = collectRefs(policy["deadLetterTargetArn"], queueIds)[0];
      const max = resolveNumber(policy["maxReceiveCount"], parameters);
      if (target) {
        redrive.set(q.id, { target, max });
        deadLetterTargets.add(target);
      } else if (policy["deadLetterTargetArn"] !== undefined) {
        warnings.push(`${q.id}: RedrivePolicy points at a dead-letter queue that is not in this template; messages that exhaust maxReceiveCount are discarded.`);
      }
    }
  }
  for (const q of queueResources) {
    const notes: string[] = [];
    const vt = resolveNumber(q.props["VisibilityTimeout"], parameters);
    if (q.props["VisibilityTimeout"] === undefined) notes.push("VisibilityTimeout not set: SQS default of 30 s");
    else if (vt === undefined) {
      warnings.push(`${q.id}: VisibilityTimeout could not be resolved to a number; using the SQS default of 30 s.`);
    }
    const r = redrive.get(q.id);
    if (resolveString(q.props["FifoQueue"], parameters) === "true" || q.props["FifoQueue"] === true) {
      warnings.push(`${q.id}: FIFO ordering and deduplication are not modelled; it is treated as a standard queue.`);
    }
    if (q.props["DelaySeconds"] !== undefined && resolveNumber(q.props["DelaySeconds"], parameters) !== 0) {
      warnings.push(`${q.id}: DelaySeconds is not modelled.`);
    }
    const c = model.messageQueue(names.get(q.id) as string, {
      visibilityTimeout: vt ?? 30,
      ...(r?.max !== undefined ? { maxReceiveCount: r.max } : {}),
    });
    components.set(q.id, c);
    note(q, c, notes);
  }
  for (const [id, r] of redrive) {
    const target = components.get(r.target);
    if (target) (components.get(id) as Component<string>).link("deadLetter", target);
  }

  // --- event source mappings: which queue feeds which function
  const feeds = new Map<string, { queue: string; max: number | undefined }>();
  for (const m of byType("AWS::Lambda::EventSourceMapping")) {
    const queue = collectRefs(m.props["EventSourceArn"], queueIds)[0];
    const fn = collectRefs(m.props["FunctionName"], ids)[0];
    if (!queue || !fn) {
      warnings.push(`${m.id}: event source mapping skipped (its event source is not an SQS queue in this template, or its function is not).`);
      continue;
    }
    if (m.props["Enabled"] === false) continue;
    const batch = resolveNumber(m.props["BatchSize"], parameters);
    if (batch !== undefined && batch > 1) warnings.push(`${m.id}: BatchSize ${batch} is modelled as one message per invocation.`);
    const scaling = m.props["ScalingConfig"];
    const max = isRecord(scaling) ? resolveNumber(scaling["MaximumConcurrency"], parameters) : undefined;
    feeds.set(fn, { queue, max });
  }

  // --- functions and services
  const pools = new Map<string, Component<string>>();
  const pushEntries: string[] = [];
  for (const f of byType("AWS::Lambda::Function")) {
    const notes: string[] = [];
    const reserved = resolveNumber(f.props["ReservedConcurrentExecutions"], parameters);
    const feed = feeds.get(f.id);
    let concurrency = reserved ?? defaultLambdaConcurrency;
    if (reserved === undefined) notes.push(`no reserved concurrency: assumed ${defaultLambdaConcurrency}`);
    if (feed?.max !== undefined && feed.max < concurrency) {
      concurrency = feed.max;
      notes.push(`limited by the event source's MaximumConcurrency (${feed.max})`);
    }
    if (reserved === undefined && f.props["ReservedConcurrentExecutions"] !== undefined) {
      warnings.push(`${f.id}: ReservedConcurrentExecutions could not be resolved to a number; assumed ${defaultLambdaConcurrency}.`);
    }
    const queue = feed ? components.get(feed.queue) : undefined;
    const c = model.workerPool(names.get(f.id) as string, {
      concurrency,
      serviceTime,
      ...(options.coldStartTime !== undefined ? { coldStartTime: options.coldStartTime } : {}),
      ...(queue ? { queue } : {}),
      next: completed,
    });
    pools.set(f.id, c);
    components.set(f.id, c);
    if (!feed) pushEntries.push(f.id);
    note(f, c, notes);
  }
  for (const s of byType("AWS::ECS::Service")) {
    const desired = resolveNumber(s.props["DesiredCount"], parameters) ?? 1;
    if (s.props["DesiredCount"] === undefined) assumptions.push(`${s.id}: DesiredCount not set; assumed 1 task.`);
    const c = model.workerPool(names.get(s.id) as string, { concurrency: Math.max(1, desired * concurrencyPerTask), serviceTime, next: completed });
    pools.set(s.id, c);
    components.set(s.id, c);
    pushEntries.push(s.id);
    note(s, c, [`${desired} task(s) x ${concurrencyPerTask} concurrent requests each`]);
  }
  if (byType("AWS::ECS::Service").length > 0 && options.concurrencyPerTask === undefined) {
    assumptions.push(`ECS: each task handles ${concurrencyPerTask} requests concurrently (set concurrencyPerTask).`);
  }

  // --- autoscaling
  const policies = byType("AWS::ApplicationAutoScaling::ScalingPolicy");
  const ecsIds = new Set(byType("AWS::ECS::Service").map((s) => s.id));
  for (const t of byType("AWS::ApplicationAutoScaling::ScalableTarget")) {
    const service = collectRefs(t.props["ResourceId"], ecsIds)[0] ?? (ecsIds.size === 1 ? [...ecsIds][0] : undefined);
    const pool = service ? pools.get(service) : undefined;
    if (!service || !pool) {
      warnings.push(`${t.id}: auto scaling target skipped (only ECS service scaling is modelled${ecsIds.size > 1 ? ", and its service could not be identified" : ""}).`);
      continue;
    }
    const min = resolveNumber(t.props["MinCapacity"], parameters) ?? 1;
    const max = resolveNumber(t.props["MaxCapacity"], parameters);
    if (max === undefined) {
      warnings.push(`${t.id}: MaxCapacity could not be resolved; auto scaling skipped.`);
      continue;
    }
    const policy = policies.find((p) => collectRefs(p.props["ScalingTargetId"], new Set([t.id])).length > 0);
    const cfg = policy && isRecord(policy.props["TargetTrackingScalingPolicyConfiguration"]) ? (policy.props["TargetTrackingScalingPolicyConfiguration"] as Record<string, Json>) : undefined;
    let target = 0.6;
    let cooldown: number | undefined;
    const notes = [`${min} to ${max} tasks`];
    if (policy && !cfg) {
      warnings.push(`${policy.id}: only target-tracking scaling policies are modelled; assumed a 60% utilisation target.`);
    } else if (cfg) {
      const value = resolveNumber(cfg["TargetValue"], parameters);
      const metric = isRecord(cfg["PredefinedMetricSpecification"]) ? cfg["PredefinedMetricSpecification"]["PredefinedMetricType"] : undefined;
      if (value !== undefined && value > 0 && value <= 100) {
        target = value / 100;
        notes.push(`target ${value}${typeof metric === "string" ? ` (${metric})` : ""} treated as ${value}% busy workers`);
        if (typeof metric === "string" && !/Utilization/i.test(metric)) warnings.push(`${policy!.id}: target metric ${metric} is approximated as worker utilisation.`);
      } else {
        warnings.push(`${policy!.id}: TargetValue could not be used as a utilisation percentage; assumed 60%.`);
      }
      cooldown = resolveNumber(cfg["ScaleInCooldown"], parameters);
    } else {
      assumptions.push(`${t.id}: no scaling policy found; assumed target tracking at 60% utilisation.`);
    }
    const scaler = model.autoscaler(`${names.get(service)}-autoscaler`, {
      targetUtilisation: target,
      minConcurrency: Math.max(1, min * concurrencyPerTask),
      maxConcurrency: Math.max(1, max * concurrencyPerTask),
      ...(cooldown !== undefined ? { scaleDownCooldown: cooldown } : {}),
      target: pool,
    });
    note(t, scaler, notes);
    assumptions.push(`${t.id}: evaluated every 60 s (the autoscaler default), with no provisioning delay.`);
  }

  // --- API Gateway throttling
  let throttle: { rate: number; burst: number; from: string } | undefined;
  for (const u of byType("AWS::ApiGateway::UsagePlan")) {
    const t = u.props["Throttle"];
    if (isRecord(t)) {
      const r = resolveNumber(t["RateLimit"], parameters);
      const b = resolveNumber(t["BurstLimit"], parameters);
      if (r !== undefined) throttle ??= { rate: r, burst: Math.max(1, b ?? r), from: u.id };
    }
  }
  for (const s of byType("AWS::ApiGateway::Stage")) {
    const settings = Array.isArray(s.props["MethodSettings"]) ? s.props["MethodSettings"] : [];
    for (const m of settings) {
      if (!isRecord(m)) continue;
      const r = resolveNumber(m["ThrottlingRateLimit"], parameters);
      const b = resolveNumber(m["ThrottlingBurstLimit"], parameters);
      if (r !== undefined) throttle ??= { rate: r, burst: Math.max(1, b ?? r), from: s.id };
    }
  }

  // --- entry points and traffic
  const requested = options.entry ? [...options.entry] : undefined;
  const entryIds: string[] = [];
  if (requested) {
    for (const want of requested) {
      const id = [...components.keys()].find((k) => k === want || components.get(k)?.name === want);
      if (id) entryIds.push(id);
      else warnings.push(`entry "${want}" is not a queue, function or service in this template; ignored.`);
    }
  } else {
    for (const id of queueIds) if (!deadLetterTargets.has(id)) entryIds.push(id);
    entryIds.push(...pushEntries);
  }
  if (entryIds.length === 0) {
    warnings.push("no entry point found: the model has no traffic. Pass entry to choose where requests arrive.");
  } else if (!requested && entryIds.length > 1) {
    assumptions.push(`Entry points (each gets ${rate}/s): ${entryIds.map((id) => components.get(id)?.name).join(", ")}. Pass entry to choose.`);
  }

  const rejected = throttle && entryIds.length > 0 ? model.entitySink("rejected") : undefined;
  if (throttle && rejected) {
    assumptions.push(`API Gateway throttle (${throttle.from}): ${throttle.rate}/s with burst ${throttle.burst}, applied in front of every entry point.`);
  }
  for (const id of entryIds) {
    const target = components.get(id) as Component<string>;
    const name = target.name;
    let next: Component<string> = target;
    if (throttle && rejected) {
      next = model.rateLimiter(`${name}-throttle`, { rate: throttle.rate, burst: throttle.burst, next: target, onReject: rejected });
    }
    model.entityGenerator(`traffic-${name}`, { mode: "rateProfile", rateProfile: [[0, rate]], next });
  }

  return { ok: true, model: model.toJSON(), mapped, ignored, assumptions, warnings };
}
