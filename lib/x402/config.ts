export interface OkxCredentials {
  apiKey: string;
  secretKey: string;
  passphrase: string;
  baseUrl: string;
}

export interface X402ServerConfig {
  chain: string;
  asset: string;
  payTo: string;
  domainName: string;
  domainVersion: string;
  rpcUrl: string;
  publicBaseUrl: string;
  okxCredentials: OkxCredentials | null;
}

export function getOkxCredentials(): OkxCredentials | null {
  const apiKey = process.env.OKX_API_KEY;
  const secretKey = process.env.OKX_SECRET_KEY;
  const passphrase = process.env.OKX_PASSPHRASE;
  const baseUrl = process.env.OKX_BASE_URL || "https://web3.okx.com";

  if (!apiKey || !secretKey || !passphrase) {
    return null;
  }

  return { apiKey, secretKey, passphrase, baseUrl };
}

export function getX402Config(): X402ServerConfig {
  return {
    chain: process.env.X402_CHAIN || "eip155:196",
    asset: process.env.X402_ASSET || "0x779ded0c9e1022225f8e0630b35a9b54be713736",
    payTo: process.env.X402_PAY_TO || "0x2a8efe3093278bb4bd3b2d9c7b5ba992ca4fc9b0",
    domainName: process.env.X402_DOMAIN_NAME || "USD₮0",
    domainVersion: process.env.X402_DOMAIN_VERSION || "1",
    rpcUrl: process.env.X402_RPC || "https://rpc.xlayer.tech",
    publicBaseUrl: (process.env.PUBLIC_BASE_URL || "https://mcp.evidiq.dev/cadence").replace(/\/$/, ""),
    okxCredentials: getOkxCredentials(),
  };
}

/**
 * Phase 1 build/test bypass: when CADENCE_X402_BYPASS=1 or X402_BYPASS=1,
 * the payment gate is disabled and all tools return 200 (PLAN §11.1).
 * Phase 2 removes the bypass and enables the gate.
 */
export function isX402Bypassed(): boolean {
  return process.env.CADENCE_X402_BYPASS === "1" || process.env.X402_BYPASS === "1";
}
