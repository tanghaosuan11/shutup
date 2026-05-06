import { ImageResponse } from "next/og";
import { getClaimRecord } from "@/lib/claim-redis";
import type { ShareMetaStored } from "@/lib/share-meta";

export const runtime = "nodejs";
export const alt = "Wealth Proof";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const CLAIM_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function palette(t: ShareMetaStored["templateDefault"] | undefined) {
  switch (t) {
    case "ember":
      return {
        bg: "linear-gradient(135deg, #431407 0%, #7f1d1d 45%, #0c0a09 100%)",
        accent: "#fb923c",
        badge: "rgba(251, 146, 60, 0.15)",
      };
    case "mono":
      return {
        bg: "linear-gradient(135deg, #09090b 0%, #27272a 50%, #18181b 100%)",
        accent: "#d4d4d8",
        badge: "rgba(255,255,255,0.06)",
      };
    default:
      return {
        bg: "linear-gradient(135deg, #1e1b4b 0%, #581c87 50%, #0f172a 100%)",
        accent: "#c4b5fd",
        badge: "rgba(196, 181, 253, 0.12)",
      };
  }
}

async function loadCnFont(): Promise<ArrayBuffer | undefined> {
  try {
    const res = await fetch(
      "https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-sc@5.2.5/files/noto-sans-sc-chinese-simplified-700-normal.woff"
    );
    if (!res.ok) return undefined;
    return await res.arrayBuffer();
  } catch {
    return undefined;
  }
}

export default async function Image({
  params,
}: {
  params: Promise<{ claimId: string }>;
}) {
  const { claimId } = await params;
  const p = palette(undefined);
  const shortId = claimId.slice(0, 8);

  if (!CLAIM_ID_RE.test(claimId)) {
    return new ImageResponse(
      (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: p.bg,
            color: "#94a3b8",
            fontSize: 42,
          }}
        >
          Invalid link
        </div>
      ),
      { ...size }
    );
  }

  const rec = await getClaimRecord(claimId);
  const share = rec?.share;
  const pal = palette(share?.templateDefault);
  const fontData = await loadCnFont();

  const title = share?.thresholdLine ?? "ZK Wealth Proof";
  const sub = share
    ? `Ethereum Mainnet · #${share.blockNumber} · ${share.assetType === "erc20" ? "ERC20" : "ETH"}`
    : `Claim ${shortId}…`;
  const tag = share?.userTagLabel ? `标签 · ${share.userTagLabel}` : "零知识 · 不暴露地址与余额";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 64,
          background: pal.bg,
          color: "#fafafa",
          fontFamily: fontData ? "Noto Sans SC" : "system-ui, sans-serif",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div
            style={{
              fontSize: 28,
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: pal.accent,
            }}
          >
            ShutUp
          </div>
          <div
            style={{
              fontSize: 22,
              color: "#a1a1aa",
              backgroundColor: pal.badge,
              padding: "10px 18px",
              borderRadius: 999,
            }}
          >
            {shortId}…
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ fontSize: 72, fontWeight: 800, lineHeight: 1.1 }}>{title}</div>
          <div style={{ fontSize: 34, color: "#cbd5e1" }}>{sub}</div>
          <div style={{ fontSize: 28, color: "#94a3b8" }}>{tag}</div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
          <div style={{ fontSize: 24, color: "#64748b" }}>Plonk · UltraHonk · 本地可验证</div>
          <div style={{ fontSize: 24, color: "#64748b" }}>wealth-proof</div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: fontData
        ? [
            {
              name: "Noto Sans SC",
              data: fontData,
              style: "normal",
              weight: 700,
            },
          ]
        : [],
    }
  );
}
