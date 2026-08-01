import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import type { CadenceRuntime } from "./lib/cadence/runtime.js";
import {
  parseScheduleSpec,
  computeFirstFire,
  computeResumeFire,
  type ParsedSpec,
} from "./lib/cadence/schedule.js";
import { buildReceipt, verifyReceipt, getSignerAddress, signerAvailable } from "./lib/cadence/receipt.js";
import { TOOL_PRICES_ATOMIC, TOOL_PRICES_HUMAN, FREE_TOOL_NAMES } from "./lib/x402/challenge.js";
import { isPaidTool } from "./lib/x402/gate.js";

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function digestOf(payload: string): string {
  return `0x${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function payloadString(payload: unknown): string {
  return typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
}

// Some MCP clients (OpenClaw's glm-5.2 tool use) serialize nested objects to
// JSON strings. Coerce a string that parses as JSON back to its value so the
// same tool call works identically from every client.
function coerce(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed === "") return value;
  if (!/^[{[\"]/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function validationError(message: string) {
  return textResult({ ok: false, error: message });
}

const COMMON = {
  payload: z.any().optional().describe("Opaque payload, returned verbatim on firing."),
  deliveryMode: z
    .enum(["poll", "webhook", "a2a"])
    .optional()
    .describe("How to deliver: poll (default) or webhook. a2a is rejected until proven."),
  webhookUrl: z.string().optional().describe("Required when deliveryMode=webhook. Signed with EIP-191 headers."),
  pollKey: z.string().optional().describe("Your poll key; poll_due returns all pending deliveries for it."),
};

const delaySchema = {
  at: z.string().or(z.number()).optional().describe("Absolute ISO 8601 timestamp or epoch ms."),
  delay: z.string().optional().describe('Relative delay, e.g. "5m".'),
};

export function createCadenceServer(runtime: CadenceRuntime) {
  const INSTRUCTIONS = `EVIDIQ Cadence MCP — durable, attested future execution for agents. 18 tools (8 free, 10 paid).

Free tools (always 200): cadence_capabilities, estimate_cost, validate_schedule, verify_receipt, get_job, poll_due, pause_job, cancel_job.

Paid tools (x402-gated, USDT0 on eip155:196): schedule_job (0.005), schedule_recurring (0.01), schedule_retry (0.01), schedule_expiration (0.01), schedule_monitor (0.02), schedule_verification (0.015), schedule_workflow (0.03), reschedule_job (0.005), resume_job (0.005), attest_execution (0.03). Payment settles before work begins.

Delivery: poll (always works, the baseline), webhook (signed with EIP-191 headers, retried on the ladder, then falls back to poll). At-least-once: every firing carries an idempotencyKey; the buyer deduplicates. A job never fires early (except schedule_expiration, whose whole purpose is a configured lead time); a firing that missed its window is marked late with the delay in the receipt. Stopping is always free: pause_job and cancel_job cost nothing.`;

  const handler = createMcpHandler(
    (server) => {
      // ── FREE 1: cadence_capabilities ────────────────────────────────────
      server.registerTool(
        "cadence_capabilities",
        {
          title: "Cadence capabilities: tools, prices, delivery modes, guarantees",
          description:
            "Everything a buyer needs to decide: all 18 tools with prices, the three delivery modes (a2a only when proven), timing guarantees (at-least-once, never-early, late marking), limits, and lastTickAt from the real ticker. Free.",
          inputSchema: {},
        },
        async () => {
          const lastTickAt = runtime.getLastTickAt();
          const paid = Object.entries(TOOL_PRICES_HUMAN).map(([tool, price]) => ({ tool, price, paid: true }));
          const free = FREE_TOOL_NAMES.map((tool) => ({ tool, price: "0", paid: false }));
          return textResult({
            ok: true,
            service: "EVIDIQ Cadence — the Temporal Layer for Autonomous Agents",
            tools: [...paid, ...free].sort((a, b) => a.tool.localeCompare(b.tool)),
            prices: {
              schedule_job: TOOL_PRICES_HUMAN.schedule_job,
              schedule_recurring: TOOL_PRICES_HUMAN.schedule_recurring,
              schedule_retry: TOOL_PRICES_HUMAN.schedule_retry,
              schedule_expiration: TOOL_PRICES_HUMAN.schedule_expiration,
              schedule_monitor: TOOL_PRICES_HUMAN.schedule_monitor,
              schedule_verification: TOOL_PRICES_HUMAN.schedule_verification,
              schedule_workflow: TOOL_PRICES_HUMAN.schedule_workflow,
              reschedule_job: TOOL_PRICES_HUMAN.reschedule_job,
              resume_job: TOOL_PRICES_HUMAN.resume_job,
              attest_execution: TOOL_PRICES_HUMAN.attest_execution,
            },
            deliveryModes: {
              poll: "Always works. The baseline and the fallback for the other modes.",
              webhook: "HTTPS POST signed with an EIP-191 header so the buyer can verify origin. Retried on the ladder, then falls back to poll.",
              a2a: "Not yet proven in Phase 1 — not advertised until a real firing has been observed arriving.",
            },
            guarantees: {
              delivery: "At-least-once, never exactly-once. Every firing carries an idempotencyKey; the buyer deduplicates.",
              timing: "A job never fires early (except schedule_expiration lead time) and fires within a published skew window of its due time.",
              durability: "If the ticker is down, jobs fire late; they are not lost and not silently dropped. A firing that missed its window is marked late with the delay in the receipt.",
              terminal: "A cancelled or expired job is a terminal state with a receipt. Silence is never an outcome.",
            },
            stoppingIsFree: "pause_job and cancel_job are free. Paying buys the future; stopping is always free.",
            signer: getSignerAddress(),
            signerAvailable: signerAvailable(),
            lastTickAt,
            tickerFresh: lastTickAt > 0,
          });
        }
      );

      // ── FREE 2: estimate_cost ────────────────────────────────────────────
      server.registerTool(
        "estimate_cost",
        {
          title: "Exact atomic and human price for any paid tool",
          description:
            "Exact price in USDT0 for a paid tool. Never invents an answer: unknown tools return no price. Free.",
          inputSchema: {
            toolName: z.string().optional().describe("Paid tool name, e.g. schedule_monitor."),
          },
        },
        async ({ toolName }) => {
          if (!toolName) {
            return textResult({
              ok: false,
              usage: "Provide `toolName`. Returns the exact USDT0 price. Prices: " +
                Object.entries(TOOL_PRICES_HUMAN).map(([t, p]) => `${t} ${p}`).join(", ") + ".",
              note: "Free. Estimate before you pay — validate_schedule is also free.",
            });
          }
          const atomic = TOOL_PRICES_ATOMIC[toolName];
          if (atomic === undefined) {
            return textResult({
              ok: false,
              toolName,
              error: `unknown tool "${toolName}" — no price exists for it`,
              note: "estimate_cost never invents an answer.",
            });
          }
          return textResult({
            ok: true,
            toolName,
            paid: true,
            atomic,
            price: TOOL_PRICES_HUMAN[toolName],
            chain: "eip155:196",
            asset: "USDT0",
          });
        }
      );

      // ── FREE 3: validate_schedule ────────────────────────────────────────
      server.registerTool(
        "validate_schedule",
        {
          title: "Parse and validate a schedule spec without creating anything",
          description:
            "Validates any schedule spec — cron syntax, timezone, lead time, backoff ladder, monitor target, workflow steps — before you pay. A monitor with no target, or an expiration with no deadline, is rejected here before payment. Free.",
          inputSchema: {
            scheduleSpec: z.any().optional().describe("The schedule spec to validate."),
          },
        },
        async ({ scheduleSpec }) => {
          if (scheduleSpec === undefined) {
            return textResult({
              ok: false,
              usage: "Provide `scheduleSpec` (e.g. { kind: \"recurring\", interval: \"1h\" } or { kind: \"cron\", ... }). Validates cron syntax, timezone, lead time, backoff ladder, workflow steps. Creates nothing.",
              note: "Free. A monitor with no target, or an expiration with no deadline, is rejected here before payment.",
            });
          }
          try {
            const spec: ParsedSpec = parseScheduleSpec(coerce(scheduleSpec));
            const now = Date.now();
            const firstFire = computeFirstFire(spec, now);
            return textResult({
              ok: true,
              kind: spec.kind,
              parsed: spec,
              firstFireAt: firstFire,
              firesIn: firstFire - now,
              warning: firstFire - now < 60_000 ? "fires within the next minute" : undefined,
              note: "Validated. Nothing was created and nothing was charged.",
            });
          } catch (err) {
            return validationError(`invalid schedule: ${(err as Error).message}`);
          }
        }
      );

      // ── FREE 4: verify_receipt ───────────────────────────────────────────
      server.registerTool(
        "verify_receipt",
        {
          title: "Verify the EIP-191 signature and digest of an execution receipt",
          description:
            "Verification is never charged; it is the product's own trust claim. Returns digestValid, signatureValid and the recovered signer. Free.",
          inputSchema: {
            receipt: z.any().optional().describe("The receipt object from a firing."),
            digest: z.string().optional().describe("The receipt digest (0x + 64 hex)."),
            signature: z.string().optional().describe("The EIP-191 signature (0x + 130 hex)."),
          },
        },
        async ({ receipt, digest, signature }) => {
          if (!receipt || !digest || !signature) {
            return textResult({
              ok: false,
              usage: "Provide `receipt` + `digest` + `signature` (all three, as returned by a firing). Returns digestValid + signatureValid.",
              note: "Free. Verification is never charged.",
            });
          }
          try {
            const verified = await verifyReceipt(
              coerce(receipt) as import("./lib/cadence/receipt.js").Receipt,
              digest as `0x${string}`,
              signature as `0x${string}`,
              process.env.CADENCE_SIGNER_PRIVATE_KEY ?? ""
            );
            return textResult({
              ok: verified.digestValid && verified.signatureValid,
              digestValid: verified.digestValid,
              signatureValid: verified.signatureValid,
              expectedSigner: verified.expectedSigner,
              recoveredSigner: verified.recoveredSigner,
            });
          } catch (err) {
            return validationError(`cannot verify: ${(err as Error).message}`);
          }
        }
      );

      // ── FREE 5: get_job ──────────────────────────────────────────────────
      server.registerTool(
        "get_job",
        {
          title: "Status and firing history for a job, by jobId or pollKey",
          description:
            "Returns the job's state, schedule, next fire, and full firing history with receipts. Lookup by jobId or by pollKey (all jobs under that key). Free.",
          inputSchema: {
            jobId: z.string().optional().describe("The job id."),
            pollKey: z.string().optional().describe("The poll key; returns every job and delivery under it."),
          },
        },
        async ({ jobId, pollKey }) => {
          if (!jobId && !pollKey) {
            return textResult({
              ok: false,
              usage: "Provide `jobId` or `pollKey`. Returns state, schedule, next fire, firing history with receipts.",
              note: "Free.",
            });
          }
          if (jobId) {
            const job = runtime.store.getJob(jobId);
            if (!job) {
              return textResult({ ok: false, error: `job "${jobId}" not found` });
            }
            return textResult({
              ok: true,
              job: serializeJob(job),
              firings: runtime.store.getFirings(jobId).map(serializeFiring),
              pendingDeliveries: runtime.store.pollDue(job.poll_key).length,
            });
          }
          const jobs = runtime.store.listJobs().filter((j) => j.poll_key === pollKey);
          return textResult({
            ok: true,
            count: jobs.length,
            jobs: jobs.map((j) => serializeJob(j)),
            deliveries: runtime.store.pollDue(pollKey!).map((d) => ({
              id: d.id,
              jobId: d.job_id,
              idempotencyKey: d.idempotency_key,
              state: d.state,
              payload: JSON.parse(d.payload),
              receipt: JSON.parse(d.receipt),
              createdAt: d.created_at,
            })),
          });
        }
      );

      // ── FREE 6: poll_due ─────────────────────────────────────────────────
      server.registerTool(
        "poll_due",
        {
          title: "The delivery baseline: everything due and unacknowledged for a pollKey",
          description:
            "Returns every pending delivery for the pollKey (payload + idempotencyKey + signed receipt) and accepts acknowledgements via `ack`. Delivery of work already paid for is never charged twice. Free.",
          inputSchema: {
            pollKey: z.string().optional().describe("Your poll key."),
            ack: z.array(z.string()).optional().describe("Idempotency keys to acknowledge."),
          },
        },
        async ({ pollKey, ack }) => {
          if (!pollKey) {
            return textResult({
              ok: false,
              usage: "Provide `pollKey`. Returns pending deliveries (payload + idempotencyKey + receipt); pass `ack` with idempotency keys to acknowledge.",
              note: "Free. Delivery of work already paid for must not be charged twice.",
            });
          }
          const acknowledged = ack && ack.length > 0 ? runtime.store.ackDeliveries(pollKey, ack) : 0;
          if (acknowledged > 0) {
            completeAckedRetryJobs(runtime, pollKey);
          }
          const pending = runtime.store.pollDue(pollKey);
          return textResult({
            ok: true,
            pollKey,
            pendingCount: pending.length,
            acknowledged,
            deliveries: pending.map((d) => ({
              id: d.id,
              jobId: d.job_id,
              idempotencyKey: d.idempotency_key,
              payload: JSON.parse(d.payload),
              receipt: JSON.parse(d.receipt),
              createdAt: d.created_at,
            })),
          });
        }
      );

      // ── FREE 7: pause_job ────────────────────────────────────────────────
      server.registerTool(
        "pause_job",
        {
          title: "Suspend a job or whole series without losing schedule, history or pollKey",
          description:
            "Reversible via resume_job. A paused job keeps its schedule and can come back with its history intact. Free — stopping is always free.",
          inputSchema: {
            jobId: z.string().optional().describe("The job id."),
          },
        },
        async ({ jobId }) => {
          if (!jobId) {
            return textResult({
              ok: false,
              usage: "Provide `jobId`. Pauses the job: keeps schedule, history and pollKey. Reversible via resume_job.",
              note: "Free. Stopping is always free.",
            });
          }
          const job = runtime.store.getJob(jobId);
          if (!job) {
            return textResult({ ok: false, error: `job "${jobId}" not found` });
          }
          if (job.state === "cancelled" || job.state === "completed") {
            return textResult({ ok: false, error: `job "${jobId}" is ${job.state} — cannot pause` });
          }
          runtime.store.pauseJob(jobId);
          return textResult({ ok: true, jobId, state: "paused", note: "Schedule, history and pollKey preserved. resume_job brings it back." });
        }
      );

      // ── FREE 8: cancel_job ───────────────────────────────────────────────
      server.registerTool(
        "cancel_job",
        {
          title: "Terminal stop for a job or series, with a final receipt",
          description:
            "Terminal and irreversible — a cancelled job is done and gets a closing receipt. Free — stopping is always free.",
          inputSchema: {
            jobId: z.string().optional().describe("The job id."),
          },
        },
        async ({ jobId }) => {
          if (!jobId) {
            return textResult({
              ok: false,
              usage: "Provide `jobId`. Terminal stop with a final receipt. Irreversible.",
              note: "Free. Stopping is always free.",
            });
          }
          const job = runtime.store.getJob(jobId);
          if (!job) {
            return textResult({ ok: false, error: `job "${jobId}" not found` });
          }
          if (job.state === "cancelled") {
            return textResult({ ok: true, jobId, state: "cancelled", note: "Already cancelled." });
          }
          let receipt = null;
          let receiptSigned = false;
          if (signerAvailable()) {
            try {
              const spec: ParsedSpec = JSON.parse(job.spec);
              const built = await buildReceipt({
                jobId,
                scheduleSpec: spec,
                scheduledFor: job.next_fire_at ?? Date.now(),
                firedAt: Date.now(),
                attempt: job.attempt + 1,
                deliveryMode: job.delivery_mode,
                deliveredTo: job.poll_key,
                payloadDigest: job.payload_digest,
                outcome: "cancelled",
                late: false,
              });
              receipt = { receipt: built.receipt, digest: built.digest, signature: built.signature };
              receiptSigned = true;
            } catch (err) {
              receipt = null;
              receiptSigned = false;
            }
          }
          runtime.store.cancelJob(jobId, JSON.stringify(receipt ?? { unsigned: true }));
          return textResult({
            ok: true,
            jobId,
            state: "cancelled",
            receipt,
            receiptSigned,
            note: receiptSigned ? undefined : "Cancelled, but the closing receipt could not be signed (CADENCE_SIGNER_PRIVATE_KEY unset).",
          });
        }
      );

      // ── PAID 1: schedule_job (0.005 USDT0) ───────────────────────────────
      server.registerTool(
        "schedule_job",
        {
          title: "One-shot: run at an absolute timestamp or after a delay",
          description:
            "Payload is opaque to Cadence and returned verbatim on firing. Delivered over poll (default) or webhook, with an EIP-191 receipt. Costs 0.005 USDT0. Paid.",
          inputSchema: {
            ...delaySchema,
            ...COMMON,
          },
        },
        async (params) => {
          const at = params?.at;
          const delay = params?.delay;
          if (at === undefined && delay === undefined) {
            return textResult({
              ok: false,
              usage: "Provide `at` (ISO 8601 or epoch ms) or `delay` (e.g. \"5m\"), plus `payload`, optional `deliveryMode`/`webhookUrl`/`pollKey`.",
              note: "Paid. Costs 0.005 USDT0.",
            });
          }
          return scheduleOne(runtime, { kind: "one_shot", at, delay }, params);
        }
      );

      // ── PAID 2: schedule_recurring (0.01 USDT0) ──────────────────────────
      server.registerTool(
        "schedule_recurring",
        {
          title: "Fixed interval or cron expression, with optional end date and max-fires cap",
          description:
            "Fires forever at the interval or cron until endDate or maxFires. Costs 0.01 USDT0. Paid.",
          inputSchema: {
            interval: z.string().optional().describe('Interval, e.g. "30m" or "1h".'),
            cron: z.string().optional().describe('Cron expression (5 or 6 fields), e.g. "*/15 * * * *".'),
            timezone: z.string().optional().describe("IANA timezone for the cron expression (default UTC)."),
            endDate: z.string().optional().describe("Stop firing at this ISO timestamp."),
            maxFires: z.number().int().optional().describe("Stop after this many firings."),
            ...COMMON,
          },
        },
        async (params) => {
          const { interval, cron, timezone, endDate, maxFires } = params ?? {};
          if (!interval && !cron) {
            return textResult({
              ok: false,
              usage: "Provide `interval` (e.g. \"1h\") or `cron` (e.g. \"*/15 * * * *\"), plus `payload`. Optional: timezone, endDate, maxFires.",
              note: "Paid. Costs 0.01 USDT0.",
            });
          }
          return scheduleOne(runtime, { kind: "recurring", interval, cron, timezone, endDate, maxFires }, params);
        }
      );

      // ── PAID 3: schedule_retry (0.01 USDT0) ──────────────────────────────
      server.registerTool(
        "schedule_retry",
        {
          title: "A backoff ladder that stops on the first acknowledged delivery",
          description:
            "e.g. backoff [\"1m\", \"10m\", \"1h\", \"6h\"]. Drives webhook delivery retries; with poll, fires on the ladder until acknowledged. Costs 0.01 USDT0. Paid.",
          inputSchema: {
            backoff: z.array(z.string()).optional().describe('Backoff ladder rungs, e.g. ["1m", "10m", "1h", "6h"].'),
            ...delaySchema,
            ...COMMON,
          },
        },
        async (params) => {
          const { backoff, at, delay } = params ?? {};
          if (!backoff || backoff.length === 0) {
            return textResult({
              ok: false,
              usage: "Provide `backoff` (rung list, e.g. [\"1m\", \"10m\", \"1h\"]), plus `payload`. Optional: at/delay.",
              note: "Paid. Costs 0.01 USDT0.",
            });
          }
          return scheduleOne(runtime, { kind: "retry", backoff, at, delay }, params);
        }
      );

      // ── PAID 4: schedule_expiration (0.01 USDT0) ─────────────────────────
      server.registerTool(
        "schedule_expiration",
        {
          title: "Watch a deadline and fire before it lapses, with a configurable lead time",
          description:
            "Built for x402 challenge expiry, escrow windows, subscription renewals. Fires at deadline minus leadTime. Costs 0.01 USDT0. Paid.",
          inputSchema: {
            deadline: z.string().optional().describe("The deadline (ISO 8601 or epoch ms)."),
            leadTime: z.string().optional().describe('Lead time, e.g. "10m" (default 1h).'),
            ...COMMON,
          },
        },
        async (params) => {
          const { deadline, leadTime } = params ?? {};
          if (!deadline) {
            return textResult({
              ok: false,
              usage: "Provide `deadline` + optional `leadTime`. Fires at deadline minus lead time.",
              note: "Paid. Costs 0.01 USDT0.",
            });
          }
          return scheduleOne(runtime, { kind: "expiration", deadline, leadTime }, params);
        }
      );

      // ── PAID 5: schedule_monitor (0.02 USDT0) ────────────────────────────
      server.registerTool(
        "schedule_monitor",
        {
          title: "Recurring call to a target MCP tool plus a condition; fires only when it trips",
          description:
            "The engine behind recurring revenue for the rest of the fleet. Costs 0.02 USDT0. Paid.",
          inputSchema: {
            interval: z.string().optional().describe('Check interval, e.g. "6h".'),
            cron: z.string().optional().describe("Cron expression for checks."),
            timezone: z.string().optional().describe("IANA timezone for cron."),
            targetUrl: z.string().optional().describe("Target MCP endpoint (…/mcp)."),
            toolName: z.string().optional().describe("Target MCP tool to call."),
            arguments: z.record(z.string(), z.any()).optional().describe("Arguments for the target tool."),
            condition: z.any().optional().describe('Trip condition, e.g. { field: "/score", op: "lt", value: 60 }.'),
            ...COMMON,
          },
        },
        async (params) => {
          const { interval, cron, timezone, targetUrl, toolName, arguments: args, condition } = params ?? {};
          if (!interval && !cron) {
            return textResult({
              ok: false,
              usage: "Provide `interval` or `cron`, plus `targetUrl` + `toolName` + `condition` (fires only when the condition trips), plus `payload`.",
              note: "Paid. Costs 0.02 USDT0.",
            });
          }
          return scheduleOne(
            runtime,
            { kind: "monitor", interval, cron, timezone, targetUrl, toolName, arguments: args, condition },
            params
          );
        }
      );

      // ── PAID 6: schedule_verification (0.015 USDT0) ──────────────────────
      server.registerTool(
        "schedule_verification",
        {
          title: "Convenience wrapper over schedule_monitor pre-wired to EVIDIQ services",
          description:
            "Same shape as schedule_monitor. Presets for Core, Sentinel, Bastion land in Phase 3; until then provide targetUrl/toolName/condition directly. Costs 0.015 USDT0. Paid.",
          inputSchema: {
            interval: z.string().optional().describe('Check interval, e.g. "6h".'),
            cron: z.string().optional().describe("Cron expression for checks."),
            timezone: z.string().optional().describe("IANA timezone for cron."),
            preset: z.string().optional().describe("Phase 3: core | sentinel | bastion | circuit | redact. Not available yet."),
            targetUrl: z.string().optional().describe("Target MCP endpoint (…/mcp)."),
            toolName: z.string().optional().describe("Target MCP tool to call."),
            arguments: z.record(z.string(), z.any()).optional().describe("Arguments for the target tool."),
            condition: z.any().optional().describe("Trip condition."),
            ...COMMON,
          },
        },
        async (params) => {
          const { interval, cron, timezone, preset, targetUrl, toolName, arguments: args, condition } = params ?? {};
          if (preset) {
            return textResult({
              ok: false,
              error: `preset "${preset}" is not available yet — presets for core/sentinel/bastion land in Phase 3. Provide targetUrl + toolName + condition directly.`,
            });
          }
          if (!interval && !cron) {
            return textResult({
              ok: false,
              usage: "Provide `interval` or `cron`, plus `targetUrl` + `toolName` + `condition`. Presets land in Phase 3.",
              note: "Paid. Costs 0.015 USDT0.",
            });
          }
          return scheduleOne(
            runtime,
            { kind: "verification", interval, cron, timezone, targetUrl, toolName, arguments: args, condition },
            params
          );
        }
      );

      // ── PAID 7: schedule_workflow (0.03 USDT0) ───────────────────────────
      server.registerTool(
        "schedule_workflow",
        {
          title: "An ordered chain of steps, each with its own deadline",
          description:
            "A step that misses its deadline fires its escalation instead of silently stalling. Costs 0.03 USDT0. Paid.",
          inputSchema: {
            steps: z
              .array(
                z.object({
                  id: z.string().describe("Step id."),
                  description: z.string().describe("What this step is."),
                  deadline: z.string().describe("ISO 8601 deadline for this step."),
                  escalation: z.any().optional().describe("Payload delivered instead when the step fires past its deadline."),
                })
              )
              .optional()
              .describe("Ordered steps, each with its own deadline."),
            ...COMMON,
          },
        },
        async (params) => {
          const { steps } = params ?? {};
          if (!steps || steps.length === 0) {
            return textResult({
              ok: false,
              usage: "Provide `steps` ([{ id, description, deadline, escalation? }, …]), plus `payload`.",
              note: "Paid. Costs 0.03 USDT0.",
            });
          }
          return scheduleOne(runtime, { kind: "workflow", steps }, params);
        }
      );

      // ── PAID 8: reschedule_job (0.005 USDT0) ─────────────────────────────
      server.registerTool(
        "reschedule_job",
        {
          title: "Change the time, interval, backoff or payload of an existing job",
          description:
            "Keeps the job's history. Returns the updated job. Costs 0.005 USDT0. Paid.",
          inputSchema: {
            jobId: z.string().optional().describe("The job id."),
            at: z.string().or(z.number()).optional().describe("New absolute time."),
            delay: z.string().optional().describe("New delay."),
            interval: z.string().optional().describe("New interval (recurring)."),
            cron: z.string().optional().describe("New cron expression."),
            backoff: z.array(z.string()).optional().describe("New backoff ladder."),
            payload: z.any().optional().describe("New payload."),
            deliveryMode: COMMON.deliveryMode,
            webhookUrl: COMMON.webhookUrl,
            pollKey: COMMON.pollKey,
          },
        },
        async (params) => {
          const { jobId, at, delay, interval, cron, backoff, payload } = params ?? {};
          if (!jobId) {
            return textResult({
              ok: false,
              usage: "Provide `jobId` plus at least one of: at/delay/interval/cron/backoff/payload.",
              note: "Paid. Costs 0.005 USDT0.",
            });
          }
          const job = runtime.store.getJob(jobId);
          if (!job) {
            return textResult({ ok: false, error: `job "${jobId}" not found` });
          }
          if (job.state === "cancelled") {
            return textResult({ ok: false, error: `job "${jobId}" is cancelled — terminal` });
          }
          const changes: Record<string, unknown> = {};
          if (at !== undefined) changes.at = at;
          if (delay !== undefined) changes.delay = delay;
          if (interval !== undefined) changes.interval = interval;
          if (cron !== undefined) changes.cron = cron;
          if (backoff !== undefined) changes.backoff = backoff;
          if (payload !== undefined) changes.payload = payload;
          if (Object.keys(changes).length === 0) {
            return textResult({
              ok: false,
              usage: "Provide `jobId` plus at least one change (at/delay/interval/cron/backoff/payload).",
              note: "Paid. Costs 0.005 USDT0.",
            });
          }
          const current: ParsedSpec = JSON.parse(job.spec);
          const specChanges = normalizeSpecFields(changes);
          delete specChanges.payload;
          const merged = { ...current, ...specChanges };
          if ("delay" in changes && "at" in merged) delete (merged as Record<string, unknown>).at;
          if ("at" in changes && "delay" in merged) delete (merged as Record<string, unknown>).delay;
          if ("interval" in changes && "cron" in merged) delete (merged as Record<string, unknown>).cron;
          if ("cron" in changes && "interval" in merged) delete (merged as Record<string, unknown>).interval;
          if ("backoff" in changes) delete (merged as Record<string, unknown>).backoffMs;
          let next: ParsedSpec;
          try {
            next = parseScheduleSpec(merged);
          } catch (err) {
            return validationError(`invalid reschedule: ${(err as Error).message}`);
          }
          const now = Date.now();
          const nextFireAt = computeFirstFire(next, now);
          runtime.store.updateJobState(jobId, {
            spec: JSON.stringify(next),
            next_fire_at: nextFireAt,
            payload: changes.payload !== undefined ? payloadString(coerce(changes.payload)) : job.payload,
            payload_digest: changes.payload !== undefined ? digestOf(payloadString(coerce(changes.payload))) : job.payload_digest,
            state: "active",
          });
          const updated = runtime.store.getJob(jobId)!;
          return textResult({
            ok: true,
            jobId,
            state: updated.state,
            nextFireAt,
            spec: next,
            note: "History and pollKey preserved.",
          });
        }
      );

      // ── PAID 9: resume_job (0.005 USDT0) ─────────────────────────────────
      server.registerTool(
        "resume_job",
        {
          title: "Return a paused job or series to active, keeping history and pollKey",
          description:
            "Priced because it puts future work back on the clock. Costs 0.005 USDT0. Paid.",
          inputSchema: {
            jobId: z.string().optional().describe("The job id."),
          },
        },
        async ({ jobId }) => {
          if (!jobId) {
            return textResult({
              ok: false,
              usage: "Provide `jobId`. Resumes a paused job: keeps history and pollKey.",
              note: "Paid. Costs 0.005 USDT0.",
            });
          }
          const job = runtime.store.getJob(jobId);
          if (!job) {
            return textResult({ ok: false, error: `job "${jobId}" not found` });
          }
          if (job.state !== "paused") {
            return textResult({ ok: false, error: `job "${jobId}" is ${job.state} — only paused jobs can be resumed` });
          }
          const spec: ParsedSpec = JSON.parse(job.spec);
          const now = Date.now();
          const nextFireAt = computeResumeFire(spec, now, job.fires_so_far);
          runtime.store.resumeJob(jobId, nextFireAt);
          return textResult({ ok: true, jobId, state: "active", nextFireAt, note: "History and pollKey preserved." });
        }
      );

      // ── PAID 10: attest_execution (0.03 USDT0) ───────────────────────────
      server.registerTool(
        "attest_execution",
        {
          title: "Signed bundle of a job's whole firing history",
          description:
            "EIP-191 signed attestation over the job's entire firing history — scheduled at, fired at, delivery mode, attempts, acknowledgements. 0G anchoring is best effort. Costs 0.03 USDT0. Paid.",
          inputSchema: {
            jobId: z.string().optional().describe("The job id."),
          },
        },
        async ({ jobId }) => {
          if (!jobId) {
            return textResult({
              ok: false,
              usage: "Provide `jobId`. Returns a signed bundle of the job's whole firing history.",
              note: "Paid. Costs 0.03 USDT0.",
            });
          }
          const job = runtime.store.getJob(jobId);
          if (!job) {
            return textResult({ ok: false, error: `job "${jobId}" not found` });
          }
          const firings = runtime.store.getFirings(jobId).map(serializeFiring);
          const attestationPayload = {
            jobId,
            kind: job.kind,
            state: job.state,
            firesSoFar: job.fires_so_far,
            spec: JSON.parse(job.spec),
            history: firings,
          };
          const signerKey = process.env.CADENCE_SIGNER_PRIVATE_KEY;
          if (!signerKey) {
            return textResult({
              ok: false,
              error: "CADENCE_SIGNER_PRIVATE_KEY not set — cannot sign the attestation; there is no fallback key.",
              job: serializeJob(job),
              firings,
            });
          }
          const signed = await signObject(attestationPayload);
          return textResult({
            ok: true,
            jobId,
            attestation: attestationPayload,
            digest: signed.digest,
            signature: signed.signature,
            anchoring: { status: "pending", note: "0G anchoring is best effort in Phase 1." },
          });
        }
      );
    },
    {
      instructions: INSTRUCTIONS,
      capabilities: { tools: {} },
    },
    {
      basePath: "",
      maxDuration: 300,
      verboseLogs: false,
    }
  );

  return handler;
}

function serializeJob(job: import("./lib/cadence/store.js").JobRow) {
  return {
    id: job.id,
    kind: job.kind,
    state: job.state,
    spec: JSON.parse(job.spec),
    nextFireAt: job.next_fire_at,
    attempt: job.attempt,
    firesSoFar: job.fires_so_far,
    payload: JSON.parse(job.payload),
    deliveryMode: job.delivery_mode,
    deliveredTo: job.delivered_to,
    pollKey: job.poll_key,
    lastError: job.last_error,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  };
}

function serializeFiring(f: import("./lib/cadence/store.js").FiringRecord) {
  return {
    id: f.id,
    scheduledFor: f.scheduled_for,
    firedAt: f.fired_at,
    attempt: f.attempt,
    outcome: f.outcome,
    late: f.late === 1,
    idempotencyKey: f.idempotency_key,
    payload: JSON.parse(f.payload),
    receipt: JSON.parse(f.receipt),
  };
}

interface ScheduleArgs {
  kind: string;
  at?: unknown;
  delay?: unknown;
  interval?: unknown;
  cron?: unknown;
  timezone?: unknown;
  endDate?: unknown;
  maxFires?: unknown;
  backoff?: unknown;
  deadline?: unknown;
  leadTime?: unknown;
  targetUrl?: unknown;
  toolName?: unknown;
  arguments?: unknown;
  condition?: unknown;
  steps?: unknown;
}

function normalizeSpecFields(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    if (v === "") continue;
    out[k] = v;
  }
  return out;
}

async function scheduleOne(runtime: CadenceRuntime, args: ScheduleArgs, params: any) {
  const deliveryMode = params?.deliveryMode ?? "poll";
  const webhookUrl = params?.webhookUrl;
  const pollKey = params?.pollKey ?? newId("pk");

  if (deliveryMode === "webhook" && !webhookUrl) {
    return textResult({ ok: false, error: "deliveryMode=webhook requires `webhookUrl`" });
  }
  if (deliveryMode === "a2a") {
    return textResult({
      ok: false,
      error: "a2a delivery is not available yet — it is not advertised until a real firing has been observed arriving (Phase 1 gate).",
    });
  }

  let spec: ParsedSpec;
  try {
    const coercedArgs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args as unknown as Record<string, unknown>)) {
      coercedArgs[k] = coerce(v);
    }
    spec = parseScheduleSpec({ ...normalizeSpecFields(coercedArgs), kind: args.kind });
  } catch (err) {
    return validationError(`invalid schedule: ${(err as Error).message}`);
  }

  const payload = payloadString(coerce(params?.payload));
  const jobId = newId("j");
  runtime.store.createJob({
    id: jobId,
    spec,
    payload,
    payloadDigest: digestOf(payload),
    deliveryMode,
    deliveredTo: webhookUrl ?? "",
    pollKey,
    firstFireAt: computeFirstFire(spec, Date.now()),
  });
  return textResult({
    ok: true,
    jobId,
    pollKey,
    kind: spec.kind,
    spec,
    nextFireAt: computeFirstFire(spec, Date.now()),
    deliveryMode,
    note: `Scheduled. Delivery over ${deliveryMode}; receipts are EIP-191 signed. poll_due with "${pollKey}" returns pending deliveries.`,
  });
}

function completeAckedRetryJobs(runtime: CadenceRuntime, pollKey: string): void {
  const jobs = runtime.store.listJobs().filter((j) => j.poll_key === pollKey && j.kind === "retry");
  for (const job of jobs) {
    if (!runtime.store.hasPendingDeliveries(job.id)) {
      runtime.store.updateJobState(job.id, { state: "completed", next_fire_at: null });
    }
  }
}

async function signObject(payload: unknown) {
  const { jcs } = await import("./lib/cadence/jcs.js");
  const { signMessage } = await import("viem/accounts");
  const { getSignerPrivateKey } = await import("./lib/cadence/receipt.js");
  const canonical = jcs(payload);
  const digest = `0x${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
  const signature = await signMessage({ privateKey: getSignerPrivateKey(), message: { raw: digest as `0x${string}` } });
  return { digest, signature };
}
