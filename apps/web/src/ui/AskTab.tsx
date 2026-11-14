import { Fragment, useEffect, useState } from "react";
import { askSafe } from "@keyhole/askclaims";
import type { AskEvidence, AskResult } from "@keyhole/askclaims";
import { DEFAULT_MODELS } from "@keyhole/ai";
import type { Ctx } from "../lib/upload";
import type { Manifest } from "../lib/vault";
import { buildIndex } from "../lib/index";
import type { PageText } from "../lib/index";
import { aiClient, ownerCredential, FALLBACK_MODEL } from "../lib/ai";
import { Check } from "./kit";

interface Turn { q: string; res?: AskResult; err?: string }

const short = (s: string) => (s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s);
const modelName = (id: string) => id.split("/").pop() ?? id;
const hardware = (e: AskEvidence) => (e.attestation_ok ? (e.attestation_complete ? "Passed" : "Passed, not complete") : "Failed");
const signature = (e: AskEvidence) => (e.chat_signature_status === "verified" ? `${short(e.chat_signature)}, checked` : e.chat_signature_status === "failed" ? "Failed" : "Not available");

const bubbleQ = { alignSelf: "flex-end", maxWidth: "78%", background: "var(--ink)", color: "#FFFFFF", borderRadius: "12px 12px 3px 12px", padding: "10px 14px", fontSize: 15, lineHeight: "21px", overflowWrap: "anywhere" } as const;
const bubbleA = { alignSelf: "flex-start", maxWidth: "78%", background: "var(--sky2)", borderRadius: "12px 12px 12px 3px", padding: "14px 16px", fontSize: 15, lineHeight: "23px", overflowWrap: "anywhere" } as const;
const evLbl = { fontSize: 10, color: "var(--blue-d)", lineHeight: "18px" } as const;
const evVal = { fontSize: 12, lineHeight: "18px", overflowWrap: "anywhere" } as const;

/** Ask my safe: owner only. Search runs on the device; only the few pages needed go out, encrypted to an attested model. */
export function AskTab({ ctx, man }: { ctx: Ctx; man: Manifest | null }) {
  const [index, setIndex] = useState<PageText[] | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [off, setOff] = useState<Record<string, boolean>>({});
  const [err, setErr] = useState("");
  useEffect(() => { if (man) buildIndex(ctx, man).then(setIndex).catch((e) => setErr(`Could not read your files: ${(e as Error).message}`)); }, [man?.seq]);

  const files = (man?.items ?? []).filter((i) => i.kind !== "claim");
  const searchable = (uid: string) => !!index?.some((p) => p.itemId === uid);
  const pages = (index ?? []).filter((p) => !off[p.itemId]);
  const lastModel = [...turns].reverse().find((t) => t.res?.evidence)?.res?.evidence?.model_id ?? DEFAULT_MODELS.text;

  const settle = (i: number, t: Partial<Turn>) => setTurns((all) => all.map((x, j) => (j === i ? { ...x, ...t } : x)));
  const ask = async () => {
    const question = q.trim();
    if (!index || !question || busy || pages.length === 0) return;
    const at = turns.length;
    setErr(""); setQ(""); setTurns((all) => [...all, { q: question }]); setBusy("Searching on this device…");
    try {
      const t = setTimeout(() => setBusy("Checking the private hardware's attestation, then sending the needed pages encrypted…"), 800);
      let r = await askSafe(question, pages, { client: aiClient(ownerCredential(ctx.id, ctx.reader)) as never });
      if (r.status === "no_answer" && r.reason === "model_error") { setBusy("The first private model is busy; trying another…"); r = await askSafe(question, pages, { client: aiClient(ownerCredential(ctx.id, ctx.reader)) as never, model: FALLBACK_MODEL }); }
      clearTimeout(t); settle(at, { res: r });
    } catch (e) { settle(at, { err: `The question could not be answered: ${(e as Error).message}` }); }
    setBusy("");
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "250px minmax(0,1fr)", gap: 20, alignItems: "stretch" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
        <div className="fl" style={{ margin: 0 }}>Ask about</div>
        {files.map((f) => searchable(f.uid) ? (
          <Check key={f.uid} on={!off[f.uid]} onChange={(v) => setOff({ ...off, [f.uid]: !v })} label={f.name}>
            <span style={{ fontSize: 14, lineHeight: "20px", overflowWrap: "anywhere" }}>{f.name}</span>
          </Check>
        ) : (
          <div key={f.uid} className="mute" style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 14, lineHeight: "20px" }}>
            <span className="check" aria-hidden="true" /><span style={{ overflowWrap: "anywhere" }}>{f.name}</span>
          </div>
        ))}
        <div className="m faint" style={{ fontSize: 11, lineHeight: "16px", marginTop: 4 }}>{index ? `${index.length} searchable pages in this safe.` : "Reading your files…"}</div>
        <div className="panel" style={{ marginTop: "auto" }}>
          <div style={{ padding: "12px 14px", display: "flex", alignItems: "center", gap: 10 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2546C2" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}><path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6l7-3ZM9 12l2 2 4-4" /></svg>
            <div style={{ minWidth: 0 }}><div style={{ fontSize: 13, fontWeight: 600 }}>Private model</div><div className="m faint" style={{ fontSize: 11, overflowWrap: "anywhere" }}>{modelName(lastModel)}</div></div>
          </div>
        </div>
      </div>

      <div className="panel" style={{ display: "flex", flexDirection: "column", minHeight: 560, minWidth: 0, overflow: "hidden" }}>
        <div style={{ flex: 1, padding: 22, display: "flex", flexDirection: "column", gap: 14 }}>
          {index && index.length === 0 && <div className="mute" style={{ fontSize: 14 }}>Nothing to search yet. Add a PDF with a text layer or a text file. Scanned pages can't be searched in this version.</div>}
          {turns.map((t, i) => (
            <TurnView key={i} t={t} names={Object.fromEntries((index ?? []).map((p) => [p.itemId, p.itemName]))} busy={i === turns.length - 1 && !t.res && !t.err ? busy : ""} />
          ))}
          {err && <p className="err">{err}</p>}
        </div>
        <div style={{ borderTop: "1px solid var(--ink)", padding: 12, display: "flex", gap: 10 }}>
          <input className="input" style={{ flex: 1, fontSize: 14, padding: "10px 12px" }} placeholder="Ask about your files" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void ask(); }} />
          <button className="btn btn-p" disabled={!index || !!busy || !q.trim() || pages.length === 0} onClick={ask}>Ask <span className="m" aria-hidden="true">→</span></button>
        </div>
      </div>
    </div>
  );
}

