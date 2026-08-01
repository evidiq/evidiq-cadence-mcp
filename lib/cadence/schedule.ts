import cronParser from "cron-parser";

export const KINDS = [
  "one_shot",
  "recurring",
  "retry",
  "expiration",
  "monitor",
  "verification",
  "workflow",
] as const;

export type JobKind = (typeof KINDS)[number];

export const CONDITION_OPS = [
  "gt",
  "gte",
  "lt",
  "lte",
  "eq",
  "neq",
  "contains",
  "exists",
  "not_exists",
] as const;

export type ConditionOp = (typeof CONDITION_OPS)[number];

export interface Condition {
  field: string;
  op: ConditionOp;
  value?: unknown;
}

export interface WorkflowStep {
  id: string;
  description: string;
  deadline: number;
  escalation?: unknown;
}

/**
 * The canonical, closed schedule spec. This object — exactly as serialized —
 * is what the receipt embeds as `scheduleSpec`, so its shape is part of the
 * receipt digest contract. No extra fields may be added to it.
 */
export interface ParsedSpec {
  kind: JobKind;
  at?: number;
  intervalMs?: number;
  cron?: string;
  timezone?: string;
  endDate?: number;
  maxFires?: number;
  backoffMs?: number[];
  maxAttempts?: number;
  deadline?: number;
  leadTimeMs?: number;
  targetUrl?: string;
  toolName?: string;
  arguments?: unknown;
  condition?: Condition;
  steps?: WorkflowStep[];
}

export const DEFAULT_LEAD_TIME_MS = 3_600_000;

const DURATION_RE = /^(\d+)(s|m|h|d|w)$/;
const ISO8601_RE =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

export function parseDuration(input: string): number {
  if (typeof input !== "string") {
    throw new Error(`duration must be a string like "5m", got ${JSON.stringify(input)}`);
  }
  const m = DURATION_RE.exec(input.trim());
  if (!m) {
    throw new Error(
      `invalid duration "${input}" — expected a positive integer with a unit (s, m, h, d, w), e.g. "30s", "5m", "1h"`
    );
  }
  const value = parseInt(m[1], 10);
  if (value <= 0) {
    throw new Error(`invalid duration "${input}" — must be greater than zero`);
  }
  return value * UNIT_MS[m[2]];
}

export function parseAt(input: string | number): number {
  if (typeof input === "number") {
    if (!Number.isInteger(input) || input <= 0) {
      throw new Error(`invalid timestamp ${input} — expected epoch milliseconds or an ISO 8601 string`);
    }
    return input;
  }
  if (typeof input !== "string" || !ISO8601_RE.test(input.trim())) {
    throw new Error(
      `unparseable timestamp "${String(input)}" — use ISO 8601 (e.g. 2026-08-02T01:00:00.000Z) or epoch milliseconds`
    );
  }
  const ms = Date.parse(input.trim());
  if (Number.isNaN(ms)) {
    throw new Error(`unparseable timestamp "${input}" — use ISO 8601 (e.g. 2026-08-02T01:00:00.000Z) or epoch milliseconds`);
  }
  return ms;
}

export function validateTimezone(timezone: string): boolean {
  if (typeof timezone !== "string" || timezone.trim() === "") {
    throw new Error("timezone must be an IANA name, e.g. \"UTC\", \"Asia/Jakarta\", \"America/New_York\"");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    throw new Error(`unknown timezone "${timezone}" — use an IANA name, e.g. "UTC", "Asia/Jakarta"`);
  }
}

export function parseCronNext(expr: string, fromMs: number, timezone = "UTC"): number {
  validateTimezone(timezone);
  if (typeof expr !== "string") {
    throw new Error("cron must be a string expression with 5 or 6 fields (minutes hours day-of-month month day-of-week [seconds])");
  }
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) {
    throw new Error(
      `invalid cron "${expr}" — expected 5 fields (minutes hours day-of-month month day-of-week) or 6 with leading seconds, got ${fields.length}`
    );
  }
  const interval = cronParser.parseExpression(expr.trim(), {
    currentDate: new Date(fromMs),
    tz: timezone,
  });
  return interval.next().getTime();
}

export function parseBackoff(ladder: string[]): number[] {
  if (!Array.isArray(ladder) || ladder.length === 0) {
    throw new Error("backoff requires a non-empty ladder of durations, e.g. [\"1m\", \"10m\", \"1h\", \"6h\"]");
  }
  return ladder.map((d) => parseDuration(d));
}

function assertOneOf(a: unknown, b: unknown, whatA: string, whatB: string): void {
  if (a === undefined && b === undefined) {
    throw new Error(`${whatA} or ${whatB} is required`);
  }
  if (a !== undefined && b !== undefined) {
    throw new Error(`specify either ${whatA} or ${whatB}, not both`);
  }
}

