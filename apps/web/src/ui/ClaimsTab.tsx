import { useEffect, useState } from "react";
import { CLAIM_WORDING } from "@keyhole/askclaims";
import type { Ctx } from "../lib/upload";
import { addItem, readSegment } from "../lib/upload";
import type { Manifest } from "../lib/vault";
import { buildIndex } from "../lib/index";
import type { PageText } from "../lib/index";
import { claimParts, crossCheckFacts, describePredicate, draftFor, makeSignedClaim, opWords, statementText } from "../lib/claims";
import type { Draft, Fact, FactCrossCheck, FactOp, Predicate } from "../lib/claims";
import { aiClient, ownerCredential, FALLBACK_MODEL } from "../lib/ai";
import { giveAccess } from "../lib/access";
import type { Services } from "../lib/access";
import { config } from "../lib/config";
import { loadGrants, saveGrants } from "../lib/localvault";
import type { SavedGrant } from "../lib/localvault";
import type { BoxView } from "@keyhole/chain";
import type { Receipt } from "../lib/upload";
import { Check, Working } from "./kit";

const svc: Services = { releaseUrl: config.releaseUrl, nodeUrls: config.nodeUrls, chainId: config.chainId, contractId: config.contractId };
const SHARE_HOURS = 24;
/** The fact a recognised document's claim starts on. */
const PREFERRED = ["gross_monthly", "monthly_rent", "date_of_birth", "expiry_date"];
const SYMBOL: Record<string, string> = { GBP: "£", USD: "$", EUR: "€" };
const defaultOp = (f: Fact): FactOp => f.kind === "text" ? "=" : f.field === "monthly_rent" ? "<=" : f.field === "date_of_birth" ? "<=" : ">=";
const plain = (f: Fact) => typeof f.value === "number" ? String(f.value) : f.value;

const tg = (on: boolean) => (
  <span role="img" aria-label={on ? "Used in the claim" : "Not used"} style={on
    ? { width: 40, height: 22, borderRadius: 11, background: "var(--ink)", display: "inline-flex", alignItems: "center", justifyContent: "flex-end", padding: 2 }
    : { width: 40, height: 22, borderRadius: 11, border: "1.5px solid var(--line2)", display: "inline-flex", alignItems: "center", justifyContent: "flex-start", padding: 2 }}>
    <i style={on ? { width: 18, height: 18, borderRadius: "50%", background: "#FFFFFF" } : { width: 15, height: 15, borderRadius: "50%", background: "var(--line2)" }} />
  </span>
);
const cardLbl = { fontSize: 10, color: "#8F98BF", lineHeight: "18px" } as const;

