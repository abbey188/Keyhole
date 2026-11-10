//! Keyhole protocol crate.
//!
//! Pure byte formats (`domain`, `msgs`, `receipt`, `merkle`) are always available and generic over a
//! SHA-256 function so the NEAR contract can use the runtime host function. Cryptographic helpers
//! (`kdf`, `aead`, `padme`, `split`, `seal`, `sig`, `hashing`) need the default `crypto` feature.
//!
//! Spec: context/spec/02_CRYPTO_AND_KEYS.md and 04_CONTRACT.md. Test vectors: vectors/keyhole-v1.json.
#![forbid(unsafe_code)]

pub mod domain;
pub mod merkle;
pub mod msgs;
pub mod receipt;
pub mod release;

#[cfg(feature = "crypto")]
pub mod aead;
#[cfg(feature = "crypto")]
pub mod hashing;
#[cfg(feature = "crypto")]
pub mod kdf;
#[cfg(feature = "crypto")]
pub mod padme;
#[cfg(feature = "crypto")]
pub mod seal;
#[cfg(feature = "crypto")]
pub mod sig;
#[cfg(feature = "crypto")]
pub mod split;

/// Errors for the crypto helpers. Deliberately coarse: callers never learn why a check failed.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Error {
    /// Authentication failed, malformed input, or wrong key.
    Invalid,
}

/// Leaf size of the blob Merkle tree in bytes (spec 02 section 4).
pub const LEAF_SIZE: usize = 64 * 1024;
/// FastFS part size in bytes (16 leaves).
pub const BLOCK_SIZE: usize = 1024 * 1024;
