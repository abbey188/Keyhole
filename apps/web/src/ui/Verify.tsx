import { useState } from "react";
import { verifyClaimOffline } from "../lib/claims";
import type { SignedClaim } from "../lib/claims";
import { verifyAnswerPackage } from "../lib/verifyAnswer";
import type { AnswerPackage, Step } from "../lib/verifyAnswer";
import { reader } from "../lib/clients";

/** Offline check of a signed claim: signature, structure, grade basis, expiry. It does not need the owner, the chain or the document. */
export function Verify() {
  const [text, setText] = useState("");
  const [pk, setPk] = useState("");
  const [out, setOut] = useState<{ ok: boolean; wording?: string; failures: string[]; claim?: SignedClaim["claim"] } | null>(null);
  const run = () => {
    try {
      const sc = JSON.parse(text) as SignedClaim;
      const key = pk.trim() || sc.claim?.owner_claims_pk;
      setOut({ ...verifyClaimOffline(sc, key), claim: sc.claim });
    } catch { setOut({ ok: false, failures: ["That is not a signed claim."] }); }
  };
  const [pkg, setPkg] = useState("");
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [pkgErr, setPkgErr] = useState("");
  const runPkg = async () => {
    setPkgErr(""); setSteps(null);
    try { setSteps((await verifyAnswerPackage(JSON.parse(pkg) as AnswerPackage, reader)).steps); } catch { setPkgErr("That is not an answer package."); }
  };
  return (
    <div>
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Check a claim</h2>
      <p className="note">Paste the signed claim (page 2 of what you were shown). This runs here, in your browser, with no server. If you already know the owner's claims key, paste it too: the check is only meaningful against a key you trust.</p>
      <textarea style={{ width: "100%", minHeight: 160, background: "#0c0e13", color: "#e8eaf0", border: "1px solid #262b36", borderRadius: 8, padding: 10 }} value={text} onChange={(e) => setText(e.target.value)} />
      <input style={{ marginTop: 8 }} placeholder="Owner's claims key (optional, hex)" value={pk} onChange={(e) => setPk(e.target.value)} />
      <div className="row" style={{ marginTop: 10 }}><button onClick={run} disabled={!text}>Check</button></div>
      {out && (
        <div style={{ marginTop: 12 }}>
          <span className={`pill ${out.ok ? "ok" : "bad"}`}>{out.ok ? "Signature and structure are valid" : "Not valid"}</span>
          {out.ok && <p>Grade {out.claim?.grade}: {out.wording}.</p>}
          {out.failures.map((f) => <p className="err" key={f}>{f}</p>)}
          <p className="note">This shows the claim was signed by that key and has not been altered. It does not show the document is genuine, or that the key belongs to the person you think.</p>
        </div>
      )}
    </div>
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Check an answer</h2>
      <p className="note">Paste an answer package. Each step below is checked here, in the fixed order, and says plainly when it was not checked.</p>
      <textarea style={{ width: "100%", minHeight: 120, background: "#0c0e13", color: "#e8eaf0", border: "1px solid #262b36", borderRadius: 8, padding: 10 }} value={pkg} onChange={(e) => setPkg(e.target.value)} />
      <div className="row" style={{ marginTop: 10 }}><button onClick={runPkg} disabled={!pkg}>Check</button></div>
      {pkgErr && <p className="err">{pkgErr}</p>}
      {steps && <table><tbody>{steps.map((s) => <tr key={s.step}><td>{s.step}. {s.name}</td><td><span className={`pill ${s.status === "passed" ? "ok" : s.status === "failed" ? "bad" : ""}`}>{s.status.replace("_", " ")}</span></td><td className="note">{s.detail}</td></tr>)}</tbody></table>}
      <p className="note">This shows the reply was signed by the key the attestation named and the answer rests on files whose roots are on chain. It does not show the answer is correct, or which model weights ran.</p>
    </div>
    </div>
  );
}
