use near_sdk::{env, require, NearToken, Promise};

fn decode_fixed<const N: usize>(s: &str, what: &str) -> [u8; N] {
    let bytes = hex::decode(s).unwrap_or_else(|_| env::panic_str(&format!("{what}: bad hex")));
    require!(bytes.len() == N, format!("{what}: expected {N} bytes"));
    let mut out = [0u8; N];
    out.copy_from_slice(&bytes);
    out
}

/// Parses a 16-byte identifier from 32 hex characters.
pub fn id16(s: &str) -> [u8; 16] {
    decode_fixed::<16>(s, "id")
}

/// Parses 32 bytes from 64 hex characters.
pub fn hash32(s: &str) -> [u8; 32] {
    decode_fixed::<32>(s, "hash")
}

/// Parses 64 bytes from 128 hex characters.
pub fn hash64(s: &str) -> [u8; 64] {
    decode_fixed::<64>(s, "signature")
}

/// Storage-deposit pattern (spec 04 section 3): the caller pays for the storage delta plus `extra`;
/// any excess of the attached deposit is refunded. Returns the amount that stays with the record.
/// Callers must flush their collections before calling so storage usage is current.
pub fn settle_storage(usage_before: u64, extra: NearToken) -> NearToken {
    let used = env::storage_usage().saturating_sub(usage_before);
    let cost = env::storage_byte_cost().saturating_mul(used as u128).saturating_add(extra);
    let attached = env::attached_deposit();
    require!(
        attached >= cost,
        format!("Attach at least {} yoctoNEAR (storage and prepaid stake)", cost.as_yoctonear())
    );
    let excess = attached.saturating_sub(cost);
    if !excess.is_zero() {
        let _ = Promise::new(env::predecessor_account_id()).transfer(excess);
    }
    cost
}
