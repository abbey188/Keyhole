import { useState } from "react";
import { bytesToHex } from "@keyhole/crypto";
import { buildClaim, ownerClaimsPublicKey, signClaim } from "@keyhole/askclaims";
import { verifyClaimOffline } from "../lib/claims";
import type { SignedClaim } from "../lib/claims";
import { verifyAnswerPackage } from "../lib/verifyAnswer";
import type { AnswerPackage, Step, StepStatus } from "../lib/verifyAnswer";
import { reader } from "../lib/clients";
import { AppShell, Working } from "./kit";

// Design A14 (docs/design/A14Verify.dc.html). Both checks run here, in the browser: a signed claim offline (signature, structure,
// source commitment, grade basis, expiry), an answer package in the fixed order of verifyAnswerPackage (with the chain for steps 2 and 5).

type Mode = "answer" | "claim";

/** The claim checks, in order. verifyClaimOffline returns one line per failure; each line belongs to the first check whose test it matches. */
const CLAIM_CHECKS: { name: string; test: RegExp }[] = [
  { name: "Owner's signature", test: /owner public key|different owner key|signature is not valid/ },
  { name: "Structure", test: /$^/ },
  { name: "Source commitment", test: /source/ },
  { name: "Grade basis", test: /grade|evidence|extractor/ },
  { name: "Expiry", test: /issued_at|expire/ },
];
const STRUCTURE = 1;
/** Matching order: grade lines also name the source, so they are tested before the source check. */
const MATCH_ORDER = [0, 3, 2, 4];

function claimSteps(sc: SignedClaim, key: string | undefined): Step[] {
  const r = verifyClaimOffline(sc, key ?? "");
  const c = sc.claim;
  const by: string[][] = CLAIM_CHECKS.map(() => []);
  for (const f of r.failures) {
    const i = MATCH_ORDER.find((j) => CLAIM_CHECKS[j]!.test.test(f));
    by[i ?? STRUCTURE]!.push(f);
  }
  const passed = [
    `Signed by the claims key ${String(key ?? "").slice(0, 16)}…`,
    "Version 1, every field in the expected form",
    `Page ${c?.source?.page} of a ${c?.doc_type} in the owner's safe`,
    `Grade ${r.grade ?? c?.grade}: ${r.wording ?? ""}`,
    `Issued ${String(c?.issued_at ?? "").slice(0, 10)}, expires ${String(c?.expires_at ?? "").slice(0, 10)}`,
  ];
  return CLAIM_CHECKS.map((k, i) => {
    const f = by[i]!;
    // the grade wording only exists when every check passed
    const ok = f.length === 0;
    return { step: i + 1, name: k.name, status: ok ? "passed" : "failed", detail: ok ? (i === 3 && !r.ok ? `Grade ${c?.grade}` : passed[i]!) : f.join("; ") };
  });
}

/** A real signed claim made here with a fresh, throwaway claims key: grade C (owner typed), for a synthetic payslip. */
function sampleClaim(): string {
  const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));
  const seed = rand(32);
  const now = new Date();
  const claim = buildClaim({
    docType: "payslip", itemId: bytesToHex(rand(16)), itemMerkleRoot: bytesToHex(rand(32)), page: 1,
    pageText: "Synthetic sample payslip. Gross monthly pay: GBP 3,850.00", predicate: { field: "monthly_gross", op: ">=", value: 3000, currency: "GBP" },
    ownerClaimsPublicKey: ownerClaimsPublicKey(seed), issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30 * 86_400_000).toISOString(),
    review: { reviewed: true, typed: "GBP 3,850.00" },
  });
  return JSON.stringify(signClaim(claim, seed), null, 1);
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const STATUS_WORDS: Record<StepStatus, string> = { passed: "Passed", failed: "Failed", not_applicable: "Not applicable", not_run: "Not run" };

const tick = <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.3l2.5 2.5L10 3.3" fill="none" stroke="#FFFFFF" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
const cross = <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" fill="none" stroke="#FFFFFF" strokeWidth="1.8" strokeLinecap="round" /></svg>;

