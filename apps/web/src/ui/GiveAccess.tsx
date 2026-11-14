// Give access drawer (design A05) and the Link ready state (design A06).
import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import qrcode from "qrcode-generator";
import type { Ctx } from "../lib/upload";
import type { ItemRecord, Manifest } from "../lib/vault";
import { endAccess, giveAccess } from "../lib/access";
import { loadGrants, saveGrants } from "../lib/localvault";
import { svc } from "../lib/safemeta";
import { Check, Steps, Working, fmtClock } from "./kit";

const DURATIONS: [string, number][] = [["1H", 1], ["2H", 2], ["24H", 24]];

function Qr({ text }: { text: string }) {
  const m = useMemo(() => { try { const q = qrcode(0, "L"); q.addData(text); q.make(); return q; } catch { return null; } }, [text]);
  if (!m) return null;
  const n = m.getModuleCount();
  const cells: ReactElement[] = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m.isDark(r, c)) cells.push(<rect key={`${r}-${c}`} x={c} y={r} width="1.02" height="1.02" />);
  return <svg width="104" height="104" viewBox={`-2 -2 ${n + 4} ${n + 4}`} role="img" aria-label="QR code of the link" style={{ background: "#FFFFFF", border: "1px solid var(--ink)", borderRadius: 8, flex: "none" }} shapeRendering="crispEdges"><g fill="#0E1435">{cells}</g></svg>;
}

