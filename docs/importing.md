# Importing CloudFormation and CDK

```bash
cdk synth                                     # writes cdk.out/<Stack>.template.json
surgesim import cdk.out/OrdersStack.template.json --out model.json --rate 50 --service-time 0.3
surgesim run model.json --html report.html
```

`surgesim import` reads a CloudFormation **JSON** template (what CDK writes to `cdk.out/*.template.json`; YAML templates
are not supported, convert with `cfn-flip`) and produces a model in the [JSON format](model-format.md). It never emits a
model the engine would reject.

## What is modelled

| CloudFormation | Becomes | Read from the template |
|---|---|---|
| `AWS::SQS::Queue` | `MessageQueue` | `VisibilityTimeout` (default 30 s), `RedrivePolicy` (`maxReceiveCount`, and a `deadLetterTargetArn` that points at another queue in the template becomes the `deadLetter` link) |
| `AWS::Lambda::Function` | `WorkerPool` | `ReservedConcurrentExecutions` (else the account default, 1000) |
| `AWS::Lambda::EventSourceMapping` | the function's `queue` link | the queue and function it connects; `ScalingConfig.MaximumConcurrency` caps concurrency |
| `AWS::ECS::Service` | `WorkerPool` | `DesiredCount` × requests per task |
| `AWS::ApplicationAutoScaling::ScalableTarget` + target-tracking `ScalingPolicy` | `Autoscaler` | `MinCapacity`, `MaxCapacity`, `TargetValue`, `ScaleInCooldown` |
| `AWS::ApiGateway::UsagePlan` `Throttle`, `Stage` `MethodSettings` | `RateLimiter` in front of every entry point | `RateLimit`, `BurstLimit` |

Intrinsics are followed where it matters: `Ref` to a parameter with a `Default`, `Fn::GetAtt`, `Fn::Join` and `Fn::Sub` (to
find which resource is meant). CDK's hashed logical ids (`OrdersQueue1A2B3C4D`) become readable names (`OrdersQueue`);
a literal `QueueName` / `FunctionName` wins.

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
| `--entry ID` | where traffic arrives (logical id or name; repeatable) | queues that are not dead-letter targets, plus functions and services with no queue trigger |
| `--duration S`, `--seed N`, `--replications N`, `--name TEXT` | run settings | 600 s, 1, 5 |

Treat the result as a **starting skeleton**: confirm the traffic and service times with real numbers (from load tests or
metrics) before trusting a conclusion. For anything the flags cannot express (a different distribution, a failure rate,
retries), edit the model, or build it with the [SDK](sdk.md) from the imported JSON.

## What is not modelled, and says so

Unsupported resources are listed under **Not modelled (ignored)** (IAM roles and CDK metadata are skipped quietly).
Within supported resources, anything that cannot be represented raises a **Warning**: FIFO ordering and deduplication,
`DelaySeconds`, `BatchSize` greater than 1 (modelled as one message per invocation), step-scaling policies (a 60%
target-tracking autoscaler is assumed instead), a dead-letter queue defined outside the template, values that could not be
resolved to numbers. A template with no entry point yields a warning that the model has no traffic.

ECS tasks and CPU targets are approximations: a task is modelled as `--concurrency-per-task` parallel workers (10 by
default), and a CPU utilisation target is treated as a target for busy workers.
