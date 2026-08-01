import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createCadenceServer } from "../server.js";
import { CadenceRuntime } from "../lib/cadence/runtime.js";
import { handleX402Gate } from "../lib/x402/gate.js";
import { FREE_TOOL_NAMES } from "../lib/x402/challenge.js";

const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // anvil #0 — throwaway, test-only

let runtime: CadenceRuntime;
let handler: ReturnType<typeof createCadenceServer>;
let gated: (req: Request) => Promise<Response>;

function setBypass(value: boolean) {
  if (value) {
    process.env.X402_BYPASS = "1";
  } else {
    delete process.env.X402_BYPASS;
  }
  delete process.env.CADENCE_X402_BYPASS;
}

function setKey(value: string | undefined) {
  if (value === undefined) delete process.env.CADENCE_SIGNER_PRIVATE_KEY;
  else process.env.CADENCE_SIGNER_PRIVATE_KEY = value;
}

beforeEach(() => {
  setBypass(true);
  setKey(TEST_KEY);
  runtime = new CadenceRuntime({ dbPath: ":memory:", autoStartTicker: false });
  handler = createCadenceServer(runtime);
  gated = (req) => handleX402Gate(req, handler);
});

afterEach(() => {
  runtime.close();
  setBypass(false);
  setKey(undefined);
});

function call(name: string, args: Record<string, unknown> = {}) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  return gated(
    new Request("https://mcp.evidiq.dev/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    })
  );
}

async function textResultOf(res: Response): Promise<{ status: number; body: unknown; toolText?: string }> {
  const body = await res.json();
  let toolText: string | undefined;
  const result = (body as any)?.result;
  if (Array.isArray(result?.content)) {
    const text = result.content.find((c: { type: string }) => c.type === "text") as { text: string } | undefined;
    if (text) toolText = text.text;
  }
  return { status: res.status, body, toolText };
}

