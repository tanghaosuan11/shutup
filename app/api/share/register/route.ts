import { NextResponse } from "next/server";
import { getRedis } from "@/lib/claim-redis";
import type { ShareMetaStored } from "@/lib/share-meta";

const CLAIM_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * POST /api/share/register — Save proof metadata to Upstash Redis
 * Body: { claimId: string, blobUrl: string, meta: ShareMetaStored }
 * Response: { success: true, claimId: string }
 */
export async function POST(req: Request) {
  try {
    const body = await req.json() as {
      claimId?: string;
      blobUrl?: string;
      meta?: ShareMetaStored;
    };

    const { claimId, blobUrl, meta } = body;

    if (!claimId || !CLAIM_ID_RE.test(claimId)) {
      return NextResponse.json(
        { error: "Invalid claim id" },
        { status: 400 }
      );
    }

    if (typeof blobUrl !== "string" || !blobUrl.startsWith("http")) {
      return NextResponse.json(
        { error: "Invalid blob URL" },
        { status: 400 }
      );
    }

    if (!meta) {
      return NextResponse.json(
        { error: "Missing metadata" },
        { status: 400 }
      );
    }

    const redis = getRedis();
    if (!redis) {
      return NextResponse.json(
        { error: "UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not configured" },
        { status: 503 }
      );
    }

    // Store in Redis with 90-day expiry (7776000 seconds)
    const record = {
      claimId,
      blobUrl,
      share: meta,
      createdAt: new Date().toISOString(),
    };

    await redis.setex(
      `claim:${claimId}`,
      7776000, // 90 days
      JSON.stringify(record)
    );

    return NextResponse.json({
      success: true,
      claimId,
    });
  } catch (err) {
    console.error("[share-register] Error:", err);
    return NextResponse.json(
      { error: "Registration failed: " + (err as Error).message },
      { status: 500 }
    );
  }
}
