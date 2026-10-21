# Importing CloudFormation and CDK

```bash
cdk synth                                     # writes cdk.out/<Stack>.template.json
surgesim import cdk.out/OrdersStack.template.json --out model.json --rate 50 --service-time 0.3
surgesim run model.json --html report.html
```

`surgesim import` reads a CloudFormation template, either **JSON** (what CDK writes to `cdk.out/*.template.json`) or
**YAML** (hand-written templates, SAM-style stacks), and produces a model in the [JSON format](model-format.md). It never
emits a model the engine would reject.

```bash
surgesim import stack.yaml --out model.json
```

YAML short-form intrinsics (`!Ref`, `!GetAtt Queue.Arn` or `!GetAtt [Queue, Arn]`, `!Sub`, `!Join`, `!If`, `!Select`,
`!FindInMap`, `!Condition` and the other `!Fn` forms) are read as their JSON long forms, so a YAML template imports to
exactly the model its JSON equivalent does ([`examples/cloudformation/orders-stack.template.yaml`](../examples/cloudformation/orders-stack.template.yaml)
is the YAML twin of the JSON example). An unknown `!Tag`, a duplicate key or malformed YAML is an error, never guessed
at. The YAML parser lives in `@surgesim/importer` (it uses the `yaml` package); the engine stays dependency-free.
Programs can call `parseTemplate(text)` from `@surgesim/importer` directly.

## What is modelled

| CloudFormation | Becomes | Read from the template |
|---|---|---|
| `AWS::SQS::Queue` | `MessageQueue` | `VisibilityTimeout` (default 30 s), `RedrivePolicy` (`maxReceiveCount`, and a `deadLetterTargetArn` that points at another queue in the template becomes the `deadLetter` link) |
| `AWS::Lambda::Function` | `WorkerPool` | `ReservedConcurrentExecutions` (else the account default, 1000) |
| `AWS::Lambda::EventSourceMapping` | the function's `queue` link | the queue and function it connects; `ScalingConfig.MaximumConcurrency` caps concurrency |
| `AWS::ECS::Service` | `WorkerPool` | `DesiredCount` × requests per task |
| `AWS::ApplicationAutoScaling::ScalableTarget` + target-tracking `ScalingPolicy` | `Autoscaler` | `MinCapacity`, `MaxCapacity`, `TargetValue`, `ScaleInCooldown` |
| `AWS::ApiGateway::UsagePlan` `Throttle`, `Stage` `MethodSettings` | `RateLimiter` in front of every entry point | `RateLimit`, `BurstLimit` |
| `AWS::SNS::Topic` + `AWS::SNS::Subscription` | `Topic` | `sqs` and `lambda` subscriptions (inline `Subscription` or separate resources) become its `subscribers`; subscribed queues and functions are fed by the topic, not by their own traffic |

Intrinsics are followed where it matters: `Ref` to a parameter with a `Default`, `Fn::GetAtt`, `Fn::Join` and `Fn::Sub` (to
find which resource is meant). CDK's hashed logical ids (`OrdersQueue1A2B3C4D`) become readable names (`OrdersQueue`);
a literal `QueueName` / `FunctionName` / `TopicName` wins.

## What the template cannot tell you, so you must

A template describes infrastructure. It says nothing about **how much traffic arrives** or **how long work takes**, which
are exactly what a simulation needs. The importer does not hide this: every number it had to invent is printed under
**Assumptions**, and you override them:

| Flag | Meaning | Default |
|---|---|---|
| `--rate N` | requests per second at each entry point | 10 |
| `--service-time MEAN` | mean seconds per request (exponential) | 0.2 |
| `--cold-start S` | cold start seconds for Lambda | none |
| `--concurrency-per-task N` | requests one ECS task handles at once | 10 |
| `--entry ID` | where traffic arrives (logical id or name; repeatable) | topics, queues that are neither dead-letter targets nor topic subscribers, plus functions and services with no queue trigger or topic subscription |
| `--duration S`, `--seed N`, `--replications N`, `--name TEXT` | run settings | 600 s, 1, 5 |

Treat the result as a **starting skeleton**: confirm the traffic and service times with real numbers (from load tests or
metrics) before trusting a conclusion. For anything the flags cannot express (a different distribution, a failure rate,
retries), edit the model, or build it with the [SDK](sdk.md) from the imported JSON.

## What is not modelled, and says so

