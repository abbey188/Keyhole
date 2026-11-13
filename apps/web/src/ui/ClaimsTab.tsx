import { useEffect, useState } from "react";
import type { Ctx } from "../lib/upload";
import { addItem } from "../lib/upload";
import type { Manifest } from "../lib/vault";
import { buildIndex } from "../lib/index";
import type { PageText } from "../lib/index";
import { claimParts, crossCheck, describePredicate, draftFor, makeSignedClaim, statementText } from "../lib/claims";
import type { CrossCheck, Draft, Predicate } from "../lib/claims";
import { aiClient } from "../lib/ai";
import type { BoxView } from "@keyhole/chain";
import type { Receipt } from "../lib/upload";

/** Claims instead of files: read facts on the device, check them, sign a statement, share that instead of the document. */
export function ClaimsTab({ ctx, man, box, afterAdd }: { ctx: Ctx; man: Manifest | null; box: BoxView; afterAdd: (t: Receipt[]) => Promise<void> }) {
  const [index, setIndex] = useState<PageText[] | null>(null);
  const [pick, setPick] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [cross, setCross] = useState<CrossCheck | null>(null);
  const [amount, setAmount] = useState("3000");
  const [typed, setTyped] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [made, setMade] = useState("");
  useEffect(() => { if (man) buildIndex(ctx, man).then(setIndex).catch((e) => setErr((e as Error).message)); }, [man?.seq]);

  const docs = (man?.items ?? []).filter((i) => i.kind === "pdf" && index?.some((p) => p.itemId === i.uid));
  const claims = (man?.items ?? []).filter((i) => i.kind === "claim");
  const choose = (uid: string) => {
    setPick(uid); setCross(null); setReviewed(false); setMade(""); setErr(""); setTyped("");
    const item = docs.find((d) => d.uid === uid);
    setDraft(item && index ? draftFor(item, index) : null);
  };
  const predicate = (): Predicate | null => {
    if (!draft) return null;
    const n = Number(amount);
    switch (draft.docType) {
      case "payslip": return { field: "monthly_gross", op: ">=", value: n, currency: "GBP" };
      case "lease": return { field: "monthly_rent", op: "<=", value: n, currency: "GBP" };
      case "id": return { field: "age", op: ">=", value: Number(amount) || 18 };
    }
  };
  const runCross = async () => {
    if (!draft) return; setErr(""); setBusy("Checking with a private model (attested hardware)…");
    try { setCross(await crossCheck(draft.docType, draft.pages as never, draft.rules, { client: aiClient() as never })); } catch (e) { setErr((e as Error).message); }
    setBusy("");
  };
  const create = async () => {
    const p = predicate(); if (!draft || !p) return;
    setErr(""); setBusy("Signing the claim…");
    try {
      const sc = makeSignedClaim({ id: ctx.id, draft, predicate: p, ...(cross ? { cross } : {}), ...(typed ? { typed } : {}) });
      const txt = statementText(sc, draft.item.name);
      const parts = claimParts(sc, draft.item.name);
      const res = await addItem({ ...ctx, progress: setBusy }, man!, box, { name: `Claim: ${describePredicate(sc.claim.predicate)}`, mime: "application/json", kind: "claim", size: txt.length, parts });
      await afterAdd(res.txs); setMade(`Grade ${sc.claim.grade} claim saved. Share it from the Access tab instead of the document.`);
    } catch (e) { setErr((e as Error).message); }
    setBusy("");
  };

  return (
    <div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Claims instead of files</h3>
        <p className="note">Prove one fact without handing over the document. Software reads the document on this device, you check it, and you sign a short statement. The other side sees the statement, not the file. They can check your signature, but a claim is your word backed by a document, not a certificate.</p>
        {docs.length === 0 ? <p className="note">Add a payslip, a lease or a passport page (a PDF with a text layer) first.</p> : (
          <select value={pick} onChange={(e) => choose(e.target.value)}><option value="">Choose a document…</option>{docs.map((d) => <option key={d.uid} value={d.uid}>{d.name}</option>)}</select>
        )}
      </div>
      {pick && !draft && <p className="note">This document type isn't recognised yet. Supported: payslip, lease, ID/passport page.</p>}
      {draft && (
        <div className="card">
          <div className="row"><strong className="grow">Found on this device: {draft.docType}</strong></div>
          <table><tbody>{Object.values(draft.rules.fields).map((f) => <tr key={f.field}><td>{f.field.replace(/_/g, " ")}</td><td>{f.raw}</td><td className="note">page {f.page}</td></tr>)}</tbody></table>
          <div className="row" style={{ marginTop: 12 }}>
            <span>{draft.docType === "payslip" ? "At least (GBP / month)" : draft.docType === "lease" ? "At most (GBP / month)" : "Age at least"}</span>
            <input style={{ width: 120 }} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div className="row" style={{ marginTop: 12 }}><button className="ghost" disabled={!!busy} onClick={runCross}>Cross-check with a private model</button><span className="note">Optional. Needed for grade B.</span></div>
          {cross && (
            <div style={{ marginTop: 8 }}>
              <p className="note">{cross.model_ran ? "The model read the same pages. Each fact:" : `The model could not be used (${cross.model_error ?? "error"}). Only grade C is available.`}</p>
              {cross.model_ran && <table><tbody>{Object.values(cross.fields).map((f) => <tr key={f.field}><td>{f.field.replace(/_/g, " ")}</td><td><span className={`pill ${f.status === "agree" ? "ok" : "warn"}`}>{f.status.replace(/_/g, " ")}</span></td></tr>)}</tbody></table>}
            </div>
          )}
          {!cross?.model_ran || Object.values(cross?.fields ?? {}).some((f) => f.status !== "agree") ? <input style={{ marginTop: 10 }} placeholder="To self-declare (grade C), type the value as written in the document" value={typed} onChange={(e) => setTyped(e.target.value)} /> : null}
          <label className="row" style={{ margin: "12px 0" }}><input type="checkbox" style={{ width: "auto" }} checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} /> I checked this against the document myself</label>
          <button disabled={!reviewed || !!busy} onClick={create}>Create signed claim</button>
          {busy && <span className="note"> {busy}</span>}
          {made && <p><span className="pill ok">saved</span> {made}</p>}
        </div>
      )}
      {err && <p className="err">{err}</p>}
      {claims.length > 0 && <div className="card"><strong>Your claims</strong>{claims.map((c) => <p className="note" key={c.uid}>{c.name}</p>)}</div>}
    </div>
  );
}
