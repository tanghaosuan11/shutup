import { NextResponse } from "next/server";
import { getClaimRecord, getRedis } from "@/lib/claim-redis";

const CLAIM_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Public card fields only (no proof blob). */
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

  const rec = await getClaimRecord(claimId);
  if (rec == null || !rec.blobUrl) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    claimId,
    createdAt: rec.createdAt ?? null,
    share: rec.share ?? null,
  });
}