Unsupported resources are listed under **Not modelled (ignored)** (IAM roles and CDK metadata are skipped quietly).
Within supported resources, anything that cannot be represented raises a **Warning**: FIFO ordering and deduplication,
SNS filter policies (every message is delivered; set the topic's `filterProbabilities`), subscription protocols other than
`sqs` and `lambda`,
`DelaySeconds`, `BatchSize` greater than 1 (modelled as one message per invocation), step-scaling policies (a 60%
target-tracking autoscaler is assumed instead), a dead-letter queue defined outside the template, values that could not be
resolved to numbers. A template with no entry point yields a warning that the model has no traffic.

ECS tasks and CPU targets are approximations: a task is modelled as `--concurrency-per-task` parallel workers (10 by
default), and a CPU utilisation target is treated as a target for busy workers.

# Importing Kubernetes manifests

`@surgesim/importer` also reads Kubernetes manifests: multi-document YAML (`---`), JSON, or the single `List` that
`kubectl get deploy,svc,hpa -o yaml` prints.

```ts
import { importKubernetes, parseManifests } from "@surgesim/importer";
import { dist } from "@surgesim/sdk";

const parsed = parseManifests(text); // { ok: true, objects } or { ok: false, message }
if (!parsed.ok) throw new Error(parsed.message);
const result = importKubernetes(parsed.objects, { ratePerSecond: 200, serviceTime: dist.lognormal(0.04, 0.015), concurrencyPerPod: 50 });
```

The result has the same shape as `importCloudFormation`'s: the model plus `mapped`, `ignored`, `assumptions` and
`warnings`.

| Kubernetes | Becomes | Read from the manifest |
|---|---|---|
| `Deployment` | a `Queue` feeding a `WorkerPool` with `replicas × concurrencyPerPod` workers | `replicas` (default 1); the largest container `readinessProbe.initialDelaySeconds` is how long a new pod takes to receive traffic |
| `HorizontalPodAutoscaler` (`autoscaling/v1` or `v2`) | `Autoscaler`: evaluates every 15 s, scales in whole pods (`step`), new pods take traffic after the readiness delay (`scaleUpDelay`) | `minReplicas`, `maxReplicas`, the CPU `averageUtilization` (or `targetCPUUtilizationPercentage`, default 80%), `behavior.scaleDown.stabilizationWindowSeconds` (default 300) |
| `Service` | nothing of its own: it marks the Deployment its `selector` matches as an entry point, and `entry` can name it | `selector` |

Each pool's `Cost` is in **pod-hours**, and the model samples every Deployment's `Concurrency` (pods × requests per pod)
and `BusyWorkers` every 5 s, so the report shows whether the HPA kept up.

| Option | Meaning | Default |
|---|---|---|
| `ratePerSecond` | requests per second at each entry point | 10 |
| `rateProfile` | time-varying rate at each entry point, `[[startSeconds, ratePerSecond], ...]`; replaces `ratePerSecond` | none |
| `serviceTime` | time per request | exponential, mean 0.2 s |
| `concurrencyPerPod` | requests one pod serves at once; beyond that they queue | 10 |
| `startupDelay` | seconds from pod creation to taking traffic | the readiness probe's `initialDelaySeconds` |
| `entry` | Service or Deployment names (or `namespace/name`) that receive traffic; a name found in several namespaces is ignored as ambiguous | Deployments behind a Service that no other Deployment calls, else all Deployments no other calls |
| `services` | per-Deployment `serviceTime`, `concurrencyPerPod`, `startupDelay` and `calls`, keyed by Service or Deployment name; see the overlay below | none |
| `duration`, `warmUp`, `seed`, `replications`, `name` | run settings | 600 s, 0, 1, 5 |

Approximations, each stated in the warnings: a Deployment's pods share one queue (an ideal load balancer, somewhat
better than per-pod round-robin); the HPA's CPU utilisation is treated as busy request slots, so a pod with every slot
busy is at 100% of its CPU request; only one HPA metric is used; `selectPolicy: Disabled` on scale-down is modelled
exactly (never below the starting pods), on scale-up it caps at the starting pods (the model may scale back up to that
after scaling in, which the HPA would not), and on both it means no autoscaler; scale-up stabilisation, scaling rate policies and the
HPA's 10% tolerance are not modelled. Every other kind (Ingress, ConfigMap, StatefulSet, ...) is listed as ignored.
Memory limits and OOM kills, nodes and the cluster autoscaler, rolling updates and CPU throttling are not modelled.

## The overlay file

Manifests describe structure: what runs, how many copies, how it scales. They do not describe behaviour: how much traffic
arrives, how long requests take, which service calls which. An **overlay** file supplies that. It is YAML or JSON, uses the
model format's units (seconds, per second) and [sampler JSON](model-format.md), and becomes import options through
`parseOverlay(text)`:

```yaml
traffic:
  entry: web                                        # Service or Deployment name, or a list
  rateProfile: [[0, 200], [300, 600], [900, 200]]   # or ratePerSecond: 200
services:
  web:                                              # Service or Deployment name, or namespace/name
    concurrencyPerPod: 50
    startupDelay: 30
    serviceTime: { dist: lognormal, mean: 0.04, stdDev: 0.015 }
    calls:
      - { service: orders-api, probability: 0.6 }
  orders-api:
    serviceTime: { dist: lognormal, mean: 0.12, stdDev: 0.06 }
    calls:
      - { service: postgres, probability: 1.0 }
```

```ts
import { importKubernetes, parseManifests, parseOverlay } from "@surgesim/importer";

const overlay = parseOverlay(overlayText); // { ok: true, options } or { ok: false, errors }
if (!overlay.ok) throw new Error(overlay.errors.map((e) => e.message).join("
"));
const result = importKubernetes(parsed.objects, { ...overlay.options, duration: 1200 });
```

`parseOverlay` checks the shape (keys, types, ranges) and reports every problem with its path, such as
`services.web.concurrencyPerPod: must be an integer >= 1`. Distribution parameters are checked by the engine when the model
loads. `importKubernetes` then rejects an overlay that does not fit the manifests: a name that matches no Service or
Deployment (or matches several), a Deployment listed twice, call probabilities adding up to more than 1, or a call cycle.

**Calls.** After a Deployment serves a request, the request goes to one called service with that call's probability, or
completes with the remaining probability, through a [`Branch`](model-format.md). So `calls` are exclusive alternatives
(a request makes at most one call per hop), and end-to-end latency at the `completed` sink includes every hop. Calls are
**asynchronous**: a pod is freed when its own work ends, not when its downstream call returns, so when a downstream
service is slow the model understates how busy the upstream pods are. Deployments that another Deployment calls get no
traffic of their own unless `entry` names them.

Service times and call probabilities can come from real data: `surgesim fit` ([calibration](calibration.md)) fits a
distribution to measured durations, such as span durations exported from OpenTelemetry or Jaeger traces, and
`surgesim fit-arrivals` turns request timestamps into a `rateProfile`.
