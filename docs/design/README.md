# Keyhole final design (2026-11-14)

The one source of truth for the front end. Everything else under `context/design/` is exploration.

**Canvas:** https://claude.ai/artifact/FxvUb68zZEjsMt6XztRPLT, page "Final" (private to the owner).

## Files
- `screens/`: a PNG of every board at 1440 wide (landing and docs full length). Compare your build against these.
- `Landing5.dc.html`: the landing page. The v3 look (full-bleed blueprint hero with the drawn vault, navy product cards, framed mock screens, the cover blocks in the call to action) in the final language.
- `app.css`: shared tokens and components for every app screen. Port this first.
- `D1` to `D5` with `docs.css`: Trust model, Security notes, What it does and does not do, Developers (retro terminal style), Proof (real contract hashes and the 9 refused attack transactions). These are the pages the landing links point to.
- `A01` to `A14`: Sign in, Safes, Name a new safe, Inside a safe (Files with folders and an upload in progress), Give access, Link ready, Access, Visitors, Ask, Claims, Hand over, Recipient view, Access ended, Verify.

## Language
- **Type:** Public Sans (all text and headings), Fragment Mono (labels, data, hashes), Share Tech Mono (numerals, timers).
- **Colour:** blue `#2546C2`, navy `#0E1435`, amber `#F2A72E`, orange `#E2603A` (End access, hand over, warnings), sky `#A9C2EC` / `#DFE7F6`, paper `#F3F2EE` / `#E8E7E1`, red `#C0392B` only for a failed check. No green. Pale colours are for the app surfaces; the landing page is saturated.
- **Shape:** flat. No shadows. Buttons radius 8, chips pill, panels radius 14 with a 1 px ink border. Folder-style tabs inside a safe. Left navy rail in the app.
- **Safe icon:** rounded square, door ring, dotted dial ring, coloured centre plate (owner picks the colour), solid keyhole. No sheen.
- **Logo:** white rounded slab with a navy keyhole.
- **Copy:** product text only. No explanatory captions, no "·" separators. Owners name their safes; the serial (`#12`) sits under the name.
- **Motion:** colour and border transitions on hover (140 to 150 ms); arrow nudges 4 px on hover; reduced motion respected.

## Build notes
- Folders do not exist in the current app (flat manifest). They need a path or parent on each item in the encrypted manifest. No contract change.
- Safe names and colours are owner metadata; store them in the encrypted manifest so they stay private.
- The landing and docs links: Trust model, Security notes, Limits, Developers and Proof are designed (D1 to D5). GitHub and Licence point at the repository. Any page not built by the freeze comes out of the nav.
- Tone for limits: factual and confident. Say "runs on NEAR testnet" and "an external audit is the next step"; do not tell people not to use it.
- The developer code block is a placeholder until the real `@keyhole/verify` snippet exists.
