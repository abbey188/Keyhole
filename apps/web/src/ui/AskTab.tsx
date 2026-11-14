import { useEffect, useState } from "react";
import { askSafe } from "@keyhole/askclaims";
import type { AskResult } from "@keyhole/askclaims";
import type { Ctx } from "../lib/upload";
import type { Manifest } from "../lib/vault";
import { buildIndex } from "../lib/index";
import type { PageText } from "../lib/index";
import { aiClient, ownerCredential, FALLBACK_MODEL } from "../lib/ai";

/** Ask my safe: owner only. Search runs on the device; only the few pages needed go out, encrypted to an attested model. */
export function AskTab({ ctx, man }: { ctx: Ctx; man: Manifest | null }) {
  const [index, setIndex] = useState<PageText[] | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState("");
  const [res, setRes] = useState<AskResult | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { if (man) buildIndex(ctx, man).then(setIndex).catch((e) => setErr(`Could not read your files: ${(e as Error).message}`)); }, [man?.seq]);

  const ask = async () => {
    if (!index || !q.trim()) return;
    setErr(""); setRes(null); setBusy("Searching on this device…");
    try {
      const t = setTimeout(() => setBusy("Checking the private hardware's attestation, then sending the needed pages encrypted…"), 800);
      let r = await askSafe(q.trim(), index, { client: aiClient(ownerCredential(ctx.id, ctx.reader)) as never });
      if (r.status === "no_answer" && r.reason === "model_error") { setBusy("The first private model is busy; trying another…"); r = await askSafe(q.trim(), index, { client: aiClient(ownerCredential(ctx.id, ctx.reader)) as never, model: FALLBACK_MODEL }); }
      clearTimeout(t); setRes(r);
    } catch (e) { setErr(`The question could not be answered: ${(e as Error).message}`); }
    setBusy("");
  };

  return (
    <div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Ask your safe</h3>
        <p className="note">Only you can ask. The search happens on this device. Only the few pages needed are sent, encrypted so that only an attested private model can read them. {index ? `${index.length} searchable pages in this safe.` : "Reading your files…"}</p>
        <div className="row"><input className="grow" placeholder="e.g. How much is the monthly rent?" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void ask(); }} /><button disabled={!index || !!busy || !q.trim()} onClick={ask}>Ask</button></div>
        {index && index.length === 0 && <p className="note">Nothing to search yet. Add a PDF with a text layer or a text file. Scanned pages can't be searched in this version.</p>}
        {busy && <p className="note">{busy}</p>}
        {err && <p className="err">{err}</p>}
      </div>
      {res?.status === "answer" && (
        <div className="card">
          <div className="row"><strong className="grow">Answer</strong><span className="pill ok">Private · attested hardware</span></div>
          <p style={{ fontSize: 18 }}>{res.answer}</p>
          {res.citations.map((c, i) => <p key={i} className="note">From <strong>{c.itemName}</strong>, page {c.page}: “{c.quote}”</p>)}
          <details><summary className="note">Evidence</summary>
            <table><tbody>
              <tr><td>Model</td><td>{res.evidence.model_id}</td></tr>
              <tr><td>Sent</td><td>{res.sent.map((s) => `${s.chars} characters from page ${s.page}`).join("; ")}</td></tr>
              <tr><td>Attestation</td><td>{res.evidence.attestation_ok ? "checks passed" : "failed"}{res.evidence.attestation_complete ? "" : " (some checks were not performed: see below)"}</td></tr>
              <tr><td>Signing key</td><td className="mono">{res.evidence.enclave_signing_address}</td></tr>
              <tr><td>Report hash</td><td className="mono">{res.evidence.attestation_report_hash}</td></tr>
              <tr><td>Reply signature</td><td>{res.evidence.chat_signature_status}</td></tr>
            </tbody></table>
            <p className="note"><strong>What this shows:</strong> the answer came from software measured inside genuine hardware, over a channel only that hardware can read, and every quoted passage is in your own page. <strong>What it does not show:</strong> that the model is correct, which model weights ran (the quote does not name them), the hardware vendor's current security level (not checked here), or that the operator behaves well outside the enclave.</p>
          </details>
        </div>
      )}
      {res?.status === "no_answer" && (
        <div className="card"><p>{res.message}</p><p className="note">{res.tier === "device" ? "Nothing left this device." : "A reply was received but dropped because it did not meet the checks (every answer must quote your pages)."}</p></div>
      )}
    </div>
  );
}
