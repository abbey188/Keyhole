//! Cross-language test vectors. The TypeScript client, the storage node and the contract must reproduce
//! these bytes exactly. Run with `KEYHOLE_WRITE_VECTORS=1 cargo test -p keyhole-proto --test vectors`
//! to regenerate; otherwise the test fails if any byte changes.

use keyhole_proto::{aead, hashing::sha256, kdf, merkle, msgs, padme, receipt, seal, sig, split};
use serde_json::{json, Value};
use std::path::PathBuf;

fn hx(b: &[u8]) -> String {
    hex::encode(b)
}

fn fixed(n: u8) -> [u8; 32] {
    let mut o = [0u8; 32];
    for (i, v) in o.iter_mut().enumerate() {
        *v = n.wrapping_add(i as u8);
    }
    o
}

fn build() -> Value {
    let h = |d: &[u8]| sha256(d);

    // Key hierarchy from fixed PRF outputs.
    let prf1 = fixed(1);
    let prf2 = fixed(2);
    let dr = kdf::data_root(&prf2);
    let box_id = [0xb0u8; 16];
    let bmk = fixed(3);
    let bk0 = kdf::epoch_key(&bmk, 0);
    let item_uid = [0x17u8; 16];
    let dek = kdf::item_dek(&bk0, &item_uid);
    let sk0 = kdf::segment_key(&dek, 0);
    let hierarchy = json!({
        "prf1": hx(&prf1), "prf2": hx(&prf2),
        "account_seed_0": hx(&kdf::account_seed(&prf1, 0)),
        "account_seed_1": hx(&kdf::account_seed(&prf1, 1)),
        "data_root": hx(&dr),
        "box_wrap_key": hx(&kdf::box_wrap_key(&dr, &box_id)),
        "x25519_secret": hx(&kdf::x25519_secret(&dr)),
        "claims_seed": hx(&kdf::claims_seed(&dr)),
        "bmk": hx(&bmk),
        "epoch_key_0": hx(&bk0),
        "epoch_key_1": hx(&kdf::epoch_key(&bmk, 1)),
        "manifest_key_0": hx(&kdf::manifest_key(&bmk, 0)),
        "item_uid": hx(&item_uid),
        "item_dek": hx(&dek),
        "segment_key_0": hx(&sk0),
        "segment_key_1": hx(&kdf::segment_key(&dek, 1)),
        "dek_commit": hx(&kdf::dek_commit(&dek)),
        "bmk_commit": hx(&kdf::bmk_commit(&bmk)),
    });

    // Segment AEAD with a fixed nonce, padded plaintext.
    let plaintext = b"Rent: 1200 GBP per month. Term ends 2027-08-31.";
    let padded = padme::pad(plaintext);
    let aad = aead::seg_aad(&box_id, &item_uid, 0, 1, 0);
    let nonce = [0x24u8; aead::NONCE_LEN];
    let unit = aead::seal_with_nonce(&sk0, &nonce, &padded, &aad);
    let segment = json!({
        "plaintext": hx(plaintext), "padded_len": padded.len(), "padded": hx(&padded),
        "aad": hx(&aad), "nonce": hx(&nonce), "unit": hx(&unit),
    });

    // Padme lengths.
    let padme_lens: Vec<Value> = [0usize, 1, 2, 3, 5, 9, 100, 1000, 65536, 1_000_000, 33_554_432]
        .iter()
        .map(|&n| json!({"len": n, "padme": padme::padme_len(n)}))
        .collect();

    // Merkle trees over deterministic leaf pieces.
    let mut trees = Vec::new();
    for n in [1usize, 2, 3, 4, 5, 8, 9, 13, 16, 17] {
        let ls: Vec<[u8; 32]> = (0..n)
            .map(|i| merkle::leaf_hash(&h, format!("leaf-{i}").as_bytes()))
            .collect();
        let r = merkle::root(&h, &ls);
        let idx = n / 2;
        let path: Vec<String> = merkle::audit_path(&h, &ls, idx).iter().map(|p| hx(p)).collect();
        trees.push(json!({
            "n": n, "leaf_prefix": "leaf-", "root": hx(&r), "proof_index": idx, "proof": path,
            "blob_id": hx(&merkle::blob_id(&h, &r, (n * 65536) as u64, 65536, 1)),
        }));
    }

    // Split key.
    let seed = fixed(9);
    let s1 = split::s1(&seed, &item_uid, 0);
    let s2 = split::s2(&sk0, &s1);
    let split_v = json!({"seed": hx(&seed), "s1": hx(&s1), "s2": hx(&s2), "combined": hx(&split::combine(&s1, &s2))});

    // Sealed box with fixed ephemeral secret and nonce.
    let rsk = fixed(20);
    let rpk = seal::public_key(&rsk);
    let sealed = seal::seal_with(&rpk, b"S2-half", b"keyhole/v1/seal", &fixed(30), &[0x31u8; 24]).unwrap();
    let seal_v = json!({
        "recipient_secret": hx(&rsk), "recipient_public": hx(&rpk), "info": "keyhole/v1/seal",
        "ephemeral_secret": hx(&fixed(30)), "nonce": hx(&[0x31u8; 24]), "plaintext": hx(b"S2-half"), "sealed": hx(&sealed),
    });

    // Messages, signatures, receipts.
    let grant_id = [0x61u8; 16];
    let session_id = [0x62u8; 16];
    let session_pk = fixed(40);
    let req_seed = fixed(50);
    let req_pk = sig::public_key(&req_seed);
    let open = msgs::open_msg("testnet", "keyhole.testnet", &grant_id, &session_id, &session_pk, 1_700_000_000_000);
    let open_sig = sig::sign(&req_seed, &open);
    let rd = receipt::requester_digest_bearer(&h, &req_pk);
    let c1 = receipt::commitment(&h, &grant_id, &session_id, &session_pk, &rd, 1_700_000_000_000);
    let c2 = receipt::commitment(&h, &grant_id, &[0x63u8; 16], &session_pk, &rd, 1_700_000_100_000);
    let head1 = receipt::chain_next(&h, &receipt::GENESIS_HEAD, &c1);
    let head2 = receipt::chain_next(&h, &head1, &c2);
    let blob = [0x77u8; 32];
    let node_seed = fixed(60);
    let ack = msgs::ack_msg("testnet", "keyhole.testnet", 7, &blob, 0, 1_800_000_000_000);
    let msgs_v = json!({
        "open_msg": hx(&open), "requester_seed": hx(&req_seed), "requester_pk": hx(&req_pk), "open_sig": hx(&open_sig),
        "requester_digest": hx(&rd), "commitment_1": hx(&c1), "commitment_2": hx(&c2),
        "head_1": hx(&head1), "head_2": hx(&head2),
        "ack_msg": hx(&ack), "node_seed": hx(&node_seed), "node_pk": hx(&sig::public_key(&node_seed)),
        "ack_sig": hx(&sig::sign(&node_seed, &ack)),
        "erase_msg": hx(&msgs::erase_msg("testnet", "keyhole.testnet", 7, &blob)),
        "close_msg": hx(&msgs::close_msg("testnet", "keyhole.testnet", &session_id, &[0x88u8; 32], 1_700_000_200_000)),
        "ticket_msg": hx(&msgs::ticket_msg(&blob, &session_id, 1_700_000_300_000)),
    });

    json!({
        "version": "keyhole/v1",
        "note": "Generated by crates/keyhole-proto/tests/vectors.rs. Do not edit by hand.",
        "hierarchy": hierarchy, "segment": segment, "padme": padme_lens, "merkle": trees,
        "split": split_v, "seal": seal_v, "messages": msgs_v,
    })
}