function StepRow({ s, last }: { s: Step; last: boolean }) {
  const dot = s.status === "passed" ? { background: "var(--blue)" } : s.status === "failed" ? { background: "var(--red)" } : { border: "1.5px solid var(--line2)", background: "transparent" };
  return (
    <div className="vstep" data-step={s.step} data-status={s.status} style={{ display: "grid", gridTemplateColumns: "26px minmax(0,1fr) auto", gap: 14, alignItems: "center", padding: "15px 18px", ...(last ? {} : { borderBottom: "1px solid var(--line)" }) }}>
      <span title={STATUS_WORDS[s.status]} style={{ width: 26, height: 26, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", ...dot }}>{s.status === "passed" ? tick : s.status === "failed" ? cross : null}</span>
      <div style={{ minWidth: 0 }}>
        <div className="vname" style={{ fontWeight: 700, fontSize: 15, ...(s.status === "failed" ? { color: "var(--red)" } : {}) }}>{cap(s.name)}</div>
        <div className="mute" style={{ fontSize: 13, marginTop: 2, lineHeight: "18px", overflowWrap: "anywhere" }}>{s.detail}</div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {(s.status === "not_run" || s.status === "not_applicable") && <span className="chip chip-m">{STATUS_WORDS[s.status]}</span>}
        <span className="m faint" style={{ fontSize: 11 }}>{String(s.step).padStart(2, "0")}</span>
      </div>
    </div>
  );
}

/** The Verify page: paste an answer package or a signed claim and see each check. No account, owner or document needed. */
export function Verify() {
  const [mode, setMode] = useState<Mode>("answer");
  const [text, setText] = useState({ answer: "", claim: "" });
  const [pk, setPk] = useState("");
  const [steps, setSteps] = useState<{ mode: Mode; steps: Step[] } | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const value = text[mode];

  const run = async () => {
    setErr(""); setSteps(null);
    if (mode === "claim") {
      try {
        const sc = JSON.parse(value) as SignedClaim;
        if (!sc || typeof sc !== "object" || !sc.claim) throw new Error();
        setSteps({ mode, steps: claimSteps(sc, pk.trim() || sc.claim?.owner_claims_pk) });
      } catch { setErr("That is not a signed claim."); }
      return;
    }
    setBusy(true);
    try { setSteps({ mode, steps: (await verifyAnswerPackage(JSON.parse(value) as AnswerPackage, reader)).steps }); } catch { setErr("That is not an answer package."); }
    setBusy(false);
  };
  const shown = steps && steps.mode === mode ? steps.steps : null;
  const passed = shown?.filter((s) => s.status === "passed").length ?? 0;
  const failed = shown?.filter((s) => s.status === "failed").length ?? 0;

  return (
    <AppShell active="verify" crumb={<b>Verify</b>} actions={<span className="lbl faint">No account needed</span>}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 32, paddingTop: 2 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
          <div>
            <div className="lbl" style={{ color: "var(--blue)" }}>[ Verify ]</div>
            <h1 className="h1" style={{ marginTop: 10, fontSize: 34, lineHeight: "38px" }}>Check an answer or a claim</h1>
          </div>
          <div className="seg" role="tablist" style={{ alignSelf: "flex-start" }}>
            {(["answer", "claim"] as Mode[]).map((m) => <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? "on" : ""} onClick={() => { setMode(m); setErr(""); }}>{m === "answer" ? "Answer" : "Claim"}</button>)}
          </div>
          <label className="panel" style={{ height: 300, padding: 18, borderRadius: 12, display: "flex", flexDirection: "column", cursor: "text" }}>
            <span className="fl">Paste what you were sent</span>
            <textarea className="m" aria-label="Paste what you were sent" spellCheck={false} value={value} onChange={(e) => setText({ ...text, [mode]: e.target.value })}
              style={{ flex: 1, minHeight: 0, width: "100%", resize: "none", border: 0, outline: "none", background: "transparent", padding: 0, fontSize: 12.5, lineHeight: "20px", color: "var(--ink)", wordBreak: "break-all" }} />
          </label>
          {mode === "claim" && (
            <div>
              <div className="fl">Owner's claims key (optional)</div>
              <input className="input m" style={{ fontSize: 13 }} placeholder="Owner's claims key (optional, hex)" value={pk} onChange={(e) => setPk(e.target.value)} spellCheck={false} />
            </div>
          )}
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button className="btn btn-p btn-lg" disabled={!value.trim() || busy} onClick={() => void run()}>Verify <span className="m">→</span></button>
            {mode === "claim" && <button className="btn btn-s btn-lg" onClick={() => { setText({ ...text, claim: sampleClaim() }); setPk(""); setSteps(null); setErr(""); }}>Use a sample</button>}
            {busy && <Working>Reading the chain…</Working>}
          </div>
          {err && <p className="err">{err}</p>}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", minHeight: 26 }}>
            <span className="h2">Result</span>
            {shown && (failed > 0
              ? <span className="chip chip-r">{cross}{failed} of {shown.length} failed</span>
              : <span className="chip chip-b">{tick}{passed} of {shown.length} passed</span>)}
          </div>
          <div className="panel" style={{ overflow: "hidden" }}>
            {shown ? shown.map((s, i) => <StepRow key={s.step} s={s} last={i === shown.length - 1} />)
              : <div className="lbl faint" style={{ padding: "18px" }}>Nothing checked yet</div>}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
