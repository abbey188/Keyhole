# Gate 0: NEAR AI proof and repo state, 2026-11-13 (nothing secret recorded)

## Owner's earlier checks (copied from the briefing)
| Check | Result |
|---|---|
| Direct call, no key | HTTP 401 "Missing authorization header" |
| Direct call, bogus key | HTTP 401 "Invalid or expired API key" |
| Call through the session proxy (credential injected by the proxy; the header sent was a placeholder) | HTTP 200 |
| Attestation report per model | Full reports for `Qwen/Qwen3.8-27B`, `z-ai/glm-5.3-flash`, `Qwen/Qwen3-VL-30B-A3B-Instruct`, `openai/privacy-filter`; 503 for `deepseek-ai/DeepSeek-V4.1-Flash-1017` |
| Model decisions | `Qwen/Qwen3.8-27B` (Ask, claims), `Qwen/Qwen3-VL-30B-A3B-Instruct` (images), `openai/privacy-filter` (redaction). Only models owned by `nearai` or marked "attested 3p" may be labelled Private |

## Rechecked by the build session at 01:04 to 01:10 UTC
| Check | Result |
|---|---|
| `./scripts/verify.sh` | exit 0: 45 + 159 Rust tests, 116 TypeScript tests, C1 on chain |
| Deployed contract | `keyhole-06728d.testnet` (**v3**, keyless). The briefing names v2 (`keyhole-8ee967`); v2 was superseded on 2026-11-11 after the security review (see `SECURITY.md`) |
| Authenticated chat from this container, placeholder header | First attempt HTTP 502 "upstream request failed" (transient); then HTTP 200 for `Qwen/Qwen3.8-27B` (4.0 s), `z-ai/glm-5.3-flash` (1.4 s) |
| Model behaviour | These are reasoning models: with `max_tokens` 8 the answer was empty (`content: null`, tokens spent on `reasoning_content`). Calls need a larger token budget and must read `content` only |
| `near-ai-cloud` skill | Not installed in this session; the protocol details are taken from NEAR AI's public documentation and the live API instead |
| `nft_token` metadata carries live state? | No: it returns `token_id` and `owner_id` only. Decision: no redeploy; the app and judge page compose the public face from `get_box` and events |
| `close_session` can carry a Q&A log root? | Yes: it takes a 32-byte `log_root` signed by the release service and extends the receipt chain. The Q&A log commitment can be rolled into it with no contract change |
| Hosting | Local services plus recorded demo (default) |

Not yet done at the time of writing: end-to-end encrypted round trip (B1), client-side attestation verification (B2).
