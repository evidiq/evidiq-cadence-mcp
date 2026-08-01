import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openStore } from "../lib/cadence/store.js";
import { parseScheduleSpec } from "../lib/cadence/schedule.js";
import { Ticker, DEFAULT_RETRY_LADDER_MS, LATE_GRACE_MS } from "../lib/cadence/ticker.js";
import { verifyReceipt } from "../lib/cadence/receipt.js";

const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // throwaway, test-only
const NOW = Date.parse("2026-08-02T00:00:00.000Z");

let store: ReturnType<typeof openStore>;
let clock: number;
let webhookCalls: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] = [];
let webhookStatus: number | null = 200;

function makeStore() {
  return openStore(":memory:");
}

function makeTicker(opts: { intervalMs?: number } = {}) {
  return new Ticker(store, {
    intervalMs: opts.intervalMs ?? 60_000,
    leaseMs: 60_000,
    maxPerTick: 50,
    nowFn: () => clock,
    webhookImpl: async (url, init) => {
      webhookCalls.push({ url, init: init as any });
      return new Response(webhookStatus === null ? "" : "{}", { status: webhookStatus ?? 200 });
    },
  });
}

function createPollJob(overrides: Record<string, unknown> = {}) {
  const spec = parseScheduleSpec({ kind: "one_shot", at: "2026-08-02T00:05:00.000Z" }, NOW);
  return store.createJob({
    id: `job_${Math.random().toString(36).slice(2, 8)}`,
    spec: (overrides.spec as any) ?? spec,
    payload: JSON.stringify({ hello: "world" }),
    payloadDigest: "0x" + "cd".repeat(32),
    deliveryMode: (overrides.deliveryMode as any) ?? "poll",
    deliveredTo: (overrides.deliveredTo as string) ?? "",
    pollKey: (overrides.pollKey as string) ?? "pollkey_a",
    firstFireAt: (overrides.firstFireAt as number) ?? NOW - 60_000,
  });
}

beforeEach(() => {
  store = makeStore();
  clock = NOW;
  webhookCalls = [];
  webhookStatus = 200;
  process.env.CADENCE_SIGNER_PRIVATE_KEY = TEST_KEY;
});

afterEach(() => {
  delete process.env.CADENCE_SIGNER_PRIVATE_KEY;
  store.close();
});

