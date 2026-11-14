# Demo script (3 minutes)

Story: **Maria wants to rent 14 Harbour Road. She proves her income to the landlord without handing over her payslip, then shuts the door.** One safe, one landlord, five proof moments. All documents are fictional (`demo/files/`).

## Setup (before recording)
Record on the live site, **https://keyhole.patchway.xyz** (app at `/app`), or locally with `./scripts/dev-services.sh` (node, release service, web app). Two browser windows side by side: **Maria** (left, passkey) and **Landlord** (right, a private window, no account). Maria's window on `/app`, a third tab on `/proof`. The landlord just opens the link Maria sends. For a clean take use a fresh browser profile (a new passkey makes a new account; the sponsor funds it). Locally, also delete the `data/` folder and restart the services.

## Scenes
| # | Time | On screen | Say (one sentence) | Proves |
|---|---|---|---|---|
| 1 | 0:00–0:15 | Maria creates a safe with a passkey, names it "Flat documents" and picks a colour; the steps tick through and the safe card appears. | "My safe is an NFT. My face unlocks it; there are no wallet words." | Passkey keys; the token is the safe |
| 2 | 0:15–0:35 | She adds the payslip and the lease; the upload tray shows Prepare, Encrypt, Store, Record. "Recorded on chain" lists the transactions. | "Files are encrypted here, on my device. The chain records that they exist, not what they say." | Confidentiality; every step has a transaction |
| 3 | 0:35–1:05 | Claims tab: payslip → facts read on the device → private-model cross-check agrees → she ticks "I checked" → signed claim. | "I don't want to send my payslip. I sign one fact: income is at least £3,000. A private model in attested hardware double-checked the reading." | Claims, grade wording, private AI tier |
| 4 | 1:05–1:30 | Give access: she gives "Landlord" the claim. Link ready with a QR code. The landlord opens it: "Opening securely", then the claim page, watermarked, countdown, no download button. | "He sees the claim, not the file, for two hours." | Claims-mode grant; receipt-first; viewer protections |
| 5 | 1:30–1:50 | Maria's Visitors tab: the visit appears and says **Verified**. She clicks "Try a doctored copy": **Broken**. | "Every opening is in a log nobody can edit. Delete a row and it breaks." | Tamper-evident receipt chain |
| 6 | 1:50–2:10 | Ask tab: "How much is the monthly rent?" → answer with the quoted line, tier badge, evidence drawer. | "Only I can ask my safe. It answers from my own pages and shows what it did and did not prove." | Ask; attestation honesty |
| 7 | 2:10–2:30 | Access tab: she presses End access. The landlord reloads: "This access has ended." | "I can take it back. His next key is refused." | Revoke-then-fail |
| 8 | 2:30–3:00 | Proof page (`/proof`): **0 access keys** (live), the attack lab with nine refused attacks, the Wasm hash. Optional if time: hand the safe over (free, 15 s) and show the old link dead. | "Nobody, including us, can change this contract. Nine real attacks were refused; each has a transaction." | Keyless contract; attack lab; the NFT as permission root |

## What to cut if it runs long
In order: the Ask scene (6); the doctored copy (half of 5); the handover add-on. Never cut: scene 5's Verified, scene 7, scene 8's keyless line.

## Real timings (autopilot, two runs in a row, 2026-11-13, testnet)
| Scene | Run 1 | Run 2 |
|---|---|---|
| 1 create safe | 11 s | 12 s |
| 2 add two files | 80 s | 79 s |
| 3 claim (incl. model) | 102 s | 181 s |
| 4 give access | 8 s | 8 s |
| 5 landlord opens, visit verified | 10 s | 10 s |
| 6 Ask | 7 s | 8 s |
| 7 end access, refused | 8 s | 8 s |
| 8 Proof page | 1 s | 1 s |
| **Total** | **228 s** | **307 s** |

Scenes 2 and 3 are real waiting (uploads are chain transactions; the model takes 15 to 150 s). Record them and **cut or speed up the waits** in the edit; say "a few seconds later". Do not hide that they were cut.

## Fallbacks
- Model slow or 502: the app falls back to a second Private model by itself; if both fail the claim is grade C (self-declared) and the screen says so. Say it.
- Rehearsal videos and screenshots from the autopilot are in `demo/out/rehearsal-1` and `rehearsal-2` (gitignored). `node demo/rehearse.mjs <name>` makes a fresh set.
- Real passkey: on a laptop with Touch ID or Windows Hello the same flow works; the automated runs use a virtual authenticator. Test your own device once before recording.

## Honest lines to say on camera
"This is testnet, a demo configuration, not audited." "A photo of the screen can't be stopped." "The release service is a trusted party in this version." "The attestation shows genuine hardware ran measured software; it doesn't prove the model is right."

## Real-device passkey check (owner, about 3 minutes)
The tests use a virtual authenticator with the PRF extension. A real device is the one thing they cannot show. On the phone or laptop you will demo on, with the app open at its `localhost` or hosted HTTPS address:
1. Create with passkey, make a safe, add a text file, lock the tab (close it), reopen, press the passkey button: the same safe and file must appear. This proves the passkey returns the same key material each time.
2. If the browser says the passkey is not supported (some browsers and security keys lack the PRF extension), the app offers the **passphrase** fallback, labelled weaker. Use it once to confirm it works (create, add a file, reload, unlock with the same passphrase).
3. Write down: device, browser and version, result. Add it to `docs/EVIDENCE.md` as row `PASSKEY-REAL`. Until then the README says `[NOT FINISHED]` for this.
Browser support for the PRF extension varies by browser, version and authenticator, and we have not tested real devices. If a device does not support it, the app falls back to the passphrase option automatically; record what you saw either way.
