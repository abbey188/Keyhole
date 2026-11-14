// Access tab (design A07): open links with End access, and links closed in the last 7 days. Re-lock is kept at the bottom.
import { useEffect, useState } from "react";
import type { GrantView } from "@keyhole/chain";
import type { Ctx } from "../lib/upload";
import type { Manifest } from "../lib/vault";
import { endAccess } from "../lib/access";
import { relock } from "../lib/relock";
import { loadGrants } from "../lib/localvault";
import type { SavedGrant } from "../lib/localvault";
import { fetchFeed } from "../lib/visitors";
import type { FeedRecord } from "../lib/visitors";
import { svc } from "../lib/safemeta";
import { fmtClock, Working } from "./kit";

const WEEK = 7 * 86_400_000;
const day = (t: number) => new Date(t).toLocaleDateString(undefined, { weekday: "short", day: "numeric" }) + " " + new Date(t).toTimeString().slice(0, 5);

export function AccessTab({ ctx, man, onChanged }: { ctx: Ctx; man: Manifest | null; onChanged: () => void }) {
  const [list, setList] = useState<SavedGrant[]>(() => loadGrants(ctx.id, ctx.boxId));
  const [status, setStatus] = useState<Record<string, GrantView | null>>({});
  const [feed, setFeed] = useState<FeedRecord[]>([]);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [now, setNow] = useState(Date.now());
  const [relocking, setRelocking] = useState("");
  const [relocked, setRelocked] = useState(false);
  const refresh = async () => {
    const l = loadGrants(ctx.id, ctx.boxId); setList(l);
    const s: Record<string, GrantView | null> = {};
    for (const g of l) s[g.grantId] = await ctx.reader.grant(g.grantId).catch(() => null);
    setStatus(s);
    setFeed(await fetchFeed(ctx.id, ctx.reader, svc, ctx.boxId).catch(() => []));
  };
  useEffect(() => { void refresh(); const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const end = async (g: SavedGrant) => {
    setBusy(g.grantId); setErr("");
    try { await endAccess({ id: ctx.id, reader: ctx.reader, writer: ctx.writer, svc, grantId: g.grantId }); await refresh(); onChanged(); } catch (e) { setErr((e as Error).message); }
    setBusy("");
  };
  const doRelock = async () => {
    setErr(""); setRelocked(false);
    try {
      const box = await ctx.reader.box(ctx.boxId);
      if (!box) throw new Error("Safe not found.");
      await relock({ ...ctx, progress: setRelocking }, box, async () => {
        for (const g of list) { const v = await ctx.reader.grant(g.grantId); if (v && !v.revoked_at && Date.now() <= v.not_after_ms) await endAccess({ id: ctx.id, reader: ctx.reader, writer: ctx.writer, svc, grantId: g.grantId }); }
      });
      setRelocked(true); await refresh(); onChanged();
    } catch (e) { setErr(`Re-lock did not finish: ${(e as Error).message}`); }
    setRelocking("");
  };

  const opens = (g: SavedGrant) => status[g.grantId]?.sessions_used ?? feed.filter((r) => r.grant_id === g.grantId).length;
  const asked = (g: SavedGrant) => feed.filter((r) => r.grant_id === g.grantId).reduce((n, r) => n + (r.asks?.length ?? 0), 0);
  const isOpen = (g: SavedGrant) => { const v = status[g.grantId]; return v ? !v.revoked_at && now <= v.not_after_ms : now <= g.exp; };
  const open = list.filter(isOpen);
  const closed = list.filter((g) => !isOpen(g) && now - (status[g.grantId]?.revoked_at ?? g.exp) < WEEK);
  const cols = "180px 1fr 110px 80px 100px 120px";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}><h2 className="h2">Open links</h2><span className="lbl faint">{open.length} open</span></div>
      <div className="panel" style={{ overflow: "hidden" }}>
        <div className="th" style={{ gridTemplateColumns: cols }}><span>Who</span><span>What</span><span>Time left</span><span>Opens</span><span>Questions</span><span></span></div>
        {open.length === 0 && <div className="tr" style={{ gridTemplateColumns: "1fr" }}><span className="faint">No open links</span></div>}
        {open.map((g) => (
          <div key={g.grantId} className="tr" style={{ gridTemplateColumns: cols }}>
            <span style={{ fontWeight: 700 }}>{g.label}</span><span>{g.files.join(", ")}</span>
            <span className="n" style={{ fontSize: 16 }}>{fmtClock((status[g.grantId]?.not_after_ms ?? g.exp) - now)}</span>
            <span>{opens(g)}</span><span className="mute">{g.questions ? `${asked(g)} of ${g.questions}` : "—"}</span>
            <span style={{ textAlign: "right" }}><button className="btn btn-o" style={{ padding: "7px 12px", fontSize: 13 }} disabled={!!busy} onClick={() => end(g)}>{busy === g.grantId ? "Ending…" : "End access"}</button></span>
          </div>
        ))}
      </div>
      {closed.length > 0 && <>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginTop: 10 }}><h2 className="h2">Closed</h2><span className="lbl faint">Last 7 days</span></div>
        <div className="panel" style={{ overflow: "hidden" }}>
          {closed.map((g) => { const v = status[g.grantId]; const byYou = !!v?.revoked_at; return (
            <div key={g.grantId} className="tr" style={{ gridTemplateColumns: "180px 1fr 140px 80px 120px" }}>
              <span>{g.label}</span><span className="mute">{g.files.join(", ")}</span>
              <span className="lbl" style={{ fontSize: 10, color: byYou ? "var(--orange)" : "var(--faint)" }}>{byYou ? "Ended by you" : "Expired"}</span>
              <span>{opens(g)}</span><span className="mute" style={{ textAlign: "right", fontSize: 13 }}>{day(v?.revoked_at ?? g.exp)}</span>
            </div>); })}
        </div>
      </>}
      {err && <p className="err">{err}</p>}
      <div className="well" style={{ padding: "16px 18px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, marginTop: 10 }}>
        <div><div style={{ fontWeight: 700, fontSize: 15 }}>Re-lock this safe</div><div className="mute" style={{ fontSize: 14, marginTop: 2 }}>Ends every open link and changes the keys of every file.</div></div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>{relocking && <Working>{relocking}</Working>}{relocked && <span className="chip chip-b">Re-locked</span>}<button className="btn btn-o" disabled={!!relocking || (man?.items.length ?? 0) === 0} onClick={doRelock}>Re-lock now</button></div>
      </div>
    </div>
  );
}
