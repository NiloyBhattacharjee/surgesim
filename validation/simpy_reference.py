"""An independent reference simulator for cross-checking Surgesim.

It models the same basic system (arrivals -> a waiting line -> c identical servers) but is built differently on
purpose, so that agreement between the two means something:

* the clock and the event handling come from SimPy, a widely used third-party library;
* time-varying arrivals use *thinning* (Lewis and Shedler): candidate arrivals are generated at the highest rate and
  each is kept with probability rate(t) / highest_rate. Surgesim instead draws piecewise-exponential gaps;
* the random numbers come from Python's own generator;
* every statistic is computed here, from scratch.

Usage:  python simpy_reference.py scenario.json    (writes JSON to stdout)

Scenario fields:
  duration, warmUp, replications, seed
  rateProfile      [[startSeconds, perSecond], ...]   piecewise-constant Poisson arrival rate
  servers          number of identical servers
  service          {"dist": "exponential", "mean": m} or {"dist": "lognormal", "mean": m, "stdDev": s}
  queueLimit       optional maximum number of waiting customers (arrivals beyond it are dropped)
"""

import json
import math
import random
import sys

import simpy


class TimeWeighted:
    """Time-weighted average and maximum of a piecewise-constant value (written from scratch)."""

    def __init__(self, start, value=0):
        self.start = start
        self.last = start
        self.value = value
        self.area = 0.0
        self.max_seen = None

    def set(self, now, value):
        if now > self.last:
            self.area += self.value * (now - self.last)
            # Only values that lasted a positive amount of time count towards the maximum.
            if self.max_seen is None or self.value > self.max_seen:
                self.max_seen = self.value
            self.last = now
        self.value = value

    def reset(self, now):
        self.set(now, self.value)
        self.start = now
        self.last = now
        self.area = 0.0
        self.max_seen = None

    def mean(self, now):
        elapsed = now - self.start
        if elapsed <= 0:
            return self.value
        return (self.area + self.value * (now - self.last)) / elapsed

    def maximum(self, now):
        best = self.max_seen
        if now > self.last and (best is None or self.value > best):
            best = self.value
        return self.value if best is None else best


def percentile(sorted_values, p):
    """Linear interpolation between closest ranks (the same definition Surgesim reports)."""
    n = len(sorted_values)
    if n == 0:
        return None
    rank = (p / 100.0) * (n - 1)
    lo = math.floor(rank)
    hi = math.ceil(rank)
    return sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * (rank - lo)


def service_sampler(spec, rng):
    kind = spec["dist"]
    if kind == "exponential":
        mean = spec["mean"]
        return lambda: rng.expovariate(1.0 / mean)
    if kind == "lognormal":
        mean, sd = spec["mean"], spec["stdDev"]
        sigma2 = math.log(1 + (sd / mean) ** 2)
        mu = math.log(mean) - sigma2 / 2
        sigma = math.sqrt(sigma2)
        return lambda: rng.lognormvariate(mu, sigma)
    if kind == "constant":
        return lambda: spec["value"]
    raise ValueError("unsupported service distribution: %r" % kind)


def rate_at(profile, t):
    rate = 0.0
    for start, r in profile:
        if start <= t:
            rate = r
        else:
            break
    return rate


def run_replication(sc, seed):
    rng = random.Random(seed)
    env = simpy.Environment()
    servers = simpy.Resource(env, capacity=sc["servers"])
    sample_service = service_sampler(sc["service"], rng)
    limit = sc.get("queueLimit")
    warm = sc.get("warmUp", 0)
    profile = sc["rateProfile"]
    peak = max(r for _, r in profile)

    waiting = TimeWeighted(0, 0)
    busy = TimeWeighted(0, 0)
    stats = {"in_system": [], "waits": [], "arrived": 0, "dropped": 0}

    def touch(extra_wait=None):
        waiting.set(env.now, len(servers.queue))
        busy.set(env.now, servers.count)

    def customer(born):
        # An arrival is dropped when the waiting line is already at its limit (servers busy or not).
        if limit is not None and len(servers.queue) >= limit:
            if env.now >= warm:
                stats["dropped"] += 1
            return
        request = servers.request()
        touch()
        enqueued = env.now
        yield request
        touch()
        if env.now >= warm:
            stats["waits"].append(env.now - enqueued)
        yield env.timeout(sample_service())
        servers.release(request)
        touch()
        if env.now >= warm:
            stats["in_system"].append(env.now - born)

    def arrivals():
        # Thinning: candidates at the peak rate, each kept with probability rate(t) / peak.
        while True:
            yield env.timeout(rng.expovariate(peak))
            if env.now >= sc["duration"]:
                return
            if rng.random() < rate_at(profile, env.now) / peak:
                if env.now >= warm:
                    stats["arrived"] += 1
                env.process(customer(env.now))

    def warm_up():
        yield env.timeout(warm)
        waiting.reset(env.now)
        busy.reset(env.now)

    env.process(arrivals())
    if warm > 0:
        env.process(warm_up())
    env.run(until=sc["duration"])
    end = sc["duration"]

    times = sorted(stats["in_system"])
    waits = stats["waits"]
    n = len(times)
    return {
        "utilisation": busy.mean(end) / sc["servers"],
        "avgQueueLength": waiting.mean(end),
        "maxQueueLength": waiting.maximum(end),
        "avgQueueTime": sum(waits) / len(waits) if waits else None,
        "meanTime": sum(times) / n if n else None,
        "p50": percentile(times, 50),
        "p95": percentile(times, 95),
        "p99": percentile(times, 99),
        "completed": n,
        "dropped": stats["dropped"],
        "arrived": stats["arrived"],
    }


def main():
    with open(sys.argv[1], encoding="utf8") as f:
        sc = json.load(f)
    reps = sc.get("replications", 10)
    base = sc.get("seed", 1)
    out = [run_replication(sc, base * 100003 + i * 7919 + 13) for i in range(reps)]
    print(json.dumps({"simpy": simpy.__version__, "replications": out}))


if __name__ == "__main__":
    main()
