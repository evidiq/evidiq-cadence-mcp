import { describe, it, expect } from "vitest";
import { extractPointer, evaluateCondition, buildTargetCall } from "../lib/cadence/monitor.js";
import { parseScheduleSpec } from "../lib/cadence/schedule.js";

const NOW = Date.parse("2026-08-02T00:00:00.000Z");

describe("extractPointer", () => {
  const doc = { score: 72, tags: ["core", "verified"], meta: { owner: { id: "0xabc" } }, flat: null };

  it("walks nested paths and arrays", () => {
    expect(extractPointer(doc, "/score")).toBe(72);
    expect(extractPointer(doc, "/tags/0")).toBe("core");
    expect(extractPointer(doc, "/meta/owner/id")).toBe("0xabc");
    expect(extractPointer(doc, "/flat")).toBeNull();
  });

  it("root pointer returns the document, missing path undefined", () => {
    expect(extractPointer(doc, "/")).toEqual(doc);
    expect(extractPointer(doc, "/nope")).toBeUndefined();
    expect(extractPointer(doc, "/meta/owner/address")).toBeUndefined();
  });
});

describe("evaluateCondition", () => {
  it("numeric ops gt/gte/lt/lte", () => {
    expect(evaluateCondition({ field: "/score", op: "gt", value: 70 }, { score: 72 })).toBe(true);
    expect(evaluateCondition({ field: "/score", op: "gt", value: 72 }, { score: 72 })).toBe(false);
    expect(evaluateCondition({ field: "/score", op: "gte", value: 72 }, { score: 72 })).toBe(true);
    expect(evaluateCondition({ field: "/score", op: "lt", value: 72 }, { score: 72 })).toBe(false);
    expect(evaluateCondition({ field: "/score", op: "lte", value: 72 }, { score: 72 })).toBe(true);
  });

  it("eq/neq with deep equality", () => {
    expect(evaluateCondition({ field: "/owner", op: "eq", value: { id: "0xabc" } }, { owner: { id: "0xabc" } })).toBe(true);
    expect(evaluateCondition({ field: "/owner", op: "neq", value: { id: "0xabc" } }, { owner: { id: "0xdef" } })).toBe(true);
  });

  it("contains on arrays, strings and objects", () => {
    expect(evaluateCondition({ field: "/tags", op: "contains", value: "verified" }, { tags: ["core", "verified"] })).toBe(true);
    expect(evaluateCondition({ field: "/tags", op: "contains", value: "banned" }, { tags: ["core", "verified"] })).toBe(false);
    expect(evaluateCondition({ field: "/text", op: "contains", value: "low" }, { text: "score is low" })).toBe(true);
    expect(evaluateCondition({ field: "/meta", op: "contains", value: "owner" }, { meta: { owner: 1 } })).toBe(true);
  });

  it("exists / not_exists", () => {
    expect(evaluateCondition({ field: "/score", op: "exists" }, { score: 1 })).toBe(true);
    expect(evaluateCondition({ field: "/missing", op: "exists" }, { score: 1 })).toBe(false);
    expect(evaluateCondition({ field: "/missing", op: "not_exists" }, { score: 1 })).toBe(true);
  });

  it("a missing field never trips gt", () => {
    expect(evaluateCondition({ field: "/missing", op: "gt", value: 10 }, { score: 1 })).toBe(false);
  });
});

describe("buildTargetCall", () => {
  it("builds a JSON-RPC tools/call request", () => {
    const spec = parseScheduleSpec(
      { kind: "monitor", interval: "1h", targetUrl: "https://core.evidiq.dev/mcp", toolName: "get_trust_score", arguments: { agentId: "a1" }, condition: { field: "/score", op: "lt", value: 60 } },
      NOW
    );
    const req = buildTargetCall(spec);
    expect(req.url).toBe("https://core.evidiq.dev/mcp");
    expect(JSON.parse(req.body).method).toBe("tools/call");
    expect(JSON.parse(req.body).params).toEqual({ name: "get_trust_score", arguments: { agentId: "a1" } });
  });
});
