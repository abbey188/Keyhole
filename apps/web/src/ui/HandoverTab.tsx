import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { ChainWriter, DealApi, DealView } from "@keyhole/chain";
import type { Ctx } from "../lib/upload";
import { cancelHandover, offerHandover, parseAddress, readDeal } from "../lib/handover";
import type { Offer } from "../lib/handover";
import { config, txLink } from "../lib/config";
import type { Services } from "../lib/access";
import type { BoxView } from "@keyhole/chain";
import { SafeIcon } from "./kit";

// Design A11 (docs/design/A11HandOver.dc.html): the hand-over form on the left, the orange diagram card on the right.

const svc: Services = { releaseUrl: config.releaseUrl, nodeUrls: config.nodeUrls, chainId: config.chainId, contractId: config.contractId };
const NEAR = 10n ** 24n;
const toYocto = (s: string) => { const [a, b = ""] = s.trim().split("."); return (BigInt(a || "0") * NEAR + BigInt((b + "0".repeat(24)).slice(0, 24))).toString(); };

/** The waiting periods on offer (the demo one first). */
export const PERIODS: { ms: number; seg: string; words: string }[] = [
  { ms: 15_000, seg: "15S", words: "15 seconds" },
  { ms: 3_600_000, seg: "1H", words: "1 hour" },
  { ms: 86_400_000, seg: "1D", words: "1 day" },
];
export const periodWords = (ms: number) => PERIODS.find((p) => p.ms === ms)?.words ?? (ms < 60_000 ? `${Math.round(ms / 1000)} seconds` : ms < 7_200_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 3_600_000)} hours`);
export const fmtWhen = (ms: number, seconds: boolean) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getDate()} ${d.toLocaleString("en-GB", { month: "short" })} ${p(d.getHours())}:${p(d.getMinutes())}${seconds ? `:${p(d.getSeconds())}` : ""}`;
};
/** A short name for an account in the diagram (implicit accounts are 64 hex characters). */
export const shortAccount = (a: string) => (a.length > 16 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a.replace(/\.testnet$/, ""));

const ORANGE = "var(--orange)";
const row = (last: boolean): CSSProperties => ({ display: "flex", justifyContent: "space-between", gap: 16, ...(last ? {} : { borderBottom: "1px solid #EFC2B0", paddingBottom: 12 }) });

