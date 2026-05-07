"use client";

// WASM modules (@noir-lang/noir_js, @aztec/bb.js) cannot run during SSR.
// This dynamic import with ssr:false ensures the page is only rendered client-side.
import dynamic from "next/dynamic";
export default dynamic(() => Promise.resolve(ProofApp), { ssr: false });

import { useState, useRef, useCallback, useEffect } from "react";
import { parseEther, keccak256 } from "ethers";
import { weiToEth, truncHex, formatAge, freshnessWarning } from "@/lib/utils";
import { KNOWN_ERC20_TOKENS, type TokenInfo } from "@/lib/prover";

// ── Types ─────────────────────────────────────────────────────────────────────

type Mode = "generate" | "verify";

type GenPhase =
  | { status: "idle" }
  | { status: "proving"; pct: number; msg: string }
  | {
      status: "done";
      stateRoot: string;
      blockNumber: number;
      blockTimestamp: number;
      chainId: number;
      thresholdWei: string;
      commitmentHex: string;
      proofGenerationMs: number;
      proofHex: string;
      proofBytes: Uint8Array;
      publicInputs: string[];
      userTag: string;
      userTagLabel: string;
      token?: TokenInfo; // undefined = ETH
      shareUrl?: string; // uploaded share link
      uploading?: boolean; // currently uploading
    }
  | { status: "error"; message: string };

type VerifyPhase =
  | { status: "idle" }
  | { status: "verifying"; msg: string }
  | { status: "valid"; summary: VerifySummary }
  | { status: "invalid" }
  | { status: "error"; message: string };

interface VerifySummary {
  stateRoot?: string;
  threshold?: string;
  commitment?: string;
  userTagLabel?: string;
  blockNumber?: number;
  blockTimestamp?: number;
  chainId?: number;
  token?: TokenInfo;
}

// ── Component ─────────────────────────────────────────────────────────────────

