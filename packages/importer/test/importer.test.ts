import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadModel, runModel } from "@chronon-sim/engine";
import { dist } from "@chronon-sim/sdk";
import { importCloudFormation, type ImportOptions } from "../src/index.js";

const stack = (): Record<string, any> =>
  JSON.parse(readFileSync(fileURLToPath(new URL("../../../examples/cloudformation/orders-stack.template.json", import.meta.url)), "utf8"));

function imported(template: unknown, options: ImportOptions = {}) {
  const r = importCloudFormation(template, options);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r;
}
const comp = (r: ReturnType<typeof imported>, name: string) => r.model.components.find((c) => c.name === name);
const out = (res: ReturnType<typeof runModel>, id: string) => res.outputs.find((o) => o.id === id)!;

describe("the orders stack (CDK-style template)", () => {
  const r = imported(stack(), { serviceTime: dist.constant(0.5), ratePerSecond: 10, duration: 400, warmUp: 40, replications: 6, seed: 12 });

  it("maps each supported resource to the right component, with CDK hashes stripped from names", () => {
    expect(r.mapped.map((m) => [m.logicalId, m.component, m.componentType])).toEqual([
      ["OrdersDlq5E6F7A8B", "OrdersDlq", "MessageQueue"],
      ["OrdersQueue1A2B3C4D", "OrdersQueue", "MessageQueue"],
      ["ProcessorFnC0FFEE12", "ProcessorFn", "WorkerPool"],
      ["ApiServiceB5C6D7E8", "ApiService", "WorkerPool"],
      ["ApiServiceScalingTargetF9A0B1C2", "ApiService-autoscaler", "Autoscaler"],
    ]);
  });

  it("reads queue settings, resolving a parameter default and the redrive policy to a dead-letter link", () => {
    expect(comp(r, "OrdersQueue")).toEqual({
      type: "MessageQueue",
      name: "OrdersQueue",
      inputs: { visibilityTimeout: 60, maxReceiveCount: 5 },
      links: { deadLetter: "OrdersDlq" },
    });
  });

  it("wires the function to its queue through the event source mapping, with reserved concurrency", () => {
    expect(comp(r, "ProcessorFn")).toMatchObject({ inputs: { concurrency: 20 }, links: { queue: "OrdersQueue", next: "completed" } });
  });

  it("models the ECS service (2 tasks x 10) and its target-tracking autoscaler (70% target, 120 s scale-in)", () => {
    expect(comp(r, "ApiService")).toMatchObject({ inputs: { concurrency: 20 }, links: { next: "completed" } });
    expect(comp(r, "ApiService-autoscaler")).toMatchObject({
      inputs: { targetUtilisation: 0.7, minConcurrency: 20, maxConcurrency: 100, scaleDownCooldown: 120 },
      links: { target: "ApiService" },
    });
  });

  it("applies the API Gateway throttle in front of every entry point, with a sink for rejected calls", () => {
    expect(comp(r, "OrdersQueue-throttle")).toMatchObject({ type: "RateLimiter", inputs: { rate: 50, burst: 100 }, links: { next: "OrdersQueue", onReject: "rejected" } });
    expect(comp(r, "traffic-OrdersQueue")).toMatchObject({ links: { next: "OrdersQueue-throttle" } });
    expect(comp(r, "traffic-ApiService")).toMatchObject({ inputs: { rateProfile: [[0, 10]] }, links: { next: "ApiService-throttle" } });
  });

  it("the DLQ and the dead-letter-less defaults are not entry points; queues not targeted by a redrive policy are", () => {
    const traffic = r.model.components.filter((c) => c.name.startsWith("traffic-")).map((c) => c.name).sort();
    expect(traffic).toEqual(["traffic-ApiService", "traffic-OrdersQueue"]);
  });

  it("lists resources it does not understand, but not IAM or CDK bookkeeping", () => {
    expect(r.ignored).toEqual([{ logicalId: "ArchiveBucket1F2A3B4C", type: "AWS::S3::Bucket" }]);
  });

  it("states every assumption it had to make", () => {
    const text = r.assumptions.join("\n");
    expect(text).toContain("Entry points");
    expect(text).toContain("API Gateway throttle");
    expect(text).toContain("ECS");
    expect(text).toContain("evaluated every 60 s");
    expect(text).not.toContain("Traffic:"); // we supplied ratePerSecond
    expect(text).not.toContain("Service time:"); // we supplied serviceTime
  });

  it("produces a model the engine accepts", () => {
    const loaded = loadModel(r.model);
    expect(loaded.ok ? [] : loaded.errors).toEqual([]);
  });

  it("simulates to the queueing-theory answer: utilisation = rate x service time / concurrency = 10 x 0.5 / 20", () => {
    const loaded = loadModel(r.model);
    if (!loaded.ok) throw new Error("invalid");
    const res = runModel(loaded.model);
    const u = out(res, "ProcessorFn.Utilisation");
    expect(u.ci95!.low).toBeLessThanOrEqual(0.25);
    expect(u.ci95!.high).toBeGreaterThanOrEqual(0.25);
    expect(out(res, "OrdersQueue.NumberRedelivered").mean).toBe(0); // 0.5 s work, 60 s visibility timeout
    expect(out(res, "OrdersDlq.NumberReceived").mean).toBe(0);
  });

  it("the throttle behaves like the template says: 50/s offered, 20/s allowed -> about 60% rejected", () => {
    const heavy = imported(stack(), { serviceTime: dist.constant(0.01), ratePerSecond: 50, duration: 300, warmUp: 30, replications: 4, seed: 5, entry: ["ApiService"] });
    // the template's own limit is 50/s: lower it to 20/s to test rejection
    const t = stack();
    t["Resources"]["ApiUsagePlan7B8C9D0E"]["Properties"]["Throttle"] = { RateLimit: 20, BurstLimit: 20 };
    const limited = imported(t, { serviceTime: dist.constant(0.01), ratePerSecond: 50, duration: 300, warmUp: 30, replications: 4, seed: 5, entry: ["ApiService"] });
    expect(heavy.model.components.some((c) => c.name === "ApiService-throttle")).toBe(true);
    const loaded = loadModel(limited.model);
    if (!loaded.ok) throw new Error("invalid");
    const res = runModel(loaded.model);
    const frac = out(res, "ApiService-throttle.RejectionFraction").mean!;
    expect(frac).toBeGreaterThan(0.55);
    expect(frac).toBeLessThan(0.65);
  });
});

