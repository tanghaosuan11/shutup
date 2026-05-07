/**
 * Wealth Proof — core prover logic
 *
 * Split into two phases:
 *   1. fetchWalletData()       — main browser thread only (needs window.ethereum)
 *   2. generateProofFromData() — worker-safe (no window access, dynamic WASM imports)
 */

// SSR-safe imports only at module level
import type { InputMap } from "@noir-lang/noir_js";
import { BrowserProvider, JsonRpcProvider, SigningKey, getAddress, getBytes, verifyTypedData, TypedDataEncoder } from "ethers";
import * as ethers from "ethers";
import { decode as rlpDecode } from "@ethereumjs/rlp";

// ── Public RPC for data fetching (block + eth_getProof) ─────────────────────
// MetaMask/Infura blocks eth_getProof on specific block numbers ("proof window"
// error). We use a separate public endpoint for all read-only chain data.
// The wallet (window.ethereum) is only used for eth_requestAccounts + address.
const PROOF_RPC_URLS = [
  "https://rpc.ankr.com/eth",            // Ankr — reliable, no key required
  "https://ethereum.publicnode.com",     // PublicNode — archive, no key
  "https://1rpc.io/eth",                 // 1RPC — privacy-preserving relay
  "https://cloudflare-eth.com",          // Cloudflare — high availability
];

/** Test an RPC endpoint with a raw fetch (no ethers auto-retry loop). */
async function probeRpc(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const json = await res.json();
    return typeof json?.result === "string";
  } catch {
    return false;
  }
}

// ── Circuit constants (must match src/main.nr) ────────────────────────────────
const MAX_TRIE_NODE_LENGTH = 532;
const MAX_DEPTH = 10;
const PROOF_BYTES = MAX_TRIE_NODE_LENGTH * MAX_DEPTH; // 5320
const MAX_ACCOUNT_STATE_LENGTH = 134;

// ── Known ERC20 tokens (slot numbers verified against mainnet contract source) ─
export interface TokenInfo {
  symbol: string;
  address: string; // checksummed
  slot: number;    // storage slot of the `balances` / `_balances` mapping
  decimals: number;
}