/** The orange card: the safe moving from one owner to the other, then what changes. Shared with the receiving side. */
export function HandoverDiagram({ from, to, over, rows }: { from: string; to: string; over: string; rows: { k: string; v: ReactNode; tone?: "orange" | "num" }[] }) {
  return (
    <div style={{ background: "var(--orange2)", borderRadius: 16, padding: 26, display: "flex", flexDirection: "column", gap: 22, alignSelf: "start", minWidth: 0 }}>
      <div style={{ display: "grid", gridTemplateColumns: "80px minmax(0,1fr) 80px", alignItems: "center", gap: 18 }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
          <SafeIcon color="#0E1435" size={80} label={`Safe of ${from}`} />
          <span className="lbl" style={{ fontSize: 10, whiteSpace: "nowrap" }}>{from}</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, minWidth: 0, marginBottom: 22 }}>
          <span className="lbl" style={{ fontSize: 10, textAlign: "center" }}>{over}</span>
          <svg width="100%" height="16" viewBox="0 0 180 16" preserveAspectRatio="none" aria-hidden="true"><path d="M0 8H178" stroke="#0E1435" strokeWidth="1.5" vectorEffect="non-scaling-stroke" /></svg>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, position: "relative" }}>
          <svg width="12" height="16" viewBox="0 0 12 16" aria-hidden="true" style={{ position: "absolute", left: -20, top: 32 }}><path d="M2 2l8 6-8 6" fill="none" stroke="#0E1435" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <SafeIcon color="#2546C2" size={80} label={`Safe of ${to}`} />
          <span className="lbl" style={{ fontSize: 10, whiteSpace: "nowrap" }}>{to}</span>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, fontSize: 15 }}>
        {rows.map((r, i) => (
          <div key={r.k} style={row(i === rows.length - 1)}>
            <span>{r.k}</span>
            {r.tone === "num" ? <span className="n" style={{ fontSize: 17, textAlign: "right" }}>{r.v}</span> : <span style={{ fontWeight: 700, textAlign: "right", ...(r.tone === "orange" ? { color: ORANGE } : {}) }}>{r.v}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Tick box in the hand-over orange (same build as kit's Check: the real input is visually hidden but focusable). */
export function OrangeCheck({ on, onChange, label, children }: { on: boolean; onChange: (v: boolean) => void; label: string; children: ReactNode }) {
  return (
    <label style={{ display: "flex", gap: 12, alignItems: "flex-start", fontSize: 15, lineHeight: "22px", cursor: "pointer", position: "relative" }}>
      <input type="checkbox" aria-label={label} checked={on} onChange={(e) => onChange(e.target.checked)} style={{ position: "absolute", opacity: 0, width: 1, height: 1 }} />
      <span aria-hidden="true" style={{ width: 18, height: 18, borderRadius: 5, border: `1.5px solid ${on ? "#E2603A" : "#0E1435"}`, background: on ? "#E2603A" : "#FFFFFF", display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none", marginTop: 2 }}>
        {on && <svg width="11" height="11" viewBox="0 0 12 12"><path d="M2 6.3l2.5 2.5L10 3.3" fill="none" stroke="#FFFFFF" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>}
      </span>
      <span>{children}</span>
    </label>
  );
}

const bare: CSSProperties = { border: 0, outline: "none", background: "transparent", padding: 0, margin: 0, width: "100%", minWidth: 0, color: "var(--ink)", borderRadius: 0 };
const layout: CSSProperties = { display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,460px)", gap: 40, paddingTop: 4, alignItems: "start" };
const left: CSSProperties = { display: "flex", flexDirection: "column", gap: 22, maxWidth: 560, minWidth: 0 };

export function HandoverTab({ ctx, box, onChanged }: { ctx: Ctx; box: BoxView; onChanged: () => void }) {
  const [addr, setAddr] = useState("");
  const [price, setPrice] = useState("0");
  const [wait, setWait] = useState(15_000);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [offer, setOffer] = useState<Offer | null>(null);
  const [deal, setDeal] = useState<DealView | null>(null);
  useEffect(() => {
    let dead = false;
    const poll = async () => { if (box.in_deal) { const d = await readDeal(ctx.reader, box.in_deal).catch(() => null); if (!dead) setDeal(d); } else if (!dead) setDeal(null); };
    void poll(); const t = setInterval(poll, 5000); return () => { dead = true; clearInterval(t); };
  }, [box.in_deal, box.key_epoch]);
  const writer = ctx.writer as ChainWriter & DealApi;

  const start = async () => {
    setErr("");
    try { setOffer(await offerHandover({ ctx: { ...ctx, progress: setBusy }, writer, svc, buyerAddress: addr, priceYocto: toYocto(price), waitingMs: wait })); onChanged(); }
    catch (e) { setErr((e as Error).message); }
    setBusy("");
  };
  const cancel = async () => { setBusy("Cancelling…"); try { await cancelHandover(writer, box.in_deal!); setOffer(null); onChanged(); } catch (e) { setErr((e as Error).message); } setBusy(""); };
  const reset = () => { setAddr(""); setPrice("0"); setWait(15_000); setUnderstood(false); setErr(""); };

  const links = box.live_grants;
  const understand = links > 0 ? `I understand that my ${links} open link${links === 1 ? " stops" : "s stop"} working and I lose access to this safe.` : "I understand that I lose access to this safe.";
  const buyerName = (() => { try { return shortAccount(parseAddress(addr).account); } catch { return "New owner"; } })();

  if (box.in_deal || offer) {
    const code = offer?.code ?? `${box.in_deal}.${box.box_id}`;
    const waitMs = deal?.waiting_ms ?? wait;
    const state = deal?.state === "Funded" ? "Waiting period running" : deal?.state === "Ready" ? "Waiting for the new owner to accept" : deal?.state ?? "Reading the chain…";
    return (
      <div style={layout}>
        <div style={left}>
          <div>
            <div className="lbl" style={{ color: ORANGE }}>[ Hand over ]</div>
            <h1 className="h1" style={{ marginTop: 10, fontSize: 34, lineHeight: "38px" }}>Handover in progress</h1>
          </div>
          <span className="chip chip-o" style={{ alignSelf: "flex-start" }}>{state}</span>
          <div>
            <div className="fl">Code for the new owner</div>
            <input className="input m" style={{ fontSize: 13 }} readOnly value={code} onFocus={(e) => e.target.select()} />
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button className="btn btn-s btn-lg" onClick={() => void navigator.clipboard?.writeText(code)}>Copy code</button>
            <button className="btn btn-o btn-lg" disabled={!!busy} onClick={cancel}>Cancel handover</button>
            {busy && <span className="mute" style={{ fontSize: 14 }}>{busy}</span>}
          </div>
          {offer && offer.txs.length > 0 && (
            <div className="panel" style={{ overflow: "hidden" }}>
              <div className="th" style={{ gridTemplateColumns: "1fr auto" }}><span>Recorded on chain</span><span>Transaction</span></div>
              {offer.txs.map((t) => (
                <div className="tr" key={t.txHash} style={{ gridTemplateColumns: "1fr auto" }}>
                  <span>{t.step}</span><a className="m" style={{ fontSize: 12, color: "var(--blue)" }} href={txLink(t.txHash)} target="_blank" rel="noreferrer">{t.txHash.slice(0, 10)}…</a>
                </div>
              ))}
            </div>
          )}
          {err && <p className="err">{err}</p>}
        </div>
        <HandoverDiagram from="You" to={deal ? shortAccount(deal.buyer) : buyerName} over={`After ${periodWords(waitMs)}`} rows={[
          { k: "Open links", v: "End", tone: "orange" },
          { k: "Your access", v: "Ends", tone: "orange" },
          { k: "Visitor log", v: "Goes with the safe" },
          { k: "Cancel until", v: deal?.waiting_until ? fmtWhen(deal.waiting_until, waitMs < 3_600_000) : `${periodWords(waitMs)} after they accept`, tone: deal?.waiting_until ? "num" : undefined },
        ]} />
      </div>
    );
  }
  return (
    <div style={layout}>
      <div style={left}>
        <div>
          <div className="lbl" style={{ color: ORANGE }}>[ Hand over ]</div>
          <h1 className="h1" style={{ marginTop: 10, fontSize: 34, lineHeight: "38px", textWrap: "balance" } as CSSProperties}>Give this safe to someone else</h1>
        </div>
        <div>
          <div className="fl">New owner</div>
          <input className="input m" style={{ fontSize: 14 }} placeholder="The new owner's handover address" value={addr} onChange={(e) => setAddr(e.target.value)} spellCheck={false} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
          <div>
            <div className="fl">Price</div>
            <label className="input" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, cursor: "text" }}>
              <input className="n" aria-label="Price in NEAR" inputMode="decimal" style={{ ...bare, fontSize: 17, lineHeight: "20px" }} value={price} onChange={(e) => setPrice(e.target.value)} />
              <span className="m faint" style={{ fontSize: 12 }}>NEAR</span>
            </label>
          </div>
          <div>
            <div className="fl">Waiting period</div>
            <div className="seg" role="group" aria-label="Waiting period">
              {PERIODS.map((p) => <button key={p.ms} type="button" className={wait === p.ms ? "on" : ""} aria-pressed={wait === p.ms} onClick={() => setWait(p.ms)}>{p.seg}</button>)}
            </div>
          </div>
        </div>
        <OrangeCheck on={understood} onChange={setUnderstood} label={understand}>{understand}</OrangeCheck>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn btn-of btn-lg" disabled={!!busy || addr.length < 129 || !understood} onClick={start}>Start hand over <span className="m">→</span></button>
          <button className="btn btn-s btn-lg" disabled={!!busy} onClick={reset}>Cancel</button>
          {busy && <span className="mute" style={{ fontSize: 14 }}>{busy}</span>}
        </div>
        {err && <p className="err">{err}</p>}
      </div>
      <HandoverDiagram from="You" to={buyerName} over={`After ${periodWords(wait)}`} rows={[
        { k: "Open links", v: "End", tone: "orange" },
        { k: "Your access", v: "Ends", tone: "orange" },
        { k: "Visitor log", v: "Goes with the safe" },
        { k: "Cancel until", v: `${periodWords(wait)} after they accept` },
      ]} />
    </div>
  );
}
