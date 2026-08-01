import { describe, it, expect } from "vitest";
import {
  parseDuration,
  parseAt,
  parseScheduleSpec,
  validateTimezone,
  parseCronNext,
  parseBackoff,
  computeFirstFire,
  computeNextFire,
} from "../lib/cadence/schedule.js";

const NOW = Date.parse("2026-08-02T00:00:00.000Z");

describe("parseDuration", () => {
  it("accepts s/m/h/d/w units with integer values", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("2d")).toBe(172_800_000);
    expect(parseDuration("1w")).toBe(604_800_000);
  });

  it("rejects every malformed value", () => {
    for (const bad of ["", "5", "5x", "1.5h", "0s", "-5m", "m5", "5 ", "5min", "Infinity", "NaN", "1h30m"]) {
      expect(() => parseDuration(bad), JSON.stringify(bad)).toThrow();
    }
  });
});

describe("parseAt", () => {
  it("accepts ISO strings and epoch milliseconds", () => {
    expect(parseAt("2026-08-02T01:00:00.000Z")).toBe(Date.parse("2026-08-02T01:00:00.000Z"));
    expect(parseAt(1_752_500_000_000)).toBe(1_752_500_000_000);
  });

  it("rejects invalid inputs", () => {
    for (const bad of ["", "tomorrow", "2026-13-40T00:00:00Z", "abc", -1, 1.5, "0"]) {
      expect(() => parseAt(bad as any), JSON.stringify(bad)).toThrow();
    }
  });
});

describe("validateTimezone", () => {
  it("accepts IANA names and rejects garbage", () => {
    expect(validateTimezone("UTC")).toBe(true);
    expect(validateTimezone("America/New_York")).toBe(true);
    expect(validateTimezone("Asia/Jakarta")).toBe(true);
    expect(() => validateTimezone("Mars/Olympus")).toThrow();
    expect(() => validateTimezone("")).toThrow();
  });
});

describe("parseCronNext", () => {
  it("computes the next fire strictly after the reference", () => {
    const next = parseCronNext("*/5 * * * *", Date.parse("2026-08-02T00:03:00.000Z"), "UTC");
    expect(next).toBe(Date.parse("2026-08-02T00:05:00.000Z"));
  });

  it("supports 6-field cron with seconds and timezones", () => {
    const next = parseCronNext("0 0 9 * * *", Date.parse("2026-08-02T00:00:00.000Z"), "America/New_York");
    // 09:00 America/New_York = 13:00 UTC
    expect(next).toBe(Date.parse("2026-08-02T13:00:00.000Z"));
  });

  it("rejects invalid cron and invalid timezone", () => {
    expect(() => parseCronNext("* * * *", NOW, "UTC")).toThrow();
    expect(() => parseCronNext("61 * * * * *", NOW, "UTC")).toThrow();
    expect(() => parseCronNext("* * * * *", NOW, "Not/AZone")).toThrow();
  });
});

describe("parseBackoff", () => {
  it("parses a ladder into ordered milliseconds", () => {
    expect(parseBackoff(["1m", "10m", "1h", "6h"])).toEqual([
      60_000, 600_000, 3_600_000, 21_600_000,
    ]);
  });

  it("rejects empty or malformed ladders", () => {
    expect(() => parseBackoff([])).toThrow();
    expect(() => parseBackoff(["5m", "nope"])).toThrow();
    expect(() => parseBackoff(["0s"])).toThrow();
  });
});

