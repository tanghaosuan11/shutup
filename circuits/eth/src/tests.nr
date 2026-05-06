// Unit tests for wealth_proof_eth helpers
// Run with: nargo test

use super::{decode_be_field, pack_bytes20};
use trie::const::MAX_ACCOUNT_STATE_LENGTH;

// -----------------------------------------------------------------------------
// A. decode_be_field unit tests
// -----------------------------------------------------------------------------

// Test: zero balance (empty RLP string)
#[test]
fn test_decode_be_zero_balance() {
    let arr = [0 as u8; MAX_ACCOUNT_STATE_LENGTH];
    let result = decode_be_field(arr, 0, 0);
    assert(result == 0);
}

// Test: single-byte balance
#[test]
fn test_decode_be_single_byte() {
    let mut arr = [0 as u8; MAX_ACCOUNT_STATE_LENGTH];
    arr[5] = 0xff;
    let result = decode_be_field(arr, 5, 1);
    assert(result == 255);
}

// Test: two-byte balance
#[test]
fn test_decode_be_two_bytes() {
    let mut arr = [0 as u8; MAX_ACCOUNT_STATE_LENGTH];
    arr[10] = 0x01;
    arr[11] = 0x02;
    let result = decode_be_field(arr, 10, 2);
    assert(result == 258);
}

// Test: big-endian with leading zeros
#[test]
fn test_decode_be_leading_zeros() {
    let mut arr = [0 as u8; MAX_ACCOUNT_STATE_LENGTH];
    arr[3] = 0x01;
    let result = decode_be_field(arr, 0, 4);
    assert(result == 1);
}

/// Exactly 32 bytes (maximum allowed) must not panic.
#[test]
fn test_decode_be_max_length_ok() {
    let mut arr = [0 as u8; MAX_ACCOUNT_STATE_LENGTH];
    arr[0] = 0x01;  // MSB of a 32-byte big-endian integer
    // length = 32, should succeed
    let result = decode_be_field(arr, 0, 32);
    // 0x01 followed by 31 zero bytes = 2^248
    // Just assert it's non-zero (exact value is large but this proves no panic)
    assert(result != 0);
}

/// Length = 33 must panic (balance field cannot exceed 32 bytes in Ethereum).
/// This guards against a malformed witness that could silently truncate.
#[test(should_fail_with = "balance field too large: max 32 bytes")]
fn test_decode_be_overflow_length_panics() {
    let arr = [0 as u8; MAX_ACCOUNT_STATE_LENGTH];
    let _ = decode_be_field(arr, 0, 33);
}

/// Length = 100 also panics with the same message.
#[test(should_fail_with = "balance field too large: max 32 bytes")]
fn test_decode_be_huge_length_panics() {
    let arr = [0 as u8; MAX_ACCOUNT_STATE_LENGTH];
    let _ = decode_be_field(arr, 0, 100);
}

// -----------------------------------------------------------------------------
// B. pack_bytes20 unit tests
// -----------------------------------------------------------------------------

/// All-zero address -> Field(0).
#[test]
fn test_pack_bytes20_zero() {
    let addr = [0 as u8; 20];
    assert(pack_bytes20(addr) == 0);
}

/// Address where only the last byte is 1 -> Field(1).
#[test]
fn test_pack_bytes20_one() {
    let mut addr = [0 as u8; 20];
    addr[19] = 0x01;
    assert(pack_bytes20(addr) == 1);
}

/// Address where only the first byte is 1 -> Field(2^152) = 256^19.
#[test]
fn test_pack_bytes20_high_byte() {
    let mut addr = [0 as u8; 20];
    addr[0] = 0x01;
    // 0x01 followed by 19 zero bytes = 256^19
    let expected: Field = 256.pow_32(19);
    assert(pack_bytes20(addr) == expected);
}

/// Two distinct addresses must produce distinct Field elements (injectivity sample).
#[test]
fn test_pack_bytes20_distinct() {
    let mut a = [0 as u8; 20];
    let mut b = [0 as u8; 20];
    a[0] = 0xde;
    b[0] = 0xad;
    assert(pack_bytes20(a) != pack_bytes20(b));
}

