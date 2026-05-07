import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getClaimRecord } from "@/lib/claim-redis";
import ShareCardClient from "./ShareCardClient";

const CLAIM_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ claimId: string }>;
}): Promise<Metadata> {
  const { claimId } = await params;
  if (!CLAIM_ID_RE.test(claimId)) {
    return { title: "Not found" };
  }
  const rec = await getClaimRecord(claimId);
  const ogTitle = rec?.share?.thresholdLine
    ? `${rec.share.thresholdLine} · ZK Wealth Proof`
    : "ZK Wealth Proof";
  const desc = rec?.share
    ? `Ethereum · #${rec.share.blockNumber} · 零知识资产证明`
    : "零知识资产证明分享卡片";

  const path = `/share/${claimId}`;

  return {
    title: ogTitle,
    description: desc,
    openGraph: {
      title: ogTitle,
      description: desc,
      type: "website",
      url: path,
      images: [
        {
          url: `${path}/opengraph-image`,
          width: 1200,
          height: 630,
          alt: ogTitle,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: ogTitle,
      description: desc,
    },
  };
}

export default async function SharePage({
  params,
}: {
  params: Promise<{ claimId: string }>;
}) {
  const { claimId } = await params;
  
  if (!CLAIM_ID_RE.test(claimId)) notFound();

  const rec = await getClaimRecord(claimId);
  if (rec == null || !rec.blobUrl) notFound();

  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-zinc-950 flex items-center justify-center text-zinc-500 text-sm">
          加载中…
        </div>
      }
    >
      <ShareCardClient claimId={claimId} initial={rec} />
    </Suspense>
  );
}
