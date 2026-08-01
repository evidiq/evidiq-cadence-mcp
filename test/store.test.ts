import { describe, it, expect, beforeEach } from "vitest";
import { openStore, type CreateJobInput, type JobRow } from "../lib/cadence/store.js";
import { parseScheduleSpec } from "../lib/cadence/schedule.js";

const NOW = Date.parse("2026-08-02T00:00:00.000Z");

let store: ReturnType<typeof openStore>;

function makeJob(overrides: Partial<CreateJobInput> = {}): CreateJobInput {
  const spec = parseScheduleSpec({ kind: "one_shot", at: "2026-08-02T00:05:00.000Z" }, NOW);
  return {
    id: `job_${Math.random().toString(36).slice(2, 10)}`,
    spec,
    payload: JSON.stringify({ hello: "world" }),
    payloadDigest: "0x" + "cd".repeat(32),
    deliveryMode: "poll",
    pollKey: "pollkey_a",
    firstFireAt: Date.parse("2026-08-02T00:05:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  store = openStore(":memory:");
});

describe("store CRUD", () => {
  it("creates and reads a job", () => {
    const input = makeJob();
    store.createJob(input);
    const job = store.getJob(input.id);
    expect(job).toBeDefined();
    expect(job!.id).toBe(input.id);
    expect(job!.state).toBe("active");
    expect(job!.next_fire_at).toBe(input.firstFireAt);
    expect(job!.delivery_mode).toBe("poll");
  });

  it("rejects a duplicate job id", () => {
    const input = makeJob();
    store.createJob(input);
    expect(() => store.createJob(input)).toThrow(/exists/i);
  });

  it("lists jobs", () => {
    store.createJob(makeJob({ id: "a" }));
    store.createJob(makeJob({ id: "b" }));
    expect(store.listJobs().map((j) => j.id).sort()).toEqual(["a", "b"]);
  });
});

describe("claimDue", () => {
  it("claims only due jobs, earliest first", () => {
    store.createJob(makeJob({ id: "early", firstFireAt: NOW - 10_000 }));
    store.createJob(makeJob({ id: "later", firstFireAt: NOW - 5_000 }));
    store.createJob(makeJob({ id: "future", firstFireAt: NOW + 10_000 }));
    const claimed = store.claimDue(NOW, 60_000, 10);
    expect(claimed.map((j) => j.id)).toEqual(["early", "later"]);
  });

  it("leases claimed jobs so a restart cannot double-fire", () => {
    store.createJob(makeJob({ id: "due", firstFireAt: NOW - 5_000 }));
    const claimed = store.claimDue(NOW, 60_000, 10);
    expect(claimed).toHaveLength(1);

    const again = store.claimDue(NOW, 60_000, 10);
    expect(again).toHaveLength(0);
  });

  it("releases the lease after expiry (at-least-once recovery)", () => {
    store.createJob(makeJob({ id: "due", firstFireAt: NOW - 5_000 }));
    store.claimDue(NOW, 60_000, 10);
    const afterLease = store.claimDue(NOW + 61_000, 60_000, 10);
    expect(afterLease.map((j) => j.id)).toEqual(["due"]);
  });

  it("never claims a job that is not due", () => {
    store.createJob(makeJob({ id: "future", firstFireAt: NOW + 3_600_000 }));
    expect(store.claimDue(NOW, 60_000, 10)).toHaveLength(0);
  });

  it("does not claim paused, cancelled or completed jobs", () => {
    store.createJob(makeJob({ id: "active", firstFireAt: NOW - 1_000 }));
    store.pauseJob("active");
    store.createJob(makeJob({ id: "cancelled", firstFireAt: NOW - 1_000 }));
    store.cancelJob("cancelled", JSON.stringify({ receipt: {}, digest: "0x", signature: "0x" }));
    const claimed = store.claimDue(NOW, 60_000, 10);
    expect(claimed).toHaveLength(0);
  });
});

describe("firing history", () => {
  it("records firings with a stable idempotency key", () => {
    store.createJob(makeJob({ id: "j1", firstFireAt: NOW - 5_000 }));
    store.recordFiring({
      id: "j1:1752500000000:1",
      job_id: "j1",
      scheduled_for: NOW - 5_000,
      fired_at: NOW,
      attempt: 1,
      outcome: "fired",
      late: 0,
      idempotency_key: "c:j1:1752500000000:1",
      receipt: JSON.stringify({ digest: "0xaa", signature: "0xbb" }),
      payload: "{}",
    });
    const firings = store.getFirings("j1");
    expect(firings).toHaveLength(1);
    expect(firings[0].idempotency_key).toBe("c:j1:1752500000000:1");
    expect(firings[0].outcome).toBe("fired");
  });

  it("updates job state and next fire", () => {
    store.createJob(makeJob({ id: "j1", firstFireAt: NOW - 5_000 }));
    store.updateJobState("j1", { state: "completed", next_fire_at: null, fires_so_far: 1 });
    const job = store.getJob("j1")!;
    expect(job.state).toBe("completed");
    expect(job.next_fire_at).toBeNull();
    expect(job.fires_so_far).toBe(1);
  });

  it("records last_error", () => {
    store.createJob(makeJob({ id: "j1", firstFireAt: NOW - 5_000 }));
    store.updateJobState("j1", { last_error: "boom" });
    expect(store.getJob("j1")!.last_error).toBe("boom");
  });
});

describe("poll deliveries", () => {
  it("enqueues and returns pending deliveries per poll key", () => {
    store.createJob(makeJob({ id: "j1", pollKey: "pk1", firstFireAt: NOW - 5_000 }));
    store.createJob(makeJob({ id: "j2", pollKey: "pk2", firstFireAt: NOW - 5_000 }));
    store.enqueuePollDelivery({
      jobId: "j1",
      pollKey: "pk1",
      idempotencyKey: "c:j1:1",
      payload: "{\"x\":1}",
      receipt: JSON.stringify({ digest: "0xaa", signature: "0xbb" }),
    });
    store.enqueuePollDelivery({
      jobId: "j2",
      pollKey: "pk2",
      idempotencyKey: "c:j2:1",
      payload: "{\"x\":2}",
      receipt: JSON.stringify({ digest: "0xcc", signature: "0xdd" }),
    });

    const forPk1 = store.pollDue("pk1");
    expect(forPk1).toHaveLength(1);
    expect(forPk1[0].job_id).toBe("j1");
    expect(forPk1[0].idempotency_key).toBe("c:j1:1");
    expect(store.pollDue("pk2")).toHaveLength(1);
    expect(store.pollDue("unknown")).toHaveLength(0);
  });

  it("acks by idempotency key, at-least-once until then", () => {
    store.createJob(makeJob({ id: "j1", pollKey: "pk1", firstFireAt: NOW - 5_000 }));
    store.enqueuePollDelivery({
      jobId: "j1",
      pollKey: "pk1",
      idempotencyKey: "c:j1:1",
      payload: "{}",
      receipt: "{}",
    });
    expect(store.pollDue("pk1")).toHaveLength(1);
    expect(store.ackDeliveries("pk1", ["c:j1:1"])).toBe(1);
    expect(store.pollDue("pk1")).toHaveLength(0);
    expect(store.ackDeliveries("pk1", ["c:j1:1"])).toBe(0);
  });

  it("duplicate enqueue with the same idempotency key is a no-op", () => {
    store.createJob(makeJob({ id: "j1", pollKey: "pk1", firstFireAt: NOW - 5_000 }));
    const delivery = {
      jobId: "j1",
      pollKey: "pk1",
      idempotencyKey: "c:j1:1",
      payload: "{}",
      receipt: "{}",
    };
    store.enqueuePollDelivery(delivery);
    store.enqueuePollDelivery(delivery);
    expect(store.pollDue("pk1")).toHaveLength(1);
  });
});

describe("lifecycle", () => {
  it("pause keeps the schedule but stops claiming; resume restores", () => {
    store.createJob(makeJob({ id: "j1", firstFireAt: NOW - 1_000 }));
    store.pauseJob("j1");
    const paused = store.getJob("j1")!;
    expect(paused.state).toBe("paused");
    expect(paused.next_fire_at).toBeNull();
    expect(store.claimDue(NOW, 60_000, 10)).toHaveLength(0);

    store.resumeJob("j1", NOW + 60_000);
    const resumed = store.getJob("j1")!;
    expect(resumed.state).toBe("active");
    expect(resumed.next_fire_at).toBe(NOW + 60_000);
  });

  it("cancel is terminal with a final receipt", () => {
    store.createJob(makeJob({ id: "j1", firstFireAt: NOW - 1_000 }));
    store.cancelJob("j1", JSON.stringify({ receipt: { outcome: "cancelled" }, digest: "0x", signature: "0x" }));
    const job = store.getJob("j1")!;
    expect(job.state).toBe("cancelled");
    expect(job.next_fire_at).toBeNull();
    const firings = store.getFirings("j1");
    expect(firings).toHaveLength(1);
    expect(firings[0].outcome).toBe("cancelled");
  });
});