fn path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../vectors/keyhole-v1.json")
}

#[test]
fn vectors_match_committed_file() {
    let v = build();
    let text = serde_json::to_string_pretty(&v).unwrap() + "\n";
    if std::env::var("KEYHOLE_WRITE_VECTORS").is_ok() {
        std::fs::write(path(), text).unwrap();
        return;
    }
    let committed = std::fs::read_to_string(path()).expect("vectors file missing: run with KEYHOLE_WRITE_VECTORS=1");
    // Compare parsed values, not text: with `cargo test --workspace` another crate turns on serde_json's
    // `preserve_order`, which changes key order in the serialized text but not the content.
    let committed_v: serde_json::Value = serde_json::from_str(&committed).expect("committed vectors are valid JSON");
    assert_eq!(committed_v, v, "protocol bytes changed: regenerate vectors only if the change is intended");
}

#[test]
fn vectors_are_internally_consistent() {
    let v = build();
    // The committed segment unit decrypts and unpads to the plaintext.
    let h = |d: &[u8]| sha256(d);
    let seg = &v["segment"];
    let sk0 = hex::decode(v["hierarchy"]["segment_key_0"].as_str().unwrap()).unwrap();
    let unit = hex::decode(seg["unit"].as_str().unwrap()).unwrap();
    let aad = hex::decode(seg["aad"].as_str().unwrap()).unwrap();
    let mut key = [0u8; 32];
    key.copy_from_slice(&sk0);
    let padded = aead::open(&key, &unit, &aad).unwrap();
    assert_eq!(hx(&padme::unpad(&padded).unwrap()), seg["plaintext"].as_str().unwrap());
    // Each Merkle proof verifies.
    for t in v["merkle"].as_array().unwrap() {
        let n = t["n"].as_u64().unwrap() as usize;
        let ls: Vec<[u8; 32]> = (0..n).map(|i| merkle::leaf_hash(&h, format!("leaf-{i}").as_bytes())).collect();
        let idx = t["proof_index"].as_u64().unwrap() as usize;
        let path: Vec<[u8; 32]> = t["proof"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| hex::decode(x.as_str().unwrap()).unwrap().try_into().unwrap())
            .collect();
        let root: [u8; 32] = hex::decode(t["root"].as_str().unwrap()).unwrap().try_into().unwrap();
        assert!(merkle::verify_inclusion(&h, &ls[idx], idx, n, &path, &root));
    }
}