/** Claims instead of files: read facts on the device, check them, sign a statement, share that instead of the document. */
export function ClaimsTab({ ctx, man, box, afterAdd }: { ctx: Ctx; man: Manifest | null; box: BoxView; afterAdd: (t: Receipt[], next?: Manifest) => Promise<void> }) {
  const [index, setIndex] = useState<PageText[] | null>(null);
  const [pick, setPick] = useState("");
  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [cross, setCross] = useState<FactCrossCheck | null>(null);
  const [sel, setSel] = useState("");
  const [op, setOp] = useState<FactOp>(">=");
  const [amount, setAmount] = useState("");
  const [typed, setTyped] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [made, setMade] = useState("");
  const [madeName, setMadeName] = useState("");
  const [grades, setGrades] = useState<Record<string, string>>({});
  const [grants, setGrants] = useState<SavedGrant[]>(() => loadGrants(ctx.id, ctx.boxId));
  const [target, setTarget] = useState("");
  const [sharing, setSharing] = useState(false);
  const [who, setWho] = useState("");
  const [shared, setShared] = useState<{ link: string; sentence: string } | null>(null);
  useEffect(() => { if (man) buildIndex(ctx, man).then(setIndex).catch((e) => setErr((e as Error).message)); }, [man?.seq]);

  const docs = (man?.items ?? []).filter((i) => (i.kind === "pdf" || i.kind === "text") && index?.some((p) => p.itemId === i.uid));
  const unread = (man?.items ?? []).filter((i) => i.kind === "image" || (i.kind === "pdf" && index && !index.some((p) => p.itemId === i.uid))).length;
  const facts: Fact[] = draft ? [...draft.reading.facts, ...(cross?.extra ?? [])] : [];
  const fact = facts.find((f) => f.field === sel);
  const select = (f: Fact) => { setSel(f.field); setOp(defaultOp(f)); setAmount(plain(f)); setTyped(""); setMade(""); setErr(""); };
  const claims = (man?.items ?? []).filter((i) => i.kind === "claim");
  const choose = (uid: string) => {
    setPick(uid); setPicking(false); setCross(null); setReviewed(false); setMade(""); setErr(""); setTyped("");
    const item = docs.find((d) => d.uid === uid);
    const d = item && index ? draftFor(item, index) : null;
    setDraft(d);
    const first = d && (PREFERRED.map((k) => d.reading.facts.find((f) => f.field === k)).find(Boolean) ?? d.reading.facts.find((f) => f.kind === "amount") ?? d.reading.facts[0]);
    if (first) select(first); else setSel("");
  };
  useEffect(() => { if (!pick && docs[0]) choose(docs[0].uid); }, [index, man?.seq]);
  // the grade of each saved claim, read from its own statement page (decrypted on this device)
  useEffect(() => {
    let live = true;
    void (async () => {
      const g: Record<string, string> = {};
      for (const c of claims) {
        const s = c.segments.find((x) => x.role === "page");
        if (!s) continue;
        try { g[c.uid] = /Grade ([BC]):/.exec(new TextDecoder().decode(await readSegment(ctx, c, s.s)))?.[1] ?? ""; } catch { g[c.uid] = ""; }
      }
      if (live) setGrades(g);
    })();
    return () => { live = false; };
  }, [man?.seq]);

  const predicate = (): Predicate | null => {
    if (!fact) return null;
    const base = { field: "fact" as const, key: fact.field, label: fact.label.slice(0, 60) };
    if (fact.kind === "text") return { ...base, kind: "text", op: "=", value: String(fact.value) };
    if (fact.kind === "date") return { ...base, kind: "date", op, value: amount };
    const n = Number(amount.replace(/[,\s£$€]/g, ""));
    if (!Number.isFinite(n) || amount.trim() === "") return null;
    return fact.kind === "amount" ? { ...base, kind: "amount", op, value: n, currency: fact.currency ?? "" } : { ...base, kind: "number", op, value: n };
  };
  const runCross = async () => {
    if (!draft) return; setErr(""); setBusy("Checking with a private model (attested hardware)…");
    try {
      let cc = await crossCheckFacts(draft.reading, draft.pages as never, { client: aiClient(ownerCredential(ctx.id, ctx.reader)) as never });
      if (!cc.model_ran) { setBusy("The first private model is busy; trying another…"); cc = await crossCheckFacts(draft.reading, draft.pages as never, { client: aiClient(ownerCredential(ctx.id, ctx.reader)) as never, model: FALLBACK_MODEL }); }
      setCross(cc);
    } catch (e) { setErr((e as Error).message); }
    setBusy("");
  };
  const create = async () => {
    const p = predicate(); if (!draft || !fact) return;
    if (!p) { setErr("Enter a value for the claim."); return; }
    setErr(""); setBusy("Signing the claim…");
    try {
      const sc = makeSignedClaim({ id: ctx.id, draft, fact, predicate: p, ...(cross ? { cross } : {}), ...(typed ? { typed } : {}) });
      const txt = statementText(sc, draft.item.name);
      const parts = claimParts(sc, draft.item.name);
      const name = `Claim: ${describePredicate(sc.claim.predicate)}`;
      const res = await addItem({ ...ctx, progress: setBusy }, man!, box, { name, mime: "application/json", kind: "claim", size: txt.length, parts });
      await afterAdd(res.txs, res.manifest); setMadeName(name); setTarget(""); setShared(null);
      setMade(`Grade ${sc.claim.grade} claim saved: ${CLAIM_WORDING[sc.claim.grade]}.`);
    } catch (e) { setErr((e as Error).message); }
    setBusy("");
  };

  const shareItem = claims.find((c) => c.uid === target) ?? (madeName ? [...claims].reverse().find((c) => c.name === madeName) : undefined);
  const share = async () => {
    if (!shareItem || !who.trim()) return;
    setErr(""); setBusy("Giving access…");
    try {
      const r = await giveAccess({ id: ctx.id, reader: ctx.reader, writer: ctx.writer, svc, boxId: ctx.boxId, bmk: ctx.bmk, epoch: ctx.epoch, label: who.trim(), items: [shareItem], durationMs: SHARE_HOURS * 3_600_000, maxSessions: 3, origin: `${location.origin}${location.pathname}` });
      const next = [{ grantId: r.grantId, label: who.trim(), exp: r.payload.exp, files: [shareItem.name], link: r.link }, ...loadGrants(ctx.id, ctx.boxId)];
      saveGrants(ctx.id, ctx.boxId, next); setGrants(next);
      setShared({ link: r.link, sentence: `${who.trim()} can view this claim for ${SHARE_HOURS} hours, not the document. Every open is recorded.` });
      setSharing(false); setWho("");
      await afterAdd([{ step: "Give access to the claim", txHash: r.txHash }]);
    } catch (e) { setErr((e as Error).message); }
    setBusy("");
  };

  const agreed = !!cross?.model_ran && cross.fields[sel]?.status === "agree";
  const grade = made ? /Grade ([BC])/.exec(made)?.[1] : agreed && !typed ? "B" : !agreed && typed ? "C" : "";
  const needTyped = !agreed;
  const withModel = !!cross?.model_ran;
  const cols = withModel ? "170px minmax(0,1fr) 56px 130px 52px" : "200px minmax(0,1fr) 120px 60px";
  const pickedName = docs.find((d) => d.uid === pick)?.name ?? "";

  return (
    <div style={{ display: "grid", gridTemplateColumns: draft && fact ? "minmax(0,1fr) 400px" : "minmax(0,1fr)", gap: 24, alignItems: "start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
        {index === null && <div className="mute" style={{ fontSize: 14 }}>Reading your files…</div>}
        {index && docs.length === 0 && <div className="mute" style={{ fontSize: 14 }}>Add a document with text first: a PDF, or a text, Markdown, CSV, HTML or JSON file.</div>}
        {index && unread > 0 && <div className="faint" style={{ fontSize: 13 }}>Photos and scanned PDFs can't be read yet.</div>}
        {docs.length > 0 && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
            <span className="h2" style={{ minWidth: 0, overflowWrap: "anywhere" }}>Facts in {pickedName || "a file"}</span>
            <button className="btn btn-g" style={{ fontSize: 13, border: 0, background: "transparent", flex: "none" }} aria-expanded={picking} onClick={() => setPicking(!picking)}>Change file <span className="m" aria-hidden="true">→</span></button>
          </div>
        )}
        {picking && (
          <div className="panel" style={{ overflow: "hidden" }}>
            {docs.map((d) => (
              <button key={d.uid} className={`tr ${d.uid === pick ? "sel" : ""}`} onClick={() => choose(d.uid)} style={{ gridTemplateColumns: "minmax(0,1fr) auto", width: "100%", borderTop: 0, borderLeft: 0, borderRight: 0, background: d.uid === pick ? "var(--sky2)" : "transparent", textAlign: "left", font: "inherit", fontSize: 14, color: "var(--ink)", cursor: "pointer" }}>
                <span style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{d.name}</span>
                {d.uid === pick && <span className="chip chip-s">Open</span>}
              </button>
            ))}
          </div>
        )}
        {draft && facts.length === 0 && <div className="mute" style={{ fontSize: 14 }}>No facts found on this device. Cross-check with a private model to look for more.</div>}
        {draft && facts.length > 0 && (
          <div className="panel facts" style={{ overflow: "hidden" }}>
            <div className="th" style={{ gridTemplateColumns: cols }}><span>Fact</span><span>Value</span><span>Page</span>{withModel && <span>Private model</span>}<span>Use</span></div>
            {facts.map((f) => {
              const st = cross?.fields[f.field]?.status ?? (f.source === "model" ? "model_only" : undefined);
              return (
                <div key={f.field} className={`tr ${f.field === sel ? "sel" : ""}`} style={{ gridTemplateColumns: cols, cursor: "pointer" }} onClick={() => select(f)}>
                  <span className="mute" style={{ overflowWrap: "anywhere" }}>{f.label}</span>
                  <span style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{f.raw}</span>
                  <span className="m faint" style={{ fontSize: 12 }}>{f.page}</span>
                  {withModel && <span>{st && <span className={`xc chip ${st === "agree" ? "chip-s" : "chip-a"}`}>{st.replace(/_/g, " ")}</span>}</span>}
                  <button type="button" aria-label={`Use ${f.label}`} aria-pressed={f.field === sel} onClick={(e) => { e.stopPropagation(); select(f); }} style={{ border: 0, background: "transparent", padding: 0, cursor: "pointer" }}>{tg(f.field === sel)}</button>
                </div>
              );
            })}
          </div>
        )}
        {cross && <div className="cross-note mute" style={{ fontSize: 14 }}>{cross.model_ran ? "The model read the same pages." : `The model could not be used (${cross.model_error ?? "error"}). Only grade C is available.`}</div>}
        {err && <p className="err">{err}</p>}

        {claims.length > 0 && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}><span className="h2">Shared claims</span><span className="lbl faint">{claims.length}</span></div>
            <div className="panel" style={{ overflow: "hidden" }}>
              {claims.map((c) => {
                const to = grants.filter((g) => g.files.includes(c.name)).map((g) => g.label);
                const on = shareItem?.uid === c.uid;
                return (
                  <button key={c.uid} className={`tr ${on ? "sel" : ""}`} onClick={() => { setTarget(c.uid); setShared(null); }} aria-pressed={on} style={{ gridTemplateColumns: "minmax(0,1fr) 160px 100px", width: "100%", borderTop: 0, borderLeft: 0, borderRight: 0, background: on ? "var(--sky2)" : "transparent", textAlign: "left", font: "inherit", fontSize: 14, color: "var(--ink)", cursor: "pointer" }}>
                    <span style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{c.name.replace(/^Claim: /, "")}</span>
                    <span className={to.length ? "mute" : "faint"} style={{ overflowWrap: "anywhere" }}>{to.length ? [...new Set(to)].join(", ") : "Not shared"}</span>
                    <span>{grades[c.uid] && <span className="chip chip-m">Grade {grades[c.uid]}</span>}</span>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      {draft && fact && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
          <div className="fl" style={{ margin: 0 }}>New claim</div>
          <div style={{ background: "var(--ink)", color: "#FFFFFF", borderRadius: 14, padding: 22, display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", minHeight: 22 }}>
              <span className="lbl" style={{ color: "#A9C2EC", fontSize: 10 }}>Claim</span>
              {grade && <span className="chip" style={{ borderColor: "#A9C2EC", color: "#A9C2EC" }}>Grade {grade}</span>}
            </div>
            <div style={{ fontSize: 26, lineHeight: "32px", fontWeight: 700, letterSpacing: "-0.6px", overflowWrap: "anywhere" }}>{fact.label}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              {fact.kind === "text"
                ? <><span className="lbl" style={{ color: "#A9C2EC", fontSize: 10 }}>is</span><span className="n" style={{ background: "#FFFFFF", color: "var(--ink)", borderRadius: 8, padding: "8px 14px", fontSize: 20, fontWeight: 700, overflowWrap: "anywhere" }}>{String(fact.value)}</span></>
                : <>
                  <select aria-label="Condition" value={op} onChange={(e) => setOp(e.target.value as FactOp)} style={{ background: "transparent", color: "#FFFFFF", border: "1px solid #A9C2EC", borderRadius: 8, padding: "8px 10px", font: "inherit", fontSize: 14 }}>
                    {(["=", ">=", "<="] as FactOp[]).map((o) => <option key={o} value={o} style={{ color: "#000" }}>{opWords(fact.kind, o)}</option>)}
                  </select>
                  <label className="n" style={{ background: "#FFFFFF", color: "var(--ink)", borderRadius: 8, padding: "8px 14px", fontSize: 26, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 2 }}>
                    {fact.kind === "amount" && <span aria-hidden="true">{SYMBOL[fact.currency ?? ""] ?? `${fact.currency ?? ""} `}</span>}
                    {fact.kind === "date"
                      ? <input aria-label="Date" type="date" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ border: 0, outline: "none", background: "transparent", color: "inherit", font: "inherit", fontSize: 18, padding: 0 }} />
                      : <input aria-label="Amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: `${Math.max(2, amount.length) + 0.5}ch`, border: 0, outline: "none", background: "transparent", color: "inherit", font: "inherit", padding: 0 }} />}
                  </label>
                </>}
            </div>
            <div style={{ borderTop: "1px solid #2A3260", paddingTop: 12, display: "grid", gridTemplateColumns: "110px minmax(0,1fr)", gap: "6px 10px", fontSize: 13, lineHeight: "18px" }}>
              <span className="lbl" style={cardLbl}>Source</span><span style={{ overflowWrap: "anywhere" }}>{draft.item.name}, page {fact.page}</span>
              <span className="lbl" style={cardLbl}>Read by</span><span>{withModel ? "This device and a private model" : "This device"}</span>
              <span className="lbl" style={cardLbl}>Reviewed</span><span>{reviewed ? "By you" : "Not yet"}</span>
            </div>
          </div>
          <button className="btn btn-s" style={{ justifyContent: "center" }} disabled={!!busy} onClick={runCross}>Cross-check with a private model</button>
          {needTyped && <input className="input" style={{ fontSize: 14 }} placeholder="To self-declare (grade C), type the value as written in the document" value={typed} onChange={(e) => setTyped(e.target.value)} />}
          <Check on={reviewed} onChange={setReviewed} label="I checked this against the document myself"><span style={{ fontSize: 14 }}>I checked this against the document myself</span></Check>
          <button className="btn btn-p btn-lg" style={{ justifyContent: "space-between" }} disabled={!reviewed || !!busy} onClick={create}>Sign claim <span className="m" aria-hidden="true">→</span></button>
          <button className="btn btn-s" style={{ justifyContent: "center" }} disabled={!shareItem || !!busy} onClick={() => { setSharing(!sharing); setShared(null); }}>Share with someone</button>
          {sharing && shareItem && (
            <div style={{ display: "flex", gap: 10 }}>
              <input className="input" style={{ flex: 1, fontSize: 14, padding: "10px 12px" }} placeholder="Who is this for?" value={who} onChange={(e) => setWho(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void share(); }} />
              <button className="btn btn-p" disabled={!who.trim() || !!busy} onClick={share}>Share claim</button>
            </div>
          )}
          {busy && <div><Working>{busy}</Working></div>}
          {made && <div className="made" style={{ fontSize: 14 }}><span className="chip chip-s" style={{ marginRight: 8 }}>Saved</span>{made}</div>}
          {shared && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 14 }}>{shared.sentence}</div>
              <div style={{ display: "flex", gap: 10 }}>
                <input className="input m" readOnly value={shared.link} style={{ flex: 1, fontSize: 12, padding: "10px 12px" }} onFocus={(e) => e.target.select()} />
                <button className="btn btn-s" onClick={() => void navigator.clipboard?.writeText(shared.link)}>Copy</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
