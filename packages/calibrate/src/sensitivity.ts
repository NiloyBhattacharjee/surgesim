import type { ComponentDefinition, ModelDefinition } from "@surgesim/engine";

type Json = Record<string, unknown>;

/** Multiply a time distribution (a number of seconds, or a distribution object) by `factor`. */
export function scaleSampler(spec: unknown, factor: number): unknown {
  if (typeof spec === "number") return spec * factor;
  if (typeof spec !== "object" || spec === null) return spec;
  const s = { ...(spec as Json) };
  for (const key of ["value", "min", "mode", "max", "mean", "stdDev"]) {
    if (typeof s[key] === "number") s[key] = (s[key] as number) * factor;
  }
  return s;
}

function mapComponents(model: ModelDefinition, change: (c: ComponentDefinition) => Json | null): ModelDefinition {
  return {
    ...model,
    components: model.components.map((c) => {
      const inputs = change(c);
      return inputs === null ? c : { ...c, inputs };
    }),
  };
}

/**
 * A copy of the model with the arrival rate multiplied by `factor` (1.05 means 5% more traffic). Rate profiles are
 * multiplied; fixed or random inter-arrival times are divided.
 */
export function scaleArrivals(model: ModelDefinition, factor: number): ModelDefinition {
  return mapComponents(model, (c) => {
    if (c.type !== "EntityGenerator") return null;
    const inputs = { ...c.inputs } as Json;
    if (Array.isArray(inputs["rateProfile"])) {
      inputs["rateProfile"] = (inputs["rateProfile"] as [number, number][]).map(([start, rate]) => [start, rate * factor]);
    }
    if (inputs["interArrivalTime"] !== undefined) inputs["interArrivalTime"] = scaleSampler(inputs["interArrivalTime"], 1 / factor);
    return inputs;
  });
}

/** A copy of the model with every service time multiplied by `factor` (1.05 means 5% slower). */
export function scaleServiceTimes(model: ModelDefinition, factor: number): ModelDefinition {
  return mapComponents(model, (c) => {
    if (c.type !== "Server" && c.type !== "WorkerPool") return null;
    const inputs = { ...c.inputs } as Json;
    if (inputs["serviceTime"] !== undefined) inputs["serviceTime"] = scaleSampler(inputs["serviceTime"], factor);
    return inputs;
  });
}
