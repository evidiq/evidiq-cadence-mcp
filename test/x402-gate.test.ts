import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { handleX402Gate, isPaidTool, build402Response } from "../lib/x402/gate.js";
import { parsePaymentHeader } from "../lib/x402/verify.js";
import { TOOL_PRICES_ATOMIC, TOOL_PRICES_HUMAN, FREE_TOOL_NAMES } from "../lib/x402/challenge.js";

const PAYLOAD = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "schedule_job", arguments: { at: "2026-08-02T01:00:00.000Z", payload: {} } },
});

const PAID_PAYLOAD = PAYLOAD.replace("schedule_job", "schedule_recurring");
const FREE_PAYLOAD = PAYLOAD.replace("schedule_job", "cadence_capabilities");

function clearBypass() {
  delete process.env.CADENCE_X402_BYPASS;
  delete process.env.X402_BYPASS;
}

const okHandler = async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }), {
  status: 200,
  headers: { "Content-Type": "application/json" },
});

function post(body: string, headers: Record<string, string> = {}) {
  return new Request("https://mcp.evidiq.dev/cadence/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

beforeEach(clearBypass);
afterEach(clearBypass);

describe("tool pricing contract (PLAN §3)", () => {
  it("has exactly ten paid tools with the frozen prices", () => {
    expect(Object.keys(TOOL_PRICES_ATOMIC).sort()).toEqual([
      "attest_execution",
      "reschedule_job",
      "resume_job",
      "schedule_expiration",
      "schedule_job",
      "schedule_monitor",
      "schedule_recurring",
      "schedule_retry",
      "schedule_verification",
      "schedule_workflow",
    ]);
    expect(TOOL_PRICES_HUMAN).toMatchObject({
      schedule_job: "0.005 USDT0",
      schedule_recurring: "0.01 USDT0",
      schedule_retry: "0.01 USDT0",
      schedule_expiration: "0.01 USDT0",
      schedule_monitor: "0.02 USDT0",
      schedule_verification: "0.015 USDT0",
      schedule_workflow: "0.03 USDT0",
      reschedule_job: "0.005 USDT0",
      resume_job: "0.005 USDT0",
      attest_execution: "0.03 USDT0",
    });
    for (const name of Object.keys(TOOL_PRICES_ATOMIC)) {
      expect(isPaidTool(name)).toBe(true);
    }
  });

  it("has exactly eight free tools, all lifecycle-stopping", () => {
    expect([...FREE_TOOL_NAMES].sort()).toEqual([
      "cadence_capabilities",
      "cancel_job",
      "estimate_cost",
      "get_job",
      "pause_job",
      "poll_due",
      "validate_schedule",
      "verify_receipt",
    ]);
    for (const name of FREE_TOOL_NAMES) {
      expect(isPaidTool(name)).toBe(false);
    }
  });
});

describe("parsePaymentHeader — three accepted shapes", () => {
  const token = Buffer.from(JSON.stringify({ scheme: "exact" })).toString("base64");

  it("accepts payment-signature", () => {
    expect(parsePaymentHeader({ "payment-signature": token })).toBe(token);
    expect(parsePaymentHeader({ "Payment-Signature": token })).toBe(token);
  });

  it("accepts Authorization: Payment <base64>", () => {
    expect(parsePaymentHeader({ authorization: `Payment ${token}` })).toBe(token);
    expect(parsePaymentHeader({ authorization: `payment ${token}` })).toBe(token);
  });

  it("accepts X-PAYMENT", () => {
    expect(parsePaymentHeader({ "x-payment": token })).toBe(token);
  });

  it("returns null when absent or empty", () => {
    expect(parsePaymentHeader({})).toBeNull();
    expect(parsePaymentHeader({ authorization: "Bearer abc" })).toBeNull();
    expect(parsePaymentHeader({ "payment-signature": "" })).toBeNull();
    expect(parsePaymentHeader({ "x-payment": [] })).toBeNull();
  });
});

describe("gate structural rules (every phase)", () => {
  it("HEAD /mcp answers 402 fast with no body", async () => {
    const req = new Request("https://mcp.evidiq.dev/cadence/mcp", { method: "HEAD" });
    const start = Date.now();
    const res = await handleX402Gate(req, okHandler);
    expect(res.status).toBe(402);
    expect(await res.text()).toBe("");
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("POST without application/json content-type → 415", async () => {
    const req = post(PAYLOAD, { "content-type": "text/plain" });
    const res = await handleX402Gate(req, okHandler);
    expect(res.status).toBe(415);
  });

  it("empty POST body → 402 challenge, never forwarded", async () => {
    let forwarded = false;
    const res = await handleX402Gate(post(""), async () => {
      forwarded = true;
      return okHandler();
    });
    expect(res.status).toBe(402);
    expect(forwarded).toBe(false);
    const json = await res.json();
    expect(json.x402Version).toBe(2);
  });

  it("unparseable POST body → 402 challenge", async () => {
    const res = await handleX402Gate(post("not json {"), okHandler);
    expect(res.status).toBe(402);
  });

  it("the 402 challenge carries the frozen x402 contract and no WWW-Authenticate", async () => {
    const res = await handleX402Gate(post(PAYLOAD), okHandler);
    expect(res.status).toBe(402);
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect(res.headers.get("payment-required")).toBeTruthy();
    expect(res.headers.get("x-payment-required")).toBeTruthy();
    const challenge = await res.json();
    expect(challenge.x402Version).toBe(2);
    expect(challenge.accepts[0].scheme).toBe("exact");
    expect(challenge.accepts[0].network).toBe("eip155:196");
    expect(challenge.accepts[0].asset).toBe("0x779ded0c9e1022225f8e0630b35a9b54be713736");
    expect(challenge.accepts[0].payTo).toBe("0x2a8efe3093278bb4bd3b2d9c7b5ba992ca4fc9b0");
  });
});

describe("gate with bypass disabled", () => {
  it("unpaid paid tool → 402", async () => {
    const res = await handleX402Gate(post(PAID_PAYLOAD), okHandler);
    expect(res.status).toBe(402);
  });

  it("free tool → forwarded", async () => {
    const res = await handleX402Gate(post(FREE_PAYLOAD), okHandler);
    expect(res.status).toBe(200);
  });

  it("paid tool with a fake payment header → 402 settlement failure", async () => {
    const token = Buffer.from(JSON.stringify({ scheme: "exact" })).toString("base64");
    const res = await handleX402Gate(post(PAID_PAYLOAD, { "payment-signature": token }), okHandler);
    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.error.message).toMatch(/settlement failed/i);
  });
});

describe("gate with bypass enabled (Phase 1)", () => {
  it("CADENCE_X402_BYPASS=1 lets paid tools through", async () => {
    process.env.CADENCE_X402_BYPASS = "1";
    const res = await handleX402Gate(post(PAID_PAYLOAD), okHandler);
    expect(res.status).toBe(200);
  });

  it("X402_BYPASS=1 also lets paid tools through", async () => {
    process.env.X402_BYPASS = "1";
    const res = await handleX402Gate(post(PAID_PAYLOAD), okHandler);
    expect(res.status).toBe(200);
  });

  it("GET /mcp answers 200 with a bypass note", async () => {
    process.env.X402_BYPASS = "1";
    const req = new Request("https://mcp.evidiq.dev/cadence/mcp", { method: "GET" });
    const res = await handleX402Gate(req, okHandler);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.service).toBe("evidiq-cadence-mcp");
    expect(json.x402).toBe("bypassed");
  });

  it("empty POST still 402s even in bypass", async () => {
    process.env.X402_BYPASS = "1";
    const res = await handleX402Gate(post(""), okHandler);
    expect(res.status).toBe(402);
  });
});

describe("build402Response", () => {
  it("encodes the challenge in both payment headers", () => {
    const res = build402Response("schedule_workflow");
    const header = res.headers.get("payment-required")!;
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
    expect(decoded.accepts[0].amount).toBe("30000");
    expect(decoded.resource.url).toBe("https://mcp.evidiq.dev/cadence/mcp");
  });
});
