export type OgConfig = {
  privateKey: `0x${string}`;
  storageRpc: string;
  storageIndexer: string;
  computeRpc: string;
  chainId: number;
};

const DEFAULTS = {
  storageRpc: "https://evmrpc.0g.ai",
  storageIndexer: "https://indexer-storage-turbo.0g.ai",
  computeRpc: "https://evmrpc.0g.ai",
  chainId: 16661,
};

function normalizeKey(raw?: string): `0x${string}` | null {
  if (!raw) return null;
  const key = raw.trim();
  const withPrefix = key.startsWith("0x") ? key : `0x${key}`;
  return /^0x[0-9a-fA-F]{64}$/.test(withPrefix)
    ? (withPrefix as `0x${string}`)
    : null;
}

export function getOgConfig(): OgConfig | null {
  const privateKey = normalizeKey(process.env.OG_PRIVATE_KEY);
  if (!privateKey) return null;
  const chainId = Number(process.env.OG_CHAIN_ID) || DEFAULTS.chainId;
  return {
    privateKey,
    storageRpc: process.env.OG_STORAGE_RPC?.trim() || DEFAULTS.storageRpc,
    storageIndexer:
      process.env.OG_STORAGE_INDEXER?.trim() || DEFAULTS.storageIndexer,
    computeRpc: process.env.OG_COMPUTE_RPC?.trim() || DEFAULTS.computeRpc,
    chainId,
  };
}