describe("ticker firing", () => {
  it("fires a due poll job: enqueues delivery, records firing, completes one_shot", async () => {
    const job = createPollJob({ firstFireAt: NOW - 1_000 });
    const ticker = makeTicker();
    await ticker.runTick();

    const deliveries = store.pollDue(job.poll_key);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].job_id).toBe(job.id);
    expect(deliveries[0].idempotency_key).toBe(`c:${job.id}:${NOW - 1_000}:1`);

    const firings = store.getFirings(job.id);
    expect(firings).toHaveLength(1);
    expect(firings[0].outcome).toBe("fired");
    expect(firings[0].late).toBe(0);

    const updated = store.getJob(job.id)!;
    expect(updated.state).toBe("completed");
    expect(updated.next_fire_at).toBeNull();
  });

  it("signs every receipt with the configured key and a closed field set", async () => {
    const job = createPollJob();
    const ticker = makeTicker();
    await ticker.runTick();
    const [delivery] = store.pollDue(job.poll_key);
    const bundle = JSON.parse(delivery.receipt);
    expect(Object.keys(bundle.receipt).sort()).toEqual(
      ["jobId", "scheduleSpec", "scheduledFor", "firedAt", "attempt", "deliveryMode", "deliveredTo", "payloadDigest", "outcome", "late"].sort()
    );
    const verified = await verifyReceipt(bundle.receipt, bundle.digest, bundle.signature, TEST_KEY);
    expect(verified.digestValid).toBe(true);
    expect(verified.signatureValid).toBe(true);
    expect(bundle.receipt.outcome).toBe("fired");
    expect(bundle.receipt.deliveredTo).toBe(job.poll_key);
    expect(bundle.receipt.scheduledFor).toBe(NOW - 60_000);
    expect(bundle.receipt.payloadDigest).toBe(job.payload_digest);
  });

  it("marks a firing late when it missed its window beyond the grace", async () => {
    const job = createPollJob({ firstFireAt: NOW - 600_000 });
    const ticker = makeTicker();
    await ticker.runTick();
    const [delivery] = store.pollDue(job.poll_key);
    const bundle = JSON.parse(delivery.receipt);
    expect(bundle.receipt.late).toBe(true);
    expect(bundle.receipt.firedAt - bundle.receipt.scheduledFor).toBe(600_000);

    const onTime = createPollJob({ firstFireAt: NOW - 2_000, pollKey: "pollkey_b" });
    await ticker.runTick();
    const [onTimeDelivery] = store.pollDue("pollkey_b");
    expect(JSON.parse(onTimeDelivery.receipt).receipt.late).toBe(false);
  });

  it("advances a recurring job to its next interval", async () => {
    const spec = parseScheduleSpec({ kind: "recurring", interval: "1h" }, NOW);
    const job = createPollJob({ spec, firstFireAt: NOW - 60_000 });
    const ticker = makeTicker();
    await ticker.runTick();
    const updated = store.getJob(job.id)!;
    expect(updated.state).toBe("active");
    expect(updated.next_fire_at).toBe(NOW + 3_600_000);
    expect(updated.fires_so_far).toBe(1);
  });

  it("respects maxFires on a recurring job", async () => {
    const spec = parseScheduleSpec({ kind: "recurring", interval: "1s", maxFires: 2 }, NOW);
    const job = createPollJob({ spec, firstFireAt: NOW - 60_000 });
    const ticker = makeTicker();
    await ticker.runTick();
    expect(store.getJob(job.id)!.fires_so_far).toBe(1);
    clock += 1_100;
    await ticker.runTick();
    const updated = store.getJob(job.id)!;
    expect(updated.fires_so_far).toBe(2);
    expect(updated.state).toBe("completed");
  });

  it("does not fire paused, cancelled or future jobs", async () => {
    const a = createPollJob();
    const b = createPollJob();
    const c = createPollJob({ firstFireAt: NOW + 3_600_000 });
    store.pauseJob(a.id);
    store.cancelJob(b.id, JSON.stringify({ receipt: { outcome: "cancelled" }, digest: "0x", signature: "0x" }));
    const ticker = makeTicker();
    await ticker.runTick();
    expect(store.pollDue("pollkey_a")).toHaveLength(0);
  });

  it("restart mid-firing cannot double-deliver while the lease holds", async () => {
    const spec = parseScheduleSpec({ kind: "one_shot", at: "2026-08-02T00:05:00.000Z" }, NOW);
    const job = createPollJob({
      spec,
      deliveryMode: "webhook",
      deliveredTo: "https://buyer.example/hook",
      firstFireAt: NOW - 60_000,
    });

    const firstTicker = new Ticker(store, {
      intervalMs: 60_000,
      leaseMs: 60_000,
      nowFn: () => clock,
      webhookImpl: () => new Promise<Response>(() => {}), // process dies mid-firing
    });
    const p = firstTicker.runTick();

    const restarted = makeTicker();
    await restarted.runTick();
    expect(webhookCalls).toHaveLength(0);
    expect(store.getFirings(job.id)).toHaveLength(0);

    clock += 61_000;
    await restarted.runTick();
    expect(webhookCalls).toHaveLength(1);
    expect(webhookCalls[0].init.headers["x-cadence-idempotency-key"]).toBe(`c:${job.id}:${NOW - 60_000}:1`);
    const firings = store.getFirings(job.id);
    expect(firings).toHaveLength(1);
    expect(firings[0].idempotency_key).toBe(`c:${job.id}:${NOW - 60_000}:1`);
  });

  it("lastTickAt reflects a real tick", async () => {
    const ticker = makeTicker();
    expect(ticker.getLastTickAt()).toBe(0);
    await ticker.runTick();
    expect(ticker.getLastTickAt()).toBe(clock);
  });

  it("records last_error when a firing blows up, without losing the job", async () => {
    const job = createPollJob();
    delete process.env.CADENCE_SIGNER_PRIVATE_KEY;
    const ticker = makeTicker();
    await ticker.runTick();
    const updated = store.getJob(job.id)!;
    expect(updated.last_error).toMatch(/CADENCE_SIGNER_PRIVATE_KEY/);
    expect(updated.state).toBe("active");
    expect(updated.next_fire_at).not.toBeNull();
  });
});

