# Security

Keyhole is a hackathon prototype on NEAR testnet. It has had no external audit. Do not store real sensitive data in it.

- Threat model, residual risks and the list of what we do **not** claim: `docs/spec/09_THREAT_MODEL_AND_LIMITS.md`.
- Reporting a vulnerability: open a private security advisory on the repository, or contact the maintainers listed in the repository profile. We do not run a bug bounty.
- Known limits that matter most: the release service is a trusted third party for expiry and for deal keys; a recipient keeps whatever they saw; a stolen passkey is full compromise except for delayed sales; the contract has no upgrade path by design; screenshots cannot be prevented.