function parseScheduleWindow(
  raw: Record<string, any>,
  now: number
): Pick<ParsedSpec, "intervalMs" | "cron" | "timezone" | "endDate" | "maxFires"> {
  assertOneOf(raw.interval, raw.cron, "interval", "cron");
  const tz = raw.timezone === undefined ? "UTC" : (validateTimezone(raw.timezone), String(raw.timezone));
  const out: Pick<ParsedSpec, "intervalMs" | "cron" | "timezone" | "endDate" | "maxFires"> = { timezone: tz };
  if (raw.interval !== undefined) {
    out.intervalMs = parseDuration(raw.interval);
  }
  if (raw.cron !== undefined) {
    if (typeof raw.cron !== "string" || raw.cron.trim() === "") {
      throw new Error("cron must be a non-empty expression");
    }
    // Validate by computing the next fire; throws on a malformed expression.
    parseCronNext(raw.cron, now, tz);
    out.cron = raw.cron;
  }
  if (raw.endDate !== undefined) {
    const endDate = parseAt(raw.endDate);
    if (endDate <= now) {
      throw new Error("endDate must be in the future");
    }
    out.endDate = endDate;
  }
  if (raw.maxFires !== undefined) {
    if (!Number.isInteger(raw.maxFires) || raw.maxFires < 1) {
      throw new Error("maxFires must be a positive integer");
    }
    out.maxFires = raw.maxFires;
  }
  return out;
}

function parseFirstAttempt(
  raw: Record<string, any>,
  now: number,
  required: boolean
): { at: number } {
  if (raw.at !== undefined && raw.delay !== undefined) {
    throw new Error("specify either at or delay, not both");
  }
  if (raw.at !== undefined) {
    const at = parseAt(raw.at);
    if (at <= now) {
      throw new Error("at must be in the future");
    }
    return { at };
  }
  if (raw.delay !== undefined) {
    const delayMs = parseDuration(raw.delay);
    if (delayMs <= 0) {
      throw new Error("delay must be greater than zero");
    }
    return { at: now + delayMs };
  }
  if (required) {
    throw new Error("at or delay is required");
  }
  return { at: now };
}

function parseCondition(raw: unknown): Condition {
  if (!raw || typeof raw !== "object") {
    throw new Error("condition is required — { field, op, value? } evaluated against the target tool's result");
  }
  const c = raw as Record<string, any>;
  if (typeof c.field !== "string" || c.field.trim() === "") {
    throw new Error("condition.field is required (a dot path into the target result, e.g. \"score\")");
  }
  if (!CONDITION_OPS.includes(c.op)) {
    throw new Error(`condition.op must be one of: ${CONDITION_OPS.join(", ")}`);
  }
  return { field: c.field, op: c.op as ConditionOp, value: c.value };
}

function parseMonitor(
  kind: "monitor" | "verification",
  raw: Record<string, any>,
  now: number
): ParsedSpec {
  const window = parseScheduleWindow(raw, now);
  if (typeof raw.targetUrl !== "string" || !/^https?:\/\/.+/.test(raw.targetUrl)) {
    throw new Error("targetUrl is required for a monitor — the MCP endpoint whose tool is called each cycle");
  }
  if (typeof raw.toolName !== "string" || raw.toolName.trim() === "") {
    throw new Error("toolName is required for a monitor — the MCP tool to call each cycle");
  }
  return {
    kind,
    ...window,
    targetUrl: raw.targetUrl,
    toolName: raw.toolName,
    arguments: raw.arguments ?? {},
    condition: parseCondition(raw.condition),
  };
}

