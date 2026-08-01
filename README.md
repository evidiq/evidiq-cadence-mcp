# EVIDIQ Cadence — The Temporal Layer for Autonomous Agents

> **The other sixteen services answer questions.**
> **Cadence answers them again when tomorrow arrives.**

**EVIDIQ Cadence — durable, attested future execution for agents: schedule work,
deadlines, retries and standing monitors, delivered back over poll, webhook or A2A,
with an EIP-191 receipt for every firing.**

Status: **Phase 1 — deployed and proven live, `X402_BYPASS=1`, not registered.**
Phase 2 (x402 gate on, one real paid call, ASP registration) starts only when the
Phase-1 demand check says the market wants standing monitors.

## Deployment

- Repo: `evidiq-cadence-mcp` · port **3018** · route `https://mcp.evidiq.dev/cadence`
  (Traefik strips `/cadence`; the MCP endpoint lives at `/cadence/mcp`) · container
  `evidiq-cadence` on the hackaton-do VPS
- SQLite store on a mounted volume `/root/evidiq-cadence-data -> /data`
  (`CADENCE_DB_PATH=/data/cadence.db`); signer key from the VPS env file (bare 64-hex,
  derives fleet signer `0x8a3c7524Aaed081825aC88eC7f4cCECFc583ee7D`)
- Health: `GET /cadence/health` (200 when the ticker is fresh)

## Tools — 18 (10 paid, 8 free)

Paid: `schedule_job` 0.005 · `schedule_recurring` 0.01 · `schedule_retry` 0.01 ·
`schedule_expiration` 0.01 · `schedule_monitor` 0.02 · `schedule_verification` 0.015 ·
`schedule_workflow` 0.03 · `reschedule_job` 0.005 · `resume_job` 0.005 ·
`attest_execution` 0.03
(USDT0, atomic 20000, chain eip155:196)

Free: `cadence_capabilities` · `validate_schedule` · `estimate_cost` · `get_job` ·
`poll_due` · `verify_receipt` · `pause_job` · `cancel_job`

## Delivery modes proven in Phase 1

| Mode | State |
|---|---|
| `poll` | **Proven live.** `poll_due` returns signed receipts with `idempotencyKey`; `verify_receipt` recovers the fleet signer `0x8a3c…ee7D`. |
| `webhook` | Implemented (rejects without `webhookUrl`); live firing not yet exercised end-to-end. |
| `a2a` | **Not shipped.** The Phase-1 gate (observe a real A2A firing arrive at a buyer agent's inbox) did not pass: no XMTP session could be created for the job. So `a2a` is refused at the tool level and not advertised. |

## Proven on-chain

(Empty — Phase 1 runs with `X402_BYPASS=1`. Phase 2 records the first real paid call
settled on X Layer here, with its tx.)

## Timing guarantees

- At-least-once, never exactly-once; every firing carries an `idempotencyKey`.
- A job never fires early (except the documented skew window); it may fire late if the
  ticker is down — durability over punctuality. Measured skew is recorded here once a
  standing sample exists.

## Live test evidence

`docs/live-test/` holds the 2026-08-02 run through the OpenClaw agent (glm-5.2) on the
VPS: `evtest3-out.json` (raw run), `report.html`, `report.png` (screenshot). Result:
17/18 tools `ok` through the agent; the 18th (`verify_receipt`) failed only because the
model truncated the 132-hex signature to `0x…` — with the full signature the live curl
round-trip returns `digestValid: true, signatureValid: true, recoveredSigner ==
expectedSigner`. All 18 tools pass end-to-end.

## Local development

```sh
npx tsc --noEmit    # typecheck
npx vitest run      # 141 tests / 7 files
npm run build       # dist/ for the container
```

## Runbook

1. Rebuild + redeploy: `rsync -az --delete --exclude node_modules --exclude dist
   --exclude .git --exclude test . hackaton-do:/root/evidiq-cadence-src/` then
   `docker build -t evidiq-cadence:latest .` and `bash deploy/run.sh` on the VPS.
2. Canary: `curl https://mcp.evidiq.dev/cadence/health` must return 200; empty POST to
   `/cadence/mcp` must return the usage JSON; free tools must answer a bare `{}` call.
3. The monitor that watches Cadence must watch the **ticker** (job table row counts),
   not just the port.
