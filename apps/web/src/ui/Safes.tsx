// The owner's safes (design A02) and naming a new safe (design A03).
import { useState } from "react";
import type { BoxView } from "@keyhole/chain";
import type { Identity } from "../lib/keys";
import { ensureFunded, reader, writerFor } from "../lib/clients";
import { createSafe } from "../lib/safe";
import type { SafeCard } from "../lib/safe";
import { saveManifest } from "../lib/upload";
import { emptyManifest, SAFE_COLOURS } from "../lib/vault";
import { txLink } from "../lib/config";
import { ctxFor, safeColour, safeName } from "../lib/safemeta";
import type { SafeInfo } from "../lib/safemeta";
import { AppShell, SafeIcon, fmtClock, serialLabel } from "./kit";
import type { RailSafe } from "./kit";
import { Receive } from "./Receive";

const ago = (t: number) => { const s = (Date.now() - t) / 1000; if (s < 90) return "Just now"; if (s < 3600) return `${Math.round(s / 60)} min ago`; if (s < 86400) return `${Math.round(s / 3600)} h ago`; const d = Math.round(s / 86400); return d === 1 ? "Yesterday" : `${d} days ago`; };
const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 5);

export function SafesPage({ id, cards, infos, rail, onOpen, onCreated, onLock }: {
  id: Identity; cards: SafeCard[] | null; infos: Record<string, SafeInfo>; rail: RailSafe[];
  onOpen: (boxId: string, action?: "give") => void; onCreated: (boxId: string) => Promise<void>; onLock: () => void;
}) {
  const [naming, setNaming] = useState(false);
  const activity = Object.values(infos).flatMap((i) => i.activity).sort((a, b) => b.at - a.at).slice(0, 8);
  const nameOf = (boxId: string) => { const c = cards?.find((x) => x.boxId === boxId); return c ? safeName(infos[boxId]?.manifest, c.serial) : ""; };
  return (
    <AppShell active="safes" safes={rail} onSafe={(b) => onOpen(b)} onSafes={() => undefined} account={id.accountId} crumb={<b>Safes</b>}
      actions={<><button className="btn btn-g" onClick={onLock}>Lock</button><button className="btn btn-p" onClick={() => setNaming(true)}>New safe <span className="m">+</span></button></>}>
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
          <h1 className="h1">Your safes</h1>
          {cards && <span className="lbl faint">{cards.length} {cards.length === 1 ? "safe" : "safes"}</span>}
        </div>
        {cards === null && <p className="mute" style={{ margin: 0 }}>Opening your safes…</p>}
        {cards && cards.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(300px,1fr))", gap: 20 }}>
            {cards.map((c) => {
              const info = infos[c.boxId];
              const name = safeName(info?.manifest, c.serial);
              const inside = info?.inside;
              return (
                <div key={c.boxId} className="panel safe-card" style={{ padding: 22, display: "flex", flexDirection: "column", gap: 18, cursor: "pointer" }} onClick={() => onOpen(c.boxId)}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <SafeIcon color={safeColour(info?.manifest)} label={inside ? "Safe, open" : "Safe, locked"} />
                    {c.state === "in_handover" ? <span className="chip chip-o">Handing over</span> : inside ? <span className="chip chip-a">Open</span> : <span className="chip">Locked</span>}
                  </div>
                  <div>
                    <div style={{ fontSize: 22, lineHeight: "28px", fontWeight: 700, letterSpacing: "-0.5px" }}>{name}</div>
                    <div className="m faint" style={{ fontSize: 12, marginTop: 4 }}>{serialLabel(c.serial)}</div>
                  </div>
                  <div style={{ borderTop: "1px solid var(--line)", paddingTop: 14, display: "flex", flexDirection: "column", gap: 9, fontSize: 14, lineHeight: "20px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}><span className="mute">Inside now</span>{inside ? <span>{inside.who}</span> : <span className="faint">Nobody</span>}</div>
                    {inside
                      ? <div style={{ display: "flex", justifyContent: "space-between" }}><span className="mute">Time left</span><span className="n" style={{ fontSize: 15, lineHeight: "20px" }}>{fmtClock(inside.until - Date.now())}</span></div>
                      : <div style={{ display: "flex", justifyContent: "space-between" }}><span className="mute">Last visit</span>{info?.lastVisit ? <span>{ago(info.lastVisit)}</span> : <span className="faint">Never</span>}</div>}
                    <div style={{ display: "flex", justifyContent: "space-between" }}><span className="mute">Files</span><span>{info?.manifest ? info.manifest.items.length : "…"}</span></div>
                  </div>
                  <button className="btn btn-p" style={{ justifyContent: "space-between" }} onClick={(e) => { e.stopPropagation(); onOpen(c.boxId, "give"); }} disabled={c.state === "in_handover"}>Give access <span className="m">→</span></button>
                </div>
              );
            })}
          </div>
        )}
        <div style={{ border: "1px dashed var(--line2)", borderRadius: 14, padding: "22px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
            <svg width="44" height="44" viewBox="0 0 64 64" aria-hidden="true"><rect x="1.5" y="1.5" width="61" height="61" rx="14" fill="none" stroke="#7A7F95" strokeWidth="1.5" strokeDasharray="4 4" /><path d="M32 22v20M22 32h20" stroke="#7A7F95" strokeWidth="1.8" strokeLinecap="round" /></svg>
            <div><div style={{ fontSize: 17, fontWeight: 700 }}>New safe</div><div className="mute" style={{ fontSize: 14, marginTop: 2 }}>Give it a name. It takes a minute.</div></div>
          </div>
          <button className="btn btn-s" onClick={() => setNaming(true)}>New safe <span className="m">+</span></button>
        </div>
        <Receive id={id} onDone={() => void onCreated("")} />
        {activity.length > 0 && (
          <div className="panel" style={{ overflow: "hidden" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 18px", borderBottom: "1px solid var(--ink)" }}><span className="h2" style={{ fontSize: 17 }}>Recent activity</span></div>
            <div className="th" style={{ gridTemplateColumns: "90px 200px 1fr 160px 120px", borderBottom: "1px solid var(--line)" }}><span>Time</span><span>Who</span><span>What</span><span>Safe</span><span>Proof</span></div>
            {activity.map((a, i) => (
              <div key={i} className="tr" style={{ gridTemplateColumns: "90px 200px 1fr 160px 120px" }}>
                <span className="n" style={{ fontSize: 15 }}>{hhmm(a.at)}</span><span style={{ fontWeight: 600 }}>{a.who}</span><span>{a.what}</span><span className="mute">{nameOf(a.boxId)}</span>
                <a className="m" style={{ fontSize: 12, color: "var(--blue)" }} href={txLink(a.txHash)} target="_blank" rel="noreferrer">{a.commitment.slice(0, 8)} ↗</a>
              </div>
            ))}
          </div>
        )}
      </div>
      {naming && <NewSafe id={id} nextSerial={(cards?.length ?? 0) + 1} onClose={() => setNaming(false)} onCreated={async (b) => { setNaming(false); await onCreated(b); }} />}
    </AppShell>
  );
}

function NewSafe({ id, nextSerial, onClose, onCreated }: { id: Identity; nextSerial: number; onClose: () => void; onCreated: (boxId: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(SAFE_COLOURS[0]);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [tx, setTx] = useState("");
  const create = async () => {
    setErr(""); setBusy("Setting up…");
    try {
      await ensureFunded(id, setBusy);
      setBusy("Creating your safe…");
      const r = await createSafe(id, writerFor(id));
      setTx(r.txHash);
      setBusy("Saving the name…");
      const box = (await reader.box(r.boxId)) as BoxView;
      const ctx = ctxFor(id, reader, box);
      await saveManifest(ctx, box, { ...emptyManifest(r.boxId, box.key_epoch), seq: 1, meta: { name: name.trim() || `Safe ${nextSerial}`, color } });
      await onCreated(r.boxId);
    } catch (e) { setErr((e as Error).message); setBusy(""); }
  };
  return (
    <>
      <div className="scrim" onClick={() => !busy && onClose()} />
      <div className="modal" role="dialog" aria-label="Name your safe">
        <div style={{ padding: "26px 28px 6px", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div><div className="lbl" style={{ color: "var(--blue)" }}>[ New safe ]</div><div className="h1" style={{ marginTop: 8, fontSize: 26, lineHeight: "30px" }}>Name your safe</div></div>
          <button className="x" aria-label="Close" onClick={onClose} disabled={!!busy}>×</button>
        </div>
        <div style={{ padding: "18px 28px 24px", display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ display: "flex", gap: 18, alignItems: "center" }}>
            <SafeIcon color={color} size={72} label="Preview of the safe" />
            <div style={{ flex: 1 }}><div className="fl">Name</div><input className="input" autoFocus placeholder="Flat documents" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !busy) void create(); }} /></div>
          </div>
          <div>
            <div className="fl">Colour</div>
            <div style={{ display: "flex", gap: 10 }}>
              {SAFE_COLOURS.map((c) => <button key={c} aria-label={`Colour ${c}`} onClick={() => setColor(c)} style={{ width: 36, height: 36, borderRadius: 10, background: c, border: 0, outline: c === color ? "2px solid #0E1435" : "none", outlineOffset: 2 }} />)}
            </div>
          </div>
          {err && <p className="err" style={{ margin: 0 }}>{err}</p>}
        </div>
        <div style={{ padding: "18px 28px", borderTop: "1px solid var(--line)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <span className="lbl faint">{busy || (tx ? "" : "")}</span>
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn btn-s" onClick={onClose} disabled={!!busy}>Cancel</button>
            <button className="btn btn-p" onClick={create} disabled={!!busy}>Create safe <span className="m">→</span></button>
          </div>
        </div>
      </div>
    </>
  );
}