export function parseScheduleSpec(raw: unknown, now: number = Date.now()): ParsedSpec {
  if (!raw || typeof raw !== "object") {
    throw new Error("a schedule spec object is required");
  }
  const input = raw as Record<string, any>;
  const kind: string = input.kind;

  switch (kind) {
    case "one_shot": {
      const { at } = parseFirstAttempt(input, now, true);
      return { kind: "one_shot", at };
    }
    case "recurring": {
      const window = parseScheduleWindow(input, now);
      return { kind: "recurring", ...window };
    }
    case "retry": {
      const backoffMs = parseBackoff(input.backoff);
      const first = parseFirstAttempt(input, now, false);
      let maxAttempts: number | undefined;
      if (input.maxAttempts !== undefined) {
        if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) {
          throw new Error("maxAttempts must be a positive integer");
        }
        maxAttempts = input.maxAttempts;
      }
      return { kind: "retry", ...first, backoffMs, maxAttempts };
    }
    case "expiration": {
      if (input.deadline === undefined) {
        throw new Error("deadline is required for an expiration watch — the time that must not lapse unnoticed");
      }
      const deadline = parseAt(input.deadline);
      const leadTimeMs =
        input.leadTime === undefined
          ? DEFAULT_LEAD_TIME_MS
          : parseDuration(input.leadTime);
      if (deadline - leadTimeMs <= now) {
        throw new Error(
          `deadline ${new Date(deadline).toISOString()} is too close — with lead time ${leadTimeMs}ms there is no time left to fire before it lapses`
        );
      }
      return { kind: "expiration", deadline, leadTimeMs };
    }
    case "monitor":
      return parseMonitor("monitor", input, now);
    case "verification":
      return parseMonitor("verification", input, now);
    case "workflow": {
      if (!Array.isArray(input.steps) || input.steps.length === 0) {
        throw new Error("workflow requires a non-empty steps array — each step has an id, description and deadline");
      }
      const steps: WorkflowStep[] = input.steps.map((s: any, i: number) => {
        if (!s || typeof s !== "object") {
          throw new Error(`steps[${i}] must be an object`);
        }
        if (typeof s.id !== "string" || s.id.trim() === "") {
          throw new Error(`steps[${i}].id is required`);
        }
        if (typeof s.description !== "string" || s.description.trim() === "") {
          throw new Error(`steps[${i}].description is required`);
        }
        let deadline: number;
        try {
          deadline = parseAt(s.deadline);
        } catch (err) {
          throw new Error(`steps[${i}].deadline invalid: ${(err as Error).message}`);
        }
        const out: WorkflowStep = { id: s.id, description: s.description, deadline };
        if (s.escalation !== undefined) out.escalation = s.escalation;
        return out;
      });
      return { kind: "workflow", steps };
    }
    default:
      throw new Error(
        `unknown schedule kind "${kind}" — must be one of: ${KINDS.join(", ")}`
      );
  }
}

/**
 * When the job first becomes due. Never earlier than `now` — the only kind
 * that fires "early" is expiration, and that early-ness is the configured
 * lead time, already folded into its `deadline - leadTimeMs`.
 */
export function computeFirstFire(spec: ParsedSpec, now: number): number {
  switch (spec.kind) {
    case "one_shot":
      return spec.at!;
    case "retry":
      return spec.at!;
    case "expiration":
      return spec.deadline! - spec.leadTimeMs!;
    case "recurring":
    case "monitor":
    case "verification":
      if (spec.cron) {
        return parseCronNext(spec.cron, now, spec.timezone || "UTC");
      }
      return now + spec.intervalMs!;
    case "workflow":
      return spec.steps![0].deadline;
  }
}

/**
 * The next due time after a firing, or null when the series is terminal.
 * `firesSoFar` is the count of firings already recorded (0-based index for
 * workflow steps, 1-based count for ladder indexing).
 *
 * - one_shot / expiration: terminal after the first firing.
 * - recurring / monitor / verification: next cron match or interval step,
 *   bounded by maxFires and endDate.
 * - retry: the next ladder rung after a failed delivery; null when the
 *   ladder is exhausted (caller falls back to poll).
 * - workflow: the next step's deadline; null after the last step.
 */
/**
 * The next due time after resuming a paused job (or series). Never before
 * `now` — a resumed job that missed its time fires on the next tick rather
 * than silently in the past.
 */
export function computeResumeFire(spec: ParsedSpec, now: number, firesSoFar: number): number {
  switch (spec.kind) {
    case "one_shot":
    case "retry":
      return Math.max(spec.at ?? now, now);
    case "expiration":
      return Math.max(spec.deadline! - spec.leadTimeMs!, now);
    case "recurring":
    case "monitor":
    case "verification":
      if (spec.cron) {
        return parseCronNext(spec.cron, now, spec.timezone || "UTC");
      }
      return now + spec.intervalMs!;
    case "workflow": {
      const step = spec.steps![firesSoFar];
      return step ? Math.max(step.deadline, now) : now;
    }
  }
}

export function computeNextFire(spec: ParsedSpec, afterMs: number, firesSoFar: number): number | null {
  switch (spec.kind) {
    case "one_shot":
    case "expiration":
      return null;
    case "retry": {
      const idx = firesSoFar - 1;
      if (idx < 0 || idx >= (spec.backoffMs || []).length) return null;
      return afterMs + spec.backoffMs![idx];
    }
    case "workflow": {
      const next = spec.steps![firesSoFar];
      return next ? next.deadline : null;
    }
    case "recurring":
    case "monitor":
    case "verification": {
      if (spec.maxFires !== undefined && firesSoFar >= spec.maxFires) return null;
      let next: number;
      if (spec.cron) {
        next = parseCronNext(spec.cron, afterMs, spec.timezone || "UTC");
      } else {
        next = afterMs + spec.intervalMs!;
      }
      if (spec.endDate !== undefined && next > spec.endDate) return null;
      return next;
    }
  }
}
