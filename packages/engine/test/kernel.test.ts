import { describe, expect, it } from "vitest";
import { Kernel, Priority } from "../src/index.js";

describe("Kernel ordering", () => {
  it("orders by tick", () => {
    const k = new Kernel();
    const log: string[] = [];
    k.schedule(30, 5, () => log.push("c"));
    k.schedule(10, 5, () => log.push("a"));
    k.schedule(20, 5, () => log.push("b"));
    k.runUntil(100);
    expect(log).toEqual(["a", "b", "c"]);
    expect(k.currentTick).toBe(100);
  });

  it("orders by priority within a tick (lower first)", () => {
    const k = new Kernel();
    const log: string[] = [];
    k.schedule(10, 7, () => log.push("low"));
    k.schedule(10, 1, () => log.push("high"));
    k.schedule(10, 5, () => log.push("mid"));
    k.runUntil(10);
    expect(log).toEqual(["high", "mid", "low"]);
  });

  it("is FIFO among equal tick and priority", () => {
    const k = new Kernel();
    const log: number[] = [];
    for (let i = 0; i < 50; i++) k.schedule(5, 5, () => log.push(i));
    k.runUntil(5);
    expect(log).toEqual([...Array(50).keys()]);
  });

  it("lifo inserts ahead of equals, but not ahead of earlier tick/priority", () => {
    const k = new Kernel();
    const log: string[] = [];
    k.schedule(5, 5, () => log.push("a"));
    k.schedule(5, 5, () => log.push("b"));
    k.schedule(5, 5, () => log.push("L1"), { lifo: true });
    k.schedule(5, 5, () => log.push("L2"), { lifo: true });
    k.schedule(5, 1, () => log.push("prio"), { lifo: true });
    k.schedule(4, 9, () => log.push("early"));
    k.runUntil(10);
    expect(log).toEqual(["early", "prio", "L2", "L1", "a", "b"]);
  });

  it("events scheduled during execution at delay 0 run in the same tick", () => {
    const k = new Kernel();
    const log: string[] = [];
    k.schedule(3, 5, () => {
      log.push("outer");
      k.schedule(0, 5, () => log.push("inner"));
    });
    k.schedule(3, 5, () => log.push("sibling"));
    k.runUntil(3);
    expect(log).toEqual(["outer", "sibling", "inner"]);
  });

  it("rejects invalid delays", () => {
    const k = new Kernel();
    expect(() => k.schedule(-1, 5, () => {})).toThrow(RangeError);
    expect(() => k.schedule(1.5, 5, () => {})).toThrow(RangeError);
    expect(() => k.schedule(NaN, 5, () => {})).toThrow(RangeError);
  });

  it("handles many random events in sorted order", () => {
    const k = new Kernel();
    const seen: number[] = [];
    let x = 12345;
    for (let i = 0; i < 5000; i++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      const d = x % 1000;
      k.schedule(d, 5, () => seen.push(k.currentTick));
    }
    k.runUntil(1000);
    expect(seen).toHaveLength(5000);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });
});

describe("Kernel cancellation", () => {
  it("cancelled events never fire and isScheduled reflects state", () => {
    const k = new Kernel();
    const log: string[] = [];
    const a = k.schedule(5, 5, () => log.push("a"));
    const b = k.schedule(6, 5, () => log.push("b"));
    expect(a.isScheduled()).toBe(true);
    expect(k.pendingCount).toBe(2);
    a.cancel();
    expect(a.isScheduled()).toBe(false);
    expect(k.pendingCount).toBe(1);
    a.cancel(); // idempotent
    expect(k.pendingCount).toBe(1);
    k.runUntil(10);
    expect(log).toEqual(["b"]);
    expect(b.isScheduled()).toBe(false); // fired
    b.cancel(); // no effect after firing
    expect(k.pendingCount).toBe(0);
  });

  it("an event can cancel a later event", () => {
    const k = new Kernel();
    const log: string[] = [];
    const later = k.schedule(10, 5, () => log.push("later"));
    k.schedule(5, 5, () => later.cancel());
    k.runUntil(20);
    expect(log).toEqual([]);
  });
});

describe("Kernel conditional events", () => {
  it("fires only when the next event would advance the clock, never mid-tick", () => {
    const k = new Kernel();
    let flag = false;
    const log: string[] = [];
    k.waitUntil(
      () => flag,
      () => log.push(`cond@${k.currentTick}`),
    );
    k.schedule(10, 5, () => {
      flag = true;
      log.push("set");
    });
    k.schedule(10, 5, () => log.push("same-tick-after-set"));
    k.schedule(20, 5, () => log.push("later"));
    k.runUntil(30);
    // Condition is true after the first tick-10 event, but only fires after the whole tick finished.
    expect(log).toEqual(["set", "same-tick-after-set", "cond@10", "later"]);
  });

  it("a satisfied condition fires at the current tick, before the clock advances", () => {
    const k = new Kernel();
    let flag = false;
    let firedAt = -1;
    k.waitUntil(
      () => flag,
      () => (firedAt = k.currentTick),
    );
    k.schedule(7, 5, () => (flag = true));
    k.schedule(50, 5, () => {});
    k.runUntil(100);
    expect(firedAt).toBe(7);
  });

  it("fires when the event queue runs dry, and is cancellable", () => {
    const k = new Kernel();
    let flag = false;
    let fired = 0;
    k.waitUntil(
      () => flag,
      () => fired++,
    );
    const cancelled = k.waitUntil(
      () => flag,
      () => (fired += 100),
    );
    cancelled.cancel();
    expect(cancelled.isScheduled()).toBe(false);
    k.schedule(1, 5, () => (flag = true));
    while (k.step()) {
      /* drain */
    }
    expect(fired).toBe(1);
  });

  it("conditions can chain: a fired condition may satisfy another", () => {
    const k = new Kernel();
    let a = false;
    let b = false;
    const log: string[] = [];
    k.waitUntil(
      () => b,
      () => log.push("b"),
    );
    k.waitUntil(
      () => a,
      () => {
        log.push("a");
        b = true;
      },
    );
    k.schedule(1, Priority.DEFAULT, () => (a = true));
    k.schedule(5, Priority.DEFAULT, () => log.push("t5"));
    k.runUntil(10);
    expect(log).toEqual(["a", "b", "t5"]);
  });
});

describe("Kernel time API", () => {
  it("converts seconds to ticks and runs durations", () => {
    const k = new Kernel(1000);
    expect(k.secondsToTicks(1.2344)).toBe(1234);
    expect(k.secondsToTicks(1.2346)).toBe(1235);
    k.run(2.5);
    expect(k.currentTick).toBe(2500);
    expect(k.currentSeconds).toBe(2.5);
    expect(() => k.runUntil(10)).toThrow(RangeError);
  });

  it("step executes exactly one event", () => {
    const k = new Kernel();
    let n = 0;
    k.schedule(1, 5, () => n++);
    k.schedule(2, 5, () => n++);
    expect(k.step()).toBe(true);
    expect(n).toBe(1);
    expect(k.currentTick).toBe(1);
    expect(k.step()).toBe(true);
    expect(k.step()).toBe(false);
    expect(k.eventsProcessed).toBe(2);
  });
});
