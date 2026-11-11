# Security

Keyhole is a hackathon prototype on NEAR testnet. It has had no external audit. Do not store real sensitive data in it.

- Threat model, residual risks and the list of what we do **not** claim: `docs/spec/09_THREAT_MODEL_AND_LIMITS.md`.
- Reporting a vulnerability: open a private security advisory on the repository, or contact the maintainers listed in the repository profile. We do not run a bug bounty.
- Known limits that matter most: the release service is a trusted third party for expiry and for deal keys; a recipient keeps whatever they saw; a stolen passkey is full compromise except for delayed sales; the contract has no upgrade path by design; screenshots cannot be prevented.

## Internal security review (2026-11-10/11)
A hostile read of the contract and services. Not an external audit. Fixed items have tests (see `CLAIMS.md`); the open items are known and unfixed.

| # | Finding | Severity | Status |
|---|---|---|---|
| S1 | `delete_grant` refunded the stake of opened sessions while their records stayed, so the contract's balance carried the storage (a cheap way to lock it up) | High | **Fixed** in the v3 contract: used stakes are kept; init refuses a stake smaller than a session record |
| S2 | A sale offer was accepted with no proof the release service held the key half | Medium | **Fixed** in v3: `create_deal` verifies the release service's signed acknowledgement |
| S4 | `set_wrapped_bmk` could grow a record without paying | Low | **Fixed** in v3. A sale still grows the buyer's box list by 16 unpaid bytes |
| S5 | The node erased local data on a single "record missing" answer (a lagging RPC could cause data loss) | High | **Fixed**: erased only after the record stays missing for three sweeps over ten minutes of chain time |
| S7 | Anyone could lock a recipient out of a grant with bad-signature opens (grant ids are public) | Medium | **Fixed**: backoff is per caller and grant |
| S8 | Signed owner requests could be replayed for two minutes | Medium | **Fixed**: each signature is accepted once. The services still speak plain HTTP and need TLS in front |
| S13 | A close that failed on chain could not be retried | Low | **Fixed** |
| S14 | Owner read tickets had no maximum lifetime | Low | **Fixed**: ten minutes |
| S3 | Release-service and node keys are immutable in the contract; a leaked or lost key strands that deployment's boxes (no migration) | Medium, by design | Open |
| S6 | Services trust one RPC endpoint for state, time and access keys (first answer wins) | Medium | Open: needs agreement between independent RPCs and block-height pinning |
| S9 | The relayer's gas can be spent by an owner looping opens and closes | Medium on a paid network | Open: needs per-box relay budgets |
| S10 | A read ticket covers a whole blob, so a recipient of one page can copy the ciphertext of the others | Low to medium | Open: tickets should carry a leaf range |
| S11 | Page-level logs and the owner's receipt feed live in the release service's memory and are lost on restart | Medium for the product | Open |
| S12 | Per-IP limiting uses the socket address (wrong behind a proxy) | Low | Open |
| S15 | Someone who sees a relayed open can submit it first; the recipient is then refused | Low | Open |
| S16 | Signature acceptance rules may differ between the services' library and the chain's host function | Low, unverified | Open: needs edge-case vectors |

Not reviewed: the web app (it does not exist yet) and third-party dependencies beyond the lockfile.