describe("options and defaults", () => {
  it("without options, it states the traffic and service-time assumptions loudly", () => {
    const r = imported(stack());
    expect(r.assumptions.join("\n")).toContain("Traffic: 10 requests/second");
    expect(r.assumptions.join("\n")).toContain("Service time: exponential with mean 0.2 s");
  });

  it("entry selects where traffic arrives (by logical id or name) and warns about unknown ones", () => {
    const r = imported(stack(), { entry: ["OrdersQueue1A2B3C4D", "Nope"] });
    expect(r.model.components.filter((c) => c.name.startsWith("traffic-")).map((c) => c.name)).toEqual(["traffic-OrdersQueue"]);
    expect(r.warnings.join("\n")).toContain('entry "Nope" is not');
  });

  it("a function with no event source is a web-style entry, and uses the default account concurrency", () => {
    const r = imported({ Resources: { Api: { Type: "AWS::Lambda::Function", Properties: {} } } }, { duration: 100 });
    expect(comp(r, "Api")).toMatchObject({ inputs: { concurrency: 1000 } });
    expect(comp(r, "traffic-Api")).toBeDefined();
    expect(r.mapped[0]!.notes.join()).toContain("no reserved concurrency");
  });

  it("the event source's MaximumConcurrency caps the function; BatchSize > 1 is flagged", () => {
    const t = stack();
    t["Resources"]["ProcessorFnSqsEventSourceD1E2F3A4"]["Properties"]["ScalingConfig"] = { MaximumConcurrency: 8 };
    t["Resources"]["ProcessorFnSqsEventSourceD1E2F3A4"]["Properties"]["BatchSize"] = 10;
    const r = imported(t);
    expect(comp(r, "ProcessorFn")).toMatchObject({ inputs: { concurrency: 8 } });
    expect(r.warnings.join("\n")).toContain("BatchSize 10 is modelled as one message per invocation");
  });

  it("coldStartTime and the model name/settings come from options", () => {
    const r = imported(stack(), { coldStartTime: dist.constant(1.5), name: "mine", duration: 123, seed: 9, replications: 2 });
    expect(comp(r, "ProcessorFn")!.inputs).toMatchObject({ coldStartTime: { dist: "constant", value: 1.5 } });
    expect(r.model).toMatchObject({ name: "mine", settings: { duration: 123, seed: 9, replications: 2 } });
  });

  it("the template description is the default model name", () => {
    expect(imported(stack()).model.name).toContain("Order processing stack");
  });
});