function ProofApp() {
  const [mode, setMode] = useState<Mode>("generate");

  // Generate state
  const [threshold, setThreshold] = useState("1");
  const [userTagLabel, setUserTagLabel] = useState("");
  const [customRpcUrl, setCustomRpcUrl] = useState("");
  const [customBlockNumber, setCustomBlockNumber] = useState("");
  const [enableAutoUpload, setEnableAutoUpload] = useState(false);
  // "ETH" = native ETH; any other symbol = ERC20 token
  const [selectedToken, setSelectedToken] = useState<"ETH" | string>("ETH");
  const [genPhase, setGenPhase] = useState<GenPhase>({ status: "idle" });

  // Verify state
  const [verifyPhase, setVerifyPhase] = useState<VerifyPhase>({ status: "idle" });

  const workerRef = useRef<Worker | null>(null);

  const handleProve = useCallback(async () => {
    workerRef.current?.terminate();
    const token = KNOWN_ERC20_TOKENS.find((t) => t.symbol === selectedToken);
    const isErc20 = !!token;
    let thresholdWei: bigint;
    try {
      // Parse threshold as raw token units: user inputs in human units (ETH / token decimals)
      const decimals = token ? token.decimals : 18;
      const factor = 10n ** BigInt(decimals);
      // parseEther works for any 18-decimal token; for non-18 we scale manually
      const parsed = parseEther(threshold || "0");
      thresholdWei = decimals === 18 ? parsed : (parsed * factor / (10n ** 18n));
    } catch {
      setGenPhase({ status: "error", message: "请输入有效的数值（如 0.000001）" });
      return;
    }
    setGenPhase({ status: "proving", pct: 0, msg: "Starting..." });

    let walletData;
    try {
      if (isErc20) {
        const { fetchWalletDataERC20 } = await import("@/lib/prover");
        walletData = await fetchWalletDataERC20(
          token, thresholdWei, userTagLabel, customRpcUrl || undefined, customBlockNumber || undefined,
          (pct, msg) => setGenPhase({ status: "proving", pct, msg })
        );
      } else {
        const { fetchWalletData } = await import("@/lib/prover");
        walletData = await fetchWalletData(
          thresholdWei, userTagLabel, customRpcUrl || undefined, customBlockNumber || undefined,
          (pct, msg) => setGenPhase({ status: "proving", pct, msg })
        );
      }
    } catch (err) {
      setGenPhase({ status: "error", message: (err as Error).message });
      return;
    }

    const worker = new Worker(
      new URL("@/lib/prover.worker.ts", import.meta.url),
      { type: "module" }
    );
    workerRef.current = worker;

    worker.onmessage = (e) => {
      const data = e.data;
      if (data.type === "progress") {
        setGenPhase({ status: "proving", pct: data.pct, msg: data.msg });
      } else if (data.type === "done") {
        const r = data.result;
        const newPhase: Extract<GenPhase, { status: "done" }> = {
          status: "done",
          stateRoot: r.stateRoot,
          blockNumber: r.blockNumber,
          blockTimestamp: r.blockTimestamp,
          chainId: r.chainId,
          thresholdWei: r.thresholdWei,
          commitmentHex: r.commitmentHex,
          proofGenerationMs: r.proofGenerationMs,
          proofHex: Buffer.from(r.proof).toString("hex"),
          proofBytes: r.proof,
          publicInputs: r.publicInputs,
          userTag: r.userTag,
          userTagLabel: r.userTagLabel,
          token: r.token,
        };
        setGenPhase(newPhase);
        worker.terminate();

        // Auto-upload if enabled
        if (enableAutoUpload) {
          // Call handleUpload after state update
          // handleUpload will use the updated genPhase
          setTimeout(() => handleUpload(), 0);
        }
      } else if (data.type === "error") {
        setGenPhase({ status: "error", message: data.message });
        worker.terminate();
      }
    };
    worker.onerror = (e) => {
      setGenPhase({ status: "error", message: e.message });
      worker.terminate();
    };
    worker.postMessage({
      type: "prove",
      assetType: isErc20 ? "erc20" : "eth",
      thresholdWei: thresholdWei.toString(),
      walletData,
    });
  }, [threshold, userTagLabel, customRpcUrl, customBlockNumber, selectedToken]);

  const handleGenReset = () => {
    workerRef.current?.terminate();
    setGenPhase({ status: "idle" });
  };

  const handleDownload = () => {
    if (genPhase.status !== "done") return;
    const payload = JSON.stringify({
      plonkProof: genPhase.proofHex,
      publicInputs: genPhase.publicInputs,
      assetType: genPhase.token ? "erc20" : "eth",
      token: genPhase.token ?? null,
      stateRoot: genPhase.stateRoot,
      blockNumber: genPhase.blockNumber,
      blockTimestamp: genPhase.blockTimestamp,
      chainId: genPhase.chainId,
      threshold: genPhase.thresholdWei,
      commitment: genPhase.commitmentHex,
      userTag: genPhase.userTag,
      userTagLabel: genPhase.userTagLabel,
    }, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const symbol = genPhase.token?.symbol ?? "ETH";
    a.download = `wealth-proof-${symbol}-${Date.now()}.proof`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleUpload = async () => {
    if (genPhase.status !== "done") return;
    
    setGenPhase(prev => 
      prev.status === "done" 
        ? { ...prev, uploading: true }
        : prev
    );

    try {
      const { buildShareMetaForRegister } = await import("@/lib/share-meta");
      const proofPayload = JSON.stringify({
        plonkProof: genPhase.proofHex,
        publicInputs: genPhase.publicInputs,
        assetType: genPhase.token ? "erc20" : "eth",
        token: genPhase.token ?? null,
        stateRoot: genPhase.stateRoot,
        blockNumber: genPhase.blockNumber,
        blockTimestamp: genPhase.blockTimestamp,
        chainId: genPhase.chainId,
        threshold: genPhase.thresholdWei,
        commitment: genPhase.commitmentHex,
        userTag: genPhase.userTag,
        userTagLabel: genPhase.userTagLabel,
      });

      // Upload proof to Vercel Blob
      const blobResp = await fetch("/api/proof/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proof: proofPayload,
        }),
      });

      if (!blobResp.ok) {
        throw new Error(`Blob upload failed: ${blobResp.status}`);
      }

      const { claimId, blobUrl } = await blobResp.json() as { claimId: string; blobUrl: string };

      // Save metadata to Upstash Redis
      const meta = buildShareMetaForRegister({
        token: genPhase.token,
        thresholdWei: genPhase.thresholdWei,
        blockNumber: genPhase.blockNumber,
        blockTimestamp: genPhase.blockTimestamp,
        chainId: genPhase.chainId,
        userTagLabel: genPhase.userTagLabel,
      });

      const regResp = await fetch("/api/share/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          claimId,
          blobUrl,
          meta,
        }),
      });

      if (!regResp.ok) {
        throw new Error(`Registration failed: ${regResp.status}`);
      }

      const shareUrl = `/share/${claimId}`;
      setGenPhase(prev =>
        prev.status === "done"
          ? { ...prev, shareUrl, uploading: false }
          : prev
      );
    } catch (err) {
      setGenPhase(prev =>
        prev.status === "done"
          ? { ...prev, uploading: false }
          : prev
      );
      alert("上传失败: " + (err as Error).message);
    }
  };

  // ── Verify (shared between file-upload and generated proof) ──────────────
  const runVerify = useCallback((proofHex: string, publicInputs: string[], summary: VerifySummary, assetType: "eth" | "erc20" = "eth") => {
    workerRef.current?.terminate();
    setVerifyPhase({ status: "verifying", msg: "加载验证器..." });

    const proofBytes = Uint8Array.from(Buffer.from(proofHex, "hex"));
    const proofCopy = proofBytes.slice();

    const worker = new Worker(
      new URL("@/lib/prover.worker.ts", import.meta.url),
      { type: "module" }
    );
    workerRef.current = worker;

    worker.onmessage = (e) => {
      const data = e.data;
      if (data.type === "progress") {
        setVerifyPhase({ status: "verifying", msg: data.msg });
      } else if (data.type === "verified") {
        setVerifyPhase(data.valid ? { status: "valid", summary } : { status: "invalid" });
        worker.terminate();
      } else if (data.type === "error") {
        setVerifyPhase({ status: "error", message: data.message });
        worker.terminate();
      }
    };
    worker.onerror = (e) => {
      setVerifyPhase({ status: "error", message: e.message });
      worker.terminate();
    };
    worker.postMessage(
      { type: "verify", assetType, proof: proofCopy.buffer, publicInputs },
      { transfer: [proofCopy.buffer] }
    );
  }, []);

  // Called from DoneView — switches to verify tab and starts immediately
  const handleVerifyGenerated = useCallback(() => {
    if (genPhase.status !== "done") return;
    setMode("verify");
    runVerify(genPhase.proofHex, genPhase.publicInputs, {
      stateRoot: genPhase.stateRoot,
      threshold: genPhase.thresholdWei,
      commitment: genPhase.commitmentHex,
      userTagLabel: genPhase.userTagLabel,
      blockNumber: genPhase.blockNumber,
      blockTimestamp: genPhase.blockTimestamp,
      chainId: genPhase.chainId,
      token: genPhase.token,
    }, genPhase.token ? "erc20" : "eth");
  }, [genPhase, runVerify]);

  const handleVerifyReset = () => {
    workerRef.current?.terminate();
    setVerifyPhase({ status: "idle" });
  };

  const switchMode = (m: Mode) => {
    workerRef.current?.terminate();
    setMode(m);
  };

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
      <div className="w-full max-w-lg space-y-6">

        {/* Header */}
        <div className="text-center space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">
            ShutUp
          </h1>
          <p className="text-zinc-400 text-sm">
            用零知识证明展示资产，不暴露地址与余额
          </p>
        </div>

        {/* Tab switcher */}
        <div className="flex gap-1 bg-zinc-900 border border-zinc-800 rounded-xl p-1">
          <button
            onClick={() => switchMode("generate")}
            className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
              mode === "generate"
                ? "bg-violet-600 text-white shadow-sm"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            生成证明
          </button>
          <button
            onClick={() => switchMode("verify")}
            className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
              mode === "verify"
                ? "bg-violet-600 text-white shadow-sm"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            验证证明
          </button>
        </div>

        {/* Card */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 space-y-5">
          {mode === "generate" && (
            <>
              {genPhase.status === "idle" && (
                <IdleForm
                  threshold={threshold}
                  onChangeThreshold={setThreshold}
                  userTagLabel={userTagLabel}
                  onChangeUserTagLabel={setUserTagLabel}
                  customRpcUrl={customRpcUrl}
                  onChangeCustomRpcUrl={setCustomRpcUrl}
                  customBlockNumber={customBlockNumber}
                  onChangeCustomBlockNumber={setCustomBlockNumber}
                  enableAutoUpload={enableAutoUpload}
                  onChangeEnableAutoUpload={setEnableAutoUpload}
                  selectedToken={selectedToken}
                  onChangeSelectedToken={setSelectedToken}
                  onProve={handleProve}
                />
              )}
              {genPhase.status === "proving" && (
                <ProvingView pct={genPhase.pct} msg={genPhase.msg} />
              )}
              {genPhase.status === "done" && (
                <DoneView 
                  phase={genPhase} 
                  onReset={handleGenReset} 
                  onDownload={handleDownload} 
                  onUpload={handleUpload}
                  onVerify={handleVerifyGenerated}
                />
              )}
              {genPhase.status === "error" && (
                <ErrorView message={genPhase.message} onReset={handleGenReset} />
              )}
            </>
          )}
          {mode === "verify" && (
            <VerifyView phase={verifyPhase} onRun={runVerify} onReset={handleVerifyReset} />
          )}
        </div>

        {/* Footer */}
        <p className="text-center text-zinc-600 text-xs">
          所有计算在浏览器本地完成 · 零服务器知情 · 基于 Noir + barretenberg
        </p>
      </div>
    </main>
  );
}

