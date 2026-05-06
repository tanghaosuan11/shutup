import { Redis } from "@upstash/redis";
import type { ShareMetaStored } from "@/lib/share-meta";

export interface ClaimRecord {
  nullifier?: string;
  createdAt?: string;
  blobUrl?: string;
  pathname?: string;
  share?: ShareMetaStored;
}

export function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export async function getClaimRecord(claimId: string): Promise<ClaimRecord | null> {
  const redis = getRedis();
  if (!redis) return null;
  const raw = await redis.get<string>(`wealth-proof:v1:claim:${claimId}`);
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as ClaimRecord;
  } catch {
    return null;
  }
}