export const KNOWN_ERC20_TOKENS: TokenInfo[] = [
  { symbol: "WETH",  address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", slot: 3,  decimals: 18 },
  { symbol: "UNI",   address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", slot: 4,  decimals: 18 },
  { symbol: "LINK",  address: "0x514910771AF9Ca656af840dff83E8264EcF986CA", slot: 1,  decimals: 18 },
  { symbol: "AAVE",  address: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", slot: 0,  decimals: 18 },
  { symbol: "MKR",   address: "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2", slot: 1,  decimals: 18 },
  { symbol: "CRV",   address: "0xD533a949740bb3306d119CC777fa900bA034cd52", slot: 3,  decimals: 18 },
  { symbol: "LDO",   address: "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32", slot: 0,  decimals: 18 },
];

// ── Public types ──────────────────────────────────────────────────────────────

export type ProgressCallback = (pct: number, msg: string) => void;

/** Data fetched from the wallet + Ethereum node. Serialisable (plain objects/strings). */
export interface WalletData {
  address: string;
  stateRoot: string;
  blockNumber: number;
  proofResponse: {
    accountProof: string[];
    nonce: string;
    balance: string;
    storageHash: string;
    codeHash: string;
  };
  // ECDSA ownership proof — derived from MetaMask EIP-712 signTypedData
  pubKeyX: string;      // 32-byte hex: secp256k1 pubkey X coordinate
  pubKeyY: string;      // 32-byte hex: secp256k1 pubkey Y coordinate
  signatureRS: string;  // 64-byte hex: r || s (no recovery id)
  userTag: string;      // 32-byte hex: keccak256(user-chosen label)
  userTagLabel: string; // human-readable label the user typed (for display only)
  chainId: number;      // EVM chain ID (1 = mainnet) — included in EIP-712 struct
  blockTimestamp: number; // Unix timestamp (seconds) of the proof block
  // ERC20 fields (undefined for ETH proofs)
  token?: TokenInfo;
  storageProofNodes?: string[]; // RLP-encoded storage MPT nodes from eth_getProof
  storageValue?: string;        // raw 32-byte hex balance from storage slot
}

export interface ProofResult {
  proof: Uint8Array;
  publicInputs: string[];
  stateRoot: string;
  blockNumber: number;
  blockTimestamp: number;
  chainId: number;
  thresholdWei: bigint;
  commitmentHex: string;
  proofGenerationMs: number;
  userTag: string;
  userTagLabel: string;
  token?: TokenInfo; // undefined = ETH
}

// ── Phase 1: wallet connection (main thread only) ─────────────────────────────

/**
 * Connects MetaMask, fetches the block state root and eth_getProof data.
 * Must run in the main browser thread (needs window.ethereum).
 */
export async function fetchWalletData(
  thresholdWei: bigint,
  userTagLabel: string,
  customRpcUrl?: string,
  onProgress?: ProgressCallback
): Promise<WalletData> {
  const progress = (pct: number, msg: string) => {
    console.log(`[${pct}%] ${msg}`);
    onProgress?.(pct, msg);
  };

  // Connect wallet
  progress(0, "Requesting wallet access...");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const win = window as any;
  if (!win?.ethereum)
    throw new Error("MetaMask not found. Please install it.");
  const provider = new BrowserProvider(win.ethereum);
  await provider.send("eth_requestAccounts", []);

  // Enforce Ethereum mainnet (chainId 1) — proofs from other chains are useless
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  if (chainId !== 1) {
    const CHAIN_NAMES: Record<number, string> = {
      10: "Optimism", 8453: "Base", 42161: "Arbitrum One",
      137: "Polygon", 56: "BNB Chain", 11155111: "Sepolia testnet",
    };
    const chainName = CHAIN_NAMES[chainId] ?? `chain #${chainId}`;
    throw new Error(
      `请将 MetaMask 切换到以太坊主网（Ethereum Mainnet）后再生成证明。\n` +
      `当前连接的是：${chainName}（chainId=${chainId}），该链上此地址余额为 0。`
    );
  }

  const signer = await provider.getSigner();
  const address = getAddress(await signer.getAddress());
  progress(5, `Wallet connected: ${address.slice(0, 8)}…`);

  // Use a public archive RPC for all read-only data (block + eth_getProof).
  // MetaMask's Infura endpoint rejects eth_getProof on specific block numbers
  // with "distance to target block exceeds maximum proof window".
  // If the user provides a custom RPC, try it first; fall back to the public list.
  progress(8, "Connecting to RPC for chain data...");

  // Validate custom URL before using it (prevents open-redirect / protocol abuse)
  if (customRpcUrl) {
    try {
      const u = new URL(customRpcUrl);
      if (!u.protocol.startsWith("http"))
        throw new Error();
    } catch {
      throw new Error("自定义 RPC URL 格式无效（需要以 http:// 或 https:// 开头）");
    }
  }
  const candidateUrls = customRpcUrl ? [customRpcUrl, ...PROOF_RPC_URLS] : PROOF_RPC_URLS;

  let dataProvider: JsonRpcProvider | null = null;
  for (const url of candidateUrls) {
    const ok = await probeRpc(url);
    if (ok) {
      dataProvider = new JsonRpcProvider(url);
      console.log(`[wealth-proof] Using data RPC: ${url}`);
      break;
    }
    console.warn(`[wealth-proof] RPC unavailable: ${url}`);
  }
  if (!dataProvider) throw new Error("所有 RPC 均不可用，请检查网络或更换自定义 RPC。");

  // Get block number then fire both in parallel for the same block.
  progress(12, "Fetching block + account proof...");
  const blockNumberHex: string = await dataProvider.send("eth_blockNumber", []);
  const [block, proofResponse] = await Promise.all([
    dataProvider.getBlock(blockNumberHex),
    dataProvider.send("eth_getProof", [address, [], blockNumberHex]),
  ]);
  if (!block) throw new Error("Could not fetch latest block");
  const { number: blockNumber, timestamp: blockTimestamp } = block;
  const stateRoot = block.stateRoot;
  if (!stateRoot) throw new Error("stateRoot missing — RPC does not expose stateRoot");
  progress(25, `Block #${blockNumber} · ${proofResponse.accountProof.length}-node MPT proof`);

  // EIP-712 typed data for structured signing.
  // MetaMask will display this as a readable form instead of garbled binary.
  const EIP712_DOMAIN = { name: "WealthProof", version: "1" };
  const EIP712_TYPES = {
    WealthClaim: [
      { name: "threshold",   type: "uint128" },
      { name: "stateRoot",   type: "bytes32" },
      { name: "userTag",     type: "string" },  // shown as plain text in MetaMask
      { name: "blockNumber", type: "uint64" },  // replay protection: specific block
      { name: "chainId",     type: "uint64" },  // replay protection: mainnet only
    ],
  };
  // Use raw label as the string value — MetaMask shows it as-is.
  // EIP-712 encodes `string` as keccak256(utf8_bytes) in the struct hash,
  // which becomes the `user_tag` circuit input.
  const label = userTagLabel.trim() || ("0x" + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"));
  const userTag = ethers.keccak256(new TextEncoder().encode(label)); // matches EIP-712 string encoding
  const ethDisplay = (Number(thresholdWei) / 1e18).toFixed(4).replace(/\.?0+$/, "") || "0";
  progress(27, `请在 MetaMask 签名授权: 证明持有 >= ${ethDisplay} ETH`);

  const typedMessage = {
    threshold:   thresholdWei,
    stateRoot:   stateRoot,
    userTag:     label,
    blockNumber: BigInt(blockNumber),
    chainId:     BigInt(chainId),
  };
  const sig65hex: string = await signer.signTypedData(EIP712_DOMAIN, EIP712_TYPES, typedMessage);

  const msgHash = TypedDataEncoder.hash(EIP712_DOMAIN, EIP712_TYPES, typedMessage);
  const pubKeyFull = SigningKey.recoverPublicKey(msgHash, sig65hex);
  const pubKeyBytes = getBytes(pubKeyFull).slice(1);
  const pubKeyX = "0x" + Buffer.from(pubKeyBytes.slice(0, 32)).toString("hex");
  const pubKeyY = "0x" + Buffer.from(pubKeyBytes.slice(32, 64)).toString("hex");
  const signatureRS = "0x" + Buffer.from(getBytes(sig65hex).slice(0, 64)).toString("hex");

  const recoveredAddress = verifyTypedData(EIP712_DOMAIN, EIP712_TYPES, typedMessage, sig65hex);
  if (recoveredAddress.toLowerCase() !== address.toLowerCase()) {
    throw new Error(`签名恢复的地址 ${recoveredAddress} 与钱包地址 ${address} 不符，请重试`);
  }
  progress(29, "Signature verified.");

  return { address, stateRoot, blockNumber, blockTimestamp, chainId, proofResponse, pubKeyX, pubKeyY, signatureRS, userTag, userTagLabel: label };
}

/**
 * ERC20 variant of fetchWalletData.
 * Fetches eth_getProof for a token contract (account proof + storage proof).
 */
export async function fetchWalletDataERC20(
  token: TokenInfo,
  thresholdWei: bigint,
  userTagLabel: string,
  customRpcUrl?: string,
  onProgress?: ProgressCallback
): Promise<WalletData> {
  const progress = (pct: number, msg: string) => {
    console.log(`[${pct}%] ${msg}`);
    onProgress?.(pct, msg);
  };

  progress(0, "Requesting wallet access...");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const win = window as any;
  if (!win?.ethereum) throw new Error("MetaMask not found. Please install it.");
  const provider = new BrowserProvider(win.ethereum);
  await provider.send("eth_requestAccounts", []);

  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  if (chainId !== 1) throw new Error(`请切换到以太坊主网（当前 chainId=${chainId}）`);

  const signer = await provider.getSigner();
  const address = getAddress(await signer.getAddress());
  progress(5, `Wallet connected: ${address.slice(0, 8)}...`);

  // RPC selection (same logic as ETH)
  if (customRpcUrl) {
    try {
      const u = new URL(customRpcUrl);
      if (!u.protocol.startsWith("http")) throw new Error();
    } catch {
      throw new Error("自定义 RPC URL 格式无效（需要以 http:// 或 https:// 开头）");
    }
  }
  const candidateUrls = customRpcUrl ? [customRpcUrl, ...PROOF_RPC_URLS] : PROOF_RPC_URLS;
  let dataProvider: JsonRpcProvider | null = null;
  for (const url of candidateUrls) {
    if (await probeRpc(url)) {
      dataProvider = new JsonRpcProvider(url);
      break;
    }
  }
  if (!dataProvider) throw new Error("所有 RPC 均不可用，请检查网络或更换自定义 RPC。");

  // Compute the ERC20 storage key for balances[walletAddress] at the given slot.
  // storage_key = keccak256(abi.encode(address, uint256(slot)))
  const storageKey = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256"],
      [address, token.slot]
    )
  );

  progress(12, `Fetching block + ${token.symbol} storage proof...`);
  const blockNumberHex: string = await dataProvider.send("eth_blockNumber", []);
  const [block, proofResponse] = await Promise.all([
    dataProvider.getBlock(blockNumberHex),
    // eth_getProof for the TOKEN CONTRACT with the storage key
    dataProvider.send("eth_getProof", [token.address, [storageKey], blockNumberHex]),
  ]);
  if (!block) throw new Error("Could not fetch latest block");
  const { number: blockNumber, timestamp: blockTimestamp } = block;
  const stateRoot = block.stateRoot;
  if (!stateRoot) throw new Error("stateRoot missing");

  const storageProofEntry = proofResponse.storageProof?.[0];
  if (!storageProofEntry) throw new Error(`${token.symbol} storage proof not found in response`);
  const storageValue: string = storageProofEntry.value ?? "0x0";
  const reportedBalance = BigInt(storageValue);

  console.log(`[erc20-proof] token=${token.symbol} block=${blockNumber} balance=${reportedBalance} threshold=${thresholdWei}`);
  if (reportedBalance < thresholdWei) {
    throw new Error(
      `${token.symbol} 余额不足：钱包持有 ${reportedBalance} (raw units)，` +
      `低于门槛 ${thresholdWei} (raw units)`
    );
  }

  progress(25, `Block #${blockNumber} · ${proofResponse.accountProof.length}-node state proof · ${storageProofEntry.proof.length}-node storage proof`);

  // EIP-712 for ERC20 — includes contractAddress and mappingSlot
  const EIP712_DOMAIN = { name: "WealthProof", version: "1" };
  const EIP712_TYPES_ERC20 = {
    WealthClaimERC20: [
      { name: "threshold",       type: "uint128" },
      { name: "stateRoot",       type: "bytes32"  },
      { name: "userTag",         type: "string"   },
      { name: "blockNumber",     type: "uint64"   },
      { name: "chainId",         type: "uint64"   },
      { name: "contractAddress", type: "address"  },
      { name: "mappingSlot",     type: "uint64"   },
    ],
  };
  const label = userTagLabel.trim() || ("0x" + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"));
  const userTag = ethers.keccak256(new TextEncoder().encode(label));

  const tokenDisplay = `${(Number(thresholdWei) / 10 ** token.decimals).toFixed(4).replace(/\.?0+$/, "")} ${token.symbol}`;
  progress(27, `请在 MetaMask 签名授权: 证明持有 >= ${tokenDisplay}`);

  const typedMessage = {
    threshold:       thresholdWei,
    stateRoot:       stateRoot,
    userTag:         label,
    blockNumber:     BigInt(blockNumber),
    chainId:         BigInt(chainId),
    contractAddress: token.address,
    mappingSlot:     BigInt(token.slot),
  };
  const sig65hex: string = await signer.signTypedData(EIP712_DOMAIN, EIP712_TYPES_ERC20, typedMessage);
  const msgHash = TypedDataEncoder.hash(EIP712_DOMAIN, EIP712_TYPES_ERC20, typedMessage);
  const pubKeyFull = SigningKey.recoverPublicKey(msgHash, sig65hex);
  const pubKeyBytes = getBytes(pubKeyFull).slice(1);
  const pubKeyX = "0x" + Buffer.from(pubKeyBytes.slice(0, 32)).toString("hex");
  const pubKeyY = "0x" + Buffer.from(pubKeyBytes.slice(32, 64)).toString("hex");
  const signatureRS = "0x" + Buffer.from(getBytes(sig65hex).slice(0, 64)).toString("hex");
  const recoveredAddress = verifyTypedData(EIP712_DOMAIN, EIP712_TYPES_ERC20, typedMessage, sig65hex);
  if (recoveredAddress.toLowerCase() !== address.toLowerCase())
    throw new Error(`签名恢复地址不符，请重试`);
  progress(29, "Signature verified.");

  return {
    address, stateRoot, blockNumber, blockTimestamp, chainId,
    proofResponse,  // accountProof for the token contract
    pubKeyX, pubKeyY, signatureRS,
    userTag, userTagLabel: label,
    token,
    storageProofNodes: storageProofEntry.proof,
    storageValue,
  };
}


/**
 * Runs the Noir witness + UltraHonk Plonk proof.
 * Safe to call from a Web Worker — no window access.
 * WASM libs are loaded dynamically to avoid SSR evaluation.
 */
export async function generateProofFromData(
  circuit: any,
  walletData: WalletData,
  thresholdWei: bigint,
  onProgress?: ProgressCallback
): Promise<ProofResult> {
  const progress = (pct: number, msg: string) => {
    console.log(`[${pct}%] ${msg}`);
    onProgress?.(pct, msg);
  };

  const { address, stateRoot, blockNumber, blockTimestamp, chainId, proofResponse, userTag, userTagLabel } = walletData;

  // Pre-flight: surface balance / depth issues before the expensive circuit run
  // eth_getProof returns balance as a hex string e.g. "0x3b9aca00"
  console.log("[wealth-proof] raw proofResponse =", JSON.stringify({
    balance: proofResponse.balance,
    nonce: proofResponse.nonce,
    accountProofDepth: proofResponse.accountProof?.length,
    address,
  }));
  const balanceHex: string = String(proofResponse.balance ?? "0x0");
  // BigInt() accepts "0x..." prefixed hex strings natively
  const reportedBalanceWei = BigInt(balanceHex);
  console.log(
    `[wealth-proof] block=${blockNumber} depth=${proofResponse.accountProof.length}` +
    ` balance=${reportedBalanceWei}wei (${(Number(reportedBalanceWei)/1e18).toFixed(12)} ETH)` +
    ` threshold=${thresholdWei}wei stateRoot=${stateRoot}`
  );
  if (reportedBalanceWei < thresholdWei) {
    throw new Error(
      `余额不足：钱包余额 ${(Number(reportedBalanceWei)/1e18).toFixed(12)} ETH，` +
      `低于门槛 ${(Number(thresholdWei)/1e18).toFixed(12)} ETH`
    );
  }
  if (proofResponse.accountProof.length > MAX_DEPTH) {
    throw new Error(
      `MPT 证明深度 ${proofResponse.accountProof.length} 超过电路上限 ${MAX_DEPTH}，` +
      `请联系开发者重新编译电路`
    );
  }

  // Format circuit inputs
  progress(30, "Formatting circuit inputs...");
  const inputs = formatInputs(address, stateRoot, thresholdWei, blockNumber, chainId, proofResponse, walletData.pubKeyX, walletData.pubKeyY, walletData.signatureRS, userTag);
  const stateProof = (inputs as { state_proof?: { value?: number[]; depth?: string } }).state_proof;
  const valueArr = stateProof?.value ?? [];
  const firstNZ = valueArr.findIndex((b) => b !== 0);
  const listHead = firstNZ >= 0 ? valueArr[firstNZ] : -1;
  console.log("[wealth-proof] witness inputs (compact)", {
    threshold: (inputs as Record<string, unknown>).threshold,
    proof_depth: stateProof?.depth,
    account_rlp_bytes: accountRlpBytesFromStateProof(proofResponse.accountProof).length,
    value_padded_len: valueArr.length,
    value_first_nonzero_index: firstNZ,
    value_list_head_byte:
      listHead >= 0 ? `0x${listHead.toString(16).padStart(2, "0")}` : null,
    hint:
      firstNZ > 0 && listHead >= 0xc0
        ? "left-padded account RLP — circuit uses byte_value() before decode1"
        : firstNZ === 0 && listHead >= 0xc0
          ? "account RLP starts at index 0"
          : "check padding / account node extraction",
  });

  // Dynamic imports — prevents SSR evaluation of WASM libs
  progress(35, "Loading Noir circuit...");
  const [{ Noir }, { Barretenberg, UltraHonkBackend }] = await Promise.all([
    import("@noir-lang/noir_js"),
    import("@aztec/bb.js"),
  ]);

  const threads = Math.min(
    typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? 4) : 4,
    8
  );
  const api = await Barretenberg.new({ threads });
  // Circuit exceeds the default 2^20 SRS limit after the userTag keccak addition.
  // Pre-load 2^21 points before constructing the backend so MemBn254CrsFactory has
  // enough capacity. This increases initial download time (~30s on first load) but
  // is cached by the browser afterwards.
  progress(37, "Loading SRS (2^21)...");
  await (api as unknown as { initSRSChonk: (n: number) => Promise<void> }).initSRSChonk(2 ** 21);
  const backend = new UltraHonkBackend(circuit.bytecode, api);
  const noir = new Noir(circuit);

  progress(40, "Generating witness...");
  const { witness } = await noir.execute(inputs as InputMap);
  progress(50, "Witness done, starting Plonk proof...");

  const t0 = performance.now();
  const { proof, publicInputs } = await backend.generateProof(witness);
  const proofGenerationMs = performance.now() - t0;
  await api.destroy();
  progress(100, `Proof done in ${(proofGenerationMs / 1000).toFixed(1)}s`);

  const commitmentHex = publicInputs[publicInputs.length - 1];

  return { proof, publicInputs, stateRoot, blockNumber, blockTimestamp, chainId, thresholdWei, commitmentHex, proofGenerationMs, userTag, userTagLabel };
}

/**
 * ERC20 variant of generateProofFromData.
 * Runs the ERC20 Noir circuit (circuit_erc20.json) with both state + storage proofs.
 */
export async function generateProofFromDataERC20(
  circuit: any,
  walletData: WalletData,
  thresholdWei: bigint,
  onProgress?: ProgressCallback
): Promise<ProofResult> {
  const progress = (pct: number, msg: string) => {
    console.log(`[${pct}%] ${msg}`);
    onProgress?.(pct, msg);
  };

  const { address, stateRoot, blockNumber, blockTimestamp, chainId, proofResponse,
          userTag, userTagLabel, token, storageProofNodes, storageValue } = walletData;

  if (!token || !storageProofNodes || storageValue === undefined)
    throw new Error("ERC20 wallet data missing token/storageProof fields");

  if (proofResponse.accountProof.length > MAX_DEPTH)
    throw new Error(`State MPT depth ${proofResponse.accountProof.length} exceeds circuit limit ${MAX_DEPTH}`);
  if (storageProofNodes.length > MAX_DEPTH)
    throw new Error(`Storage MPT depth ${storageProofNodes.length} exceeds circuit limit ${MAX_DEPTH}`);

  progress(30, "Formatting ERC20 circuit inputs...");
  const inputs = formatInputsERC20(
    address, stateRoot, thresholdWei, blockNumber, chainId,
    token, proofResponse.accountProof, storageProofNodes, storageValue,
    walletData.pubKeyX, walletData.pubKeyY, walletData.signatureRS, userTag
  );

  progress(35, "Loading Noir circuit...");
  const [{ Noir }, { Barretenberg, UltraHonkBackend }] = await Promise.all([
    import("@noir-lang/noir_js"),
    import("@aztec/bb.js"),
  ]);

  const threads = Math.min(
    typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? 4) : 4,
    8
  );
  const api = await Barretenberg.new({ threads });
  // ERC20 circuit has two MPT proofs — needs more SRS than ETH circuit.
  progress(37, "Loading SRS (2^22)...");
  await (api as unknown as { initSRSChonk: (n: number) => Promise<void> }).initSRSChonk(2 ** 22);
  const backend = new UltraHonkBackend(circuit.bytecode, api);
  const noir = new Noir(circuit);

  progress(40, "Generating witness...");
  const { witness } = await noir.execute(inputs as InputMap);
  progress(50, "Witness done, starting Plonk proof...");

  const t0 = performance.now();
  const { proof, publicInputs } = await backend.generateProof(witness);
  const proofGenerationMs = performance.now() - t0;
  await api.destroy();
  progress(100, `ERC20 proof done in ${(proofGenerationMs / 1000).toFixed(1)}s`);

  const commitmentHex = publicInputs[publicInputs.length - 1];
  return { proof, publicInputs, stateRoot, blockNumber, blockTimestamp, chainId, thresholdWei, commitmentHex, proofGenerationMs, userTag, userTagLabel, token };
}

// ── Input formatting ──────────────────────────────────────────────────────────

function formatInputs(
  address: string,
  stateRoot: string,
  thresholdWei: bigint,
  blockNumber: number,
  chainId: number,
  rpc: { accountProof: string[] },
  pubKeyX: string,
  pubKeyY: string,
  signatureRS: string,
  userTag: string,
): InputMap {
  const stateRootBytes = hexToU8Array(stateRoot, 32);
  const addressBytes = hexToU8Array(address, 20);

  const proofArray = new Uint8Array(PROOF_BYTES);
  for (let i = 0; i < Math.min(rpc.accountProof.length, MAX_DEPTH); i++) {
    const node = hexToBytes(rpc.accountProof[i]);
    if (node.length > MAX_TRIE_NODE_LENGTH)
      throw new Error(`MPT node ${i} too large: ${node.length} bytes`);
    proofArray.set(node, i * MAX_TRIE_NODE_LENGTH);
  }

  // Must match on-chain leaf bytes. Re-encoding from RPC fields can differ from
  // the trie (see noir-trie-proofs `fetch_state_proof`: value = last RLP item
  // of the last proof node).
  const accountRlp = accountRlpBytesFromStateProof(rpc.accountProof);
  if (accountRlp.length > MAX_ACCOUNT_STATE_LENGTH)
    throw new Error(`Account RLP too large: ${accountRlp.length}`);
  const valueArray = new Uint8Array(MAX_ACCOUNT_STATE_LENGTH);
  // Left-padding (zeros before RLP) matches noir-trie-proofs / eth_getProof;
  // witness applies byte_value() before rlp::decode1 (see wealth_proof_eth main.nr).
  valueArray.set(accountRlp, MAX_ACCOUNT_STATE_LENGTH - accountRlp.length);

  return {
    state_root:   Array.from(stateRootBytes),
    threshold:    thresholdWei.toString(),
    user_tag:     Array.from(hexToU8Array(userTag, 32)),
    block_number: blockNumber.toString(),
    chain_id:     chainId.toString(),
    address:      Array.from(addressBytes),
    pub_key_x: Array.from(hexToU8Array(pubKeyX, 32)),
    pub_key_y: Array.from(hexToU8Array(pubKeyY, 32)),
    signature: Array.from(hexToBytes(signatureRS)),
    state_proof: {
      key: Array.from(addressBytes),
      proof: Array.from(proofArray),
      depth: rpc.accountProof.length.toString(),
      value: Array.from(valueArray),
    },
  } satisfies InputMap;
}

/** Format inputs for the ERC20 Noir circuit. */
function formatInputsERC20(
  address: string,
  stateRoot: string,
  thresholdWei: bigint,
  blockNumber: number,
  chainId: number,
  token: TokenInfo,
  accountProof: string[],    // state MPT proof for the token contract
  storageProofNodes: string[], // storage MPT proof for balance slot
  storageValue: string,       // raw hex value from storage slot
  pubKeyX: string,
  pubKeyY: string,
  signatureRS: string,
  userTag: string,
): InputMap {
  const stateRootBytes = hexToU8Array(stateRoot, 32);
  const walletAddrBytes = hexToU8Array(address, 20);
  const contractAddrBytes = hexToU8Array(token.address, 20);

  // State proof (for token contract account)
  const stateProofArray = new Uint8Array(PROOF_BYTES);
  for (let i = 0; i < Math.min(accountProof.length, MAX_DEPTH); i++) {
    const node = hexToBytes(accountProof[i]);
    if (node.length > MAX_TRIE_NODE_LENGTH)
      throw new Error(`State MPT node ${i} too large: ${node.length} bytes`);
    stateProofArray.set(node, i * MAX_TRIE_NODE_LENGTH);
  }
  const accountRlp = accountRlpBytesFromStateProof(accountProof);
  if (accountRlp.length > MAX_ACCOUNT_STATE_LENGTH)
    throw new Error(`Account RLP too large: ${accountRlp.length}`);
  const stateValueArray = new Uint8Array(MAX_ACCOUNT_STATE_LENGTH);
  stateValueArray.set(accountRlp, MAX_ACCOUNT_STATE_LENGTH - accountRlp.length);

  // Storage proof (for balances[walletAddress] slot in the token contract)
  const STORAGE_VALUE_LEN = 32;
  const storageProofArray = new Uint8Array(PROOF_BYTES);
  for (let i = 0; i < Math.min(storageProofNodes.length, MAX_DEPTH); i++) {
    const node = hexToBytes(storageProofNodes[i]);
    if (node.length > MAX_TRIE_NODE_LENGTH)
      throw new Error(`Storage MPT node ${i} too large: ${node.length} bytes`);
    storageProofArray.set(node, i * MAX_TRIE_NODE_LENGTH);
  }
  // Storage value: uint256 big-endian, always 32 bytes
  const storageValueBytes = hexToU8Array(storageValue, STORAGE_VALUE_LEN);

  // Recompute the storage key (for the circuit's key field)
  const storageKey = hexToU8Array(
    ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256"],
        [address, token.slot]
      )
    ),
    32
  );

  return {
    state_root:       Array.from(stateRootBytes),
    threshold:        thresholdWei.toString(),
    user_tag:         Array.from(hexToU8Array(userTag, 32)),
    block_number:     blockNumber.toString(),
    chain_id:         chainId.toString(),
    contract_address: Array.from(contractAddrBytes),
    mapping_slot:     token.slot.toString(),
    wallet_address:   Array.from(walletAddrBytes),
    pub_key_x:        Array.from(hexToU8Array(pubKeyX, 32)),
    pub_key_y:        Array.from(hexToU8Array(pubKeyY, 32)),
    signature:        Array.from(hexToBytes(signatureRS)),
    state_proof: {
      key:   Array.from(contractAddrBytes),
      proof: Array.from(stateProofArray),
      depth: accountProof.length.toString(),
      value: Array.from(stateValueArray),
    },
    storage_proof: {
      key:   Array.from(storageKey),
      proof: Array.from(storageProofArray),
      depth: storageProofNodes.length.toString(),
      value: Array.from(storageValueBytes),
    },
  } satisfies InputMap;
}


