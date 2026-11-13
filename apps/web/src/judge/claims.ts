// Every claim shown on the judge page, with the test or transaction that proves it. A claim is listed only if it has proof;
// things not done are listed as NOT FINISHED or LATER. Paths are relative to the repository root.
export type Status = "proven" | "proven (mock chain)" | "partly" | "NOT FINISHED" | "LATER";
export interface JudgeClaim {
  id: string;
  claim: string;
  status: Status;
  proof: string[]; // files, test names, or "tx:<file>:<label>" resolved from deploy/*.json
  limit?: string;
}

export const CLAIMS: JudgeClaim[] = [
  { id: "NFT1", claim: "A safe is an NFT with NEP-171 views and NEP-297 events. Ordinary transfer is blocked; ownership moves only through a completed handover.", status: "proven",
    proof: ["tx:attack-lab:A7", "tx:attack-lab:A8", "contracts/keyhole/src/tests.rs nft_transfer_always_panics", "deploy/smoke-deal-testnet.json (a real handover)"], limit: "Safes have a serial and state, no art. nft_token metadata does not yet carry live state (composed from get_box and events)." },
  { id: "NFT2", claim: "The token is the permission root: only the owner can give access, end it, re-lock, or hand over; after a handover every earlier grant dies (epoch bump) and the previous owner can do nothing.", status: "proven",
    proof: ["tx:attack-lab:A6", "apps/web/e2e/a6.mjs (two users, testnet)", "apps/web/test/handover.test.ts", "contracts/keyhole/src/tests_deals.rs grants_from_before_the_deal_stop_working"] },
  { id: "KEYLESS", claim: "The deployed contract has no access keys, so nobody (including us) can change its rules or move a safe.", status: "proven", proof: ["live check on this page", "tx:deploy:launch", "scripts/verify.sh step 5"], limit: "Demo configuration (short waiting period); testnet only." },
  { id: "REPRO", claim: "The deployed Wasm is reproducible from the recorded source commit.", status: "proven", proof: ["deploy/testnet.json wasm.sourceCommit", "scripts/build-wasm.sh"] },
  { id: "CONF", claim: "Contents are encrypted on the owner's device; the storage node holds only ciphertext and every read is verified against an on-chain commitment; tampering fails closed.", status: "proven",
    proof: ["apps/web/test/vault.test.ts", "apps/web/test/upload.test.ts (tamper)", "packages/store/test/store.test.ts (S8)", "services/node/test/node.test.ts"] },
  { id: "RECEIPT", claim: "No key is released before the opening is final and recorded on chain (receipt first).", status: "proven",
    proof: ["services/release/test/release.test.ts A1", "apps/web/e2e/a3.mjs (opened in about 6 s on testnet)"] },
  { id: "LOG", claim: "Every opening is a receipt in a hash chain the contract keeps; the app recomputes it and shows Verified or Broken; a removed, altered or extra row is caught.", status: "proven",
    proof: ["apps/web/test/visitors.test.ts", "apps/web/e2e/a4.mjs (testnet)", "deploy/smoke-testnet.json (chain recomputed equals the on-chain head)"], limit: "The release service keeps the page-level log in memory; a restart loses it." },
  { id: "REVOKE", claim: "Ending access makes the next open and the next key release fail, at the release service and at the storage node.", status: "proven",
    proof: ["tx:attack-lab:A4", "apps/web/e2e/a3.mjs", "services/release/test/release.test.ts A2"], limit: "What a recipient already saved or photographed stays theirs." },
  { id: "RELOCK", claim: "Re-lock re-encrypts everything under a new key and has the node erase the old copies; old keys open only what was already in hand.", status: "proven", proof: ["apps/web/test/relock.test.ts (R1)"], limit: "Erasure attestations are signed claims, not proof of physical erasure." },
  { id: "ATTACK", claim: "Nine real attacks against the deployed contract are refused, each with its transaction.", status: "proven", proof: ["deploy/attack-lab-testnet.json", "tools/testnet/src/attack-lab.ts"] },
  { id: "SALE", claim: "A sale moves ownership and payment together through contract escrow; a funded deal can be cancelled and refunded; an offer needs the release service's acknowledgement.", status: "proven", proof: ["deploy/smoke-deal-testnet.json", "tx:attack-lab:A9", "contracts/keyhole/src/tests_deals.rs"], limit: "NEAR only; testnet money; the in-app handover run was free." },
  { id: "PASSKEY", claim: "Sign-in with a passkey derives the account and the keys; the same passkey unlocks the same account.", status: "partly", proof: ["apps/web/e2e/a1.mjs (virtual authenticator with PRF)", "apps/web/test/keys.test.ts (matches the Rust vectors)"], limit: "Real-device passkey test NOT FINISHED. Passphrase fallback is labelled weaker." },
  { id: "AI1", claim: "Ask my safe: search on the device, only the needed pages sent, end-to-end encrypted to an attested Private model; every answer must quote the owner's own page or it is dropped; an unrelated question sends nothing.", status: "proven",
    proof: ["packages/askclaims tests (injection, fabricated citations)", "apps/web/e2e/b3.mjs (live, Qwen3.8, 15 s)"], limit: "Attestation checks passed but are NOT complete: Intel TCB status was not performed. The quote does not name the model weights. Scanned pages are not searchable (no OCR)." },
  { id: "AI2", claim: "The attestation client really checks: nonce, signing-key binding, TDX quote signature and Intel certificate chain pinned to Intel's root, report data, debug off, compose binding, event-log replay, and NVIDIA GPU evidence through NVIDIA's service; 18 tamper tests fail as required.", status: "proven", proof: ["packages/ai tests", "packages/ai/test/live.test.ts"], limit: "Not checked: Intel TCB level and revocations, model identity, GPU-to-CPU binding, TLS binding." },
  { id: "AI3", claim: "Only models owned by nearai or marked attested 3p are treated as Private; routed models are refused any file content.", status: "proven", proof: ["packages/ai tests (privacy tier, request builder refusals)"] },
  { id: "ASKGRANT", claim: "An owner can let a recipient ask a few questions: the budget is committed in the grant, every question and answer is sealed to the owner, and anything outside the shared files is refused with fixed wording.", status: "proven", proof: ["services/release/test/ask.test.ts", "apps/web/test/ask-access.test.ts", "apps/web/e2e/b6.mjs (live on testnet)"], limit: "A refused question still uses one budget slot. The AI relay is not tied to visit sessions in this build (local demo only). Same attestation limits as Ask." },
  { id: "CLAIMS", claim: "Claims instead of files: facts read on the device, owner-reviewed, signed; a recipient sees the claim, not the document; offline check; fixed grade wording.", status: "proven", proof: ["packages/askclaims tests", "apps/web/test/claims.test.ts", "apps/web/e2e/b4.mjs (live, grade B)"], limit: "A claim is the owner's statement backed by a document, not a certificate. Grades A and Proved are not offered. Rules are tuned to the generated demo documents." },
  { id: "SEC", claim: "An internal hostile review found and fixed a contract storage bug, an unproven-key-half sale offer, and several service flaws; open items are listed.", status: "proven", proof: ["SECURITY.md", "contracts/keyhole/src/tests.rs deleting_a_grant_keeps_the_stake_of_every_opened_session"], limit: "No external audit." },
  { id: "RELEASE", claim: "The release service (holds half of each key) is a single trusted party in this build.", status: "partly", proof: ["README trust section"], limit: "Threshold release across three services is LATER. A compromised release service plus a leaked link reads what the grant covers." },
  { id: "ZK", claim: "Zero-knowledge proof of a credential.", status: "LATER", proof: [], limit: "Not built. Spec 12 records the measured cost and the overlap with another entry." },
  { id: "TEEREL", claim: "Release service running inside a hardware enclave.", status: "LATER", proof: [], limit: "Needs a TEE host." },
];
