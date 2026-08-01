import Database from "better-sqlite3";
import type { ParsedSpec } from "./schedule.js";

export type JobState = "active" | "paused" | "completed" | "cancelled" | "failed";
export type DeliveryMode = "poll" | "webhook" | "a2a";

export interface JobRow {
  id: string;
  kind: string;
  spec: string;
  state: JobState;
  next_fire_at: number | null;
  attempt: number;
  fires_so_far: number;
  payload: string;
  payload_digest: string;
  delivery_mode: DeliveryMode;
  delivered_to: string;
  delivery_meta: string;
  poll_key: string;
  lease_expires_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateJobInput {
  id: string;
  spec: ParsedSpec;
  payload: string;
  payloadDigest: string;
  deliveryMode: DeliveryMode;
  deliveredTo?: string;
  deliveryMeta?: unknown;
  pollKey: string;
  firstFireAt: number;
}

export interface FiringRecord {
  id: string;
  job_id: string;
  scheduled_for: number;
  fired_at: number;
  attempt: number;
  outcome: string;
  late: number;
  idempotency_key: string;
  receipt: string;
  payload: string;
}

export interface PollDelivery {
  id: string;
  job_id: string;
  poll_key: string;
  idempotency_key: string;
  payload: string;
  receipt: string;
  state: "pending" | "acked";
  created_at: number;
  acked_at: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  spec TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  next_fire_at INTEGER,
  attempt INTEGER NOT NULL DEFAULT 0,
  fires_so_far INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  delivery_mode TEXT NOT NULL,
  delivered_to TEXT NOT NULL DEFAULT '',
  delivery_meta TEXT NOT NULL DEFAULT '{}',
  poll_key TEXT NOT NULL,
  lease_expires_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(state, next_fire_at);
CREATE TABLE IF NOT EXISTS firings (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  scheduled_for INTEGER NOT NULL,
  fired_at INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  late INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL,
  receipt TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_firings_job ON firings(job_id);
CREATE TABLE IF NOT EXISTS poll_deliveries (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  poll_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  receipt TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  acked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_poll_pending ON poll_deliveries(poll_key, state);
CREATE UNIQUE INDEX IF NOT EXISTS uq_poll_idem ON poll_deliveries(idempotency_key);
`;

export class Store {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  createJob(input: CreateJobInput): JobRow {
    const existing = this.getJob(input.id);
    if (existing) {
      throw new Error(`job "${input.id}" already exists`);
    }
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO jobs (id, kind, spec, state, next_fire_at, payload, payload_digest,
           delivery_mode, delivered_to, delivery_meta, poll_key, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.spec.kind,
        JSON.stringify(input.spec),
        input.firstFireAt,
        input.payload,
        input.payloadDigest,
        input.deliveryMode,
        input.deliveredTo || "",
        JSON.stringify(input.deliveryMeta ?? {}),
        input.pollKey,
        now,
        now
      );
    return this.getJob(input.id)!;
  }

  getJob(id: string): JobRow | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
  }

  listJobs(): JobRow[] {
    return this.db.prepare("SELECT * FROM jobs ORDER BY created_at ASC").all() as JobRow[];
  }

  claimDue(nowMs: number, leaseMs: number, limit = 50): JobRow[] {
    const tx = this.db.transaction((now: number, lease: number, lim: number): JobRow[] => {
      const due = this.db
        .prepare(
          `SELECT * FROM jobs
           WHERE state = 'active' AND next_fire_at IS NOT NULL AND next_fire_at <= ?
             AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
           ORDER BY next_fire_at ASC
           LIMIT ?`
        )
        .all(now, now, lim) as JobRow[];
      const upd = this.db.prepare(
        "UPDATE jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ?"
      );
      for (const job of due) {
        upd.run(now + lease, now, job.id);
      }
      return due;
    });
    return tx(nowMs, leaseMs, limit);
  }

  recordFiring(f: FiringRecord): void {
    this.db
      .prepare(
        `INSERT INTO firings (id, job_id, scheduled_for, fired_at, attempt, outcome, late,
           idempotency_key, receipt, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`
      )
      .run(f.id, f.job_id, f.scheduled_for, f.fired_at, f.attempt, f.outcome, f.late, f.idempotency_key, f.receipt, f.payload);
  }

  getFirings(jobId: string): FiringRecord[] {
    return this.db
      .prepare("SELECT * FROM firings WHERE job_id = ? ORDER BY fired_at ASC")
      .all(jobId) as FiringRecord[];
  }

  updateJobState(
    id: string,
    patch: Partial<
      Pick<
        JobRow,
        | "state"
        | "next_fire_at"
        | "attempt"
        | "fires_so_far"
        | "last_error"
        | "lease_expires_at"
        | "spec"
        | "payload"
        | "payload_digest"
      >
    >
  ): void {
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      fields.push(`${k} = ?`);
      values.push(v);
    }
    fields.push("updated_at = ?");
    values.push(Date.now());
    values.push(id);
    this.db.prepare(`UPDATE jobs SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }

  enqueuePollDelivery(input: {
    jobId: string;
    pollKey: string;
    idempotencyKey: string;
    payload: string;
    receipt: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO poll_deliveries (id, job_id, poll_key, idempotency_key, payload, receipt, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        `d:${input.idempotencyKey}`,
        input.jobId,
        input.pollKey,
        input.idempotencyKey,
        input.payload,
        input.receipt,
        Date.now()
      );
  }

  pollDue(pollKey: string): PollDelivery[] {
    return this.db
      .prepare(
        "SELECT * FROM poll_deliveries WHERE poll_key = ? AND state = 'pending' ORDER BY created_at ASC"
      )
      .all(pollKey) as PollDelivery[];
  }

  hasPendingDeliveries(jobId: string): boolean {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM poll_deliveries WHERE job_id = ? AND state = 'pending'")
      .get(jobId) as { n: number };
    return row.n > 0;
  }

  ackDeliveries(pollKey: string, idempotencyKeys: string[]): number {
    if (idempotencyKeys.length === 0) return 0;
    const tx = this.db.transaction((): number => {
      let acked = 0;
      for (const key of idempotencyKeys) {
        const res = this.db
          .prepare(
            `UPDATE poll_deliveries SET state = 'acked', acked_at = ? WHERE poll_key = ? AND idempotency_key = ? AND state = 'pending'`
          )
          .run(Date.now(), pollKey, key);
        acked += res.changes;
      }
      return acked;
    });
    return tx();
  }

  pauseJob(id: string): void {
    this.updateJobState(id, { state: "paused", next_fire_at: null });
  }

  resumeJob(id: string, nextFireAt: number): void {
    this.updateJobState(id, { state: "active", next_fire_at: nextFireAt });
  }

  cancelJob(id: string, receiptJson: string): void {
    const job = this.getJob(id);
    if (!job) throw new Error(`job "${id}" not found`);
    this.db
      .prepare(
        `INSERT INTO firings (id, job_id, scheduled_for, fired_at, attempt, outcome, late,
           idempotency_key, receipt, payload)
         VALUES (?, ?, ?, ?, ?, 'cancelled', 0, ?, ?, ?)`
      )
      .run(
        `c:${job.id}:${Date.now()}`,
        job.id,
        job.next_fire_at ?? Date.now(),
        Date.now(),
        job.attempt + 1,
        `c:${job.id}:cancel:${Date.now()}`,
        receiptJson,
        job.payload
      );
    this.updateJobState(id, { state: "cancelled", next_fire_at: null });
  }

  close(): void {
    this.db.close();
  }
}

export function openStore(dbPath: string): Store {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  return new Store(db);
}
