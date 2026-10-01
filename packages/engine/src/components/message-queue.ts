import { Priority } from "../kernel/index.js";
import { FifoBuffer, LinkedComponent, type ComponentInit, type MovingEntity, type SimContext } from "../model/index.js";
import { Tally, TimeWeightedStat } from "../stats/index.js";
import type { ComponentSchema } from "../schema/index.js";
import type { Lease, PullSource, QueueWaiter } from "./pullable.js";

interface Message {
  readonly entity: MovingEntity;
  /** Number of times this message has been received (delivered to a consumer). */
  receiveCount: number;
  /** Tick at which the message last became visible. */
  visibleAt: number;
}

/**
 * SQS-style message queue with a visibility timeout and an optional dead-letter queue.
 *
 * A consumer `receive`s a message, which hides it for `visibilityTimeout` seconds. If the consumer
 * `ack`s in time the message is deleted. Otherwise it becomes visible again (a redelivery). When a
 * message has been received `maxReceiveCount` times and its visibility timeout expires once more,
 * it moves to the `deadLetter` link (or is discarded and counted if there is none).
 *
 * A consumer whose work outlives the visibility timeout is *not* stopped: it finishes, its ack is
 * stale (returns false), and the message may be processed again by someone else. That duplicate
 * processing is the classic visibility-timeout failure mode, and it is modelled on purpose.
 */
export class MessageQueue extends LinkedComponent implements PullSource {
  static readonly schema: ComponentSchema<MessageQueue> = {
    type: "MessageQueue",
    description:
      "SQS-style queue: received messages are hidden for a visibility timeout and redelivered unless acknowledged; after maxReceiveCount receives they go to a dead-letter queue.",
    roles: ["receiver", "pullable"],
    inputs: [
      { key: "visibilityTimeout", type: "number", unit: "time", min: 0.000001, default: 30, required: false, description: "Seconds a received message stays hidden before it is redelivered." },
      { key: "maxReceiveCount", type: "integer", unit: "dimensionless", min: 1, required: false, description: "Receives allowed before a message is dead-lettered (when its visibility timeout expires again). Unlimited if omitted." },
      { key: "costPerMillionRequests", type: "number", unit: "cost", min: 0, default: 0, required: false, description: "Price per million API requests (each send, receive and delete counts as one)." },
    ],
    links: [{ key: "deadLetter", description: "Where messages that exhausted maxReceiveCount are sent. They are discarded (and counted) if omitted.", required: false, accepts: "receiver" }],
    outputs: [
      { key: "QueueLength", unit: "dimensionless", series: true, description: "Messages visible and waiting to be received.", get: (q) => q.visible.length },
      { key: "InFlight", unit: "dimensionless", series: true, description: "Messages received but not yet acknowledged or expired.", get: (q) => q.flight },
      { key: "Backlog", unit: "dimensionless", series: true, description: "Visible plus in-flight messages (SQS ApproximateNumberOfMessages + NotVisible).", get: (q) => q.visible.length + q.flight },
      { key: "AverageQueueLength", unit: "dimensionless", description: "Time-weighted average number of visible messages.", get: (q) => q.lengthStat.mean(q.now) },
      { key: "MaxQueueLength", unit: "dimensionless", description: "Largest number of visible messages.", get: (q) => q.lengthStat.max(q.now) },
      { key: "AverageInFlight", unit: "dimensionless", description: "Time-weighted average number of in-flight messages.", get: (q) => q.flightStat.mean(q.now) },
      { key: "AverageQueueTime", unit: "time", description: "Mean time a message was visible before being received (each receive counts).", get: (q) => q.waitTally.mean() },
      { key: "NumberRequests", unit: "dimensionless", description: "Billable API requests: sends + receives + deletes.", get: (q) => q.requests },
      { key: "Cost", unit: "cost", description: "Request charges over the measured window.", get: (q) => q.requests * q.pricePerRequest },
      { key: "NumberReceived", unit: "dimensionless", description: "Receive operations (a redelivered message counts each time).", get: (q) => q.received },
      { key: "NumberRedelivered", unit: "dimensionless", description: "Messages that became visible again because the visibility timeout expired.", get: (q) => q.redelivered },
      { key: "NumberDeadLettered", unit: "dimensionless", description: "Messages that exhausted maxReceiveCount.", get: (q) => q.deadLettered },
    ],
  };