function accountRlpBytesFromStateProof(accountProof: string[]): Uint8Array {
  if (accountProof.length === 0) throw new Error("accountProof is empty");
  const lastNode = hexToBytes(accountProof[accountProof.length - 1]);
  const decoded = rlpDecode(lastNode) as unknown;
  if (!Array.isArray(decoded) || decoded.length < 2) {
    throw new Error("Invalid MPT leaf node: expected RLP list with at least 2 items");
  }
  const payload = decoded[decoded.length - 1];
  if (!(payload instanceof Uint8Array)) {
    throw new Error("Invalid MPT leaf: account payload is not bytes");
  }
  return payload;
}

// ── Byte utilities ────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const s = h.length % 2 ? "0" + h : h;
  return Uint8Array.from(Buffer.from(s, "hex"));
}

function hexToU8Array(hex: string, len: number): Uint8Array {
  const raw = hexToBytes(hex);
  const out = new Uint8Array(len);
  out.set(raw.slice(0, len), len - Math.min(raw.length, len));
  return out;
}

// ── Phase 3: proof verification (worker-safe) ─────────────────────────────────

/**
 * Verifies a previously generated UltraHonk proof using bb.js.
 * Worker-safe — no window access required.
 */
export async function verifyProofData(
  circuit: any,
  proof: Uint8Array,
  publicInputs: string[],
  onProgress?: ProgressCallback
): Promise<boolean> {
  const progress = (pct: number, msg: string) => {
    onProgress?.(pct, msg);
  };
  progress(10, "Loading verifier...");
  const { Barretenberg, UltraHonkBackend } = await import("@aztec/bb.js");
  const threads = Math.min(
    typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? 4) : 4,
    8
  );
  const api = await Barretenberg.new({ threads });
  await (api as unknown as { initSRSChonk: (n: number) => Promise<void> }).initSRSChonk(2 ** 21);
  const backend = new UltraHonkBackend(circuit.bytecode, api);
  progress(50, "Verifying proof...");
  const valid = await backend.verifyProof({ proof, publicInputs });
  await api.destroy();
  progress(100, valid ? "Proof is valid." : "Proof is INVALID.");
  return valid;
}

