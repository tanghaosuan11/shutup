// Anonymous ERC20 Wealth Proof -- Noir Circuit
// Proves: I hold >= threshold ERC20 tokens without revealing address or balance.
// Steps: verify state proof -> verify storage proof -> decode balance -> check threshold -> EIP-712 signature -> commitment

use ::trie::{
    trie_proof::TrieProof,
    const::MAX_ACCOUNT_STATE_LENGTH,
    rlp,
    utils::byte_value,
};
use keccak::keccak256;

global DEPTH10_MAX: u32 = 5320;
global STORAGE_VALUE_LEN: u32 = 32;

/// Public: state_root, threshold, user_tag, block_number, chain_id, contract_address, mapping_slot
/// Private: wallet_address, pub_key_x/y, signature, state_proof, storage_proof
/// Returns: Pedersen commitment
fn main(
    // Public inputs
    state_root:       pub [u8; 32],
    threshold:        pub u128,
    user_tag:         pub [u8; 32],
    block_number:     pub u64,
    chain_id:         pub u64,
    contract_address: pub [u8; 20],
    mapping_slot:     pub u64,

    // Private inputs
    wallet_address: [u8; 20],
    pub_key_x:      [u8; 32],
    pub_key_y:      [u8; 32],
    signature:      [u8; 64],

    // MPT proofs (private - values are kept secret)
    state_proof:   TrieProof<20, DEPTH10_MAX, MAX_ACCOUNT_STATE_LENGTH>,
    storage_proof: TrieProof<32, DEPTH10_MAX, STORAGE_VALUE_LEN>,
) -> pub Field /* commitment */ {

    // Verify contract account in state trie
    assert(state_proof.verify_state_root(state_root));

    // Bind contract_address to state proof key
    for i in 0..20 {
        assert(state_proof.key[i] == contract_address[i]);
    }

    // Decode account RLP: [nonce, balance, storageRoot, codeHash]
    let (account_buf, _) = byte_value(state_proof.value);
    let account_fields: rlp::RLP_List<4> = rlp::decode1(account_buf);

    let sr_offset = account_fields.offset[2];
    let sr_len    = account_fields.length[2];
    assert(sr_len == 32, "storageRoot must be exactly 32 bytes");

    let mut storage_root: [u8; 32] = [0; 32];
    for i in 0..32_u32 {
        storage_root[i] = account_buf[(sr_offset + i as u64) as u32];
    }

    // Compute storage key = keccak256(abi.encode(wallet_address, mapping_slot))
    let mut slot_preimage = [0 as u8; 64];

    for i in 0..20 { slot_preimage[12 + i] = wallet_address[i]; }

    let slot_be = u64_to_be_bytes(mapping_slot);
    for i in 0..8 { slot_preimage[56 + i] = slot_be[i]; }
    let storage_key: [u8; 32] = keccak256(slot_preimage, 64);

    // Assert computed storage_key matches proof key
    for i in 0..32 {
        assert(storage_proof.key[i] == storage_key[i]);
    }

    // Verify storage proof against contract storageRoot
    assert(storage_proof.verify_storage_root(storage_root));

    // Decode balance from 32-byte big-endian storage value
    let balance_field = decode_be_field_32(storage_proof.value);

    // Assert balance >= threshold (cast to u128 adds range check)
    let diff: Field = balance_field - (threshold as Field);
    let _: u128 = diff as u128;

    // EIP-712 ECDSA signature verification
    // Binds: threshold, state_root, user_tag, block_number, chain_id, contract_address, mapping_slot
    let domain_separator: [u8; 32] = [
        0x16, 0x02, 0x2a, 0x0a, 0x9e, 0xc1, 0xe3, 0xe6,
        0xab, 0xd4, 0x9e, 0xa5, 0xb2, 0x93, 0x63, 0xbe,
        0x21, 0x5d, 0xf8, 0x4f, 0x13, 0x0c, 0x55, 0x74,
        0x56, 0xe0, 0x37, 0xac, 0xc7, 0xb1, 0x58, 0x35,
    ];

    let struct_type_hash: [u8; 32] = [
        0xf5, 0xd4, 0x74, 0xb7, 0xdc, 0x6d, 0x36, 0x02,
        0x14, 0xd9, 0xe5, 0xa2, 0x31, 0xfb, 0x3e, 0x28,
        0x96, 0x5d, 0xa3, 0x7f, 0x78, 0x07, 0x11, 0xa0,
        0x88, 0x04, 0xed, 0xf3, 0x50, 0x10, 0x8c, 0x88,
    ];

    // Compute struct_hash (256 bytes total)
    let mut struct_input = [0 as u8; 256];
    for i in 0..32 { struct_input[i] = struct_type_hash[i]; }
    let threshold_bytes = u128_to_be_bytes(threshold);

    for i in 0..16 { struct_input[48 + i] = threshold_bytes[i]; }
    for i in 0..32 { struct_input[64 + i] = state_root[i]; }
    for i in 0..32 { struct_input[96 + i] = user_tag[i]; }
    let block_number_bytes = u64_to_be_bytes(block_number);

    for i in 0..8 { struct_input[152 + i] = block_number_bytes[i]; }
    let chain_id_bytes = u64_to_be_bytes(chain_id);

    for i in 0..8 { struct_input[184 + i] = chain_id_bytes[i]; }

    for i in 0..20 { struct_input[204 + i] = contract_address[i]; }
    let slot_bytes = u64_to_be_bytes(mapping_slot);

    for i in 0..8 { struct_input[248 + i] = slot_bytes[i]; }
    let struct_hash: [u8; 32] = keccak256(struct_input, 256);

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
        assert(pubkey_hash[12 + i] == wallet_address[i], "Public key does not match wallet address");
    }

    // Return Pedersen commitment(wallet_address, balance)
    let wallet_field = pack_bytes20(wallet_address);
    std::hash::pedersen_hash([wallet_field, balance_field])
}

//  Helper functions 

/// Decode big-endian bytes as Field (max 32 bytes)
fn decode_be_field_32(arr: [u8; 32]) -> Field {
    let mut result: Field = 0;
    for i in 0..32 {
        result = result * 256 + arr[i] as Field;
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

/// Encode u128 as 16-byte big-endian
fn u128_to_be_bytes(x: u128) -> [u8; 16] {
    let mut bytes = [0 as u8; 16];
    let mut val = x;
    for i in 0..16 {
        bytes[15 - i] = (val & 0xff) as u8;
        val = val >> 8;
    }
    bytes
}

/// Encode u64 as 8-byte big-endian
fn u64_to_be_bytes(x: u64) -> [u8; 8] {
    let mut bytes = [0 as u8; 8];
    let mut val = x;
    for i in 0..8 {
        bytes[7 - i] = (val & 0xff) as u8;
        val = val >> 8;
    }
    bytes
}