describe("parseScheduleSpec — accept cases", () => {
  it("one_shot with absolute time", () => {
    const spec = parseScheduleSpec({ kind: "one_shot", at: "2026-08-02T01:00:00.000Z" }, NOW);
    expect(spec.kind).toBe("one_shot");
    expect(spec.at).toBe(Date.parse("2026-08-02T01:00:00.000Z"));
  });

  it("one_shot with delay", () => {
    const spec = parseScheduleSpec({ kind: "one_shot", delay: "5m" }, NOW);
    expect(spec.at).toBe(NOW + 300_000);
  });

  it("recurring with interval", () => {
    const spec = parseScheduleSpec({ kind: "recurring", interval: "1h" }, NOW);
    expect(spec.intervalMs).toBe(3_600_000);
  });

  it("recurring with cron and timezone", () => {
    const spec = parseScheduleSpec(
      { kind: "recurring", cron: "0 9 * * *", timezone: "Asia/Jakarta" },
      NOW
    );
    expect(spec.cron).toBe("0 9 * * *");
    expect(spec.timezone).toBe("Asia/Jakarta");
  });

  it("recurring with endDate and maxFires", () => {
    const spec = parseScheduleSpec(
      { kind: "recurring", interval: "1h", endDate: "2026-08-03T00:00:00.000Z", maxFires: 5 },
      NOW
    );
    expect(spec.endDate).toBe(Date.parse("2026-08-03T00:00:00.000Z"));
    expect(spec.maxFires).toBe(5);
  });

  it("retry with backoff ladder", () => {
    const spec = parseScheduleSpec({ kind: "retry", backoff: ["1m", "10m", "1h"] }, NOW);
    expect(spec.backoffMs).toEqual([60_000, 600_000, 3_600_000]);
  });

  it("expiration with deadline and default lead time", () => {
    const spec = parseScheduleSpec(
      { kind: "expiration", deadline: "2026-08-02T02:00:00.000Z" },
      NOW
    );
    expect(spec.deadline).toBe(Date.parse("2026-08-02T02:00:00.000Z"));
    expect(spec.leadTimeMs).toBe(3_600_000);
  });

  it("expiration with explicit lead time fires before the deadline", () => {
    const spec = parseScheduleSpec(
      { kind: "expiration", deadline: "2026-08-02T02:00:00.000Z", leadTime: "10m" },
      NOW
    );
    expect(spec.leadTimeMs).toBe(600_000);
    expect(computeFirstFire(spec, NOW)).toBe(Date.parse("2026-08-02T01:50:00.000Z"));
  });

  it("monitor requires target and condition and parses", () => {
    const spec = parseScheduleSpec(
      {
        kind: "monitor",
        interval: "1h",
        targetUrl: "https://mcp.evidiq.dev/core/mcp",
        toolName: "verify_agent",
        arguments: { agentId: "5232" },
        condition: { field: "score", op: "lt", value: 60 },
      },
      NOW
    );
    expect(spec.kind).toBe("monitor");
    expect(spec.targetUrl).toBe("https://mcp.evidiq.dev/core/mcp");
    expect(spec.condition?.op).toBe("lt");
  });

  it("verification parses like a monitor", () => {
    const spec = parseScheduleSpec(
      {
        kind: "verification",
        cron: "0 */6 * * *",
        targetUrl: "https://mcp.evidiq.dev/core/mcp",
        toolName: "verify_agent",
        condition: { field: "verdict", op: "eq", value: "PASS" },
      },
      NOW
    );
    expect(spec.kind).toBe("verification");
    expect(spec.cron).toBe("0 */6 * * *");
  });

  it("workflow parses steps with deadlines", () => {
    const spec = parseScheduleSpec(
      {
        kind: "workflow",
        steps: [
          { id: "s1", description: "send quote", deadline: "2026-08-02T01:00:00.000Z" },
          { id: "s2", description: "collect approval", deadline: "2026-08-02T02:00:00.000Z", escalation: { text: "escalate" } },
        ],
      },
      NOW
    );
    expect(spec.steps).toHaveLength(2);
    expect(computeFirstFire(spec, NOW)).toBe(Date.parse("2026-08-02T01:00:00.000Z"));
  });
});

