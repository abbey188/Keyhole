import { useEffect, useState } from "react";
import type { Ctx } from "../lib/upload";
import type { Manifest } from "../lib/vault";
import { endAccess, giveAccess } from "../lib/access";
import { relock } from "../lib/relock";
import type { Services } from "../lib/access";
import { config, txLink } from "../lib/config";
import type { GrantView } from "@keyhole/chain";

const svc: Services = { releaseUrl: config.releaseUrl, nodeUrls: config.nodeUrls, chainId: config.chainId, contractId: config.contractId };
interface Saved { grantId: string; label: string; exp: number; files: string[]; link: string }
const key = (boxId: string) => `keyhole.grants.${boxId}`;
const load = (boxId: string): Saved[] => { try { return JSON.parse(localStorage.getItem(key(boxId)) ?? "[]"); } catch { return []; } };
const save = (boxId: string, v: Saved[]) => { try { localStorage.setItem(key(boxId), JSON.stringify(v)); } catch { /* private mode */ } };

const DURATIONS: [string, number][] = [["1 hour", 1], ["2 hours", 2], ["24 hours", 24]];

export function AccessTab({ ctx, man, onChanged }: { ctx: Ctx; man: Manifest | null; onChanged: () => void }) {
  const items = (man?.items ?? []).filter((i) => i.shareable);
  const [pick, setPick] = useState<Record<string, boolean>>({});
  const [label, setLabel] = useState("");
  const [hours, setHours] = useState(2);
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [made, setMade] = useState<{ link: string; sentence: string; tx: string } | null>(null);
  const [list, setList] = useState<Saved[]>(() => load(ctx.boxId));
  const [status, setStatus] = useState<Record<string, GrantView | null>>({});
  const refresh = async () => { const s: Record<string, GrantView | null> = {}; for (const g of list) s[g.grantId] = await ctx.reader.grant(g.grantId).catch(() => null); setStatus(s); };
  useEffect(() => { void refresh(); }, [list.length]);

  const chosen = items.filter((i) => pick[i.uid]);
  const give = async () => {
    setErr(""); setBusy("Giving access…");
    try {
      const r = await giveAccess({ id: ctx.id, reader: ctx.reader, writer: ctx.writer, svc, boxId: ctx.boxId, bmk: ctx.bmk, epoch: ctx.epoch, label: label.trim(), items: chosen, durationMs: hours * 3_600_000, maxSessions: 3, ...(ask ? { askBudget: 5 } : {}), origin: `${location.origin}${location.pathname}` });
      const sentence = `${label.trim() || "They"} can view ${chosen.length} file${chosen.length === 1 ? "" : "s"} for ${hours} hour${hours === 1 ? "" : "s"}. They cannot download. You can end it any time. Every open is recorded.`;
      const next = [{ grantId: r.grantId, label: label.trim() || "Visitor", exp: r.payload.exp, files: chosen.map((c) => c.name), link: r.link }, ...list];
      save(ctx.boxId, next); setList(next); setMade({ link: r.link, sentence, tx: r.txHash }); onChanged();
    } catch (e) { setErr((e as Error).message); }
    setBusy("");
  };
  const end = async (g: Saved) => {
    setBusy("Ending access…"); setErr("");
    try { await endAccess({ id: ctx.id, reader: ctx.reader, writer: ctx.writer, svc, grantId: g.grantId }); await refresh(); onChanged(); } catch (e) { setErr((e as Error).message); }
    setBusy("");
  };
  const [relocking, setRelocking] = useState("");
  const [relocked, setRelocked] = useState(false);
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
  const state = (g: Saved) => { const v = status[g.grantId]; if (!v) return ["…", ""]; if (v.revoked_at) return ["ended by you", "bad"]; if (Date.now() > v.not_after_ms) return ["expired", "warn"]; return ["active", "ok"]; };

  return (
    <div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Give access</h3>
        {items.length === 0 ? <p className="note">Add a PDF, image or text file first. Only those can be shared.</p> : (
          <>
            {items.map((i) => <label key={i.uid} className="row" style={{ margin: "6px 0" }}><input type="checkbox" style={{ width: "auto" }} checked={!!pick[i.uid]} onChange={(e) => setPick({ ...pick, [i.uid]: e.target.checked })} /> {i.name}</label>)}
            <div className="row" style={{ marginTop: 10 }}>
              <input className="grow" placeholder="Who is this for? (e.g. Maria)" value={label} onChange={(e) => setLabel(e.target.value)} />
              <select style={{ width: 140 }} value={hours} onChange={(e) => setHours(Number(e.target.value))}>{DURATIONS.map(([n, h]) => <option key={h} value={h}>{n}</option>)}</select>
            </div>
            <label className="row" style={{ marginTop: 10 }}><input type="checkbox" style={{ width: "auto" }} checked={ask} onChange={(e) => setAsk(e.target.checked)} /> Let them ask up to 5 questions about these files <span className="note">(answers only from these files; you see every question)</span></label>
            <div className="row" style={{ marginTop: 12 }}><button disabled={!!busy || chosen.length === 0 || !label.trim()} onClick={give}>Give access</button>{busy && <span className="note">{busy}</span>}</div>
          </>
        )}
        {err && <p className="err">{err}</p>}
      </div>
      {made && (
        <div className="card"><h3 style={{ marginTop: 0 }}>Link ready</h3><p>{made.sentence}</p>
          <input readOnly value={made.link} onFocus={(e) => e.target.select()} />
          <div className="row" style={{ marginTop: 10 }}><button onClick={() => void navigator.clipboard?.writeText(made.link)}>Copy link</button><a href={txLink(made.tx)} target="_blank" rel="noreferrer">recorded on chain</a></div>
          <p className="note">Anyone with this link can use it, so send it only to {label.trim() || "them"}. It is shown here once; the half of the key in it is not stored anywhere else.</p>
        </div>
      )}
      {list.map((g) => { const [t, c] = state(g); const v = status[g.grantId]; return (
        <div className="card" key={g.grantId}>
          <div className="row"><strong className="grow">{g.label}</strong><span className={`pill ${c}`}>{t}</span></div>
          <p className="note">{g.files.join(", ")} · {v ? `${v.sessions_used} visit${v.sessions_used === 1 ? "" : "s"} used of ${v.max_sessions}` : ""} · until {new Date(g.exp).toLocaleString()}</p>
          {t === "active" && <button className="danger" disabled={!!busy} onClick={() => end(g)}>End access</button>}
        </div>); })}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Re-lock this safe</h3>
        <p className="note">Ends all open access, then re-encrypts every file under a new key and asks the storage node to erase the old copies. Anyone who kept an old key can open nothing that is still stored. What someone already saved or photographed stays theirs: nothing can undo that.</p>
        <div className="row"><button className="danger" disabled={!!relocking || (man?.items.length ?? 0) === 0} onClick={doRelock}>Re-lock now</button>{relocking && <span className="note">{relocking}</span>}{relocked && <span className="pill ok">re-locked</span>}</div>
      </div>
    </div>
  );
}