  readonly redeliversUnacked = true;

  private readonly visible = new FifoBuffer<Message>();
  private readonly waiters: QueueWaiter[] = [];
  private readonly visibilityTicks: number;
  private readonly maxReceiveCount: number | undefined;
  private readonly lengthStat: TimeWeightedStat;
  private readonly flightStat: TimeWeightedStat;
  private readonly waitTally = new Tally();
  private deadLetter: LinkedComponent | null = null;
  private flight = 0;
  private received = 0;
  private redelivered = 0;
  private deadLettered = 0;
  private requests = 0;
  private readonly pricePerRequest: number;

  constructor(ctx: SimContext, init: ComponentInit) {
    super(ctx, init, "Empty");
    // At least one tick, so a tiny timeout can never expire within the tick of its receive.
    this.visibilityTicks = Math.max(1, ctx.kernel.secondsToTicks(init.inputs["visibilityTimeout"] as number));
    this.maxReceiveCount = init.inputs["maxReceiveCount"] as number | undefined;
    this.pricePerRequest = (init.inputs["costPerMillionRequests"] as number) / 1_000_000;
    this.lengthStat = new TimeWeightedStat(ctx.kernel.currentTick, 0);
    this.flightStat = new TimeWeightedStat(ctx.kernel.currentTick, 0);
  }

  private get now(): number {
    return this.ctx.kernel.currentTick;
  }

  override setLink(key: string, target: LinkedComponent): void {
    if (key === "deadLetter") this.deadLetter = target;
    else super.setLink(key, target);
  }

  addWaiter(waiter: QueueWaiter): void {
    this.waiters.push(waiter);
  }

  override addEntity(entity: MovingEntity): void {
    this.noteAdded();
    this.requests++;
    this.makeVisible({ entity, receiveCount: 0, visibleAt: this.now });
  }

  receive(): Lease | null {
    const msg = this.visible.shift();
    if (msg === undefined) return null;
    msg.receiveCount++;
    this.received++;
    this.requests++;
    this.waitTally.add(this.ctx.kernel.ticksToSeconds(this.now - msg.visibleAt));
    this.setFlight(this.flight + 1);
    this.visibleChanged();

    let active = true;
    const timer = this.ctx.kernel.schedule(this.visibilityTicks, Priority.DEFAULT, () => {
      active = false;
      this.expire(msg);
    });
    return {
      entity: msg.entity,
      ack: () => {
        if (!active) return false;
        active = false;
        timer.cancel();
        this.requests++;
        this.setFlight(this.flight - 1);
        this.noteCompleted();
        return true;
      },
    };
  }

  private expire(msg: Message): void {
    this.setFlight(this.flight - 1);
    if (this.maxReceiveCount !== undefined && msg.receiveCount >= this.maxReceiveCount) {
      this.deadLettered++;
      this.noteCompleted();
      this.deadLetter?.addEntity(msg.entity);
      return;
    }
    this.redelivered++;
    msg.visibleAt = this.now;
    this.makeVisible(msg);
  }

  private makeVisible(msg: Message): void {
    this.visible.push(msg);
    this.visibleChanged();
    for (const w of this.waiters) {
      if (this.visible.length === 0) break;
      w.queueHasEntity();
    }
  }

  private visibleChanged(): void {
    this.lengthStat.set(this.now, this.visible.length);
    this.setState(this.visible.length === 0 ? "Empty" : "NonEmpty");
  }

  private setFlight(n: number): void {
    this.flight = n;
    this.flightStat.set(this.now, n);
  }

  override resetStatistics(): void {
    super.resetStatistics();
    this.lengthStat.reset(this.now);
    this.flightStat.reset(this.now);
    this.waitTally.reset();
    this.received = 0;
    this.redelivered = 0;
    this.deadLettered = 0;
    this.requests = 0;
  }
}
