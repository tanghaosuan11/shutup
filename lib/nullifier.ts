/**
 * Toy nullifier: deterministic hash over the public statement so the same proof
 * identity always maps to one Redis key (Upstash), without revealing the address.
 */
import { keccak256, toUtf8Bytes } from "ethers";
import type { TokenInfo } from "@/lib/prover";

export interface StatementNullifierParams {
  commitmentHex: string;
  stateRoot: string;
  blockNumber: number;
  chainId: number;
  thresholdWei: string;
  userTag: string;
  token?: TokenInfo;
}

function normHex(s: string): string {
  const t = s.trim();
  if (!t) return "";
  const x = t.startsWith("0x") ? t.slice(2) : t;
  return x.toLowerCase();
}

/**
 * Keccak256 over a canonical ASCII string (v1 schema).
 * Same address + same block + same threshold + same tag + same asset ⇒ same nullifier.
 */
export function deriveStatementNullifier(p: StatementNullifierParams): `0x${string}` {
  const asset =
    p.token != null
      ? `erc20:${normHex(p.token.address)}`
      : "eth";
  const canonical =
    `v1|commitment:${p.commitmentHex.trim()}|` +
    `stateRoot:0x${normHex(p.stateRoot)}|` +
    `block:${p.blockNumber}|` +
    `chain:${p.chainId}|` +
    `threshold:${p.thresholdWei.trim()}|` +
    `userTag:0x${normHex(p.userTag)}|` +
    `asset:${asset}`;
  return keccak256(toUtf8Bytes(canonical)) as `0x${string}`;
}
