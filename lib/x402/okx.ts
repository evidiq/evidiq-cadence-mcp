import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import { x402ResourceServer } from "@okxweb3/x402-core/server";
import type { PaymentPayload, PaymentRequirements } from "@okxweb3/x402-core/types";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { getX402Config } from "./config.js";
import { TOOL_PRICES_ATOMIC } from "./challenge.js";

let serverInstance: x402ResourceServer | null = null;
let serverInitPromise: Promise<void> | null = null;
let okxClientInstance: OKXFacilitatorClient | null = null;

export function getOkxFacilitatorClient(): OKXFacilitatorClient | null {
  if (okxClientInstance) return okxClientInstance;
  const cfg = getX402Config();
  if (!cfg.okxCredentials) return null;

  okxClientInstance = new OKXFacilitatorClient({
    apiKey: cfg.okxCredentials.apiKey,
    secretKey: cfg.okxCredentials.secretKey,
    passphrase: cfg.okxCredentials.passphrase,
    baseUrl: cfg.okxCredentials.baseUrl,
  });

  return okxClientInstance;
}

export function getResourceServer(): x402ResourceServer | null {
  if (serverInstance) return serverInstance;

  const client = getOkxFacilitatorClient();
  if (!client) return null;

  const cfg = getX402Config();
  const server = new x402ResourceServer(client);

  const exactScheme = new ExactEvmScheme();
  server.register(cfg.chain as `${string}:${string}`, exactScheme);

  serverInstance = server;
  return serverInstance;
}

async function ensureServerInitialized(server: x402ResourceServer): Promise<void> {
  if (!serverInitPromise) {
    serverInitPromise = server.initialize().catch((err) => {
      serverInitPromise = null;
      throw err;
    });
  }
  return serverInitPromise;
}

export async function verifyAndSettlePayment(
  paymentHeaderBase64: string,
  toolName: string
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  try {
    const server = getResourceServer();
    if (!server) {
      return { success: false, error: "OKX Facilitator client not configured" };
    }
    await ensureServerInitialized(server);

    const cfg = getX402Config();
    const atomicAmount = TOOL_PRICES_ATOMIC[toolName] || "5000";

    const payloadJson = Buffer.from(paymentHeaderBase64, "base64").toString("utf-8");
    const paymentPayload: PaymentPayload = JSON.parse(payloadJson);

    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: cfg.chain as `${string}:${string}`,
      asset: cfg.asset,
      amount: atomicAmount,
      payTo: cfg.payTo,
      maxTimeoutSeconds: 300,
      extra: {
        name: cfg.domainName,
        version: cfg.domainVersion,
      },
    };

    const verifyResult = await server.verifyPayment(paymentPayload, requirements);
    if (!verifyResult.isValid) {
      return {
        success: false,
        error: `Invalid payment signature: ${verifyResult.invalidReason || "verification failed"}`,
      };
    }

    const settleResult = await server.settlePayment(paymentPayload, requirements);
    if (settleResult.status === "success" || settleResult.success === true) {
      return {
        success: true,
        txHash: settleResult.transaction,
      };
    } else if (settleResult.status === "timeout" || settleResult.status === "pending") {
      // EVIDIQ-X402-RUNBOOK §9: poll getSettleStatus on timeout/pending if a tx
      // hash exists. NEVER report success from a timeout without confirmation.
      const txHash = settleResult.transaction;
      if (!txHash) {
        return { success: false, error: `Settlement ${settleResult.status} without transaction hash` };
      }
      const client = getOkxFacilitatorClient();
      if (!client || typeof client.getSettleStatus !== "function") {
        return { success: false, error: `Settlement ${settleResult.status}; cannot poll settle status` };
      }
      const deadline = Date.now() + 24000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        try {
          const statusRes = await client.getSettleStatus(txHash);
          if (statusRes && (statusRes.status === "success" || statusRes.success === true)) {
            return { success: true, txHash };
          }
          if (statusRes && (statusRes.status === "failed" || statusRes.success === false)) {
            return { success: false, error: `Settlement failed on-chain (tx ${txHash})` };
          }
        } catch (err) {
          // ignore transient error during status poll
        }
      }
      return { success: false, error: `Settlement not confirmed within 24s (tx ${txHash}); retry with the same authorization` };
    } else {
      return { success: false, error: `Settlement failed: ${settleResult.errorReason || settleResult.status}` };
    }
  } catch (err: any) {
    return { success: false, error: `x402 error: ${err.message || String(err)}` };
  }
}
