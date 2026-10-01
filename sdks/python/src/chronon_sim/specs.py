"""Per-component metadata: the input, link and output keys the engine's schema declares.

The builder uses it to reject typos at authoring time, and the repository's tests compare it with the
engine's own schemas (``chronon schema``) so this SDK cannot drift from the format.
"""

SPECS = {
    "EntityGenerator": {
        "inputs": ["mode", "interArrivalTime", "rateProfile", "firstArrivalTime", "maxNumber"],
        "links": ["next"],
        "outputs": ["NumberGenerated"],
    },
    "Queue": {
        "inputs": ["maxLength"],
        "links": [],
        "outputs": ["QueueLength", "AverageQueueLength", "MaxQueueLength", "AverageQueueTime", "NumberDropped"],
    },
    "Server": {
        "inputs": ["capacity", "serviceTime"],
        "links": ["queue", "next"],
        "outputs": ["Utilisation", "AverageBusyWorkers", "BusyWorkers"],
    },
    "EntitySink": {
        "inputs": [],
        "links": [],
        "outputs": ["count", "mean", "p50", "p95", "p99"],
    },
    "MessageQueue": {
        "inputs": ["visibilityTimeout", "maxReceiveCount", "costPerMillionRequests"],
        "links": ["deadLetter"],
        "outputs": [
            "QueueLength", "InFlight", "Backlog", "AverageQueueLength", "MaxQueueLength", "AverageInFlight",
            "AverageQueueTime", "NumberRequests", "Cost", "NumberReceived", "NumberRedelivered", "NumberDeadLettered",
        ],
    },
    "WorkerPool": {
        "inputs": [
            "concurrency", "serviceTime", "coldStartTime", "idleTimeout", "initialWarm", "failureProbability",
            "costPerBusySecond", "costPerProvisionedSecond", "costPerRequest",
        ],
        "links": ["queue", "next", "onFailure", "onThrottle"],
        "outputs": [
            "Utilisation", "Concurrency", "AverageConcurrency", "AverageBusyWorkers", "BusyWorkers", "ColdStarts",
            "NumberSucceeded", "NumberFailed", "NumberThrottled", "ThrottleFraction", "Cost", "StaleAcks",
        ],
    },
    "RetryPolicy": {
        "inputs": ["maxAttempts", "baseDelay", "multiplier", "maxDelay", "jitter"],
        "links": ["next", "giveUp"],
        "outputs": ["NumberRequests", "NumberAttempts", "NumberRetries", "NumberGivenUp", "RetryAmplification", "Retrying"],
    },
    "RateLimiter": {
        "inputs": ["rate", "burst"],
        "links": ["next", "onReject"],
        "outputs": ["NumberAllowed", "NumberRejected", "RejectionFraction", "Tokens"],
    },
    "Autoscaler": {
        "inputs": ["targetUtilisation", "evaluationInterval", "minConcurrency", "maxConcurrency", "scaleUpDelay", "scaleDownCooldown"],
        "links": ["target"],
        "outputs": ["ScaleOuts", "ScaleIns", "DesiredConcurrency"],
    },
}
