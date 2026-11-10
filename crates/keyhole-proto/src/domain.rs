//! Domain separation: every hash or KDF input starts with `keyhole/v1/<purpose>` and a zero byte.

/// Protocol version prefix.
pub const PREFIX: &str = "keyhole/v1/";

/// Returns `keyhole/v1/<purpose>\0`.
pub fn tag(purpose: &str) -> Vec<u8> {
    let mut v = Vec::with_capacity(PREFIX.len() + purpose.len() + 1);
    v.extend_from_slice(PREFIX.as_bytes());
    v.extend_from_slice(purpose.as_bytes());
    v.push(0);
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tag_format() {
        assert_eq!(tag("open"), b"keyhole/v1/open\0".to_vec());
    }
    #[test]
    fn tags_are_prefix_free() {
        // The trailing zero byte means no tag is a prefix of another.
        let a = tag("a");
        let ab = tag("ab");
        assert!(!ab.starts_with(&a));
    }
}
