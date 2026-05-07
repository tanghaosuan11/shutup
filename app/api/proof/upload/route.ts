import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { randomUUID } from "crypto";

/**
 * POST /api/proof/upload — Upload a proof to Vercel Blob
 * Body: { proof: string (JSON) }
 * Response: { claimId: string, blobUrl: string }
 */
export async function POST(req: Request) {
  try {
    const body = await req.json() as { proof?: string };
    const proof = body.proof;

    if (typeof proof !== "string" || !proof.trim()) {
      return NextResponse.json(
        { error: "Invalid or empty proof" },
        { status: 400 }
      );
    }

    // Generate unique claim ID using crypto.randomUUID()
    const claimId = randomUUID();

    const fileName = `proofs/${claimId}.json`;

    // Upload to Vercel Blob (private by default)
    const blob = await put(fileName, proof, { access: "private" });

    return NextResponse.json({
      claimId,
      blobUrl: blob.url,
    });
  } catch (err) {
    console.error("Proof upload error:", err);
    return NextResponse.json(
      { error: "Upload failed: " + (err as Error).message },
      { status: 500 }
    );
  }
}
