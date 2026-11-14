import { useEffect, useState } from "react";
import type { Ctx } from "../lib/upload";
import { fetchFeed, readAskLog, verifyLog } from "../lib/visitors";
import type { FeedRecord, LogCheck } from "../lib/visitors";
import { config, txLink } from "../lib/config";
import type { Services } from "../lib/access";
import { loadGrants } from "../lib/localvault";
import type { Identity } from "../lib/keys";

const svc: Services = { releaseUrl: config.releaseUrl, nodeUrls: config.nodeUrls, chainId: config.chainId, contractId: config.contractId };
const labels = (id: Identity, boxId: string): Record<string, string> => Object.fromEntries(loadGrants(id, boxId).map((g) => [g.grantId, g.label]));

export function VisitorsTab({ ctx, refreshKey }: { ctx: Ctx; refreshKey: number }) {
  const [feed, setFeed] = useState<FeedRecord[] | null>(null);
  const [check, setCheck] = useState<LogCheck | null>(null);
  const [tampered, setTampered] = useState(false);
  const [err, setErr] = useState("");
  const names = labels(ctx.id, ctx.boxId);
  const asks = feed && !tampered ? readAskLog(ctx.id, feed) : [];

  const load = async () => {
    setErr("");
    try { const f = await fetchFeed(ctx.id, ctx.reader, svc, ctx.boxId); setFeed(f); setTampered(false); setCheck(await verifyLog(f, ctx.boxId, ctx.reader)); }
    catch (e) { setErr((e as Error).message); }
  };
  useEffect(() => { void load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [refreshKey]);

  /** Shows what a doctored copy looks like: the same check on a copy with one receipt removed. */
  const tamper = async () => {
    if (!feed) return;
    const copy = feed.length > 0 ? feed.slice(1).map((r) => ({ ...r })) : [];
    setTampered(true); setCheck(await verifyLog(copy, ctx.boxId, ctx.reader));
  };

  return (
    <div>
      <div className="row">
        <h3 className="grow" style={{ margin: 0 }}>Visitors</h3>
        {check && <span className={`pill ${check.ok ? "ok" : "bad"}`}>{check.ok ? `Verified · ${check.onChain} receipts match the chain` : "Broken"}</span>}
      </div>
      <p className="note">Every visit is a receipt in a chain the contract keeps. This page recomputes that chain from the raw records here and compares it with the contract's own — no one, including us, can edit a row without breaking it.</p>
      {check && !check.ok && <p className="err">{check.reason}{tampered ? " (this is the doctored copy, not your real log)" : ""}</p>}
      {check && check.ok && check.rows.length === 0 && <p className="note">No one has opened this safe yet.</p>}
      {check && check.rows.length > 0 && (
        <table><thead><tr><th>#</th><th>What</th><th>Who</th><th>When</th><th>Pages</th><th>Check</th><th></th></tr></thead><tbody>
          {check.rows.map((r) => (
            <tr key={r.seq}><td>{r.seq}</td><td>{r.kind === "opened" ? "Opened" : "Closed"}</td><td>{names[r.grantId] ?? "link holder"}</td>
              <td>{new Date(r.at).toLocaleTimeString()}</td><td>{r.kind === "opened" ? r.pages : ""}</td>
              <td><span className={`pill ${r.ok ? "ok" : "bad"}`} title={r.detail}>{r.ok ? "matches" : "broken"}</span></td>
              <td>{r.txHash && <a href={txLink(r.txHash)} target="_blank" rel="noreferrer">tx</a>}</td></tr>
          ))}
        </tbody></table>
      )}
      {asks.length > 0 && (
        <div style={{ marginTop: 12 }}><strong>Questions asked about your files</strong>
          {asks.map((a, i) => <p key={i} className="note"><span className={`pill ${a.ok ? "ok" : "bad"}`}>{a.ok ? "matches log" : "does not match"}</span> visit #{a.seq} · {names[a.grantId] ?? "link holder"}: “{a.question}” → {a.answer ?? "(no answer was recorded)"}</p>)}
        </div>
      )}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="ghost" onClick={load}>Check again</button>
        <button className="ghost" disabled={!feed || feed.length === 0} onClick={tamper}>Try a doctored copy</button>
      </div>
      <p className="note">Pages viewed come from the release service's signed log; the receipts themselves come from the chain. The log does not show who a link holder really is, only the name you gave the link. The release service keeps this record on its own disk (encrypted); the contract's receipt chain does not depend on it, so a lost record shows as a gap, never as a clean log.</p>
      {err && <p className="err">{err}</p>}
    </div>
  );
}
