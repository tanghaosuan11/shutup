import type { TokenInfo } from "@/lib/prover";
import { weiToEth } from "@/lib/utils";

export const SHARE_TEMPLATE_IDS = ["aurora", "ember", "mono"] as const;
export type ShareTemplateId = (typeof SHARE_TEMPLATE_IDS)[number];

export interface ShareMetaStored {
  assetType: "eth" | "erc20";
  symbol: string;
  thresholdLine: string;
  blockNumber: number;
  blockTimestamp: number;
  chainId: number;
  userTagLabel?: string;
  templateDefault: ShareTemplateId;
}

export function buildShareMetaForRegister(
  phase: {
    token?: TokenInfo;
    thresholdWei: string;
    blockNumber: number;
    blockTimestamp: number;
    chainId: number;
    userTagLabel: string;
  },
  templateDefault: ShareTemplateId = "aurora"
): ShareMetaStored {
  const symbol = phase.token?.symbol ?? "ETH";
  const decimals = phase.token?.decimals ?? 18;
  const rawAmount = BigInt(phase.thresholdWei);
  const humanAmt = phase.token
    ? (Number(rawAmount) / 10 ** decimals).toFixed(6).replace(/\.?0+$/, "")
    : weiToEth(rawAmount);
  const thresholdLine = `≥ ${humanAmt} ${symbol}`;
  const assetType: "eth" | "erc20" = phase.token ? "erc20" : "eth";
  const tag = phase.userTagLabel?.trim();
  return {
    assetType,
    symbol,
    thresholdLine,
    blockNumber: phase.blockNumber,
    blockTimestamp: phase.blockTimestamp,
    chainId: phase.chainId,
    ...(tag ? { userTagLabel: tag.slice(0, 64) } : {}),
    templateDefault: SHARE_TEMPLATE_IDS.includes(templateDefault)
      ? templateDefault
      : "aurora",
  };
}

export function parseShareMetaFromBody(raw: unknown): ShareMetaStored | null {
  if (raw === null || raw === undefined || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  const assetType =
    o.assetType === "erc20" ? "erc20" : o.assetType === "eth" ? "eth" : null;
  if (!assetType) return null;

  const symbol =
    typeof o.symbol === "string" && o.symbol.length > 0 && o.symbol.length <= 24
      ? o.symbol.trim()
      : null;
  if (!symbol) return null;

  const thresholdLine =
    typeof o.thresholdLine === "string" &&
    o.thresholdLine.length > 0 &&
    o.thresholdLine.length <= 160
      ? o.thresholdLine.trim()
      : null;
  if (!thresholdLine) return null;

  const blockNumber =
    typeof o.blockNumber === "number" &&
    Number.isFinite(o.blockNumber) &&
    o.blockNumber >= 0
      ? Math.floor(o.blockNumber)
      : null;
  if (blockNumber === null) return null;

  const blockTimestamp =
    typeof o.blockTimestamp === "number" &&
    Number.isFinite(o.blockTimestamp) &&
    o.blockTimestamp > 0
      ? Math.floor(o.blockTimestamp)
      : null;
  if (blockTimestamp === null) return null;

  const chainId =
    typeof o.chainId === "number" && Number.isFinite(o.chainId) && o.chainId > 0
      ? Math.floor(o.chainId)
      : null;
  if (chainId === null) return null;

  let templateDefault: ShareTemplateId = "aurora";
  if (
    typeof o.templateDefault === "string" &&
    (SHARE_TEMPLATE_IDS as readonly string[]).includes(o.templateDefault)
  ) {
    templateDefault = o.templateDefault as ShareTemplateId;
  }

  let userTagLabel: string | undefined;
  if (typeof o.userTagLabel === "string" && o.userTagLabel.trim()) {
    userTagLabel = o.userTagLabel.trim().slice(0, 64);
  }

  return {
    assetType,
    symbol,
    thresholdLine,
    blockNumber,
    blockTimestamp,
    chainId,
    templateDefault,
    ...(userTagLabel ? { userTagLabel } : {}),
  };
}