describe("parseScheduleSpec — rejection cases", () => {
  it("rejects an unknown kind", () => {
    expect(() => parseScheduleSpec({ kind: "nope" }, NOW)).toThrow(/kind/i);
    expect(() => parseScheduleSpec({}, NOW)).toThrow(/kind/i);
  });

  it("one_shot rejects neither at nor delay", () => {
    expect(() => parseScheduleSpec({ kind: "one_shot" }, NOW)).toThrow(/at.*delay|delay.*at/i);
  });

  it("one_shot rejects both at and delay", () => {
    expect(() =>
      parseScheduleSpec({ kind: "one_shot", at: "2026-08-02T01:00:00.000Z", delay: "5m" }, NOW)
    ).toThrow(/either|one of/i);
  });

  it("one_shot rejects a time in the past", () => {
    expect(() => parseScheduleSpec({ kind: "one_shot", at: "2026-08-01T00:00:00.000Z" }, NOW)).toThrow(/future|past/i);
    expect(() => parseScheduleSpec({ kind: "one_shot", delay: "0s" }, NOW)).toThrow();
  });

  it("recurring rejects neither interval nor cron", () => {
    expect(() => parseScheduleSpec({ kind: "recurring" }, NOW)).toThrow(/interval|cron/i);
  });

  it("recurring rejects both interval and cron", () => {
    expect(() =>
      parseScheduleSpec({ kind: "recurring", interval: "1h", cron: "* * * * *" }, NOW)
    ).toThrow(/either|one of/i);
  });

  it("recurring rejects invalid endDate and maxFires", () => {
    expect(() => parseScheduleSpec({ kind: "recurring", interval: "1h", endDate: "not-a-date" }, NOW)).toThrow();
    expect(() => parseScheduleSpec({ kind: "recurring", interval: "1h", maxFires: 0 }, NOW)).toThrow();
    expect(() => parseScheduleSpec({ kind: "recurring", interval: "1h", maxFires: -1 }, NOW)).toThrow();
  });

  it("recurring rejects endDate in the past", () => {
    expect(() =>
      parseScheduleSpec({ kind: "recurring", interval: "1h", endDate: "2026-08-01T00:00:00.000Z" }, NOW)
    ).toThrow(/future|past/i);
  });

  it("retry rejects missing or empty backoff", () => {
    expect(() => parseScheduleSpec({ kind: "retry" }, NOW)).toThrow(/backoff/i);
    expect(() => parseScheduleSpec({ kind: "retry", backoff: [] }, NOW)).toThrow(/backoff/i);
  });

  it("expiration rejects missing deadline — the §0 defect", () => {
    expect(() => parseScheduleSpec({ kind: "expiration" }, NOW)).toThrow(/deadline/i);
  });

  it("expiration rejects a deadline too close to fire before it lapses", () => {
    expect(() =>
      parseScheduleSpec({ kind: "expiration", deadline: "2026-08-02T00:05:00.000Z", leadTime: "1h" }, NOW)
    ).toThrow(/lead|deadline/i);
  });

  it("monitor rejects a missing target — the §0 defect", () => {
    expect(() =>
      parseScheduleSpec({ kind: "monitor", interval: "1h", condition: { field: "x", op: "eq", value: 1 } }, NOW)
    ).toThrow(/target/i);
  });

  it("monitor rejects a missing condition", () => {
    expect(() =>
      parseScheduleSpec({ kind: "monitor", interval: "1h", targetUrl: "https://x/mcp", toolName: "t" }, NOW)
    ).toThrow(/condition/i);
  });

  it("monitor rejects a bad condition op", () => {
    expect(() =>
      parseScheduleSpec(
        { kind: "monitor", interval: "1h", targetUrl: "https://x/mcp", toolName: "t", condition: { field: "x", op: "wat" } },
        NOW
      )
    ).toThrow(/op/i);
  });

  it("verification rejects a missing target like a monitor", () => {
    expect(() =>
      parseScheduleSpec({ kind: "verification", interval: "1h", toolName: "verify_agent" }, NOW)
    ).toThrow(/target/i);
  });

  it("workflow rejects empty or malformed steps", () => {
    expect(() => parseScheduleSpec({ kind: "workflow", steps: [] }, NOW)).toThrow(/step/i);
    expect(() =>
      parseScheduleSpec({ kind: "workflow", steps: [{ id: "s1", description: "x", deadline: "nope" }] }, NOW)
    ).toThrow(/deadline/i);
  });

  it("rejects bad timezone on recurring and monitor", () => {
    expect(() => parseScheduleSpec({ kind: "recurring", interval: "1h", timezone: "Mars/Olympus" }, NOW)).toThrow();
    expect(() =>
      parseScheduleSpec({ kind: "monitor", interval: "1h", timezone: "x", targetUrl: "https://x/mcp", toolName: "t", condition: { field: "x", op: "eq", value: 1 } }, NOW)
    ).toThrow();
  });
});

