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
  if (!redis) {
    console.error("[claim-redis] Redis not configured");
    return null;
  }
  const key = `claim:${claimId}`;
  try {
    const raw = await redis.get<string | ClaimRecord>(key);
    
    if (raw == null) {
      return null;
    }
    
    // Upstash Redis SDK may return already-parsed objects or strings
    if (typeof raw === 'object') {
      return raw as ClaimRecord;
    }
    
    if (typeof raw === 'string') {
      return JSON.parse(raw) as ClaimRecord;
    }
    
    return null;
  } catch (err) {
    console.error(`[claim-redis] Error processing key ${key}:`, err);
    return null;
  }
}
