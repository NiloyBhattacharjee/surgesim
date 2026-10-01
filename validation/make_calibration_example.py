"""Generate a synthetic "monitoring export" to demonstrate the calibration workflow.

This is NOT real production data. A small ground-truth system is simulated once with SimPy (independent of Chronon
Sim), and three files are written that look like what a monitoring tool would give you:

  arrivals.csv        one ISO timestamp per request                     (like a request log)
  service_times.csv   how long each request took to process, in ms       (like a Lambda Duration metric)
  observed.json       end-to-end numbers measured over that one period   (like a dashboard)

The point is to show the workflow: fit the inputs from the first two files, build a model, and check the model's
output against the third. Because the ground truth is known, the repository's tests can also check that the fitted
inputs recover it. Run:  python make_calibration_example.py <output directory>
"""

import json
import math
import os
import random
import sys
from datetime import datetime, timedelta, timezone

import simpy

SEED = 20240506
SERVERS = 8
SERVICE_MEAN, SERVICE_SD = 0.35, 0.20  # seconds, lognormal
PROFILE = [[0, 8.0], [300, 20.0], [600, 8.0]]  # arrivals per second: normal, a spike, normal
DURATION = 900
START = datetime(2024, 5, 6, 9, 0, 0, tzinfo=timezone.utc)


def percentile(sorted_values, p):
    rank = (p / 100.0) * (len(sorted_values) - 1)
    lo, hi = math.floor(rank), math.ceil(rank)
    return sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * (rank - lo)


def rate_at(t):
    r = 0.0
    for start, rate in PROFILE:
        if start <= t:
            r = rate
    return r


def main(out_dir):
    rng = random.Random(SEED)
    sigma2 = math.log(1 + (SERVICE_SD / SERVICE_MEAN) ** 2)
    mu, sigma = math.log(SERVICE_MEAN) - sigma2 / 2, math.sqrt(sigma2)

    env = simpy.Environment()
    workers = simpy.Resource(env, capacity=SERVERS)
    arrival_times, service_times, latencies = [], [], []
    area = {"queue": 0.0, "busy": 0.0, "last": 0.0, "q": 0, "b": 0}

    def tick():
        dt = env.now - area["last"]
        area["queue"] += area["q"] * dt
        area["busy"] += area["b"] * dt
        area["last"] = env.now
        area["q"], area["b"] = len(workers.queue), workers.count

    def customer(born):
        request = workers.request()
        tick()
        yield request
        tick()
        service = rng.lognormvariate(mu, sigma)
        service_times.append(service)
        yield env.timeout(service)
        workers.release(request)
        tick()
        latencies.append(env.now - born)

    def arrivals():
        peak = max(r for _, r in PROFILE)
        while True:
            yield env.timeout(rng.expovariate(peak))
            if env.now >= DURATION:
                return
            if rng.random() < rate_at(env.now) / peak:
                arrival_times.append(env.now)
                env.process(customer(env.now))

    env.process(arrivals())
    env.run(until=DURATION)
    tick()

    latencies.sort()
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "arrivals.csv"), "w", encoding="utf8", newline="\n") as f:
        f.write("timestamp\n")
        for t in arrival_times:
            moment = START + timedelta(seconds=t)
            # Seconds and milliseconds come from the same datetime, so they can never disagree or reach ".1000".
            f.write(moment.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ\n" % (moment.microsecond // 1000))
    with open(os.path.join(out_dir, "service_times.csv"), "w", encoding="utf8", newline="\n") as f:
        f.write("duration_ms\n")
        for s in service_times:
            f.write("%.1f\n" % (s * 1000))
    observed = {
        "tolerance": 0.15,
        "metrics": {
            "sink.mean": round(sum(latencies) / len(latencies), 4),
            "sink.p50": round(percentile(latencies, 50), 4),
            "sink.p95": round(percentile(latencies, 95), 4),
            "sink.p99": round(percentile(latencies, 99), 4),
            "server.Utilisation": round(area["busy"] / (DURATION * SERVERS), 4),
            "queue.AverageQueueLength": round(area["queue"] / DURATION, 4),
        },
    }
    with open(os.path.join(out_dir, "observed.json"), "w", encoding="utf8", newline="\n") as f:
        json.dump(observed, f, indent=2)
        f.write("\n")
    print("ground truth: %d workers, lognormal service mean %.2f sd %.2f, arrivals %s" % (SERVERS, SERVICE_MEAN, SERVICE_SD, PROFILE))
    print("wrote %d arrivals, %d service times; observed %s" % (len(arrival_times), len(service_times), json.dumps(observed["metrics"])))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "examples/calibration")