describe("honest about what it cannot represent", () => {
  it("a redrive policy pointing outside the template warns", () => {
    const t = stack();
    t["Resources"]["OrdersQueue1A2B3C4D"]["Properties"]["RedrivePolicy"] = { deadLetterTargetArn: "arn:aws:sqs:eu-west-1:1:elsewhere", maxReceiveCount: 3 };
    const r = imported(t);
    expect(r.warnings.join("\n")).toContain("not in this template");
    expect(comp(r, "OrdersQueue")!.links).toBeUndefined();
  });

  it("FIFO queues and delivery delays are flagged as not modelled", () => {
    const t = { Resources: { Q: { Type: "AWS::SQS::Queue", Properties: { FifoQueue: true, DelaySeconds: 30 } } } };
    const r = imported(t);
    expect(r.warnings.join("\n")).toContain("FIFO");
    expect(r.warnings.join("\n")).toContain("DelaySeconds");
  });

  it("step scaling is not modelled and says so; the autoscaler falls back to 60%", () => {
    const t = stack();
    t["Resources"]["ApiServiceScalingTargetCpu3D4E5F6A"]["Properties"] = { PolicyType: "StepScaling", ScalingTargetId: { Ref: "ApiServiceScalingTargetF9A0B1C2" } };
    const r = imported(t);
    expect(r.warnings.join("\n")).toContain("only target-tracking");
    expect(comp(r, "ApiService-autoscaler")!.inputs).toMatchObject({ targetUtilisation: 0.6 });
  });

  it("an unresolvable VisibilityTimeout warns and falls back to the SQS default", () => {
    const t = { Resources: { Q: { Type: "AWS::SQS::Queue", Properties: { VisibilityTimeout: { "Fn::ImportValue": "x" } } } } };
    const r = imported(t);
    expect(comp(r, "Q")!.inputs).toMatchObject({ visibilityTimeout: 30 });
    expect(r.warnings.join("\n")).toContain("could not be resolved");
  });

  it("a template with no entry point warns that there is no traffic", () => {
    const r = imported({ Resources: { B: { Type: "AWS::S3::Bucket" } } });
    expect(r.warnings.join("\n")).toContain("no entry point");
    expect(r.ignored).toHaveLength(1);
  });

  it("colliding names are made unique", () => {
    const t = {
      Resources: {
        A: { Type: "AWS::SQS::Queue", Properties: { QueueName: "same" } },
        B: { Type: "AWS::SQS::Queue", Properties: { QueueName: "same" } },
      },
    };
    const names = imported(t).mapped.map((m) => m.component);
    expect(new Set(names).size).toBe(2);
  });

  it("rejects things that are not CloudFormation templates with a structured error", () => {
    for (const bad of [null, [], "x", {}, { Resources: [] }]) {
      const r = importCloudFormation(bad);
      expect(r.ok).toBe(false);
      expect(r.ok ? [] : r.errors[0]!.message).toContain("Resources");
    }
  });
});
