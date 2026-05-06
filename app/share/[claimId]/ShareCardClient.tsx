"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toPng } from "html-to-image";
import type { ClaimRecord } from "@/lib/claim-redis";
import {
  SHARE_TEMPLATE_IDS,
  type ShareMetaStored,
  type ShareTemplateId,
} from "@/lib/share-meta";

const TEMPLATE_STYLES: Record<
  ShareTemplateId,
  { card: string; accent: string; badge: string; grain: string }
> = {
  aurora: {
    card: "bg-gradient-to-br from-indigo-950 via-violet-950 to-fuchsia-950 border border-violet-500/35",
    accent: "text-violet-200",
    badge: "bg-violet-500/15 text-violet-200/90 border border-violet-400/25",
    grain:
      "pointer-events-none absolute inset-0 opacity-[0.12] bg-[radial-gradient(ellipse_at_top,rgba(255,255,255,0.35),transparent_55%)]",
  },
  ember: {
    card: "bg-gradient-to-br from-orange-950 via-red-950 to-zinc-950 border border-orange-500/35",
    accent: "text-orange-200",
    badge: "bg-orange-500/15 text-orange-200/90 border border-orange-400/25",
    grain:
      "pointer-events-none absolute inset-0 opacity-[0.14] bg-[radial-gradient(ellipse_at_20%_0%,rgba(251,146,60,0.45),transparent_50%)]",
  },
  mono: {
    card: "bg-gradient-to-br from-zinc-950 via-zinc-900 to-black border border-zinc-600/40",
    accent: "text-zinc-200",
    badge: "bg-white/5 text-zinc-300 border border-zinc-500/30",
    grain:
      "pointer-events-none absolute inset-0 opacity-[0.08] bg-[linear-gradient(120deg,transparent,rgba(255,255,255,0.06),transparent)]",
  },
};

function formatBlockTime(unixSec: number): string {
  try {
    return new Date(unixSec * 1000).toLocaleString("zh-CN", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

export default function ShareCardClient({
  claimId,
  initial,
}: {
  claimId: string;
  initial: ClaimRecord;
}) {
  const searchParams = useSearchParams();
  const share = initial.share;
  const [template, setTemplate] = useState<ShareTemplateId>(
    share?.templateDefault ?? "aurora"
  );

  useEffect(() => {
    const t = searchParams.get("t");
    if (t && (SHARE_TEMPLATE_IDS as readonly string[]).includes(t)) {
      setTemplate(t as ShareTemplateId);
    }
  }, [searchParams]);
  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const st = TEMPLATE_STYLES[template];

  const shareUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    const u = new URL(`/share/${claimId}`, window.location.origin);
    u.searchParams.set("t", template);
    return u.toString();
  }, [claimId, template]);

  const copyLink = useCallback(() => {
    if (!shareUrl) return;
    void navigator.clipboard.writeText(shareUrl);
  }, [shareUrl]);

  const exportPng = useCallback(async () => {
    const el = cardRef.current;
    if (!el) return;
    setExporting(true);
    setExportErr(null);
    try {
      const dataUrl = await toPng(el, {
        pixelRatio: 2,
        cacheBust: true,
        backgroundColor: "#09090b",
      });
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = `wealth-proof-${claimId.slice(0, 8)}-${template}.png`;
      a.click();
    } catch (e) {
      setExportErr(e instanceof Error ? e.message : "导出失败");
    } finally {
      setExporting(false);
    }
  }, [claimId, template]);

  const fallback: ShareMetaStored | null = share ?? null;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col items-center px-4 py-8 pb-16">
      <div className="w-full max-w-lg space-y-5">
        <header className="text-center space-y-1">
          <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Share card</p>
          <h1 className="text-lg font-semibold text-zinc-100">零知识资产证明</h1>
          <p className="text-[11px] text-zinc-500 font-mono break-all">{claimId}</p>
        </header>

        <div className="flex flex-wrap justify-center gap-1.5">
          {SHARE_TEMPLATE_IDS.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setTemplate(id)}
              className={`px-3 py-1 rounded-full text-[11px] font-medium border transition-colors ${
                template === id
                  ? "bg-violet-600 border-violet-500 text-white"
                  : "bg-zinc-900 border-zinc-700 text-zinc-400 hover:border-zinc-600"
              }`}
            >
              {id === "aurora" ? "极光" : id === "ember" ? "余烬" : "极简"}
            </button>
          ))}
        </div>

        <div className="flex justify-center">
          <div
            ref={cardRef}
            className={`relative w-[360px] max-w-full overflow-hidden rounded-3xl shadow-2xl ${st.card}`}
          >
            <div className={st.grain} aria-hidden />
            <div className="relative p-8 flex flex-col gap-8 min-h-[520px]">
              <div className="flex justify-between items-start gap-3">
                <div>
                  <p className={`text-[10px] uppercase tracking-[0.25em] font-semibold ${st.accent}`}>
                    ShutUp
                  </p>
                  <p className="text-zinc-500 text-[11px] mt-2 leading-snug">
                    不暴露地址 · Plonk 证明可离线验证
                  </p>
                </div>
                <span
                  className={`shrink-0 text-[10px] font-mono px-2.5 py-1 rounded-full ${st.badge}`}
                >
                  {claimId.slice(0, 8)}…
                </span>
              </div>

              <div className="space-y-3">
                {fallback ? (
                  <>
                    <p className="text-4xl sm:text-[2.6rem] font-bold tracking-tight text-white leading-tight">
                      {fallback.thresholdLine}
                    </p>
                    <p className="text-zinc-400 text-sm">
                      Ethereum Mainnet · #{fallback.blockNumber} ·{" "}
                      {fallback.assetType === "erc20" ? `${fallback.symbol} (ERC20)` : "原生 ETH"}
                    </p>
                    <p className="text-zinc-500 text-xs">
                      区块时间 {formatBlockTime(fallback.blockTimestamp)}
                    </p>
                    {fallback.userTagLabel ? (
                      <p className="text-violet-300/90 text-sm">标签 · {fallback.userTagLabel}</p>
                    ) : null}
                  </>
                ) : (
                  <div className="space-y-2 text-zinc-400 text-sm">
                    <p>该登记暂无分享元数据。</p>
                    <p className="text-xs text-zinc-500">
                      请使用最新版本重新勾选「登记」生成卡片数据。
                    </p>
                  </div>
                )}
              </div>

              <div className="mt-auto pt-4 border-t border-white/10 flex justify-between items-end text-[10px] text-zinc-500">
                <span>UltraHonk · Noir</span>
                <span className="font-mono">chain {fallback?.chainId ?? "—"}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-2 justify-center items-stretch sm:items-center">
          <button
            type="button"
            onClick={() => void exportPng()}
            disabled={exporting}
            className="px-4 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-sm font-medium transition-colors"
          >
            {exporting ? "导出中…" : "导出 PNG（发朋友圈）"}
          </button>
          <button
            type="button"
            onClick={copyLink}
            className="px-4 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-sm font-medium transition-colors"
          >
            复制分享链接（含模板）
          </button>
        </div>
        {exportErr ? (
          <p className="text-center text-red-400/90 text-xs">{exportErr}</p>
        ) : null}

        <p className="text-center text-zinc-600 text-[10px] leading-relaxed max-w-sm mx-auto">
          X / 微信等会使用本页自动生成的 OG 图（与登记时模板一致，默认极光）。导出 PNG
          为当前所选皮肤的高分辨率快照；复制链接带 <span className="font-mono">?t=</span>{" "}
          便于对方打开同款皮肤。
        </p>
      </div>
    </div>
  );
}
