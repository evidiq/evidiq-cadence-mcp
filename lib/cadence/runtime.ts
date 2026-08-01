import { Store, openStore, type JobRow } from "./store.js";
import { Ticker } from "./ticker.js";
import { evaluateMonitor as callTargetMonitor } from "./monitor.js";
import type { ParsedSpec } from "./schedule.js";

export interface RuntimeOptions {
  dbPath?: string;
  intervalMs?: number;
  leaseMs?: number;
  maxPerTick?: number;
  nowFn?: () => number;
  webhookImpl?: (url: string, init: RequestInit) => Promise<Response>;
  targetFetch?: typeof fetch;
  autoStartTicker?: boolean;
}

export class CadenceRuntime {
  readonly store: Store;
  readonly ticker: Ticker;
  private targetFetch: typeof fetch;

  constructor(opts: RuntimeOptions = {}) {
    this.store = openStore(opts.dbPath ?? process.env.CADENCE_DB_PATH ?? "/data/cadence.db");
    this.targetFetch = opts.targetFetch ?? fetch;
    this.ticker = new Ticker(this.store, {
      intervalMs: opts.intervalMs ?? 5_000,
      leaseMs: opts.leaseMs ?? 60_000,
      maxPerTick: opts.maxPerTick ?? 50,
      nowFn: opts.nowFn,
      webhookImpl: opts.webhookImpl,
      evaluateMonitor: async (job: JobRow, spec: ParsedSpec) => {
        const result = await callTargetMonitor(spec, this.targetFetch);
        return result.trip;
      },
    });
    if (opts.autoStartTicker ?? true) {
      this.ticker.start();
    }
  }

  getLastTickAt(): number {
    return this.ticker.getLastTickAt();
  }

  close(): void {
    this.ticker.stop();
    this.store.close();
  }
}
