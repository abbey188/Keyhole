# UI integration guide (for the restyle)

The logic is finished and tested; a restyle changes markup and CSS only. `apps/web/src/lib` is UI-free logic with unit tests; `src/ui` are the screens; `src/style.css` is the whole stylesheet (about 80 uses of `note`, `row`, `card`, `ghost`, `err`, `mono`, `pill ok|warn|bad`, `danger`, `grow`, `tabs`).

## Rules that must survive a redesign
1. **Visible text is part of the proofs.** The browser proofs (`apps/web/e2e/*.mjs`, `demo/rehearse.mjs`) find controls by their text. `apps/web/test/ui-contract.test.ts` fails if any of those strings leaves the UI source. Change layout, colour and markup freely; keep the wording, or change the wording and the proof script together.
2. **Fixed wording that must not be paraphrased:** the grade lines ("Grade B: machine-read and owner-reviewed", "Grade C: self-declared"), the badge "Private · attested hardware", the refusal "This access does not cover that.", "I can't find that in this safe.", the honest-limits and attestation "what this shows / does not show" paragraphs, and every `[NOT FINISHED]` label.
3. **Never** show "verified" for a machine-read claim, a Private badge for a routed model, or a download button in the recipient viewer. The watermark is baked into canvas pixels (`Recipient.tsx` `draw`): keep it there, not in CSS.
4. **No inline script, no remote script.** CSP is `default-src 'self'; script-src 'self'`. Fonts or images from another host need a CSP edit in `apps/web/index.html` (and `style-src`/`font-src`); prefer self-hosted fonts under `public/`.
5. The access link lives in the URL **fragment** (`#open=`): never move it into a path or query.

## Screens and the logic each one calls
| Screen (`src/ui`) | Calls (`src/lib`) |
|---|---|
| `App.tsx` sign-in, safe list | `keys` (passkey / passphrase), `safe` (create), `clients` |
| `SafePage` Files | `files` (plan), `upload` (add, read), `render` (PDF/image) |
| `RedactPanel` | `redact` |
| `AccessTab` | `access.giveAccess`, `endAccess`, `localvault` |
| `VisitorsTab` | `visitors` (feed, verify chain, ask log) |
| `AskTab`, `ClaimsTab` | `ai` (credentials), `index`, `claims`, `@keyhole/askclaims` |
| `HandoverTab`, `Receive` | `handover`, `relock` |
| `Recipient` (link holder) | `access.openVisit`, `viewSegment`, `askPages`, `reserveQuestion`, `verifyAnswer` |
| `Verify` | `claims.verifyClaimOffline`, `verifyAnswer` |
| `src/judge` | claims list, `deploy/*.json` records, live key check |

## Configuration (build-time, `VITE_*`)
`VITE_RELEASE_URL`, `VITE_NODE_URL` (comma-separated), `VITE_RPC_URL` (comma-separated, tried in order). A hosted build adds the release and node origins to the CSP automatically (`vite.config.ts`). Services in production need `APP_ORIGIN` (the web app's https origin; they refuse to start without it) and `TRUST_PROXY=1` behind a reverse proxy; TLS is terminated by the proxy.

## After a restyle, run
`./scripts/verify.sh`, then the browser proofs against the local services (`./scripts/demo-reset.sh`, then `node demo/rehearse.mjs <name>` and `apps/web/e2e/a1…b6.mjs`).
