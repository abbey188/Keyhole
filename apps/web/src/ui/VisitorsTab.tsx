// Visitors (design A08): every visit recomputed from the raw records and compared with the receipt chain the contract keeps.
import { useEffect, useState } from "react";
import type { Ctx } from "../lib/upload";
import { fetchFeed, readAskLog, verifyLog } from "../lib/visitors";
import type { FeedRecord, LogCheck } from "../lib/visitors";
import { txLink } from "../lib/config";
import { loadGrants } from "../lib/localvault";
import { svc } from "../lib/safemeta";

const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 5);
const cols = "90px 190px 1fr 210px 90px";

export function VisitorsTab({ ctx, refreshKey }: { ctx: Ctx; refreshKey: number }) {
  const [feed, setFeed] = useState<FeedRecord[] | null>(null);
  const [check, setCheck] = useState<LogCheck | null>(null);
  const [checkedAt, setCheckedAt] = useState(0);
  const [tampered, setTampered] = useState(false);
  const [err, setErr] = useState("");
  const grants = loadGrants(ctx.id, ctx.boxId);
  const name = (g: string) => grants.find((x) => x.grantId === g)?.label ?? "Link holder";
  const files = (g: string) => grants.find((x) => x.grantId === g)?.files ?? [];
  const asks = feed && !tampered ? readAskLog(ctx.id, feed) : [];

  const load = async () => {
    setErr("");
    try { const f = await fetchFeed(ctx.id, ctx.reader, svc, ctx.boxId); setFeed(f); setTampered(false); setCheck(await verifyLog(f, ctx.boxId, ctx.reader)); setCheckedAt(Date.now()); }
    catch (e) { setErr((e as Error).message); }
  };
  useEffect(() => { void load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [refreshKey]);
  /** Shows what a doctored copy looks like: the same check on a copy with one receipt removed. */
  const tamper = async () => {
    if (!feed) return;
    const copy = feed.length > 0 ? feed.slice(1).map((r) => ({ ...r })) : [];
    setTampered(true); setCheck(await verifyLog(copy, ctx.boxId, ctx.reader)); setCheckedAt(Date.now());
  };

  // chain heads by receipt number, from the raw records, to show each link in the chain
  const heads = new Map<number, string>();
  for (const r of feed ?? []) { heads.set(r.seq, r.head); if (r.close) heads.set(r.close.seq, r.close.head); }
  const link = (seq: number) => `${(heads.get(seq) ?? "").slice(0, 8)} ← ${seq > 1 ? (heads.get(seq - 1) ?? "").slice(0, 8) : "start"}`;
  const rows = [...(check?.rows ?? [])].sort((a, b) => b.at - a.at);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {check && (check.ok
            ? <><span className="chip chip-b"><svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.3l2.5 2.5L10 3.3" fill="none" stroke="#FFFFFF" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>Verified</span><span className="mute" style={{ fontSize: 14 }}>Matches the chain</span></>
            : <><span className="chip chip-r">Broken</span><span className="mute" style={{ fontSize: 14 }}>{tampered ? "Doctored copy" : "Does not match the chain"}</span></>)}
          {check && <span className="m faint" style={{ fontSize: 12 }}>{check.onChain} {check.onChain === 1 ? "receipt" : "receipts"}, checked {hhmm(checkedAt)}</span>}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-g" style={{ fontSize: 13, textDecoration: "underline", textUnderlineOffset: 4, background: "transparent", border: 0 }} disabled={!feed || feed.length === 0} onClick={tamper}>Try a doctored copy</button>
          <button className="btn btn-s" style={{ fontSize: 13, padding: "8px 14px" }} onClick={load}>Check again</button>
        </div>
      </div>
      {check && !check.ok && <p className="err" style={{ margin: 0 }}>{check.reason}</p>}
      <div className="panel" style={{ overflow: "hidden" }}>
        <div className="th" style={{ gridTemplateColumns: cols }}><span>Time</span><span>Who</span><span>What</span><span>Link</span><span>Proof</span></div>
        {check && check.ok && rows.length === 0 && <div className="tr" style={{ gridTemplateColumns: "1fr" }}><span className="faint">No one has opened this safe yet</span></div>}
        {rows.map((r) => (
          <div key={`${r.seq}-${r.kind}`} className="tr" style={{ gridTemplateColumns: cols, ...(r.ok ? {} : { background: "#F6E3E0" }) }} title={r.detail}>
            <span className="n" style={{ fontSize: 16 }}>{hhmm(r.at)}</span>
            <span style={{ fontWeight: 700 }}>{name(r.grantId)}</span>
            <span>{r.kind === "opened" ? (files(r.grantId).length ? `Opened ${files(r.grantId).join(", ")}` : "Opened") : "Closed"}</span>
            <span className="m mute" style={{ fontSize: 12 }}>{link(r.seq)}</span>
            {r.txHash ? <a className="m" style={{ fontSize: 12, color: "var(--blue)" }} href={txLink(r.txHash)} target="_blank" rel="noreferrer">open ↗</a> : <span />}
          </div>
        ))}
      </div>
      {asks.length > 0 && <>
        <h2 className="h2" style={{ marginTop: 8 }}>Questions asked about your files</h2>
        <div className="panel" style={{ overflow: "hidden" }}>
          {asks.map((a, i) => (
            <div key={i} className="tr" style={{ gridTemplateColumns: "90px 190px 1fr 130px" }}>
              <span className="n" style={{ fontSize: 16 }}>{hhmm(a.at)}</span><span style={{ fontWeight: 700 }}>{name(a.grantId)}</span>
              <span><span>{a.question}</span><br /><span className="mute" style={{ fontSize: 13 }}>{a.answer ?? "No answer was recorded"}</span></span>
              <span style={{ textAlign: "right" }}><span className={`chip ${a.ok ? "chip-b" : "chip-r"}`}>{a.ok ? "Matches log" : "Does not match"}</span></span>
            </div>
          ))}
        </div>
      </>}
      {err && <p className="err">{err}</p>}
    </div>
  );
}
