import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { jcs } from "../lib/cadence/jcs.js";
import {
  buildReceipt,
  verifyReceipt,
  getSignerPrivateKey,
  FLEET_SIGNER_ADDRESS,
  RECEIPT_FIELDS,
} from "../lib/cadence/receipt.js";

const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // anvil #0 — throwaway, test-only
const TEST_KEY_BARE = TEST_KEY.slice(2);

const SPEC = {
  kind: "one_shot",
  at: Date.parse("2026-08-02T01:00:00.000Z"),
};

const INPUT = {
  jobId: "job_123",
  scheduleSpec: SPEC,
  scheduledFor: Date.parse("2026-08-02T01:00:00.000Z"),
  firedAt: Date.parse("2026-08-02T01:00:02.000Z"),
  attempt: 1,
  deliveryMode: "poll",
  deliveredTo: "pollkey_abc",
  payloadDigest: "0x" + "ab".repeat(32),
  outcome: "fired",
  late: false,
};

function setKey(value: string | undefined) {
  if (value === undefined) delete process.env.CADENCE_SIGNER_PRIVATE_KEY;
  else process.env.CADENCE_SIGNER_PRIVATE_KEY = value;
}

beforeEach(() => setKey(TEST_KEY));
afterEach(() => setKey(undefined));

describe("jcs (RFC 8785)", () => {
  it("sorts object keys lexicographically in UTF-16 code unit order", () => {
    expect(jcs({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(jcs({ α: 2, Ω: 1 })).toBe('{"Ω":1,"α":2}');
  });

  it("handles arrays, null, booleans, numbers", () => {
    expect(jcs([1, "two", null])).toBe('[1,"two",null]');
    expect(jcs({ a: null, b: false, c: true })).toBe('{"a":null,"b":false,"c":true}');
    expect(jcs({ a: 1e10 })).toBe('{"a":10000000000}');
    expect(jcs({ a: 0.000001 })).toBe('{"a":0.000001}');
    expect(jcs({})).toBe("{}");
  });

  it("escapes strings the way JSON requires", () => {
    expect(jcs({ a: 'say "hi"\n' })).toBe('{"a":"say \\"hi\\"\\n"}');
    expect(jcs({ a: "\u0001" })).toBe('{"a":"\\u0001"}');
  });

  it("rejects non-finite numbers and undefined", () => {
    expect(() => jcs({ a: NaN })).toThrow();
    expect(() => jcs({ a: Infinity })).toThrow();
    expect(() => jcs(undefined as any)).toThrow();
  });
});

describe("receipt digest + signature", () => {
  it("signs with the configured key and recovers the signer", async () => {
    const { receipt, digest, signature } = await buildReceipt(INPUT);
    const verified = await verifyReceipt(receipt, digest, signature, getSignerPrivateKey());
    expect(verified.digestValid).toBe(true);
    expect(verified.signatureValid).toBe(true);
    expect(verified.digest).toBe(digest);
  });

  it("is deterministic: identical input yields identical digest and signature", async () => {
    const a = await buildReceipt(INPUT);
    const b = await buildReceipt(INPUT);
    expect(a.digest).toBe(b.digest);
    expect(a.signature).toBe(b.signature);
    expect(a.receipt).toEqual(b.receipt);
  });

  it("covers exactly the ten closed fields", async () => {
    const { receipt } = await buildReceipt(INPUT);
    expect(Object.keys(receipt).sort()).toEqual([...RECEIPT_FIELDS].sort());
    expect(RECEIPT_FIELDS).toHaveLength(10);
  });

  it("ignores extra input fields — the field set is closed", async () => {
    const withExtra = await buildReceipt({ ...INPUT, extra: "should-not-appear" });
    const clean = await buildReceipt(INPUT);
    expect(withExtra.receipt).toEqual(clean.receipt);
    expect(withExtra.digest).toBe(clean.digest);
  });

  it("accepts the key with or without the 0x prefix", async () => {
    const prefixed = await buildReceipt(INPUT);
    setKey(TEST_KEY_BARE);
    const bare = await buildReceipt(INPUT);
    expect(prefixed.digest).toBe(bare.digest);
    expect(prefixed.signature).toBe(bare.signature);
  });

  it("detects a tampered field", async () => {
    const { receipt, digest, signature } = await buildReceipt(INPUT);
    const tampered = await verifyReceipt({ ...receipt, firedAt: receipt.firedAt + 1 }, digest, signature, TEST_KEY);
    expect(tampered.digestValid).toBe(false);
    expect(tampered.signatureValid).toBe(false);
  });

  it("rejects a signature from another key", async () => {
    const { receipt, digest, signature } = await buildReceipt(INPUT);
    const otherKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // anvil #1 — throwaway
    const verified = await verifyReceipt(receipt, digest, signature, otherKey);
    expect(verified.digestValid).toBe(true);
    expect(verified.signatureValid).toBe(false);
  });

  it("throws when the signer key is unset — no fallback key exists", async () => {
    setKey(undefined);
    await expect(buildReceipt(INPUT)).rejects.toThrow(/CADENCE_SIGNER_PRIVATE_KEY/);
    expect(() => getSignerPrivateKey()).toThrow(/CADENCE_SIGNER_PRIVATE_KEY/);
  });

  it("throws on a malformed key value", async () => {
    setKey("0xnothex");
    await expect(buildReceipt(INPUT)).rejects.toThrow();
    setKey("abc");
    await expect(buildReceipt(INPUT)).rejects.toThrow();
  });

  it("the fleet signer constant is the documented address", () => {
    expect(FLEET_SIGNER_ADDRESS.toLowerCase()).toBe("0x8a3c7524aaed081825ac88ec7f4ccecfc583ee7d");
  });
});