describe("webhook delivery", () => {
  it("POSTs the payload signed, and completes the job on 2xx", async () => {
    const spec = parseScheduleSpec({ kind: "one_shot", at: "2026-08-02T00:05:00.000Z" }, NOW);
    const job = createPollJob({ deliveryMode: "webhook", deliveredTo: "https://buyer.example/hook", spec });
    const ticker = makeTicker();
    await ticker.runTick();

    expect(webhookCalls).toHaveLength(1);
    const call = webhookCalls[0];
    expect(call.url).toBe("https://buyer.example/hook");
    expect(call.init.method).toBe("POST");
    expect(call.init.headers["content-type"]).toBe("application/json");
    expect(call.init.headers["x-cadence-signature"]).toMatch(/^0x[0-9a-f]{130}$/);
    expect(call.init.headers["x-cadence-digest"]).toMatch(/^0x[0-9a-f]{64}$/);
    expect(call.init.headers["x-cadence-job-id"]).toBe(job.id);
    expect(call.init.headers["x-cadence-idempotency-key"]).toBe(`c:${job.id}:${NOW - 60_000}:1`);
    expect(JSON.parse(call.init.body)).toEqual({ hello: "world" });

    const [firing] = store.getFirings(job.id);
    expect(firing.outcome).toBe("delivered");
    expect(store.getJob(job.id)!.state).toBe("completed");
  });

  it("retries a failed webhook on the ladder, then falls back to poll", async () => {
    const spec = parseScheduleSpec({ kind: "one_shot", at: "2026-08-02T00:05:00.000Z" }, NOW);
    const job = createPollJob({ deliveryMode: "webhook", deliveredTo: "https://buyer.example/hook", spec });
    const ticker = makeTicker();

    webhookStatus = 503;
    await ticker.runTick();
    let updated = store.getJob(job.id)!;
    expect(updated.state).toBe("active");
    expect(updated.attempt).toBe(1);
    expect(updated.next_fire_at).toBe(NOW + DEFAULT_RETRY_LADDER_MS[0]);
    expect(store.pollDue(job.poll_key)).toHaveLength(0);
    expect(store.getFirings(job.id)[0].outcome).toBe("webhook_failed");

    clock += DEFAULT_RETRY_LADDER_MS[0];
    await ticker.runTick();
    updated = store.getJob(job.id)!;
    expect(updated.attempt).toBe(2);
    expect(updated.next_fire_at).toBe(NOW + DEFAULT_RETRY_LADDER_MS[0] + DEFAULT_RETRY_LADDER_MS[1]);

    for (let i = 0; i < DEFAULT_RETRY_LADDER_MS.length; i++) {
      clock = store.getJob(job.id)!.next_fire_at!;
      await ticker.runTick();
    }
    updated = store.getJob(job.id)!;
    expect(updated.state).toBe("completed");
    expect(updated.next_fire_at).toBeNull();
    const [delivery] = store.pollDue(job.poll_key);
    expect(delivery).toBeDefined();
    expect(JSON.parse(delivery.receipt).receipt.outcome).toBe("fired");
    expect(JSON.parse(delivery.receipt).receipt.deliveredTo).toBe(job.poll_key);
  });

  it("uses the job's own backoff ladder when specified", async () => {
    const spec = parseScheduleSpec({ kind: "retry", backoff: ["1m", "10m"], at: "2026-08-02T00:05:00.000Z" }, NOW);
    const job = createPollJob({ deliveryMode: "webhook", deliveredTo: "https://buyer.example/hook", spec });
    const ticker = makeTicker();
    webhookStatus = 500;
    await ticker.runTick();
    const updated = store.getJob(job.id)!;
    expect(updated.next_fire_at).toBe(NOW + 60_000);
    clock = updated.next_fire_at!;
    await ticker.runTick();
    expect(store.getJob(job.id)!.next_fire_at).toBe(NOW + 60_000 + 600_000);
  });
});

