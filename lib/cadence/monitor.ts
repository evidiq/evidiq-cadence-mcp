import type { Condition, ParsedSpec } from "./schedule.js";

export function extractPointer(doc: unknown, pointer: string): unknown {
  if (pointer === "/") return doc;
  const parts = pointer.split("/").filter((p) => p !== "");
  let cur: unknown = doc;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(part)) {
      cur = cur[Number(part)];
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function evaluateCondition(condition: Condition, result: unknown): boolean {
  const value = extractPointer(result, condition.field);
  if (value === undefined) {
    if (condition.op === "not_exists") return true;
    if (condition.op === "exists") return false;
    return false;
  }
  if (condition.op === "exists") return true;
  if (condition.op === "not_exists") return false;

  switch (condition.op) {
    case "gt":
      return typeof value === "number" && typeof condition.value === "number" && value > condition.value;
    case "gte":
      return typeof value === "number" && typeof condition.value === "number" && value >= condition.value;
    case "lt":
      return typeof value === "number" && typeof condition.value === "number" && value < condition.value;
    case "lte":
      return typeof value === "number" && typeof condition.value === "number" && value <= condition.value;
    case "eq":
      return deepEqual(value, condition.value);
    case "neq":
      return !deepEqual(value, condition.value);
    case "contains":
      if (Array.isArray(value)) {
        return value.some((item) => deepEqual(item, condition.value));
      }
      if (typeof value === "string") {
        return typeof condition.value === "string" && value.includes(condition.value);
      }
      if (typeof value === "object" && value !== null) {
        return typeof condition.value === "string" && condition.value in (value as Record<string, unknown>);
      }
      return false;
    default:
      return false;
  }
}

export function buildTargetCall(spec: ParsedSpec): { url: string; body: string; headers: Record<string, string> } {
  return {
    url: spec.targetUrl!,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: spec.toolName, arguments: spec.arguments ?? {} },
    }),
  };
}

function parseResultText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Calls the target MCP tool and evaluates the condition. Throws on transport
 * errors (the ticker records last_error and retries after the lease expires);
 * returns `{ trip: boolean, evaluation: unknown }` when the call succeeded.
 */
export async function evaluateMonitor(
  spec: ParsedSpec,
  fetchImpl: typeof fetch = fetch
): Promise<{ trip: boolean; evaluation: unknown }> {
  const call = buildTargetCall(spec);
  const res = await fetchImpl(call.url, { method: "POST", headers: call.headers, body: call.body });
  if (!res.ok) {
    throw new Error(`target MCP ${call.url} answered ${res.status} for ${spec.toolName}`);
  }
  const envelope = (await res.json()) as {
    result?: { content?: { type: string; text: string }[]; isError?: boolean };
    error?: { message?: string };
  };
  if (envelope.error) {
    throw new Error(`target tool error: ${envelope.error.message ?? "unknown"}`);
  }
  const result = envelope.result ?? {};
  if (result.isError) {
    throw new Error(`target tool ${spec.toolName} returned isError`);
  }
  const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
  const parsed = parseResultText(text);
  const evaluation = { raw: parsed, text };
  const trip = evaluateCondition(spec.condition!, parsed);
  return { trip, evaluation };
}
