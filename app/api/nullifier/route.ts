import { Redis } from "@upstash/redis";
import { NextResponse } from "next/server";
import { deleteProofBlob, isBlobConfigured, putProofJson } from "@/lib/blob-storage";
import { parseShareMetaFromBody, type ShareMetaStored } from "@/lib/share-meta";

const NULLIFIER_RE = /^0x[a-fA-F0-9]{64}$/;
const MAX_PROOF_BYTES = 2 * 1024 * 1024;

/**
 * POST { nullifier, proofJson?, shareMeta? }
 * Stores nullifier once (NX). Optional proofJson uploads full .proof JSON to Vercel Blob.
 * When proofJson is set, shareMeta is required (public card + OG fields).
 */
export async function POST(req: Request) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return NextResponse.json(
      { error: "UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not configured" },
      { status: 503 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const b = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};

  const nullifier = b.nullifier;
  if (typeof nullifier !== "string" || !NULLIFIER_RE.test(nullifier)) {
    return NextResponse.json(
      { error: 'Expected body { nullifier: "0x" + 64 hex chars, proofJson?: string, shareMeta?: object }' },
      { status: 400 }
    );
  }

  const proofJsonRaw = b.proofJson;
  const proofJson =
    typeof proofJsonRaw === "string" && proofJsonRaw.length > 0 ? proofJsonRaw : undefined;

  const shareMetaRaw = b.shareMeta;

  let shareStored: ShareMetaStored | undefined;
  if (proofJson) {
    if (Buffer.byteLength(proofJson, "utf8") > MAX_PROOF_BYTES) {
      return NextResponse.json(
        { error: `proofJson exceeds ${MAX_PROOF_BYTES} bytes` },
        { status: 413 }
      );
    }
    if (!isBlobConfigured()) {
      return NextResponse.json(
        {
          error:
            "proofJson requires Vercel Blob: set BLOB_READ_WRITE_TOKEN (create a Blob store in Vercel)",
        },
        { status: 503 }
      );
    }
    const share = parseShareMetaFromBody(shareMetaRaw);
    if (share === null) {
      return NextResponse.json(
        { error: "shareMeta is required and must be valid when proofJson is sent" },
        { status: 400 }
      );
    }
    shareStored = share;
  }

  const key = `wealth-proof:v1:nullifier:${nullifier.toLowerCase()}`;
  const claimId = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  const payload = proofJson
    ? JSON.stringify({
        claimId,
        createdAt,
        proofStored: true,
      })
    : JSON.stringify({
        claimId,
        createdAt,
      });

  const redis = new Redis({ url, token });
  const ok = await redis.set(key, payload, { nx: true });

  if (ok === null) {
    return NextResponse.json(
      { duplicate: true, message: "This nullifier was already registered" },
      { status: 409 }
    );
  }

  if (proofJson && shareStored) {
    let blobUrl: string | undefined;
    try {
      const uploaded = await putProofJson(claimId, proofJson);
      blobUrl = uploaded.url;
      await redis.set(
        `wealth-proof:v1:claim:${claimId}`,
        JSON.stringify({
          nullifier: nullifier.toLowerCase(),
          createdAt,
          blobUrl: uploaded.url,
          pathname: uploaded.pathname,
          share: shareStored,
        })
      );
    } catch (err) {
      if (blobUrl) await deleteProofBlob(blobUrl).catch(() => {});
      await redis.del(key).catch(() => {});
      const msg =
        err instanceof Error ? err.message : "Failed to register proof (rolled back)";
      return NextResponse.json({ error: msg }, { status: 500 });
    }

    return NextResponse.json({
      claimId,
      nullifier: nullifier.toLowerCase(),
      proofStored: true,
    });
  }

  return NextResponse.json({ claimId, nullifier: nullifier.toLowerCase() });
}