/**
 * ERC20 proof verifier — uses 2^22 SRS for the larger circuit.
 */
export async function verifyProofDataERC20(
  circuit: any,
  proof: Uint8Array,
  publicInputs: string[],
  onProgress?: ProgressCallback
): Promise<boolean> {
  const progress = (pct: number, msg: string) => { onProgress?.(pct, msg); };
  progress(10, "Loading ERC20 verifier...");
  const { Barretenberg, UltraHonkBackend } = await import("@aztec/bb.js");
  const threads = Math.min(
    typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? 4) : 4,
    8
  );
  const api = await Barretenberg.new({ threads });
  await (api as unknown as { initSRSChonk: (n: number) => Promise<void> }).initSRSChonk(2 ** 22);
  const backend = new UltraHonkBackend(circuit.bytecode, api);
  progress(50, "Verifying ERC20 proof...");
  const valid = await backend.verifyProof({ proof, publicInputs });
  await api.destroy();
  progress(100, valid ? "ERC20 proof is valid." : "ERC20 proof is INVALID.");
  return valid;
}


export function serializeForServer(r: ProofResult): string {
  return JSON.stringify({
    plonkProof: Buffer.from(r.proof).toString("hex"),
    publicInputs: r.publicInputs,
    stateRoot: r.stateRoot,
    threshold: r.thresholdWei.toString(),
    commitment: r.commitmentHex,
    userTag: r.userTag,
    userTagLabel: r.userTagLabel,
  });
}
