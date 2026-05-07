# Wealth Proof — Anonymous ETH & ERC20 Holder Proofs

Zero-knowledge circuits + Next.js frontend for proving ETH/ERC20 holdings without revealing address or balance.

## Project Structure

```
shut_up/
├── circuits/
│   ├── eth/           # ETH wealth proof (Noir circuit)
│   └── erc20/         # ERC20 wealth proof (Noir circuit)
├── app/               # Next.js frontend
├── lib/               # TypeScript utilities (RPC, prover, etc)
└── public/            # Circuit artifacts
```

## Quick Start

### 1. Compile Noir Circuits

```bash
# Compile both ETH and ERC20 circuits
pnpm compile:circuits

# Or individually
pnpm compile:eth
pnpm compile:erc20

# Manual compilation
cd circuits/eth && nargo compile
cd ../erc20 && nargo compile
```

### 2. Run Development Server

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) to see the app.

**Production Deployment:** https://shutup-omega.vercel.app

## Available Scripts

- `pnpm compile:circuits` — Compile ETH + ERC20 circuits
- `pnpm compile:eth` — Compile ETH circuit only
- `pnpm compile:erc20` — Compile ERC20 circuit only
- `pnpm dev` — Start Next.js dev server (webpack mode)
- `pnpm build` — Production build
- `pnpm start` — Run production server
- `pnpm lint` — Run ESLint

## How It Works

### Proof Generation Flow
1. **Fetch Proof Data** — Call eth_getProof to get state/storage proofs from Ethereum
2. **Generate Witness** — Use Noir to compute witness from proof data
3. **Create Proof** — Barretenberg (bb.js) generates SNARK proof in browser
4. **Verify Locally** — Verify proof on-chain or off-chain

### Noir Circuits

- **eth/src/main.nr** — Verifies state trie proof, decodes balance, checks threshold, signs with EIP-712
- **erc20/src/main.nr** — Verifies state + storage trie proofs, decodes ERC20 balance, similar signing

## Building Circuits

After editing circuit code (`.nr` files), recompile:

```bash
# From project root
pnpm compile:circuits

# Artifacts are generated in:
# - circuits/eth/target/wealth_proof_eth.json
# - circuits/erc20/target/wealth_proof_erc20.json
```

## Testing

```bash
# Test ETH circuit
cd circuits/eth && nargo test

# Test ERC20 circuit
cd circuits/erc20 && nargo test
```

## Dependencies

### Runtime
- **@noir-lang/noir_js** — Noir witness generation
- **@aztec/bb.js** — Barretenberg backend for proof generation
- **ethers v6** — Wallet connection, RPC calls, signing

### Circuit Compilation
- **noir-trie-proofs** — Merkle Patricia Trie (MPT) verification utilities for Ethereum state proofs
  - GitHub: https://github.com/tanghaosuan11/noir-trie-proofs
  - Required for compiling ETH and ERC20 wealth proof circuits
  - Provides utilities for RLP decoding and trie proof verification

## Circuit Dependencies Setup

The Noir circuits in `circuits/eth/` and `circuits/erc20/` depend on the [noir-trie-proofs](https://github.com/tanghaosuan11/noir-trie-proofs) library. This library provides:
- RLP (Recursive Length Prefix) decoding for Ethereum data structures
- Merkle Patricia Trie proof verification
- State and storage proof validation

Make sure the noir-trie-proofs library is accessible before compiling circuits. The circuits reference it through their `Nargo.toml` configuration.

## References

- [Noir Docs](https://docs.noir-lang.org/)
- [Barretenberg](https://github.com/aztecprotocol/barretenberg)
- [noir-trie-proofs](https://github.com/tanghaosuan11/noir-trie-proofs) — Trie proof verification library
- [Ethereum MPT](https://eth.wiki/fundamentals/patricia-tree)
