import type { Component } from "./component.js";
import type { RateProfile, Sampler } from "./values.js";

/**
 * Per-component metadata: the input keys, link keys and output keys the engine's schema declares.
 * The builder uses it to reject typos at authoring time, and the test suite checks it against the
 * engine's own schemas (`surgesim schema`) so the SDK cannot drift from the format.
 */
export const SPECS = {
  EntityGenerator: {
    inputs: ["mode", "interArrivalTime", "rateProfile", "firstArrivalTime", "maxNumber", "dispersionIndex"],
    links: ["next"],
    outputs: ["NumberGenerated"],
  },
  Queue: {
    inputs: ["maxLength"],
    links: [],
    outputs: ["QueueLength", "AverageQueueLength", "MaxQueueLength", "AverageQueueTime", "NumberDropped"],
  },
  Server: {
    inputs: ["capacity", "serviceTime"],
    links: ["queue", "next"],
    outputs: ["Utilisation", "AverageBusyWorkers", "BusyWorkers"],
  },
  EntitySink: {
    inputs: ["percentiles"],
    links: [],
    outputs: ["count", "mean", "p50", "p95", "p99"],
  },
  MessageQueue: {
    inputs: ["visibilityTimeout", "maxReceiveCount", "costPerMillionRequests"],
    links: ["deadLetter"],
    outputs: [
      "QueueLength", "InFlight", "Backlog", "AverageQueueLength", "MaxQueueLength", "AverageInFlight",
      "AverageQueueTime", "NumberRequests", "Cost", "NumberReceived", "NumberRedelivered", "NumberDeadLettered",
    ],
  },
  WorkerPool: {
    inputs: [
      "concurrency", "serviceTime", "coldStartTime", "idleTimeout", "initialWarm", "failureProbability",
      "costPerBusySecond", "costPerProvisionedSecond", "costPerRequest",
    ],
    links: ["queue", "next", "onFailure", "onThrottle"],
    outputs: [
      "Utilisation", "Concurrency", "AverageConcurrency", "AverageBusyWorkers", "BusyWorkers", "ColdStarts",
      "NumberSucceeded", "NumberFailed", "NumberThrottled", "ThrottleFraction", "Cost", "StaleAcks",
    ],
  },
  RetryPolicy: {
    inputs: ["maxAttempts", "baseDelay", "multiplier", "maxDelay", "jitter"],
    links: ["next", "giveUp"],
    outputs: ["NumberRequests", "NumberAttempts", "NumberRetries", "NumberGivenUp", "RetryAmplification", "Retrying"],
  },
  RateLimiter: {
    inputs: ["rate", "burst"],
    links: ["next", "onReject"],
    outputs: ["NumberAllowed", "NumberRejected", "RejectionFraction", "Tokens"],
  },
  Autoscaler: {
    inputs: ["targetUtilisation", "evaluationInterval", "minConcurrency", "maxConcurrency", "scaleUpDelay", "scaleDownCooldown", "scaleDownStabilisation", "step"],
    links: ["target"],
    outputs: ["ScaleOuts", "ScaleIns", "DesiredConcurrency"],
  },
  Topic: {
    inputs: ["filterProbabilities"],
    links: ["subscribers"],
    outputs: ["NumberPublished", "NumberDelivered", "NumberFiltered"],
  },
} as const;

type Spec = typeof SPECS;
/** The output keys of a component type, e.g. `OutputOf<"EntitySink">` is `"count" | "mean" | ...`. */
export type OutputOf<T extends keyof Spec> = Spec[T]["outputs"][number];

type Ref = Component<string>;
type Common = {
  /** RNG stream id (default: the component name). Two components share random numbers only if you give them the same id. */
  stream?: string;
};

/** Props for {@link Model.entityGenerator}. Times are seconds. */
export interface EntityGeneratorProps extends Common {
  mode?: "interval" | "rateProfile";
  /** Interval mode: time between arrivals. */
  interArrivalTime?: Sampler;
  /** RateProfile mode: piecewise-constant Poisson rate `[[startSeconds, ratePerSecond], ...]`. */
  rateProfile?: RateProfile;
  firstArrivalTime?: Sampler;
  maxNumber?: number;
  /** How bursty arrivals are (variance / mean of counts, as `surgesim fit-arrivals` prints it). Default 1: Poisson. */
  dispersionIndex?: number;
  next?: Ref;
}

export interface QueueProps extends Common {
  maxLength?: number;
}

export interface ServerProps extends Common {
  capacity?: number;
  serviceTime: Sampler;
  queue: Ref;
  next?: Ref;
}

export interface EntitySinkProps extends Common {
  /** `"exact"` (default) stores every time in system; `"streaming"` uses a t-digest in constant memory for long or high-rate runs. */
  percentiles?: "exact" | "streaming";
}

export interface MessageQueueProps extends Common {
  /** Seconds a received message stays hidden before redelivery (default 30). */
  visibilityTimeout?: number;
  /** Receives before a message is dead-lettered (default unlimited). */
  maxReceiveCount?: number;
  costPerMillionRequests?: number;
  deadLetter?: Ref;
}

export interface WorkerPoolProps extends Common {
  concurrency: number;
  serviceTime: Sampler;
  coldStartTime?: Sampler;
  idleTimeout?: number;
  initialWarm?: number;
  failureProbability?: number;
  costPerBusySecond?: number;
  costPerProvisionedSecond?: number;
  costPerRequest?: number;
  /** Pull from this Queue or MessageQueue. Omit to accept pushed entities (and throttle when full). */
  queue?: Ref;
  next?: Ref;
  onFailure?: Ref;
  onThrottle?: Ref;
}

export interface RetryPolicyProps extends Common {
  maxAttempts?: number;
  baseDelay?: number;
  multiplier?: number;
  maxDelay?: number;
  jitter?: "none" | "full" | "equal";
  /** The thing that can fail. */
  next?: Ref;
  giveUp?: Ref;
}

export interface RateLimiterProps extends Common {
  /** Tokens per second (the sustained allowed rate). */
  rate: number;
  /** Bucket size. */
  burst: number;
  next?: Ref;
  onReject?: Ref;
}

export interface AutoscalerProps extends Common {
  targetUtilisation?: number;
  evaluationInterval?: number;
  minConcurrency?: number;
  maxConcurrency: number;
  scaleUpDelay?: number;
  scaleDownCooldown?: number;
  /** Kubernetes HPA scale-down stabilisation window (seconds); replaces scaleDownCooldown when set. */
  scaleDownStabilisation?: number;
  /** Scale in whole multiples of this many workers (e.g. requests per pod). */
  step?: number;
  /** The WorkerPool to scale. */
  target: Ref;
}

export interface TopicProps extends Common {
  /** Each published entity is copied to every subscriber, in order. */
  subscribers: Ref[];
  /** One probability per subscriber that a copy passes its filter policy (default: all pass). */
  filterProbabilities?: number[];
}
