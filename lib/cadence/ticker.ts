import { createHash } from "node:crypto";
import { Store, type JobRow } from "./store.js";
import { buildReceipt, type ReceiptInput } from "./receipt.js";
import { computeNextFire, type ParsedSpec } from "./schedule.js";

export const LATE_GRACE_MS = 5_000;
export const ESCALATION_GRACE_MS = 60_000;
export const DEFAULT_RETRY_LADDER_MS = [60_000, 300_000, 1_800_000, 7_200_000];

export interface ReceiptBundle {
  receipt: ReceiptInput;
  digest: string;
  signature: string;
}

export type WebhookFn = (url: string, init: RequestInit) => Promise<Response>;

export interface TickerOptions {
  intervalMs?: number;
  leaseMs?: number;
  maxPerTick?: number;
  nowFn?: () => number;
  webhookImpl?: WebhookFn;
  evaluateMonitor?: (job: JobRow, spec: ParsedSpec) => Promise<boolean>;
}

function digestOf(payload: string): string {
  return `0x${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

export function idempotencyKey(jobId: string, scheduledFor: number, attempt: number): string {
  return `c:${jobId}:${scheduledFor}:${attempt}`;
}

export class Ticker {
  private store: Store;
  private opts: Required<Pick<TickerOptions, "intervalMs" | "leaseMs" | "maxPerTick">> &
    Pick<TickerOptions, "nowFn" | "webhookImpl" | "evaluateMonitor">;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastTickAt = 0;

  constructor(store: Store, opts: TickerOptions = {}) {
    this.store = store;
    this.opts = {
      intervalMs: opts.intervalMs ?? 5_000,
      leaseMs: opts.leaseMs ?? 60_000,
      maxPerTick: opts.maxPerTick ?? 50,
      nowFn: opts.nowFn,
      webhookImpl: opts.webhookImpl,
      evaluateMonitor: opts.evaluateMonitor,
    };
  }

  start(): void {
    if (this.timer) return;
    void this.runTick();
    this.timer = setInterval(() => void this.runTick(), this.opts.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getLastTickAt(): number {
    return this.lastTickAt;
  }

  async runTick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const now = this.now();
    this.lastTickAt = now;
    try {
      const jobs = this.store.claimDue(now, this.opts.leaseMs, this.opts.maxPerTick);
      for (const job of jobs) {
        try {
          await this.fireJob(job);
        } catch (err) {
          this.store.updateJobState(job.id, { last_error: (err as Error).message });
        }
      }
    } finally {
      this.running = false;
    }
  }

  private now(): number {
    return this.opts.nowFn ? this.opts.nowFn() : Date.now();
  }

  private webhookPost(url: string, init: RequestInit): Promise<Response> {
    if (this.opts.webhookImpl) return this.opts.webhookImpl(url, init);
    return fetch(url, init);
  }

  private async fireJob(job: JobRow): Promise<void> {
    const spec: ParsedSpec = JSON.parse(job.spec);
    const now = this.now();
    const scheduledFor = job.next_fire_at ?? now;
    const attempt = job.attempt + 1;
    const late = now - scheduledFor > LATE_GRACE_MS ? 1 : 0;

    if (spec.kind === "monitor" || spec.kind === "verification") {
      if (!this.opts.evaluateMonitor) {
        throw new Error("monitor evaluation is not configured");
      }
      const trips = await this.opts.evaluateMonitor(job, spec);
      if (!trips) {
        this.store.updateJobState(job.id, {
          next_fire_at: computeNextFire(spec, now, job.fires_so_far + 1),
          fires_so_far: job.fires_so_far + 1,
          lease_expires_at: null,
          last_error: null,
        });
        return;
      }
    }

    let payload = job.payload;
    let payloadDigest = job.payload_digest;
    let outcome = "fired";

    if (spec.kind === "workflow") {
      const step = spec.steps![job.fires_so_far];
      if (step && step.escalation !== undefined && now - step.deadline > ESCALATION_GRACE_MS) {
        payload = JSON.stringify(step.escalation);
        payloadDigest = digestOf(payload);
        outcome = "escalated";
      }
    }

    if (job.delivery_mode === "poll") {
      const receipt = await buildReceipt({
        jobId: job.id,
        scheduleSpec: spec,
        scheduledFor,
        firedAt: now,
        attempt,
        deliveryMode: "poll",
        deliveredTo: job.poll_key,
        payloadDigest,
        outcome,
        late: late === 1,
      });
      const bundle: ReceiptBundle = { receipt: receipt.receipt, digest: receipt.digest, signature: receipt.signature };
      this.store.enqueuePollDelivery({
        jobId: job.id,
        pollKey: job.poll_key,
        idempotencyKey: idempotencyKey(job.id, scheduledFor, attempt),
        payload,
        receipt: JSON.stringify(bundle),
      });
      this.recordFiring(job, spec, scheduledFor, now, attempt, late, outcome, bundle, payload);
      this.advance(job, spec, now);
      return;
    }

    if (job.delivery_mode === "webhook") {
      const delivered = await this.deliverWebhook(job, spec, scheduledFor, now, attempt, late, payload, payloadDigest);
      if (delivered) {
        this.advance(job, spec, now);
      } else {
        this.scheduleWebhookRetry(job, spec, now, attempt);
      }
      return;
    }

    throw new Error(`delivery mode "${job.delivery_mode}" is not implemented`);
  }

  private async deliverWebhook(
    job: JobRow,
    spec: ParsedSpec,
    scheduledFor: number,
    firedAt: number,
    attempt: number,
    late: number,
    payload: string,
    payloadDigest: string
  ): Promise<boolean> {
    const outcome = "delivered";
    const receipt = await buildReceipt({
      jobId: job.id,
      scheduleSpec: spec,
      scheduledFor,
      firedAt,
      attempt,
      deliveryMode: "webhook",
      deliveredTo: job.delivered_to,
      payloadDigest,
      outcome,
      late: late === 1,
    });
    const bundle: ReceiptBundle = { receipt: receipt.receipt, digest: receipt.digest, signature: receipt.signature };

    try {
      const res = await this.webhookPost(job.delivered_to, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cadence-signature": receipt.signature,
          "x-cadence-digest": receipt.digest,
          "x-cadence-job-id": job.id,
          "x-cadence-idempotency-key": idempotencyKey(job.id, scheduledFor, attempt),
        },
        body: payload,
      });
      if (res.ok) {
        this.recordFiring(job, spec, scheduledFor, firedAt, attempt, late, outcome, bundle, payload);
        return true;
      }
      this.recordFiring(job, spec, scheduledFor, firedAt, attempt, late, "webhook_failed", bundle, payload);
      return false;
    } catch (err) {
      this.recordFiring(job, spec, scheduledFor, firedAt, attempt, late, "webhook_failed", bundle, payload);
      this.store.updateJobState(job.id, { last_error: (err as Error).message });
      return false;
    }
  }

  private scheduleWebhookRetry(job: JobRow, spec: ParsedSpec, now: number, attempt: number): void {
    const ladder = spec.backoffMs && spec.backoffMs.length > 0 ? spec.backoffMs : DEFAULT_RETRY_LADDER_MS;
    const rung = job.attempt;
    if (rung < ladder.length) {
      this.store.updateJobState(job.id, {
        attempt: rung + 1,
        next_fire_at: now + ladder[rung],
        lease_expires_at: null,
      });
      return;
    }
    void this.fallbackToPoll(job, spec, now, attempt);
  }

  private async fallbackToPoll(job: JobRow, spec: ParsedSpec, now: number, attempt: number): Promise<void> {
    const scheduledFor = job.next_fire_at ?? now;
    const fallbackAttempt = attempt + 1;
    const late = now - scheduledFor > LATE_GRACE_MS ? 1 : 0;
    const receipt = await buildReceipt({
      jobId: job.id,
      scheduleSpec: spec,
      scheduledFor,
      firedAt: now,
      attempt: fallbackAttempt,
      deliveryMode: "poll",
      deliveredTo: job.poll_key,
      payloadDigest: job.payload_digest,
      outcome: "fired",
      late: late === 1,
    });
    const bundle: ReceiptBundle = { receipt: receipt.receipt, digest: receipt.digest, signature: receipt.signature };
    this.store.enqueuePollDelivery({
      jobId: job.id,
      pollKey: job.poll_key,
      idempotencyKey: idempotencyKey(job.id, scheduledFor, fallbackAttempt),
      payload: job.payload,
      receipt: JSON.stringify(bundle),
    });
    this.recordFiring(job, spec, scheduledFor, now, fallbackAttempt, late, "fired", bundle, job.payload);
    this.advance(job, spec, now);
  }

  private recordFiring(
    job: JobRow,
    spec: ParsedSpec,
    scheduledFor: number,
    firedAt: number,
    attempt: number,
    late: number,
    outcome: string,
    bundle: ReceiptBundle,
    payload: string
  ): void {
    this.store.recordFiring({
      id: `${job.id}:${scheduledFor}:${attempt}`,
      job_id: job.id,
      scheduled_for: scheduledFor,
      fired_at: firedAt,
      attempt,
      outcome,
      late,
      idempotency_key: idempotencyKey(job.id, scheduledFor, attempt),
      receipt: JSON.stringify(bundle),
      payload,
    });
  }

  private advance(job: JobRow, spec: ParsedSpec, firedAt: number): void {
    const firesSoFar = job.fires_so_far + 1;
    const next = computeNextFire(spec, firedAt, firesSoFar);
    if (next === null) {
      this.store.updateJobState(job.id, {
        state: "completed",
        next_fire_at: null,
        fires_so_far: firesSoFar,
        attempt: 0,
        lease_expires_at: null,
      });
    } else {
      this.store.updateJobState(job.id, {
        next_fire_at: next,
        fires_so_far: firesSoFar,
        attempt: 0,
        lease_expires_at: null,
        last_error: null,
      });
    }
  }
}
