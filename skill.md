# EVIDIQ Cadence MCP

Durable, attested future execution for agents — service #17 of the EVIDIQ fleet.

- **18 tools** (8 free, 10 paid in USDT0 on eip155:196): schedule one-shot, recurring,
  retry-ladder, expiration, monitor, verification, workflow jobs; reschedule, resume,
  attest; plus free capabilities/estimate/validate/verify/get/poll/pause/cancel.
- **Delivery:** poll (baseline) and webhook (EIP-191 signed, ladder-retried, falls back
  to poll). a2a is not advertised until a real firing has been observed arriving.
- **Receipts:** every firing carries an EIP-191-signed receipt (JCS SHA-256 digest over
  `jobId, scheduleSpec, scheduledFor, firedAt, attempt, deliveryMode, deliveredTo,
  payloadDigest, outcome, late`) and an idempotency key — at-least-once, never
  exactly-once, never early (except expiration lead time), late firings marked with
  their delay. Silence is never an outcome.
- **Free lifecycle:** pause_job and cancel_job cost nothing; stopping is always free.
- **Endpoint:** `POST https://mcp.evidiq.dev/cadence/mcp` (MCP streamable HTTP).