// ── Sub-views ─────────────────────────────────────────────────────────────────

function IdleForm({
  threshold,
  onChangeThreshold,
  userTagLabel,
  onChangeUserTagLabel,
  customRpcUrl,
  onChangeCustomRpcUrl,
  customBlockNumber,
  onChangeCustomBlockNumber,
  enableAutoUpload,
  onChangeEnableAutoUpload,
  selectedToken,
  onChangeSelectedToken,
  onProve,
}: {
  threshold: string;
  onChangeThreshold: (v: string) => void;
  userTagLabel: string;
  onChangeUserTagLabel: (v: string) => void;
  customRpcUrl: string;
  onChangeCustomRpcUrl: (v: string) => void;
  customBlockNumber: string;
  onChangeCustomBlockNumber: (v: string) => void;
  enableAutoUpload: boolean;
  onChangeEnableAutoUpload: (v: boolean) => void;
  selectedToken: string;
  onChangeSelectedToken: (v: string) => void;
  onProve: () => void;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const token = KNOWN_ERC20_TOKENS.find((t) => t.symbol === selectedToken);
  const tokenLabel = token ? token.symbol : "ETH";
  return (
    <div className="space-y-5">
      {/* Token selector */}
      <div className="space-y-2">
        <label className="block text-sm font-medium text-zinc-300">资产类型</label>
        <div className="flex flex-wrap gap-2">
          {["ETH", ...KNOWN_ERC20_TOKENS.map((t) => t.symbol)].map((sym) => (
            <button
              key={sym}
              type="button"
              onClick={() => onChangeSelectedToken(sym)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                selectedToken === sym
                  ? "bg-violet-600 border-violet-500 text-white"
                  : "bg-zinc-800 border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600"
              }`}
            >
              {sym}
            </button>
          ))}
        </div>
        {token && (
          <p className="text-zinc-600 text-xs font-mono truncate">{token.address}</p>
        )}
      </div>

      <div className="space-y-2">
        <label className="block text-sm font-medium text-zinc-300">
          要证明持有 ≥
        </label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min="0"
            step="0.1"
            value={threshold}
            onChange={(e) => onChangeThreshold(e.target.value)}
            className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-2.5 text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 placeholder:text-zinc-600"
            placeholder="1"
          />
          <span className="text-zinc-400 font-medium">{tokenLabel}</span>
        </div>
      </div>
      <div className="space-y-2">
        <label className="block text-sm font-medium text-zinc-300">
          个人标签 <span className="text-zinc-500 font-normal">(可选，用于区分证明来源)</span>
        </label>
        <input
          type="text"
          maxLength={64}
          value={userTagLabel}
          onChange={(e) => onChangeUserTagLabel(e.target.value)}
          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-2.5 text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 placeholder:text-zinc-600"
          placeholder="@你的推特用户名 或 任意文字  (空白 = 自动生成随机 64 位 hex)"
        />
        <p className="text-zinc-500 text-xs">
          标签会被包含在证明里并公开显示——转发证明的人无法伪装拥有你的标签
        </p>
        <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-zinc-800/50 border border-zinc-700">
          <input
            type="checkbox"
            id="auto-upload"
            checked={enableAutoUpload}
            onChange={(e) => onChangeEnableAutoUpload(e.target.checked)}
            className="w-4 h-4 rounded cursor-pointer"
          />
          <label htmlFor="auto-upload" className="flex-1 cursor-pointer">
            <p className="text-xs font-medium text-zinc-300">生成后自动上传并分享</p>
            <p className="text-xs text-zinc-600 mt-0.5">证明生成完成后自动上传到云端，获得分享链接</p>
          </label>
        </div>
      </div>
      <p className="text-zinc-500 text-xs">
        {token ? "ERC20 证明含两次 MPT 验证，约需 60–120 秒，请保持页面开启" : "证明生成约需 40–90 秒，期间请保持页面开启"}
      </p>

      {/* Advanced settings — custom RPC */}
      <div className="border border-zinc-800 rounded-xl overflow-hidden">
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="w-full flex items-center justify-between px-4 py-2.5 text-xs text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/60 transition-colors"
        >
          <span>高级设置</span>
          <span className="font-mono">{showAdvanced ? "▲" : "▼"}</span>
        </button>
        {showAdvanced && (
          <div className="px-4 pb-4 pt-1 space-y-3 border-t border-zinc-800">
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1">
                块号 <span className="text-zinc-600 font-normal">(留空则使用最新块)</span>
              </label>
              <input
                type="number"
                min="0"
                value={customBlockNumber}
                onChange={(e) => onChangeCustomBlockNumber(e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-zinc-100 text-xs focus:outline-none focus:ring-2 focus:ring-violet-500 placeholder:text-zinc-600"
                placeholder="例：20000000（留空则自动用当前块）"
              />
              <p className="text-zinc-600 text-xs mt-1">
                用于为过往某个块生成证明。需要提供能访问历史数据的 RPC 节点。
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1">
                自定义 RPC URL&nbsp;
                <span className="text-zinc-600 font-normal">(留空则使用公共节点)</span>
              </label>
              <input
                type="url"
                value={customRpcUrl}
                onChange={(e) => onChangeCustomRpcUrl(e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-zinc-100 text-xs focus:outline-none focus:ring-2 focus:ring-violet-500 placeholder:text-zinc-600"
                placeholder="https://mainnet.infura.io/v3/YOUR_KEY"
              />
              <p className="text-zinc-600 text-xs mt-1">
                使用自己的节点或 Alchemy / Infura 私钥可提升隐私性，并支持历史归档数据。
                填写后将优先使用此节点，失败则自动回退到公共节点。
              </p>
            </div>
          </div>
        )}
      </div>

      <button
        onClick={onProve}
        className="w-full py-3 rounded-xl bg-violet-600 hover:bg-violet-500 active:bg-violet-700 font-semibold transition-colors"
      >
        连接钱包并生成证明
      </button>
      <div className="border-t border-zinc-800 pt-4 space-y-1 text-xs text-zinc-500">
        <p>✓ 不会发起任何交易或签名</p>
        <p>✓ 服务器看不到你的地址或余额</p>
        <p>✓ 证明可分享给任何人验证</p>
      </div>
    </div>
  );
}

function ProvingView({ pct, msg }: { pct: number; msg: string }) {
  return (
    <div className="space-y-4 py-2">
      <div className="space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-zinc-300">生成证明中...</span>
          <span className="text-violet-400 font-mono">{pct}%</span>
        </div>
        <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-violet-600 rounded-full transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="text-zinc-500 text-xs truncate">{msg}</p>
      </div>
      <p className="text-center text-zinc-500 text-xs">
        请勿关闭或切换页面 · WASM 正在运行 Plonk 证明
      </p>
    </div>
  );
}

function DoneView({
  phase,
  onReset,
  onDownload,
  onUpload,
  onVerify,
}: {
  phase: Extract<GenPhase, { status: "done" }>;
  onReset: () => void;
  onDownload: () => void;
  onUpload: () => void;
  onVerify: () => void;
}) {
  const symbol = phase.token?.symbol ?? "ETH";
  const decimals = phase.token?.decimals ?? 18;
  const rawAmount = BigInt(phase.thresholdWei);
  const humanAmt = phase.token
    ? (Number(rawAmount) / 10 ** decimals).toFixed(6).replace(/\.?0+$/, "")
    : weiToEth(rawAmount);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 bg-emerald-950/50 border border-emerald-700/40 rounded-xl p-4">
        <span className="text-2xl">✅</span>
        <div>
          <p className="font-semibold text-emerald-300">证明生成成功</p>
          <p className="text-emerald-400/70 text-xs mt-0.5">
            持有 ≥ {humanAmt} {symbol} 已得到零知识证明
          </p>
        </div>
      </div>
      <div className="space-y-2 text-sm">
        <Row label="资产" value={symbol + (phase.token ? ` (ERC20)` : " (原生)")} />
        <Row label="区块高度" value={`#${phase.blockNumber}`} />
        <Row label="区块时间" value={`${new Date(phase.blockTimestamp * 1000).toLocaleString("zh-CN")}（${formatAge(phase.blockTimestamp)}）`} />
        <Row label="链" value={`Ethereum Mainnet (chainId=${phase.chainId})`} />
        <Row label="状态根" value={truncHex(phase.stateRoot)} mono />
        <Row label="地址承诺" value={truncHex(phase.commitmentHex)} mono />
        <Row label="生成耗时" value={`${(phase.proofGenerationMs / 1000).toFixed(1)}s`} />
        {phase.userTagLabel && <Row label="标签" value={phase.userTagLabel} />}
      </div>
      <div className="flex gap-2">
        <button
          onClick={onDownload}
          className="flex-1 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-500 font-medium text-sm transition-colors"
        >
          下载 .proof
        </button>
        <button
          onClick={onUpload}
          disabled={phase.uploading || !!phase.shareUrl}
          className={`flex-1 py-2.5 rounded-xl font-medium text-sm transition-colors ${
            phase.uploading || phase.shareUrl
              ? "bg-zinc-700 text-zinc-400 cursor-not-allowed"
              : "bg-emerald-600 hover:bg-emerald-500"
          }`}
        >
          {phase.uploading ? "上传中..." : phase.shareUrl ? "✓ 已上传" : "上传并分享"}
        </button>
        <button
          onClick={onVerify}
          className="flex-1 py-2.5 rounded-xl bg-zinc-700 hover:bg-zinc-600 font-medium text-sm transition-colors"
        >
          验证此证明
        </button>
        <button
          onClick={onReset}
          className="px-4 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-sm transition-colors"
        >
          重置
        </button>
      </div>
      {phase.shareUrl && (
        <div className="bg-emerald-950/50 border border-emerald-700/40 rounded-xl p-4 space-y-2">
          <p className="text-emerald-400 text-sm font-medium">分享链接已生成</p>
          <div className="flex gap-2 items-center">
            <code className="flex-1 bg-zinc-800 px-3 py-2 rounded text-xs font-mono text-zinc-300 break-all">
              {typeof window !== "undefined" ? `${window.location.origin}${phase.shareUrl}` : phase.shareUrl}
            </code>
            <button
              onClick={() => {
                const url = typeof window !== "undefined" ? `${window.location.origin}${phase.shareUrl!}` : phase.shareUrl!;
                navigator.clipboard.writeText(url);
              }}
              className="px-3 py-2 rounded bg-zinc-700 hover:bg-zinc-600 text-xs font-medium transition-colors"
            >
              复制
            </button>
          </div>
          <p className="text-zinc-500 text-xs">
            任何人可以通过此链接验证你的证明，无需知道你的地址或余额。
          </p>
        </div>
      )}
    </div>
  );
}

function VerifyView({
  phase,
  onRun,
  onReset,
}: {
  phase: VerifyPhase;
  onRun: (proofHex: string, publicInputs: string[], summary: VerifySummary, assetType: "eth" | "erc20") => void;
  onReset: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<{
    proofHex: string;
    publicInputs: string[];
    summary: VerifySummary;
    assetType: "eth" | "erc20";
  } | null>(null);

  const handleFile = async (file: File) => {
    setFileError(null);
    setFileName(file.name);
    setParsed(null);
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      if (typeof json.plonkProof !== "string" || !json.plonkProof)
        throw new Error("文件缺少 plonkProof 字段");
      if (!Array.isArray(json.publicInputs) || json.publicInputs.length === 0)
        throw new Error("文件缺少 publicInputs 字段（旧版 .proof 文件不支持，请重新生成）");

      const pis = json.publicInputs as string[];
      const assetType: "eth" | "erc20" = json.assetType === "erc20" ? "erc20" : "eth";
      const isErc20 = assetType === "erc20";

      // ── EIP layout helper ─────────────────────────────────────────────────
      // ETH public inputs: state_root[0..32] | threshold[32] | user_tag[33..65] | block_number[65] | chain_id[66] | commitment[67]
      // ERC20 public inputs: same prefix, then contract_address[67..87] | mapping_slot[87] | commitment[88]
      const piByteAt = (i: number) =>
        pis[i].replace("0x", "").padStart(64, "0").slice(-2);

      // 1. stateRoot
      if (json.stateRoot && pis.length >= 32) {
        const srFromPi = "0x" + Array.from({ length: 32 }, (_, i) => piByteAt(i)).join("");
        if (srFromPi.toLowerCase() !== (json.stateRoot as string).toLowerCase())
          throw new Error("stateRoot 与证明公开输入不符，文件元数据已被篡改");
      }

      // 2. threshold (index 32)
      if (json.threshold !== undefined && pis.length >= 33) {
        const threshFromPi = BigInt("0x" + pis[32].replace("0x", "").padStart(64, "0"));
        if (threshFromPi !== BigInt(json.threshold))
          throw new Error("threshold 与证明公开输入不符，文件元数据已被篡改");
      }

      // 3. userTag (indices 33..65)
      if (json.userTag && pis.length >= 65) {
        const tagFromPi = "0x" + Array.from({ length: 32 }, (_, i) => piByteAt(33 + i)).join("");
        if (tagFromPi.toLowerCase() !== (json.userTag as string).toLowerCase())
          throw new Error("userTag 与证明公开输入不符，文件元数据已被篡改");
      }

      // 4. userTagLabel → keccak256
      if (typeof json.userTagLabel === "string" && json.userTag) {
        const computed = keccak256(new TextEncoder().encode(json.userTagLabel));
        if (computed.toLowerCase() !== (json.userTag as string).toLowerCase())
          throw new Error("userTagLabel 与 userTag 不符，标签字段已被篡改");
      }

      // 5. block_number (index 65)
      if (json.blockNumber !== undefined && pis.length >= 66) {
        const bnFromPi = BigInt("0x" + pis[65].replace("0x", "").padStart(64, "0"));
        if (bnFromPi !== BigInt(json.blockNumber))
          throw new Error("blockNumber 与证明公开输入不符，文件元数据已被篡改");
      }

      // 6. chain_id (index 66)
      if (json.chainId !== undefined && pis.length >= 67) {
        const cidFromPi = BigInt("0x" + pis[66].replace("0x", "").padStart(64, "0"));
        if (cidFromPi !== BigInt(json.chainId))
          throw new Error("chainId 与证明公开输入不符，文件元数据已被篡改");
        if (cidFromPi !== 1n)
          throw new Error(`证明来自非主网链（chainId=${cidFromPi}），拒绝接受`);
      }

      // ERC20 extra checks
      if (isErc20 && json.token) {
        const tok = json.token as TokenInfo;
        // contract_address (indices 67..87 = 20 u8 fields)
        const caFromPi = "0x" + Array.from({ length: 20 }, (_, i) => piByteAt(67 + i)).join("");
        if (caFromPi.toLowerCase() !== tok.address.toLowerCase())
          throw new Error("contract_address 与证明公开输入不符");
        // mapping_slot (index 87)
        if (pis.length >= 88) {
          const slotFromPi = BigInt("0x" + pis[87].replace("0x", "").padStart(64, "0"));
          if (slotFromPi !== BigInt(tok.slot))
            throw new Error("mapping_slot 与证明公开输入不符");
        }
      }

      // 7. commitment (last PI)
      if (json.commitment && pis.length > 0) {
        const lastPi = pis[pis.length - 1].replace("0x", "").padStart(64, "0");
        const commitFromJson = (json.commitment as string).replace("0x", "").padStart(64, "0");
        if (lastPi.toLowerCase() !== commitFromJson.toLowerCase())
          throw new Error("commitment 与证明公开输入不符，文件元数据已被篡改");
      }

      setParsed({
        proofHex: json.plonkProof,
        publicInputs: pis,
        assetType,
        summary: {
          stateRoot:      json.stateRoot,
          threshold:      json.threshold,
          commitment:     json.commitment,
          userTagLabel:   json.userTagLabel,
          blockNumber:    json.blockNumber,
          blockTimestamp: typeof json.blockTimestamp === "number" ? json.blockTimestamp : undefined,
          chainId:        json.chainId,
          token:          json.token ?? undefined,
        },
      });
    } catch (e) {
      setFileError((e as Error).message);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  if (phase.status === "idle") {
    return (
      <div className="space-y-5">
        <p className="text-zinc-400 text-sm">上传一个 .proof 文件，在浏览器本地完成零知识证明验证</p>
        <div
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
          onClick={() => fileRef.current?.click()}
          className="border-2 border-dashed border-zinc-700 rounded-xl p-8 text-center cursor-pointer hover:border-violet-500 transition-colors"
        >
          <p className="text-zinc-400 text-sm">点击或拖拽上传 .proof 文件</p>
          {fileName && (
            <p className="text-zinc-300 text-xs mt-2 font-mono truncate">{fileName}</p>
          )}
          <input
            ref={fileRef}
            type="file"
            accept=".proof,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
              e.target.value = "";
            }}
          />
        </div>
        {fileError && <p className="text-red-400 text-xs">{fileError}</p>}
        {parsed && (
          <div className="space-y-3">
            <div className="bg-zinc-800 rounded-xl p-3 text-xs space-y-1.5">
              {parsed.summary.token && <Row label="资产" value={`${parsed.summary.token.symbol} (ERC20)`} />}
              {!parsed.summary.token && parsed.summary.threshold && <Row label="资产" value="ETH (原生)" />}
              {parsed.summary.userTagLabel && <Row label="标签" value={parsed.summary.userTagLabel} />}
              {parsed.summary.threshold && (
                <Row label="阈值" value={
                  parsed.summary.token
                    ? `≥ ${(Number(BigInt(parsed.summary.threshold)) / 10 ** parsed.summary.token.decimals).toFixed(6).replace(/\.?0+$/, "")} ${parsed.summary.token.symbol}`
                    : `≥ ${weiToEth(BigInt(parsed.summary.threshold))} ETH`
                } />
              )}
              {parsed.summary.blockNumber !== undefined && <Row label="区块高度" value={`#${parsed.summary.blockNumber}`} />}
              {parsed.summary.blockTimestamp !== undefined && (
                <Row label="区块时间" value={`${new Date(parsed.summary.blockTimestamp * 1000).toLocaleString("zh-CN")}（${formatAge(parsed.summary.blockTimestamp)}）`} />
              )}
              {parsed.summary.chainId !== undefined && <Row label="链" value={`Ethereum Mainnet (chainId=${parsed.summary.chainId})`} />}
              {parsed.summary.stateRoot && <Row label="状态根" value={truncHex(parsed.summary.stateRoot)} mono />}
              {parsed.summary.commitment && <Row label="地址承诺" value={truncHex(parsed.summary.commitment)} mono />}
            </div>
            {parsed.summary.blockTimestamp !== undefined && (() => {
              const fw = freshnessWarning(parsed.summary.blockTimestamp!);
              if (!fw) return null;
              return (
                <div className={`rounded-lg px-3 py-2 text-xs ${fw.level === "alert" ? "bg-red-950/60 border border-red-700/40 text-red-300" : "bg-yellow-950/60 border border-yellow-700/40 text-yellow-300"}`}>
                  ⚠ {fw.msg}
                </div>
              );
            })()}
            <button
              onClick={() => onRun(parsed.proofHex, parsed.publicInputs, parsed.summary, parsed.assetType)}
              className="w-full py-3 rounded-xl bg-violet-600 hover:bg-violet-500 font-semibold text-sm transition-colors"
            >
              验证此证明
            </button>
          </div>
        )}
      </div>
    );
  }

  if (phase.status === "verifying") {
    return (
      <div className="space-y-4 py-2">
        <div className="space-y-2">
          <span className="text-zinc-300 text-sm">验证中...</span>
          <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
            <div className="h-full bg-violet-600 rounded-full animate-pulse w-3/5" />
          </div>
          <p className="text-zinc-500 text-xs">{phase.msg}</p>
        </div>
      </div>
    );
  }

  if (phase.status === "valid") {
    const s = phase.summary;
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3 bg-emerald-950/50 border border-emerald-700/40 rounded-xl p-4">
          <span className="text-2xl">✅</span>
          <div>
            <p className="font-semibold text-emerald-300">验证通过</p>
            <p className="text-emerald-400/70 text-xs mt-0.5">证明有效，已在浏览器本地验证</p>
          </div>
        </div>
        {(s.userTagLabel || s.threshold || s.blockNumber || s.stateRoot || s.commitment) && (
          <div className="space-y-2 text-sm">
            {s.token && <Row label="资产" value={`${s.token.symbol} (ERC20)`} />}
            {!s.token && <Row label="资产" value="ETH (原生)" />}
            {s.userTagLabel && <Row label="标签" value={s.userTagLabel} />}
            {s.threshold && (
              <Row label="阈值" value={
                s.token
                  ? `≥ ${(Number(BigInt(s.threshold)) / 10 ** s.token.decimals).toFixed(6).replace(/\.?0+$/, "")} ${s.token.symbol}`
                  : `≥ ${weiToEth(BigInt(s.threshold))} ETH`
              } />
            )}
            {s.blockNumber !== undefined && <Row label="区块高度" value={`#${s.blockNumber}`} />}
            {s.blockTimestamp !== undefined && (
              <Row label="区块时间" value={`${new Date(s.blockTimestamp * 1000).toLocaleString("zh-CN")}（${formatAge(s.blockTimestamp)}）`} />
            )}
            {s.chainId !== undefined && <Row label="链" value={`Ethereum Mainnet (chainId=${s.chainId})`} />}
            {s.stateRoot && <Row label="状态根" value={truncHex(s.stateRoot)} mono />}
            {s.commitment && <Row label="地址承诺" value={truncHex(s.commitment)} mono />}
          </div>
        )}
        {s.blockTimestamp !== undefined && (() => {
          const fw = freshnessWarning(s.blockTimestamp!);
          if (!fw) return null;
          return (
            <div className={`rounded-lg px-3 py-2 text-xs ${fw.level === "alert" ? "bg-red-950/60 border border-red-700/40 text-red-300" : "bg-yellow-950/60 border border-yellow-700/40 text-yellow-300"}`}>
              ⚠ {fw.msg}
            </div>
          );
        })()}
        <button onClick={onReset} className="w-full py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-sm transition-colors">
          验证另一个证明
        </button>
      </div>
    );
  }

  if (phase.status === "invalid") {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3 bg-red-950/50 border border-red-700/40 rounded-xl p-4">
          <span className="text-2xl">❌</span>
          <div>
            <p className="font-semibold text-red-300">验证失败</p>
            <p className="text-red-400/70 text-xs mt-0.5">证明无效或已被篡改</p>
          </div>
        </div>
        <button onClick={onReset} className="w-full py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-sm transition-colors">重试</button>
      </div>
    );
  }

  return <ErrorView message={(phase as { status: "error"; message: string }).message} onReset={onReset} />;
}

function ErrorView({ message, onReset }: { message: string; onReset: () => void }) {
  return (
    <div className="space-y-4">
      <div className="bg-red-950/40 border border-red-700/40 rounded-xl p-4">
        <p className="font-semibold text-red-400 mb-1">出错了</p>
        <p className="text-red-300/70 text-xs wrap-break-word whitespace-pre-wrap">{message}</p>
      </div>
      <button
        onClick={onReset}
        className="w-full py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-sm transition-colors"
      >
        重试
      </button>
    </div>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4 items-start">
      <span className="text-zinc-500 whitespace-nowrap">{label}</span>
      <span className={`text-zinc-300 text-right break-all ${mono ? "font-mono text-xs" : ""}`}>
        {value}
      </span>
    </div>
  );
}
