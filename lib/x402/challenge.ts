import { X402Challenge, X402AcceptRequirement } from "./types.js";
import { getX402Config } from "./config.js";

export const TOOL_PRICES_ATOMIC: Record<string, string> = {
  schedule_job: "5000",
  schedule_recurring: "10000",
  schedule_retry: "10000",
  schedule_expiration: "10000",
  schedule_monitor: "20000",
  schedule_verification: "15000",
  schedule_workflow: "30000",
  reschedule_job: "5000",
  resume_job: "5000",
  attest_execution: "30000",
};

export const TOOL_PRICES_HUMAN: Record<string, string> = {
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
};

export const FREE_TOOL_NAMES: string[] = [
  "cadence_capabilities",
  "estimate_cost",
  "validate_schedule",
  "verify_receipt",
  "get_job",
  "poll_due",
  "pause_job",
  "cancel_job",
];

export function createChallenge(toolName: string): X402Challenge {
  const cfg = getX402Config();
  const atomicAmount = TOOL_PRICES_ATOMIC[toolName] || "5000";
  const humanAmount = TOOL_PRICES_HUMAN[toolName] || "0.005 USDT0";

  const acceptReq: X402AcceptRequirement = {
    scheme: "exact",
    network: cfg.chain,
    asset: cfg.asset,
    amount: atomicAmount,
    payTo: cfg.payTo,
    maxTimeoutSeconds: 300,
    extra: {
      name: cfg.domainName,
      version: cfg.domainVersion,
    },
  };

  return {
    x402Version: 2,
    resource: {
      url: `${cfg.publicBaseUrl}/mcp`,
      description:
        "EVIDIQ Cadence — durable, attested future execution for agents: schedule work, deadlines, retries and standing monitors, delivered back over A2A, webhook, or poll, with an EIP-191 receipt for every firing.",
      mimeType: "application/json",
    },
    accepts: [acceptReq],
    error: `Payment Required for tool '${toolName}'. Costs ${humanAmount}.`,
  };
}

export function encodeChallengeToBase64(challenge: X402Challenge): string {
  const { error, ...headerChallenge } = challenge;
  return Buffer.from(JSON.stringify(headerChallenge)).toString("base64");
}

export function getX402DiscoveryCatalog() {
  const cfg = getX402Config();
  const paid = Object.entries(TOOL_PRICES_ATOMIC).map(([tool, amount]) => ({
    tool,
    amount,
    usd: Number(TOOL_PRICES_HUMAN[tool].split(" ")[0]),
  }));
  const free = FREE_TOOL_NAMES.map((tool) => ({ tool, amount: "0", usd: 0, free: true }));
  return {
    x402Version: 2,
    resource: {
      url: `${cfg.publicBaseUrl}/mcp`,
      description:
        "EVIDIQ Cadence — durable, attested future execution for agents. 8 free tools (cadence_capabilities, estimate_cost, validate_schedule, verify_receipt, get_job, poll_due, pause_job, cancel_job) remain free.",
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: cfg.chain,
        asset: cfg.asset,
        amount: "5000",
        payTo: cfg.payTo,
        maxTimeoutSeconds: 300,
        extra: {
          name: cfg.domainName,
          version: cfg.domainVersion,
        },
      },
    ],
    pricing: [...paid, ...free],
    guidance:
      "Paying buys the future; stopping is always free. pause_job and cancel_job are free — a customer must never be unable to stop work because of a balance.",
  };
}
