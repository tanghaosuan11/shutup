# Wealth Proof Noir Circuits

This directory contains two zero-knowledge circuits for proving Ethereum holdings without revealing the wallet address or exact balance.

## Circuits

### `eth/` - ETH Wealth Proof Circuit
Proves ownership of a minimum ETH balance using a single Ethereum state trie proof.

**Public inputs:**
- `state_root`: Ethereum block state root
- `threshold`: Minimum balance in Wei (u128)
- `user_tag`: keccak256 hash of user-chosen label (string)
- `block_number`: Block height (u64, replay protection)
- `chain_id`: EVM chain ID (u64, replay protection)

**Output:** Pedersen commitment to (address, balance)

### `erc20/` - ERC20 Token Wealth Proof Circuit
Proves ownership of a minimum ERC20 token balance using dual MPT proofs (state trie + storage trie).

**Public inputs:**
- `state_root`: Ethereum block state root
- `threshold`: Minimum token balance in raw units (u128)
- `user_tag`: keccak256 hash of user-chosen label (string)
- `block_number`: Block height (u64, replay protection)
- `chain_id`: EVM chain ID (u64, replay protection)
- `contract_address`: ERC20 token contract address (bytes20)
- `mapping_slot`: Storage slot of the `balances` mapping in the contract (u64)

**Output:** Pedersen commitment to (address, balance)

## Building

### Compile both circuits
```bash
# From wealth-proof root directory
pnpm compile:circuits
```

### Compile ETH circuit only
```bash
pnpm compile:eth
```

### Compile ERC20 circuit only
```bash
pnpm compile:erc20
```

### Manual compilation
```bash
cd eth && nargo compile
cd ../erc20 && nargo compile
```

## Output Artifacts

After compilation, circuit artifacts are generated in:
- `eth/target/wealth_proof_eth.json` (1.8 MB)
- `erc20/target/wealth_proof_erc20.json` (3.3 MB)

These are automatically copied to `../public/` during the build process for the Next.js frontend to load.

## Dependencies

Both circuits depend on:
- **noir-trie-proofs** (`../../noir-trie-proofs/lib`) — MPT verification utilities
- **keccak** (`https://github.com/noir-lang/keccak256`) — Keccak256 hash function

## Testing

```bash
cd eth && nargo test
cd ../erc20 && nargo test
```

## Documentation

See the `main.nr` files in each circuit directory for detailed inline documentation of the proof process.
