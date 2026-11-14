// Inside a safe (design A04): header with the owner's name and colour, folder tabs, and the Files view with folders and the upload tray.
import { useEffect, useMemo, useRef, useState } from "react";
import type { BoxView } from "@keyhole/chain";
import type { Identity } from "../lib/keys";
import { reader } from "../lib/clients";
import { txLink } from "../lib/config";
import { addItem, loadManifest, readOriginal, readSegment, saveManifest } from "../lib/upload";
import type { Ctx, Receipt } from "../lib/upload";
import { planItem, FileRefused } from "../lib/files";
import { browserRenderers } from "../lib/render";
import type { ItemRecord, Manifest } from "../lib/vault";
import { emptyManifest } from "../lib/vault";
import { loadGrants } from "../lib/localvault";
import { ctxFor, safeColour, safeName } from "../lib/safemeta";
import type { SafeInfo } from "../lib/safemeta";
import { AppShell, SafeIcon, fmtClock, serialLabel } from "./kit";
import type { RailSafe } from "./kit";
import { RedactPanel } from "./RedactPanel";
import { AccessTab } from "./AccessTab";
import { GiveAccessDrawer } from "./GiveAccess";
import { VisitorsTab } from "./VisitorsTab";
import { HandoverTab } from "./HandoverTab";
import { AskTab } from "./AskTab";
import { ClaimsTab } from "./ClaimsTab";

export type Tab = "files" | "access" | "visitors" | "ask" | "claims" | "handover";
const TABS: [Tab, string][] = [["files", "Files"], ["access", "Access"], ["visitors", "Visitors"], ["ask", "Ask"], ["claims", "Claims"]];