export function GiveAccessDrawer({ ctx, man, onClose, onChanged }: { ctx: Ctx; man: Manifest | null; onClose: () => void; onChanged: () => void }) {
  const items = (man?.items ?? []).filter((i) => i.shareable);
  const [pick, setPick] = useState<Record<string, boolean>>({});
  const [label, setLabel] = useState("");
  const [hours, setHours] = useState(2);
  const [questions, setQuestions] = useState(0);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [made, setMade] = useState<{ link: string; grantId: string; exp: number; files: number; questions: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [ended, setEnded] = useState(false);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const chosen: ItemRecord[] = items.filter((i) => pick[i.uid]);
  const who = label.trim() || "They";
  const sentence = `${who} can view ${chosen.length} file${chosen.length === 1 ? "" : "s"} for ${hours} hour${hours === 1 ? "" : "s"}${questions ? ` and ask up to ${questions} question${questions === 1 ? "" : "s"}` : ""}. They cannot download.`;

  const create = async () => {
    setErr(""); setBusy("Creating the link…");
    try {
      const r = await giveAccess({ id: ctx.id, reader: ctx.reader, writer: ctx.writer, svc, boxId: ctx.boxId, bmk: ctx.bmk, epoch: ctx.epoch, label: label.trim(), items: chosen, durationMs: hours * 3_600_000, maxSessions: 3, ...(questions ? { askBudget: questions } : {}), origin: `${location.origin}${location.pathname}` });
      const list = loadGrants(ctx.id, ctx.boxId);
      saveGrants(ctx.id, ctx.boxId, [{ grantId: r.grantId, label: label.trim() || "Visitor", exp: r.payload.exp, files: chosen.map((c) => c.name), link: r.link, ...(questions ? { questions } : {}) }, ...list]);
      setMade({ link: r.link, grantId: r.grantId, exp: r.payload.exp, files: chosen.length, questions });
      onChanged();
    } catch (e) { setErr((e as Error).message); }
    setBusy("");
  };
  const end = async () => {
    if (!made) return;
    setBusy("Ending access…"); setErr("");
    try { await endAccess({ id: ctx.id, reader: ctx.reader, writer: ctx.writer, svc, grantId: made.grantId }); setEnded(true); onChanged(); } catch (e) { setErr((e as Error).message); }
    setBusy("");
  };

  return (
    <>
      <div className="scrim" onClick={() => !busy && onClose()} />
      <aside className="drawer" role="dialog" aria-label={made ? "Link ready" : "Give access"}>
        {!made ? <>
          <div className="dh"><div><div className="lbl" style={{ color: "var(--blue)" }}>[ Give access ]</div><div className="h1" style={{ marginTop: 8, fontSize: 26, lineHeight: "30px" }}>Let someone in</div></div><button className="x" aria-label="Close" onClick={onClose}>×</button></div>
          <div className="db">
            <div><div className="fl">Who</div><input className="input" placeholder="Who is this for?" value={label} onChange={(e) => setLabel(e.target.value)} /></div>
            <div>
              <div className="fl">What they can open</div>
              {items.length === 0 ? <p className="mute" style={{ margin: 0, fontSize: 14 }}>Add a PDF, image or text file first.</p> : (
                <div className="panel" style={{ overflow: "hidden" }}>
                  {items.map((i) => (
                    <div key={i.uid} className="tr" style={{ gridTemplateColumns: "1fr auto", padding: "10px 14px" }}>
                      <Check on={!!pick[i.uid]} onChange={(v) => setPick({ ...pick, [i.uid]: v })} label={i.name}><span style={{ fontSize: 14 }}>{i.name}</span></Check>
                      <span className="m faint" style={{ fontSize: 11 }}>{i.folder ?? ""}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16 }}>
              <div><div className="fl">How long</div><div className="seg">{DURATIONS.map(([n, h]) => <button key={h} className={h === hours ? "on" : ""} onClick={() => setHours(h)}>{n}</button>)}</div></div>
              <div><div className="fl" style={{ textAlign: "right" }}>Questions</div><div className="seg">
                <button aria-label="Fewer questions" onClick={() => setQuestions(Math.max(0, questions - 1))}>−</button>
                <button className="on" aria-label="Questions allowed" style={{ minWidth: 44 }}>{questions}</button>
                <button aria-label="More questions" onClick={() => setQuestions(Math.min(10, questions + 1))}>+</button>
              </div></div>
            </div>
            {chosen.length > 0 && <div style={{ background: "var(--amber2)", borderRadius: 10, padding: "14px 16px", fontSize: 14, lineHeight: "21px" }}>{sentence}</div>}
            {busy === "Creating the link…" && <div className="well" style={{ padding: "14px 16px" }}><Steps current={0} steps={["Recording the access on NEAR and handing the key half to the release service", "Your link"]} /></div>}
            {err && <p className="err" style={{ margin: 0 }}>{err}</p>}
          </div>
          <div className="df" style={{ justifyContent: "flex-end", alignItems: "center" }}>
            {busy && busy !== "Creating the link…" && <span style={{ marginRight: "auto" }}><Working>{busy}</Working></span>}
            <button className="btn btn-s" onClick={onClose} disabled={!!busy}>Cancel</button>
            <button className="btn btn-p" onClick={create} disabled={!!busy || chosen.length === 0 || !label.trim()}>Create link <span className="m">→</span></button>
          </div>
        </> : <>
          <div className="dh"><div><div className="lbl" style={{ color: "var(--blue)" }}>[ Link ready ]</div><div className="h1" style={{ marginTop: 8, fontSize: 26, lineHeight: "30px" }}>Send this to {label.trim() || "them"}</div></div><button className="x" aria-label="Close" onClick={onClose}>×</button></div>
          <div className="db">
            <div><div className="fl">Link</div><div style={{ display: "flex", gap: 8 }}><input className="input m" readOnly value={made.link} onFocus={(e) => e.target.select()} style={{ fontSize: 13 }} /><button className="btn btn-p" onClick={() => void navigator.clipboard?.writeText(made.link)}>Copy</button></div></div>
            <div style={{ display: "flex", gap: 18, alignItems: "center" }}>
              <Qr text={made.link} />
              <div>
                <div className="lbl faint">{ended ? "Ended" : "Closes in"}</div>
                <div className="n" style={{ fontSize: 40, lineHeight: "44px", marginTop: 4 }}>{ended ? "00:00:00" : fmtClock(made.exp - now).padStart(8, "00:")}</div>
                <div className="mute" style={{ fontSize: 13, marginTop: 2 }}>{new Date(made.exp).toDateString() === new Date().toDateString() ? "Today" : new Date(made.exp).toLocaleDateString()} at {new Date(made.exp).toTimeString().slice(0, 5)}</div>
              </div>
            </div>
            <div className="panel" style={{ overflow: "hidden" }}>
              <div className="tr" style={{ gridTemplateColumns: "1fr auto" }}><span className="mute">Files</span><span>{made.files}</span></div>
              <div className="tr" style={{ gridTemplateColumns: "1fr auto" }}><span className="mute">Questions</span><span>{made.questions ? `Up to ${made.questions}` : "None"}</span></div>
              <div className="tr" style={{ gridTemplateColumns: "1fr auto" }}><span className="mute">Download</span><span>Off</span></div>
            </div>
            <p className="mute" style={{ margin: 0, fontSize: 14 }}>Anyone with this link can open it until it closes.</p>
            {err && <p className="err" style={{ margin: 0 }}>{err}</p>}
          </div>
          <div className="df" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <button className="btn btn-o" onClick={end} disabled={!!busy || ended}>{ended ? "Access ended" : "End access"}</button>
            {busy && <Working>{busy}</Working>}
            <button className="btn btn-p" onClick={onClose}>Done</button>
          </div>
        </>}
      </aside>
    </>
  );
}