describe("computeNextFire", () => {
  it("one_shot and expiration are terminal after the first firing", () => {
    const one = parseScheduleSpec({ kind: "one_shot", at: "2026-08-02T01:00:00.000Z" }, NOW);
    expect(computeNextFire(one, NOW + 3_600_000, 1)).toBeNull();

    const exp = parseScheduleSpec({ kind: "expiration", deadline: "2026-08-02T02:00:00.000Z", leadTime: "10m" }, NOW);
    expect(computeNextFire(exp, NOW + 1_800_000, 1)).toBeNull();
  });

  it("recurring advances by the interval from the fired time", () => {
    const spec = parseScheduleSpec({ kind: "recurring", interval: "30m" }, NOW);
    const firedAt = NOW + 60_000;
    expect(computeNextFire(spec, firedAt, 1)).toBe(firedAt + 1_800_000);
  });

  it("recurring advances by cron from the fired time", () => {
    const spec = parseScheduleSpec({ kind: "recurring", cron: "*/15 * * * *", timezone: "UTC" }, NOW);
    const firedAt = Date.parse("2026-08-02T00:07:00.000Z");
    expect(computeNextFire(spec, firedAt, 1)).toBe(Date.parse("2026-08-02T00:15:00.000Z"));
  });

  it("recurring stops at maxFires and endDate", () => {
    const capped = parseScheduleSpec({ kind: "recurring", interval: "1h", maxFires: 3 }, NOW);
    expect(computeNextFire(capped, NOW + 3_600_000, 2)).not.toBeNull();
    expect(computeNextFire(capped, NOW + 3_600_000, 3)).toBeNull();

    const dated = parseScheduleSpec(
      { kind: "recurring", interval: "1h", endDate: "2026-08-02T01:30:00.000Z" },
      NOW
    );
    expect(computeNextFire(dated, NOW + 3_600_000, 1)).toBeNull();
  });

  it("retry walks the ladder rungs after failed deliveries", () => {
    const spec = parseScheduleSpec({ kind: "retry", backoff: ["1m", "10m", "1h"] }, NOW);
    const firedAt = NOW + 60_000;
    expect(computeNextFire(spec, firedAt, 1)).toBe(firedAt + 60_000);
    expect(computeNextFire(spec, firedAt + 60_000, 2)).toBe(firedAt + 60_000 + 600_000);
    expect(computeNextFire(spec, firedAt + 660_000, 3)).toBe(firedAt + 660_000 + 3_600_000);
    expect(computeNextFire(spec, firedAt + 4_260_000, 4)).toBeNull();
  });

  it("workflow advances step by step and ends after the last step", () => {
    const spec = parseScheduleSpec(
      {
        kind: "workflow",
        steps: [
          { id: "s1", description: "step one", deadline: "2026-08-02T01:00:00.000Z" },
          { id: "s2", description: "step two", deadline: "2026-08-02T02:00:00.000Z" },
        ],
      },
      NOW
    );
    expect(computeNextFire(spec, Date.parse("2026-08-02T01:00:00.000Z"), 1)).toBe(Date.parse("2026-08-02T02:00:00.000Z"));
    expect(computeNextFire(spec, Date.parse("2026-08-02T02:00:00.000Z"), 2)).toBeNull();
  });
});