// -----------------------------------------------------------------------------
// C. Full-circuit negative witness SKELETONS
// -----------------------------------------------------------------------------
//
// These tests require real Ethereum MPT proof data obtained via eth_getProof.
// They are listed here as documentation; fill in the TODO sections to activate.
//
// How to obtain proof data for a test address:
//   1. Pick a test address with a known balance on mainnet (or a fork).
//   2. Run: cast rpc eth_getProof <address> '[]' <block_hex> --rpc-url <RPC>
//   3. Record: stateRoot (from getBlock), accountProof array, balance (hex).
//   4. Run the TypeScript helper in wealth-proof/lib/prover.ts to format inputs
//      and dump them as a Prover.toml (see formatInputs()).
//
// Then create a test Nargo package under wealth_proof_eth/tests/<test_name>/ and copy
// the Prover.toml there. The tests below document the expected failure mode.

// SKELETON C1: Balance below threshold must fail.
//
// Setup:
//   - Use a real proof for an address with balance B.
//   - Set threshold = B + 1 (one Wei above actual balance).
//   - Expected: constraint fails at `let _: u128 = diff as u128;`
//
// Nargo package structure (create wealth_proof_eth/tests/negative_balance/):
//   Nargo.toml: type = "bin", depends on wealth_proof_eth as a lib or copy main.nr
//   Prover.toml: state_root, threshold = B+1, address, pub_key_x, pub_key_y,
//                signature, state_proof
//   src/main.nr: calls the same main() function
//
// #[test(should_fail)]
// fn skeleton_c1_balance_below_threshold() {
//     // TODO: paste formatInputs() output here
//     // main(state_root, threshold_above_balance, address, pk_x, pk_y, sig, proof);
// }

// SKELETON C2: Wrong ECDSA signature must fail.
//
// Setup:
//   - Use a valid proof (so MPT + balance checks pass).
//   - Flip one byte in `signature` (e.g. signature[0] ^= 0x01).
//   - Expected: constraint fails at `verify_signature(...)`.
//
// #[test(should_fail)]
// fn skeleton_c2_wrong_signature() {
//     // TODO: take a valid witness, then:
//     // signature[0] ^= 0x01;
//     // main(state_root, threshold, address, pk_x, pk_y, signature, proof);
// }

// SKELETON C3: Mismatched address (proof key != private address) must fail.
//
// Setup:
//   - Use a valid proof for address A.
//   - Pass address B (different) as the private `address` input.
//   - Expected: constraint fails at `state_proof.key[i] == address[i]`.
//
// #[test(should_fail)]
// fn skeleton_c3_address_mismatch() {
//     // TODO: take valid witness for address A, substitute address B:
//     // address = <B's bytes>;
//     // main(state_root, threshold, address_B, pk_x, pk_y, sig_A, proof_A);
// }

// SKELETON C4: Tampered trie leaf (wrong state_root) must fail.
//
// Setup:
//   - Use a valid proof.
//   - Flip one byte in `state_root`.
//   - Expected: constraint fails at `verify_state_root(state_root)`.
//
// #[test(should_fail)]
// fn skeleton_c4_tampered_state_root() {
//     // TODO: take valid witness, then:
//     // state_root[0] ^= 0x01;
//     // main(state_root, threshold, address, pk_x, pk_y, sig, proof);
// }

// SKELETON C5: Public key does not match address must fail.
//
// Setup:
//   - Use a valid proof for address A.
//   - Substitute a valid keypair for a *different* address B.
//   - Sign state_root with address B's key.
//   - Expected: constraint fails at `pubkey_hash[12+i] == address[i]`
//     (ECDSA verifies because sig/key are consistent, but keccak(pk) != address_A).
//
// #[test(should_fail)]
// fn skeleton_c5_pubkey_address_mismatch() {
//     // TODO: two address-keypair sets; proof for A, signature from B.
// }
