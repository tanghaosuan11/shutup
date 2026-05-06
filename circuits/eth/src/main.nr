// Anonymous Wealth Proof -- Noir Circuit
// Proves: I hold >= threshold ETH without revealing address or balance.
// Steps: verify MPT proof -> extract balance -> check threshold -> EIP-712 signature -> Pedersen commitment

use ::trie::{
    trie_proof::TrieProof,
    const::MAX_ACCOUNT_STATE_LENGTH,
    rlp,
    utils::byte_value,
};
use keccak::keccak256;

// Max state proof size (depth 10, ~5320 bytes)
global DEPTH10_MAX: u32 = 5320;

/// Public: state_root, threshold, user_tag, block_number, chain_id
/// Private: address, pub_key_x/y, signature, state_proof
/// Returns: Pedersen commitment
fn main(
    // Public inputs
    state_root:   pub [u8; 32],
    threshold:    pub u128,
    user_tag:     pub [u8; 32],
    block_number: pub u64,
    chain_id:     pub u64,

    // Private inputs
    address:     [u8; 20],
    pub_key_x:   [u8; 32],
    pub_key_y:   [u8; 32],
    signature:   [u8; 64],
    state_proof: TrieProof<20, DEPTH10_MAX, MAX_ACCOUNT_STATE_LENGTH>,
) -> pub Field /* commitment */ {

    // Verify state proof -> account state at state_root
    assert(state_proof.verify_state_root(state_root));

    // Check address matches proof key
    for i in 0..20 {
        assert(state_proof.key[i] == address[i]);
    }

    // Decode RLP account state: [nonce, balance, storageRoot, codeHash]
    let (account_buf, _) = byte_value(state_proof.value);


    let account_fields: rlp::RLP_List<4> = rlp::decode1(account_buf);

    // Extract balance from account state (index 1)
    let balance_field = decode_be_field(
        account_buf,
        account_fields.offset[1],
        account_fields.length[1],
    );

    // Assert balance >= threshold (cast to u128 adds range check)
    let diff: Field = balance_field - (threshold as Field);
    let _: u128 = diff as u128;

    // EIP-712 ECDSA signature verification
    // Binds: threshold, state_root, user_tag, block_number, chain_id
    let domain_separator: [u8; 32] = [
        0x16, 0x02, 0x2a, 0x0a, 0x9e, 0xc1, 0xe3, 0xe6,
        0xab, 0xd4, 0x9e, 0xa5, 0xb2, 0x93, 0x63, 0xbe,
        0x21, 0x5d, 0xf8, 0x4f, 0x13, 0x0c, 0x55, 0x74,
        0x56, 0xe0, 0x37, 0xac, 0xc7, 0xb1, 0x58, 0x35,
    ];

    let struct_type_hash: [u8; 32] = [
        0xa9, 0xe7, 0xd8, 0xdd, 0x71, 0x6c, 0x93, 0xdc,
        0xcb, 0xd7, 0x17, 0x94, 0x19, 0x29, 0x5f, 0x25,
        0xf8, 0x59, 0x21, 0xc4, 0xa6, 0xfd, 0xc4, 0x5f,
        0x59, 0x9c, 0x05, 0x17, 0x0b, 0xbd, 0x41, 0x3d,
    ];

    // Compute struct_hash (192 bytes total)
    let mut struct_input = [0 as u8; 192];
    for i in 0..32 { struct_input[i] = struct_type_hash[i]; }
    let threshold_bytes = u128_to_be_bytes(threshold);

    for i in 0..16 { struct_input[48 + i] = threshold_bytes[i]; }
    for i in 0..32 { struct_input[64 + i] = state_root[i]; }
    for i in 0..32 { struct_input[96 + i] = user_tag[i]; }
    let block_number_bytes = u64_to_be_bytes(block_number);

    for i in 0..8 { struct_input[152 + i] = block_number_bytes[i]; }
    let chain_id_bytes = u64_to_be_bytes(chain_id);

    for i in 0..8 { struct_input[184 + i] = chain_id_bytes[i]; }
    let struct_hash: [u8; 32] = keccak256(struct_input, 192);

    // msg_hash = keccak256("\x19\x01" || domain_separator || struct_hash)
    let mut final_input = [0 as u8; 66];
    final_input[0] = 0x19;
    final_input[1] = 0x01;
    for i in 0..32 { final_input[2 + i] = domain_separator[i]; }
    for i in 0..32 { final_input[34 + i] = struct_hash[i]; }
    let msg_hash: [u8; 32] = keccak256(final_input, 66);

    assert(std::ecdsa_secp256k1::verify_signature(pub_key_x, pub_key_y, signature, msg_hash));

    // Recover address from pubkey and verify it matches
    let mut pubkey_bytes = [0 as u8; 64];
    for i in 0..32 { pubkey_bytes[i] = pub_key_x[i]; }
    for i in 0..32 { pubkey_bytes[32 + i] = pub_key_y[i]; }
    let pubkey_hash: [u8; 32] = keccak256(pubkey_bytes, 64);
    for i in 0..20 {
        assert(pubkey_hash[12 + i] == address[i], "Public key does not match address");
    }

    // Return Pedersen commitment(address, balance)
    let address_field = pack_bytes20(address);
    std::hash::pedersen_hash([address_field, balance_field])
}

// Helper functions

/// Decode big-endian bytes as Field (max 32 bytes)
fn decode_be_field(
    arr:    [u8; MAX_ACCOUNT_STATE_LENGTH],
    offset: u64,
    length: u64,
) -> Field {
    assert(length <= 32, "balance field too large: max 32 bytes");
    let mut result: Field = 0;
    for i in 0..32_u32 {
        if (i as u64) < length {
            let idx: u32 = (offset + i as u64) as u32;
            result = result * 256 + arr[idx] as Field;
        }
    }
    result
}

/// Pack 20-byte address as Field (big-endian)
fn pack_bytes20(addr: [u8; 20]) -> Field {
    let mut f: Field = 0;
    for i in 0..20 {
        f = f * 256 + addr[i] as Field;
    }
    f
}

/// Encode a u128 as a 16-byte big-endian array.
fn u128_to_be_bytes(x: u128) -> [u8; 16] {
    let mut bytes = [0 as u8; 16];
    let mut val = x;
    for i in 0..16 {
        bytes[15 - i] = (val & 0xff) as u8;
        val = val >> 8;
    }
    bytes
}

/// Encode a u64 as an 8-byte big-endian array.
fn u64_to_be_bytes(x: u64) -> [u8; 8] {
    let mut bytes = [0 as u8; 8];
    let mut val = x;
    for i in 0..8 {
        bytes[7 - i] = (val & 0xff) as u8;
        val = val >> 8;
    }
    bytes
}

// Unit tests and integration-test skeletons.
mod tests;
