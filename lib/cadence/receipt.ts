import { createHash } from "node:crypto";
import { privateKeyToAccount, signMessage } from "viem/accounts";
import { verifyMessage } from "viem";
import { jcs } from "./jcs.js";

export const FLEET_SIGNER_ADDRESS = "0x8a3c7524Aaed081825aC88eC7f4cCECFc583ee7D";

export const RECEIPT_FIELDS = [
  "jobId",
  "scheduleSpec",
  "scheduledFor",
  "firedAt",
  "attempt",
  "deliveryMode",
  "deliveredTo",
  "payloadDigest",
  "outcome",
  "late",
] as const;

export interface ReceiptInput {
  jobId: string;
  scheduleSpec: unknown;
  scheduledFor: number;
  firedAt: number;
  attempt: number;
  deliveryMode: string;
  deliveredTo: string;
  payloadDigest: string;
  outcome: string;
  late: boolean;
}

export type Receipt = { [K in (typeof RECEIPT_FIELDS)[number]]: ReceiptInput[K] };

function normalizeKey(value: string): `0x${string}` {
  const bare = value.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(bare)) {
    throw new Error(`CADENCE_SIGNER_PRIVATE_KEY is not a valid 32-byte private key (got "${value.slice(0, 6)}…")`);
  }
  return `0x${bare.toLowerCase()}`;
}

export function getSignerPrivateKey(): `0x${string}` {
  const raw = process.env.CADENCE_SIGNER_PRIVATE_KEY;
  if (raw === undefined || raw === "") {
    throw new Error(
      "CADENCE_SIGNER_PRIVATE_KEY is not set — cadence refuses to sign receipts without an explicit signer key; there is no fallback key"
    );
  }
  return normalizeKey(raw);
}

export function getSignerAddress(): `0x${string}` {
  return privateKeyToAccount(getSignerPrivateKey()).address;
}

export function signerAvailable(): boolean {
  const raw = process.env.CADENCE_SIGNER_PRIVATE_KEY;
  return typeof raw === "string" && raw !== "";
}

function digestOf(receipt: Receipt): `0x${string}` {
  const canonical = jcs(receipt);
  return `0x${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export async function buildReceipt(input: ReceiptInput): Promise<{
  receipt: Receipt;
  digest: `0x${string}`;
  signature: `0x${string}`;
}> {
  const receipt: Receipt = {
    jobId: input.jobId,
    scheduleSpec: input.scheduleSpec,
    scheduledFor: input.scheduledFor,
    firedAt: input.firedAt,
    attempt: input.attempt,
    deliveryMode: input.deliveryMode,
    deliveredTo: input.deliveredTo,
    payloadDigest: input.payloadDigest,
    outcome: input.outcome,
    late: input.late,
  };
  const digest = digestOf(receipt);
  const signature = await signMessage({
    privateKey: getSignerPrivateKey(),
    message: { raw: digest },
  });
  return { receipt, digest, signature };
}

export async function verifyReceipt(
  receipt: Receipt,
  digest: `0x${string}`,
  signature: `0x${string}`,
  signerKey: string
): Promise<{
  digest: `0x${string}`;
  digestValid: boolean;
  signatureValid: boolean;
  recoveredSigner: `0x${string}` | null;
  expectedSigner: `0x${string}`;
}> {
  const recomputed = digestOf(receipt);
  const digestValid = recomputed === digest;
  const expectedSigner = privateKeyToAccount(normalizeKey(signerKey)).address;
  let recoveredSigner: `0x${string}` | null = null;
  if (digestValid) {
    try {
      const matches = await verifyMessage({
        address: expectedSigner,
        message: { raw: digest },
        signature,
      });
      recoveredSigner = matches ? expectedSigner : null;
    } catch {
      recoveredSigner = null;
    }
  }
  return {
    digest: recomputed,
    digestValid,
    signatureValid: digestValid && recoveredSigner !== null,
    recoveredSigner,
    expectedSigner,
  };
}