describe("workflow escalation", () => {
  it("delivers the escalation payload when a step fires past its deadline", async () => {
    const spec = parseScheduleSpec(
      {
        kind: "workflow",
        steps: [
          { id: "s1", description: "first", deadline: "2026-08-02T00:01:00.000Z", escalation: { alert: "s1 late" } },
          { id: "s2", description: "second", deadline: "2026-08-02T01:00:00.000Z" },
        ],
      },
      NOW
    );
    const job = store.createJob({
      id: "wf1",
      spec,
      payload: JSON.stringify({ step: "s1" }),
      payloadDigest: "0x" + "ef".repeat(32),
      deliveryMode: "poll",
      pollKey: "pk_wf",
      firstFireAt: Date.parse("2026-08-02T00:01:00.000Z"),
    });
    clock = Date.parse("2026-08-02T00:02:01.000Z");
    const ticker = makeTicker();
    await ticker.runTick();

    const [delivery] = store.pollDue("pk_wf");
    expect(JSON.parse(delivery.payload)).toEqual({ alert: "s1 late" });
    expect(JSON.parse(delivery.receipt).receipt.outcome).toBe("escalated");
    expect(store.getJob(job.id)!.next_fire_at).toBe(Date.parse("2026-08-02T01:00:00.000Z"));
  });

  it("delivers the step payload when on time", async () => {
    const spec = parseScheduleSpec(
      {
        kind: "workflow",
        steps: [
          { id: "s1", description: "first", deadline: "2026-08-02T00:01:00.000Z", escalation: { alert: "late" } },
          { id: "s2", description: "second", deadline: "2026-08-02T01:00:00.000Z" },
        ],
      },
      NOW
    );
    store.createJob({
      id: "wf2",
      spec,
      payload: JSON.stringify({ step: "s1" }),
      payloadDigest: "0x" + "ef".repeat(32),
      deliveryMode: "poll",
      pollKey: "pk_wf2",
      firstFireAt: Date.parse("2026-08-02T00:01:00.000Z"),
    });
    clock = Date.parse("2026-08-02T00:01:00.000Z");
    const ticker = makeTicker();
    await ticker.runTick();
    const [delivery] = store.pollDue("pk_wf2");
    expect(JSON.parse(delivery.payload)).toEqual({ step: "s1" });
    expect(JSON.parse(delivery.receipt).receipt.outcome).toBe("fired");
  });
});

describe("expiration lead time", () => {
  it("fires at deadline minus lead time, and is terminal", async () => {
    const spec = parseScheduleSpec(
      { kind: "expiration", deadline: "2026-08-02T01:00:00.000Z", leadTime: "10m" },
      NOW
    );
    const job = store.createJob({
      id: "exp1",
      spec,
      payload: JSON.stringify({ window: "x402" }),
      payloadDigest: "0x" + "ab".repeat(32),
      deliveryMode: "poll",
      pollKey: "pk_exp",
      firstFireAt: Date.parse("2026-08-02T00:50:00.000Z"),
    });
    const ticker = makeTicker();
    clock = Date.parse("2026-08-02T00:50:00.000Z");
    await ticker.runTick();
    const [delivery] = store.pollDue("pk_exp");
    expect(delivery).toBeDefined();
    expect(store.getJob(job.id)!.state).toBe("completed");
    expect(LATE_GRACE_MS).toBe(5_000);
  });
});
