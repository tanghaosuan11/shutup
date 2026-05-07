/**
 * Prover Web Worker
 *
 * Receives pre-fetched wallet data from the main thread and runs the heavy
 * Noir witness + UltraHonk Plonk proof generation off the main thread.
 *
 * Message protocol:
 *   IN  { type: "prove",      assetType: "eth"|"erc20", thresholdWei: string, walletData: WalletData }
 *   IN  { type: "verify",     assetType: "eth"|"erc20", proof: ArrayBuffer, publicInputs: string[] }
 *   OUT { type: "progress",   pct: number, msg: string }
 *       { type: "done",       result: serialisable ProofResult subset }
 *       { type: "verified",   valid: boolean }
 *       { type: "error",      message: string }
 */

import {
  generateProofFromData,
  generateProofFromDataERC20,
  verifyProofData,
  verifyProofDataERC20,
  type WalletData,
  type ProofResult,
} from "@/lib/prover";

async function loadCircuit(url: string): Promise<any> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  return resp.json() as Promise<any>;
}

self.onmessage = async (e: MessageEvent) => {
  const { type } = e.data ?? {};
  const assetType: "eth" | "erc20" = e.data.assetType === "erc20" ? "erc20" : "eth";
  const circuitUrl = assetType === "erc20" ? "/circuit_erc20.json" : "/circuit.json";

  if (type === "prove") {
    try {
      const thresholdWei = BigInt(e.data.thresholdWei as string);
      const walletData = e.data.walletData as WalletData;
      const circuitJson = await loadCircuit(circuitUrl);

      const result: ProofResult = assetType === "erc20"
        ? await generateProofFromDataERC20(
            circuitJson, walletData, thresholdWei,
            (pct, msg) => self.postMessage({ type: "progress", pct, msg })
          )
        : await generateProofFromData(
            circuitJson, walletData, thresholdWei,
            (pct, msg) => self.postMessage({ type: "progress", pct, msg })
          );

      self.postMessage(
        {
          type: "done",
          result: {
            proof: result.proof,
            publicInputs: result.publicInputs,
            stateRoot: result.stateRoot,
            blockNumber: result.blockNumber,
            blockTimestamp: result.blockTimestamp,
            chainId: result.chainId,
            thresholdWei: result.thresholdWei.toString(),
            commitmentHex: result.commitmentHex,
            proofGenerationMs: result.proofGenerationMs,
            userTag: result.userTag,
            userTagLabel: result.userTagLabel,
            token: result.token,
          },
        },
        { transfer: [result.proof.buffer] }
      );
    } catch (err) {
      self.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }

  } else if (type === "verify") {
    try {
      const proof = new Uint8Array(e.data.proof as ArrayBuffer);
      const publicInputs = e.data.publicInputs as string[];
      const circuitJson = await loadCircuit(circuitUrl);

      const valid = assetType === "erc20"
        ? await verifyProofDataERC20(
            circuitJson, proof, publicInputs,
            (pct, msg) => self.postMessage({ type: "progress", pct, msg })
          )
        : await verifyProofData(
            circuitJson, proof, publicInputs,
            (pct, msg) => self.postMessage({ type: "progress", pct, msg })
          );

      self.postMessage({ type: "verified", valid });
    } catch (err) {
      self.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }
};
