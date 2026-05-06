import { NextResponse } from "next/server";
import { getClaimRecord, getRedis } from "@/lib/claim-redis";

/** RFC 4122 UUID v4 from `crypto.randomUUID()` */
const CLAIM_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * GET /api/proof/:claimId — JSON body of the stored .proof file (Vercel Blob, public URL).
 * Requires prior registration with proof upload (Upstash claim index + blobUrl).
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ claimId: string }> }
) {
  const { claimId } = await ctx.params;
  if (!CLAIM_ID_RE.test(claimId)) {
    return NextResponse.json({ error: "Invalid claim id" }, { status: 400 });
  }

  if (!getRedis()) {
    return NextResponse.json(
      { error: "UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not configured" },
      { status: 503 }
    );
  }

  const meta = await getClaimRecord(claimId);
  if (meta == null) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (typeof meta.blobUrl !== "string" || !meta.blobUrl.startsWith("http")) {
    return NextResponse.json(
      { error: "Claim has no stored proof URL (re-register to use Blob)" },
      { status: 404 }
    );
  }

  try {
    const res = await fetch(meta.blobUrl);
    if (!res.ok) {
      return NextResponse.json({ error: "Proof file missing" }, { status: 404 });
    }
    const json = await res.text();
    return new NextResponse(json, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      },
    });
  } catch {
    return NextResponse.json({ error: "Proof file missing" }, { status: 404 });
  }
}