export function SafePage({ id, boxId, serial, info, rail, initial, onSafe, onBack, onChanged }: {
  id: Identity; boxId: string; serial: number; info?: SafeInfo; rail: RailSafe[]; initial?: "give";
  onSafe: (boxId: string) => void; onBack: () => void; onChanged: () => void;
}) {
  const [box, setBox] = useState<BoxView | null>(null);
  const [man, setMan] = useState<Manifest | null>(null);
  const [tab, setTab] = useState<Tab>("files");
  const [giving, setGiving] = useState(initial === "give");
  const [err, setErr] = useState("");
  const [txs, setTxs] = useState<Receipt[]>([]);
  const [now, setNow] = useState(Date.now());
  const ctx: Ctx | null = useMemo(() => (box ? ctxFor(id, reader, box) : null), [box?.box_id, box?.key_epoch, box?.wrapped_bmk]);

  const refresh = async () => {
    const b = await reader.box(boxId);
    if (!b) throw new Error("This safe was not found on chain.");
    setBox(b);
  };
  useEffect(() => { refresh().catch((e) => setErr((e as Error).message)); const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [boxId]);
  useEffect(() => { if (ctx && box) loadManifest(ctx, box).then(setMan).catch((e) => setErr(`Could not open the file list: ${(e as Error).message}`)); }, [ctx, box?.manifest_seq]);
  const afterWrite = async (t: Receipt[]) => { setTxs(t); await refresh(); onChanged(); };

  const name = safeName(man ?? info?.manifest, serial);
  const colour = safeColour(man ?? info?.manifest);
  const inside = info?.inside && info.inside.until > now ? info.inside : null;
  const [renaming, setRenaming] = useState<string | null>(null);
  const rename = async () => {
    if (!ctx || !box || renaming === null) return;
    const next = renaming.trim(); setRenaming(null);
    if (!next || next === name) return;
    const cur = man ?? emptyManifest(ctx.boxId, ctx.epoch);
    try { await afterWrite(await saveManifest(ctx, box, { ...cur, seq: cur.seq + 1, meta: { ...cur.meta, name: next } })); } catch (e) { setErr((e as Error).message); }
  };

  const handover = tab === "handover";
  return (
    <AppShell active="safes" safes={rail} currentBox={boxId} onSafe={onSafe} onSafes={onBack} account={id.accountId}
      crumb={handover ? <><a href="#" onClick={(e) => { e.preventDefault(); onBack(); }}>Safes</a> / <a href="#" onClick={(e) => { e.preventDefault(); setTab("files"); }}>{name}</a> / <b>Hand over</b></> : <><a href="#" onClick={(e) => { e.preventDefault(); onBack(); }}>Safes</a> / <b>{name}</b></>}
      actions={handover ? <button className="btn btn-g" onClick={() => setTab("files")}>Back to the safe</button> : <>
        <button className="btn btn-s" onClick={() => setTab("handover")} disabled={!box}>Hand over</button>
        <button className="btn btn-p" onClick={() => setGiving(true)} disabled={!ctx || !!box?.in_deal}>Give access <span className="m">→</span></button>
      </>}>
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        {!handover && <>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <SafeIcon color={colour} size={52} label={inside ? "Safe, open" : "Safe, locked"} />
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {renaming === null ? <>
                    <h1 className="h1">{name}</h1>
                    <button className="x" aria-label="Rename" onClick={() => setRenaming(name)} disabled={!ctx}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#7A7F95" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4" /></svg></button>
                  </> : <input className="input" autoFocus value={renaming} maxLength={40} onChange={(e) => setRenaming(e.target.value)} onBlur={rename} onKeyDown={(e) => { if (e.key === "Enter") void rename(); if (e.key === "Escape") setRenaming(null); }} style={{ fontSize: 22, fontWeight: 700, width: 360 }} />}
                </div>
                <div className="m faint" style={{ fontSize: 12, marginTop: 4 }}>{serialLabel(serial)}</div>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              {box?.in_deal ? <span className="chip chip-o">Handover in progress</span> : inside ? <><span className="chip chip-a">Open</span><span style={{ fontSize: 14 }}>{inside.who} is in</span><span className="n" style={{ fontSize: 22 }}>{fmtClock(inside.until - now)}</span></> : <span className="chip">Locked</span>}
            </div>
          </div>
          <nav className="tabs">{TABS.map(([t, label]) => <button key={t} className={`tab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>{label}</button>)}</nav>
        </>}
        {err && <p className="err">{err}</p>}
        {tab === "files" && ctx && box && <Files ctx={ctx} box={box} man={man} id={id} afterWrite={afterWrite} />}
        {tab === "claims" && ctx && box && <ClaimsTab ctx={ctx} man={man} box={box} afterAdd={afterWrite} />}
        {tab === "ask" && ctx && <AskTab ctx={ctx} man={man} />}
        {tab === "access" && ctx && <AccessTab ctx={ctx} man={man} onChanged={() => { void refresh(); onChanged(); }} />}
        {tab === "visitors" && ctx && <VisitorsTab ctx={ctx} refreshKey={box?.receipts_seq ?? 0} />}
        {tab === "handover" && ctx && box && <HandoverTab ctx={ctx} box={box} onChanged={() => { void refresh(); onChanged(); }} />}
        {txs.length > 0 && tab === "files" && (
          <details style={{ fontSize: 13 }}><summary className="lbl faint" style={{ cursor: "pointer" }}>Recorded on chain ({txs.length})</summary>
            <table style={{ marginTop: 8, borderCollapse: "collapse" }}><tbody>{txs.map((t) => <tr key={t.txHash}><td className="m mute" style={{ padding: "3px 12px 3px 0", fontSize: 12 }}>{t.step}</td><td><a className="m" style={{ color: "var(--blue)", fontSize: 12 }} href={txLink(t.txHash)} target="_blank" rel="noreferrer">{t.txHash.slice(0, 10)}… ↗</a></td></tr>)}</tbody></table>
          </details>
        )}
      </div>
      {giving && ctx && <GiveAccessDrawer ctx={ctx} man={man} onClose={() => setGiving(false)} onChanged={() => { void refresh(); onChanged(); }} />}
    </AppShell>
  );
}

// ---------------------------------------------------------------- Files

type Stage = "Prepare" | "Encrypt" | "Store" | "Record";
const STAGES: Stage[] = ["Prepare", "Encrypt", "Store", "Record"];
interface Upload { name: string; size: number; stage: Stage; pct: number }
const fmtSize = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const added = (t: number) => { const d = new Date(t), n = new Date(); if (d.toDateString() === n.toDateString()) return "Today"; const y = new Date(n.getTime() - 86_400_000); return d.toDateString() === y.toDateString() ? "Yesterday" : d.toLocaleDateString(); };
const Folder = ({ on }: { on?: boolean }) => <svg width="18" height="18" viewBox="0 0 24 24" fill={on ? "#DFE7F6" : "none"} stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" /></svg>;
const DocIcon = ({ image }: { image?: boolean }) => <svg width="20" height="20" viewBox="0 0 24 24" fill="#DFE7F6" stroke="#2546C2" strokeWidth="1.6" strokeLinejoin="round"><path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /><path d={image ? "M14 3v5h5M8.5 18l2.5-3 2 2 2-3 1.5 4" : "M14 3v5h5M8 13h8M8 17h6"} fill="none" /></svg>;

function Files({ ctx, box, man, id, afterWrite }: { ctx: Ctx; box: BoxView; man: Manifest | null; id: Identity; afterWrite: (t: Receipt[]) => Promise<void> }) {
  const [folder, setFolder] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [up, setUp] = useState<Upload | null>(null);
  const [err, setErr] = useState("");
  const [notes, setNotes] = useState<string[]>([]);
  const [menu, setMenu] = useState<string | null>(null);
  const [redact, setRedact] = useState<ItemRecord | null>(null);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ item: ItemRecord; urls: { kind: string; src: string }[] } | null>(null);
  const [drag, setDrag] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const items = man?.items ?? [];
  const folders = man?.meta?.folders ?? [];
  const grants = loadGrants(id, ctx.boxId).filter((g) => g.exp > Date.now());
  const shown = items.filter((i) => (folder === null || i.folder === folder) && (!q.trim() || i.name.toLowerCase().includes(q.trim().toLowerCase())));

  const onFile = async (f: File) => {
    setErr(""); setNotes([]);
    setUp({ name: f.name, size: f.size, stage: "Prepare", pct: 8 });
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const plan = await planItem({ name: f.name, mime: f.type, bytes }, browserRenderers);
      setNotes(plan.notes);
      setUp((u) => u && { ...u, stage: "Encrypt", pct: 30 });
      const progress = (m: string) => setUp((u) => {
        if (!u) return u;
        if (m.startsWith("file: reserving")) return { ...u, stage: "Store", pct: 42 };
        if (m.startsWith("file: uploading")) return { ...u, stage: "Store", pct: 58 };
        if (m.startsWith("file: recording")) return { ...u, stage: "Record", pct: 72 };
        if (m.startsWith("index")) return { ...u, stage: "Record", pct: Math.min(96, u.pct + 6) };
        return u;
      });
      const res = await addItem({ ...ctx, progress }, man ?? emptyManifest(ctx.boxId, ctx.epoch), box, { name: f.name, mime: f.type || "application/octet-stream", kind: plan.kind, size: bytes.length, parts: plan.parts, ...(folder ? { folder } : {}) });
      setUp((u) => u && { ...u, pct: 100 });
      await afterWrite(res.txs);
      setUp(null);
    } catch (e) { setErr(e instanceof FileRefused ? e.message : `Could not add the file: ${(e as Error).message}`); setUp(null); }
  };
  const addFolder = async () => {
    const n = (newFolder ?? "").trim(); setNewFolder(null);
    if (!n || folders.includes(n)) return;
    const cur = man ?? emptyManifest(ctx.boxId, ctx.epoch);
    try { await afterWrite(await saveManifest(ctx, box, { ...cur, seq: cur.seq + 1, meta: { ...cur.meta, folders: [...folders, n] } })); setFolder(n); } catch (e) { setErr((e as Error).message); }
  };
  const open = async (item: ItemRecord) => {
    setErr(""); setMenu(null);
    try {
      const urls: { kind: string; src: string }[] = [];
      for (const s of item.segments.filter((x) => x.role === "page").slice(0, 12)) {
        const bytes = await readSegment(ctx, item, s.s);
        if (s.mime.startsWith("image/")) urls.push({ kind: "img", src: URL.createObjectURL(new Blob([bytes.slice()], { type: s.mime })) });
        else urls.push({ kind: "text", src: new TextDecoder().decode(bytes) });
      }
      setPreview({ item, urls });
    } catch (e) { setErr(`Could not open it: ${(e as Error).message}`); }
  };
  const download = async (item: ItemRecord) => {
    setMenu(null);
    try {
      const bytes = await readOriginal(ctx, item);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([bytes.slice()], { type: item.mime }));
      a.download = item.name; a.click();
    } catch (e) { setErr(`Could not download it: ${(e as Error).message}`); }
  };
  const busy = !!up;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "230px minmax(0,1fr)", gap: 20 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <button className={`fd ${folder === null ? "on" : ""}`} onClick={() => setFolder(null)}><Folder on={folder === null} /><span style={{ flex: 1 }}>All files</span><span className={`m ${folder === null ? "" : "faint"}`} style={{ fontSize: 11 }}>{items.length}</span></button>
        {folders.map((f) => <button key={f} className={`fd ${folder === f ? "on" : ""}`} onClick={() => setFolder(f)}><Folder on={folder === f} /><span style={{ flex: 1 }}>{f}</span><span className={`m ${folder === f ? "" : "faint"}`} style={{ fontSize: 11 }}>{items.filter((i) => i.folder === f).length}</span></button>)}
        {newFolder === null
          ? <button className="fd" style={{ marginTop: 8, color: "var(--blue)", fontWeight: 600 }} onClick={() => setNewFolder("")} disabled={busy}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>New folder</button>
          : <input className="input" autoFocus placeholder="Folder name" value={newFolder} maxLength={30} style={{ marginTop: 8, fontSize: 14, padding: "8px 10px" }} onChange={(e) => setNewFolder(e.target.value)} onBlur={addFolder} onKeyDown={(e) => { if (e.key === "Enter") void addFolder(); if (e.key === "Escape") setNewFolder(null); }} />}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <div className="crumb">{folder ? <><a href="#" onClick={(e) => { e.preventDefault(); setFolder(null); }}>All files</a> / <b>{folder}</b></> : <b>All files</b>}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <label className="input" style={{ padding: "8px 12px", fontSize: 14, width: 220, display: "flex", gap: 8, alignItems: "center", color: "var(--faint)" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM20 20l-4-4" /></svg>
              <input aria-label="Search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} style={{ border: 0, outline: "none", background: "transparent", font: "inherit", color: "var(--ink)", width: "100%" }} />
            </label>
            <button className="btn btn-s" onClick={() => fileInput.current?.click()} disabled={busy}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V5M7.5 9.5L12 5l4.5 4.5M5 19h14" /></svg>Upload</button>
            <input ref={fileInput} type="file" disabled={busy} style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ""; }} />
          </div>
        </div>
        {items.length > 0 && (
          <div className="panel" style={{ overflow: "visible" }}>
            <div className="th" style={{ gridTemplateColumns: "1fr 200px 90px 110px 28px" }}><span>Name</span><span>Shared with</span><span>Size</span><span>Added</span><span></span></div>
            {shown.map((it) => {
              const with_ = grants.filter((g) => g.files.includes(it.name));
              return (
                <div key={it.uid} className="tr file-row" style={{ gridTemplateColumns: "1fr 200px 90px 110px 28px", position: "relative" }}>
                  <button className="file-name" onClick={() => it.segments.some((s) => s.role === "page") ? void open(it) : void download(it)} style={{ display: "flex", alignItems: "center", gap: 12, fontWeight: 600, border: 0, background: "transparent", padding: 0, textAlign: "left", color: "var(--ink)", fontSize: 14, minWidth: 0 }}>
                    <DocIcon image={it.kind === "image"} /><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.name}</span>
                  </button>
                  <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{with_.length ? with_.map((g) => <span key={g.grantId} className="chip chip-a">{g.label}</span>) : <span className="faint" style={{ fontSize: 13 }}>{it.shareable ? "Not shared" : "Only you"}</span>}</span>
                  <span className="m mute" style={{ fontSize: 12 }}>{fmtSize(it.size)}</span>
                  <span className="mute" style={{ fontSize: 13 }}>{added(it.createdAt)}</span>
                  <button className="x" aria-label={`More for ${it.name}`} onClick={() => setMenu(menu === it.uid ? null : it.uid)} style={{ fontSize: 18 }}>…</button>
                  {menu === it.uid && (
                    <div className="panel" style={{ position: "absolute", right: 12, top: 44, zIndex: 5, padding: 6, display: "flex", flexDirection: "column", minWidth: 170 }}>
                      {it.segments.some((s) => s.role === "page") && <button className="btn btn-g" style={{ justifyContent: "flex-start" }} onClick={() => open(it)}>Open</button>}
                      {(it.kind === "text" || it.segments.some((s) => s.role === "text")) && <button className="btn btn-g" style={{ justifyContent: "flex-start" }} onClick={() => { setMenu(null); setRedact(it); }}>Hide details…</button>}
                      <button className="btn btn-g" style={{ justifyContent: "flex-start" }} onClick={() => download(it)}>Download</button>
                    </div>
                  )}
                </div>
              );
            })}
            {up && (
              <div className="tr" style={{ gridTemplateColumns: "1fr 200px 90px 110px 28px", background: "var(--paper)" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 12, fontWeight: 600, color: "var(--mute)" }}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#7A7F95" strokeWidth="1.6" strokeLinejoin="round" strokeDasharray="2.5 2.5"><path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /></svg>{up.name}</span>
                <span className="lbl faint" style={{ fontSize: 10 }}>Adding</span><span className="m faint" style={{ fontSize: 12 }}>{fmtSize(up.size)}</span><span className="faint" style={{ fontSize: 13 }}>Now</span><span />
              </div>
            )}
            {shown.length === 0 && !up && <div className="tr" style={{ gridTemplateColumns: "1fr" }}><span className="faint">{q ? "Nothing matches" : "No files here yet"}</span></div>}
          </div>
        )}
        {man && items.length === 0 && !up && <div className="panel" style={{ padding: "28px 24px", textAlign: "center" }}><div style={{ fontWeight: 700, fontSize: 17 }}>This safe is empty</div><div className="mute" style={{ fontSize: 14, marginTop: 6 }}>Add a file. It is encrypted on this device before anything leaves it.</div></div>}
        <div className={`drop ${drag ? "on" : ""}`} onClick={() => !busy && fileInput.current?.click()} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f && !busy) void onFile(f); }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2546C2" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V5M7.5 9.5L12 5l4.5 4.5M5 19h14" /></svg>Drop files into {folder ?? "this safe"}
        </div>
        {notes.map((n) => <p key={n} className="mute" style={{ margin: 0, fontSize: 13 }}>{n}</p>)}
        {err && <p className="err">{err}</p>}
        {redact && man && <RedactPanel ctx={ctx} box={box} man={man} item={redact} onDone={afterWrite} onClose={() => setRedact(null)} />}
        {preview && (
          <div className="panel" style={{ padding: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><strong>{preview.item.name}</strong><button className="btn btn-s" onClick={() => setPreview(null)}>Close</button></div>
            {preview.urls.map((u, i) => u.kind === "img" ? <img key={i} src={u.src} style={{ maxWidth: "100%", display: "block", margin: "12px 0", border: "1px solid var(--line)" }} /> : <pre key={i} style={{ whiteSpace: "pre-wrap", fontFamily: "'Fragment Mono', monospace", fontSize: 13 }}>{u.src}</pre>)}
          </div>
        )}
      </div>
      {up && (
        <div className="panel tray" style={{ position: "fixed", right: 28, bottom: 28, width: 380, overflow: "hidden", zIndex: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "13px 16px", background: "var(--ink)", color: "#FFFFFF" }}><span style={{ fontWeight: 600, fontSize: 14 }}>Adding 1 file</span><span className="n" style={{ fontSize: 16 }}>{up.pct}%</span></div>
          <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, gap: 10 }}><span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{up.name}</span><span className="lbl" style={{ fontSize: 10, color: "var(--blue)" }}>{({ Prepare: "Preparing", Encrypt: "Encrypting", Store: "Storing", Record: "Recording" } as const)[up.stage]}</span></div>
            <div style={{ height: 6, borderRadius: 3, background: "var(--paper2)", overflow: "hidden" }}><div style={{ width: `${up.pct}%`, height: 6, background: "var(--blue)", transition: "width .3s ease-out" }} /></div>
            <div style={{ display: "flex", gap: 6 }}>{STAGES.map((s) => <span key={s} className={`chip ${STAGES.indexOf(s) <= STAGES.indexOf(up.stage) ? "chip-b" : "chip-m"}`} style={{ fontSize: 9.5 }}>{s}</span>)}</div>
          </div>
        </div>
      )}
    </div>
  );
}