function TurnView({ t, names, busy }: { t: Turn; names: Record<string, string>; busy: string }) {
  const [open, setOpen] = useState(false);
  const r = t.res;
  return (
    <>
      <div style={bubbleQ}>{t.q}</div>
      {busy && <div className="mute" style={{ ...bubbleA, background: "var(--paper2)", fontSize: 14 }}>{busy}</div>}
      {t.err && <p className="err" style={{ margin: 0 }}>{t.err}</p>}
      {r?.status === "answer" && (
        <div style={bubbleA}>
          <div className="answer">{r.answer}</div>
          <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {r.citations.map((c, i) => <span key={i} className="chip chip-s" style={{ background: "#FFFFFF", borderColor: "#FFFFFF", whiteSpace: "normal" }}>{c.itemName}, page {c.page}</span>)}
            <button className="lbl" aria-expanded={open} onClick={() => setOpen(!open)} style={{ fontSize: 10, color: "var(--blue-d)", background: "transparent", border: 0, padding: "4px 2px" }}>How this was checked {open ? "↑" : "↓"}</button>
          </div>
          {open && (
            <div className="evidence" style={{ marginTop: 12, borderTop: "1px solid #C3D2EE", paddingTop: 10, display: "grid", gridTemplateColumns: "150px minmax(0,1fr)", gap: "6px 12px" }}>
              <span className="lbl" style={evLbl}>Model</span><span className="m" style={evVal}>{r.evidence.model_id}, private</span>
              <span className="lbl" style={evLbl}>Hardware check</span><span className="m" style={evVal}>{hardware(r.evidence)}</span>
              <span className="lbl" style={evLbl}>Signature</span><span className="m" style={evVal}>{signature(r.evidence)}</span>
              <span className="lbl" style={evLbl}>Signing key</span><span className="m" style={evVal} title={r.evidence.enclave_signing_address}>{short(r.evidence.enclave_signing_address)}</span>
              <span className="lbl" style={evLbl}>Report hash</span><span className="m" style={evVal} title={r.evidence.attestation_report_hash}>{short(r.evidence.attestation_report_hash)}</span>
              <span className="lbl" style={evLbl}>Sent</span><span className="m" style={evVal}>{r.sent.map((s) => `${s.chars} characters from ${names[s.itemId] ?? "a file"}, page ${s.page}`).join("; ")}</span>
              {r.citations.map((c, i) => <Fragment key={i}><span className="lbl" style={evLbl}>{i === 0 ? "Quoted" : ""}</span><span className="cite" style={{ fontSize: 13, lineHeight: "18px" }}>“{c.quote}” {c.itemName}, page {c.page}</span></Fragment>)}
              <span className="lbl" style={evLbl}>Shows</span><span style={{ fontSize: 13, lineHeight: "18px" }}>The answer came from software measured inside genuine hardware, over a channel only that hardware can read, and every quoted passage is in your own page.</span>
              <span className="lbl" style={evLbl}>Does not show</span><span style={{ fontSize: 13, lineHeight: "18px" }}>That the model is correct, which model weights ran (the quote does not name them), the hardware vendor's current security level (not checked here), or that the operator behaves well outside the enclave.</span>
            </div>
          )}
        </div>
      )}
      {r?.status === "no_answer" && (
        <div style={bubbleA}>
          <div>{r.message}</div>
          <div className="m faint" style={{ marginTop: 8, fontSize: 12, lineHeight: "18px" }}>{r.tier === "device" ? "Nothing left this device." : "A reply was received but dropped because it did not meet the checks (every answer must quote your pages)."}</div>
        </div>
      )}
    </>
  );
}
