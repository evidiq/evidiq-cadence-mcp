import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OgConfig } from "./config.js";
import { getOgConfig } from "./config.js";

export type StorageResult =
  | { ok: true; root: string; tx: string }
  | { ok: false; error: string };

const UPLOAD_TIMEOUT_MS = 30_000;

function indexerCandidates(cfg: OgConfig): string[] {
  const testnet = cfg.chainId !== 16661;
  const list = testnet
    ? [
        cfg.storageIndexer,
        "https://indexer-storage-testnet-turbo.0g.ai",
        "https://indexer-storage-testnet-standard.0g.ai",
      ]
    : [cfg.storageIndexer, "https://indexer-storage-turbo.0g.ai"];
  return list.filter((v, i) => Boolean(v) && list.indexOf(v) === i);
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

function extractRootTx(result: unknown): { root: string; tx: string } | null {
  if (!result || typeof result !== "object") return null;
  const o = result as Record<string, unknown>;
  const root =
    (typeof o.rootHash === "string" && o.rootHash) ||
    (Array.isArray(o.rootHashes) && typeof o.rootHashes[0] === "string"
      ? (o.rootHashes[0] as string)
      : "");
  const tx =
    (typeof o.txHash === "string" && o.txHash) ||
    (Array.isArray(o.txHashes) && typeof o.txHashes[0] === "string"
      ? (o.txHashes[0] as string)
      : "");
  return root && tx ? { root, tx } : null;
}

export async function uploadJson(
  cfg: OgConfig,
  data: unknown,
  filename = "evidiq-cadence.json"
): Promise<StorageResult> {
  try {
    return await withTimeout(uploadInner(cfg, data, filename), UPLOAD_TIMEOUT_MS, "0G upload");
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function uploadInner(
  cfg: OgConfig,
  data: unknown,
  filename: string
): Promise<StorageResult> {
  const { Indexer, ZgFile } = await import("@0gfoundation/0g-ts-sdk");
  const { ethers } = await import("ethers");

  const dir = await mkdtemp(join(tmpdir(), "evidiq-cadence-og-"));
  const filePath = join(dir, filename);

  try {
    await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
    const file = await ZgFile.fromFilePath(filePath);

    try {
      const provider = new ethers.JsonRpcProvider(cfg.storageRpc);
      const signer = new ethers.Wallet(cfg.privateKey, provider);

      let lastError = "0G storage upload failed across all endpoints";
      for (const indexerUrl of indexerCandidates(cfg)) {
        try {
          const indexer = new Indexer(indexerUrl);
          type UploadSigner = Parameters<typeof indexer.upload>[2];
          const [result, uploadError] = await indexer.upload(
            file,
            cfg.storageRpc,
            signer as unknown as UploadSigner
          );
          if (uploadError) {
            lastError = String(uploadError);
            continue;
          }
          const parsed = extractRootTx(result);
          if (parsed) return { ok: true, ...parsed };
          lastError = "upload succeeded but no root/tx hash was returned";
        } catch (err) {
          lastError = (err as Error).message;
        }
      }
      return { ok: false, error: lastError };
    } finally {
      await file.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Anchor an attestation bundle to 0G Storage. Returns the merkle root + upload
 * tx on success, or a labeled error on failure. Best-effort: the caller never
 * fails the paid result over anchoring; the attestation stays valid without
 * it, and "anchored" is only ever reported from a real upload result.
 */
export async function anchorToOgStorage(data: Record<string, any>): Promise<StorageResult> {
  const cfg = getOgConfig();
  if (!cfg) {
    return { ok: false, error: "0G Storage not configured (OG_PRIVATE_KEY missing)" };
  }
  return uploadJson(cfg, data);
}