describe("server surface", () => {
  it("tools/list returns all 18 tools", async () => {
    const res = await gated(
      new Request("https://mcp.evidiq.dev/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: { name: string }[] } };
    const names = body.result.tools.map((t) => t.name).sort();
    expect(names).toHaveLength(18);
    for (const free of FREE_TOOL_NAMES) expect(names).toContain(free);
  });

  it("unknown tool yields a usable error, not a crash", async () => {
    const { status, toolText } = await textResultOf(await call("not_a_tool"));
    expect(status).toBe(200);
    expect(toolText).toBeDefined();
  });

  it("bare {} input returns 200 usage, never -32602", async () => {
    const { status, toolText } = await textResultOf(await call("cadence_capabilities"));
    expect(status).toBe(200);
    expect(toolText).toBeDefined();
    const parsed = JSON.parse(toolText!) as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });

  it("HEAD without body does not hang and answers without a body", async () => {
    const res = await gated(new Request("https://mcp.evidiq.dev/mcp", { method: "HEAD" }));
    expect(res.status).toBe(402);
    expect(await res.text()).toBe("");
  });
});

describe("free tools (never charged)", () => {
  it("cadence_capabilities reports 18 tools and the frozen prices", async () => {
    const { status, toolText } = await textResultOf(await call("cadence_capabilities"));
    expect(status).toBe(200);
    const parsed = JSON.parse(toolText!) as { ok: boolean; tools: { tool: string; price: string }[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.tools).toHaveLength(18);
    const scheduleJob = parsed.tools.find((t) => t.tool === "schedule_job");
    expect(scheduleJob?.price).toBe("0.005 USDT0");
  });

  it("estimate_cost returns the exact price for a known tool", async () => {
    const { toolText } = await textResultOf(await call("estimate_cost", { toolName: "schedule_monitor" }));
    const parsed = JSON.parse(toolText!) as { ok: boolean; price: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.price).toBe("0.02 USDT0");
  });

  it("estimate_cost never invents a price for an unknown tool", async () => {
    const { toolText } = await textResultOf(await call("estimate_cost", { toolName: "nonsense" }));
    const parsed = JSON.parse(toolText!) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/unknown tool/);
  });

  it("accepts JSON-string nested params (OpenClaw glm serializes objects to strings)", async () => {
    const vs = await textResultOf(
      await call("validate_schedule", { scheduleSpec: JSON.stringify({ kind: "recurring", interval: "1h" }) })
    );
    expect((JSON.parse(vs.toolText!) as { ok: boolean }).ok).toBe(true);

    const mon = await textResultOf(
      await call("schedule_monitor", {
        interval: "1h",
        targetUrl: "https://mcp.evidiq.dev/methodology/mcp",
        toolName: "methodology_capabilities",
        condition: JSON.stringify({ field: "/ok", op: "eq", value: true }),
        payload: JSON.stringify({ mo: 1 }),
        pollKey: "stringy",
      })
    );
    expect((JSON.parse(mon.toolText!) as { ok: boolean }).ok).toBe(true);
    const stored = runtime.store.listJobs().find((j) => j.poll_key === "stringy")!;
    expect(JSON.parse(stored.spec).condition).toEqual({ field: "/ok", op: "eq", value: true });
    expect(JSON.parse(stored.payload)).toEqual({ mo: 1 });
  });

  it("validate_schedule accepts a valid recurring spec without creating anything", async () => {    const { toolText } = await textResultOf(
      await call("validate_schedule", { scheduleSpec: { kind: "recurring", interval: "1h" } })
    );
    const parsed = JSON.parse(toolText!) as { ok: boolean; kind: string; firstFireAt: number };
    expect(parsed.ok).toBe(true);
    expect(parsed.kind).toBe("recurring");
    expect(parsed.firstFireAt).toBeGreaterThan(0);
    expect(runtime.store.listJobs()).toHaveLength(0);
  });

  it("validate_schedule rejects a monitor with no target before payment", async () => {
    const { toolText } = await textResultOf(
      await call("validate_schedule", { scheduleSpec: { kind: "monitor", interval: "6h" } })
    );
    const parsed = JSON.parse(toolText!) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/target/);
  });

  it("validate_schedule rejects an expiration with no deadline", async () => {
    const { toolText } = await textResultOf(await call("validate_schedule", { scheduleSpec: { kind: "expiration" } }));
    const parsed = JSON.parse(toolText!) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/deadline/);
  });

  it("pause_job and cancel_job work without paying", async () => {
    const scheduled = await textResultOf(await call("schedule_job", { delay: "1h", payload: { x: 1 } }));
    const created = JSON.parse(scheduled.toolText!) as { jobId: string; pollKey: string };
    expect(created.ok).toBe(true);

    const paused = JSON.parse((await textResultOf(await call("pause_job", { jobId: created.jobId }))).toolText!) as {
      ok: boolean;
      state: string;
    };
    expect(paused.ok).toBe(true);
    expect(paused.state).toBe("paused");

    const cancelled = JSON.parse(
      (await textResultOf(await call("cancel_job", { jobId: created.jobId }))).toolText!
    ) as { ok: boolean; state: string; receipt: unknown };
    expect(cancelled.ok).toBe(true);
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.receipt).toBeTruthy();
  });
});

describe("paid tools under bypass", () => {
  it("schedule_job creates a poll job and it fires into poll_due", async () => {
    const scheduled = await textResultOf(await call("schedule_job", { delay: "1s", payload: { hello: "world" } }));
    const created = JSON.parse(scheduled.toolText!) as { ok: boolean; jobId: string; pollKey: string };
    expect(created.ok).toBe(true);
    expect(created.jobId).toMatch(/^j_/);

    await runtime.ticker.runTick();
    await new Promise((r) => setTimeout(r, 1100));
    await runtime.ticker.runTick();

    const polled = await textResultOf(await call("poll_due", { pollKey: created.pollKey }));
    const pollParsed = JSON.parse(polled.toolText!) as { ok: boolean; pendingCount: number; deliveries: unknown[] };
    expect(pollParsed.ok).toBe(true);
    expect(pollParsed.pendingCount).toBeGreaterThanOrEqual(1);
    const delivery = pollParsed.deliveries[0] as {
      idempotencyKey: string;
      payload: unknown;
      receipt: { digest: string; signature: string };
    };
    expect(delivery.payload).toEqual({ hello: "world" });
    expect(delivery.receipt.digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(delivery.receipt.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("schedule_recurring rejects missing interval/cron with usage", async () => {
    const { toolText } = await textResultOf(await call("schedule_recurring", { payload: {} }));
    const parsed = JSON.parse(toolText!) as { ok: boolean; usage: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.usage).toMatch(/interval|Interval/);
  });

  it("schedule_monitor requires interval or cron", async () => {
    const { toolText } = await textResultOf(
      await call("schedule_monitor", { targetUrl: "https://x", toolName: "t", condition: { field: "/v", op: "gt", value: 1 } })
    );
    const parsed = JSON.parse(toolText!) as { ok: boolean; usage: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.usage).toMatch(/interval|Interval/);
  });

  it("a2a delivery is refused with the Phase-1 gate message", async () => {
    const { toolText } = await textResultOf(await call("schedule_job", { delay: "1h", deliveryMode: "a2a", payload: {} }));
    const parsed = JSON.parse(toolText!) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/a2a delivery is not available yet/);
  });

  it("webhook mode without webhookUrl is rejected", async () => {
    const { toolText } = await textResultOf(await call("schedule_job", { delay: "1h", deliveryMode: "webhook", payload: {} }));
    const parsed = JSON.parse(toolText!) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/webhookUrl/);
  });

  it("reschedule_job changes the schedule and keeps history", async () => {
    const created = JSON.parse(
      (await textResultOf(await call("schedule_job", { delay: "1h", payload: { v: 1 } }))).toolText!
    ) as { jobId: string };
    const rescheduled = JSON.parse(
      (await textResultOf(await call("reschedule_job", { jobId: created.jobId, delay: "2h" }))).toolText!
    ) as { ok: boolean; nextFireAt: number };
    expect(rescheduled.ok).toBe(true);
    const job = runtime.store.getJob(created.jobId)!;
    const storedSpec = JSON.parse(job.spec) as { at: number };
    expect(storedSpec.at).toBeGreaterThanOrEqual(rescheduled.nextFireAt - 2000);
    expect(job.payload).toContain('"v":1');
  });

  it("resume_job refuses to resume a non-paused job", async () => {
    const created = JSON.parse(
      (await textResultOf(await call("schedule_job", { delay: "1h", payload: {} }))).toolText!
    ) as { jobId: string };
    const resumed = JSON.parse(
      (await textResultOf(await call("resume_job", { jobId: created.jobId }))).toolText!
    ) as { ok: boolean; error: string };
    expect(resumed.ok).toBe(false);
    expect(resumed.error).toMatch(/only paused jobs/);
  });

  it("attest_execution signs the firing history", async () => {
    const created = JSON.parse(
      (await textResultOf(await call("schedule_job", { delay: "1s", payload: { v: 1 } }))).toolText!
    ) as { jobId: string };
    await runtime.ticker.runTick();
    await new Promise((r) => setTimeout(r, 1100));
    await runtime.ticker.runTick();
    const attested = JSON.parse(
      (await textResultOf(await call("attest_execution", { jobId: created.jobId }))).toolText!
    ) as { ok: boolean; digest: string; signature: string; attestation: { history: unknown[] } };
    expect(attested.ok).toBe(true);
    expect(attested.digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(attested.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(attested.attestation.history.length).toBeGreaterThanOrEqual(1);
  });

  it("attest_execution signs with a bare (non-0x) private key like the VPS env file", async () => {
    setKey(TEST_KEY.slice(2));
    const created = JSON.parse(
      (await textResultOf(await call("schedule_job", { delay: "1s", payload: { v: 1 } }))).toolText!
    ) as { jobId: string };
    await runtime.ticker.runTick();
    await new Promise((r) => setTimeout(r, 1100));
    await runtime.ticker.runTick();
    const attested = JSON.parse(
      (await textResultOf(await call("attest_execution", { jobId: created.jobId }))).toolText!
    ) as { ok: boolean; digest: string; signature: string };
    expect(attested.ok).toBe(true);
    expect(attested.digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(attested.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("attest_execution stays a paid success when 0G anchoring is not configured (best effort)", async () => {
    delete process.env.OG_PRIVATE_KEY;
    delete process.env.OG_STORAGE_RPC;
    const created = JSON.parse(
      (await textResultOf(await call("schedule_job", { delay: "1s", payload: { v: 1 } }))).toolText!
    ) as { jobId: string };
    await runtime.ticker.runTick();
    await new Promise((r) => setTimeout(r, 1100));
    await runtime.ticker.runTick();
    const attested = JSON.parse(
      (await textResultOf(await call("attest_execution", { jobId: created.jobId }))).toolText!
    ) as {
      ok: boolean;
      digest: string;
      signature: string;
      anchoring: { status: string; reason?: string };
    };
    expect(attested.ok).toBe(true);
    expect(attested.digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(attested.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(attested.anchoring.status).toBe("failed");
    expect(attested.anchoring.reason).toMatch(/not configured/);
  });

  it("verify_receipt confirms a signed firing receipt", async () => {
    const created = JSON.parse(
      (await textResultOf(await call("schedule_job", { delay: "1s", payload: { v: 1 } }))).toolText!
    ) as { jobId: string; pollKey: string };
    await runtime.ticker.runTick();
    await new Promise((r) => setTimeout(r, 1100));
    await runtime.ticker.runTick();
    const polled = JSON.parse(
      (await textResultOf(await call("poll_due", { pollKey: created.pollKey }))).toolText!
    ) as { deliveries: { receipt: { receipt: unknown; digest: string; signature: string } }[] };
    const { receipt, digest, signature } = polled.deliveries[0].receipt;
    const verified = JSON.parse(
      (
        await textResultOf(await call("verify_receipt", { receipt, digest, signature }))
      ).toolText!
    ) as { ok: boolean; digestValid: boolean; signatureValid: boolean };
    expect(verified.ok).toBe(true);
    expect(verified.digestValid).toBe(true);
    expect(verified.signatureValid).toBe(true);
  });
});

describe("x402 gate enforcement", () => {
  it("paid tools answer 402 with the challenge when the gate is enforced", async () => {
    setBypass(false);
    const res = await call("schedule_job", { delay: "1h", payload: {} });
    expect(res.status).toBe(402);
    const challengeB64 = res.headers.get("payment-required");
    expect(challengeB64).toBeTruthy();
    const challenge = JSON.parse(Buffer.from(challengeB64!, "base64").toString("utf-8"));
    expect(challenge.accepts[0].scheme).toBe("exact");
    expect(challenge.accepts[0].network).toBe("eip155:196");
  });

  it("free tools answer 200 even when the gate is enforced", async () => {
    setBypass(false);
    const res = await call("cadence_capabilities");
    expect(res.status).toBe(200);
  });

  it("empty body is 402 at the gate and is never forwarded", async () => {
    setBypass(false);
    const res = await gated(
      new Request("https://mcp.evidiq.dev/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "",
      })
    );
    expect(res.status).toBe(402);
  });

  it("POST without JSON content-type answers 415", async () => {
    setBypass(false);
    const res = await gated(
      new Request("https://mcp.evidiq.dev/mcp", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "hello",
      })
    );
    expect(res.status).toBe(415);
  });
});
