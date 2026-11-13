import { useEffect, useMemo, useState } from "react";
import { HttpNodeApi } from "@keyhole/store";
import type { BoxView } from "@keyhole/chain";
import type { Identity } from "../lib/keys";
import { reader, writerFor } from "../lib/clients";
import { config, txLink } from "../lib/config";
import { unwrapBmk } from "../lib/safe";
import { addItem, loadManifest, readOriginal, readSegment } from "../lib/upload";
import type { Ctx, Receipt } from "../lib/upload";
import { planItem, FileRefused } from "../lib/files";
import { browserRenderers } from "../lib/render";
import type { ItemRecord, Manifest } from "../lib/vault";
import { AccessTab } from "./AccessTab";
import { VisitorsTab } from "./VisitorsTab";
import { HandoverTab } from "./HandoverTab";

export type Tab = "files" | "access" | "visitors" | "handover";

export function SafePage({ id, boxId, serial, onBack }: { id: Identity; boxId: string; serial: number; onBack: () => void }) {
  const [box, setBox] = useState<BoxView | null>(null);
  const [man, setMan] = useState<Manifest | null>(null);
  const [tab, setTab] = useState<Tab>("files");
  const [err, setErr] = useState("");
  const [txs, setTxs] = useState<Receipt[]>([]);
  const ctx: Ctx | null = useMemo(() => {
    if (!box) return null;
    return {
      id, reader, writer: writerFor(id), boxId, bmk: unwrapBmk(id, box), epoch: box.key_epoch,
      nodes: config.nodeUrls.map((u, i) => new HttpNodeApi(`node${i}`, u)),
    };
  }, [box?.box_id, box?.key_epoch, box?.wrapped_bmk]);

  const refresh = async () => {
    const b = await reader.box(boxId);
    if (!b) throw new Error("This safe was not found on chain.");
    setBox(b);
  };
  useEffect(() => { refresh().catch((e) => setErr((e as Error).message)); }, [boxId]);
  useEffect(() => { if (ctx && box) loadManifest(ctx, box).then(setMan).catch((e) => setErr(`Could not open the file list: ${(e as Error).message}`)); }, [ctx, box?.manifest_seq]);

  return (
    <div>
      <div className="row"><button className="ghost" onClick={onBack}>← Safes</button><h2 className="grow" style={{ margin: 0 }}>Safe #{serial}</h2></div>
      <p className="mono">{boxId}</p>
      <div className="tabs">
        {(["files", "access", "visitors", "handover"] as Tab[]).map((t) => (
          <button key={t} className={`tab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>{{ files: "Files", access: "Access", visitors: "Visitors", handover: "Hand over" }[t]}</button>
        ))}
      </div>
      {err && <p className="err">{err}</p>}
      {tab === "files" && ctx && box && <Files ctx={ctx} box={box} man={man} afterAdd={async (t) => { setTxs(t); await refresh(); }} />}
      {tab === "access" && ctx && <AccessTab ctx={ctx} man={man} onChanged={() => void refresh()} />}
      {tab === "visitors" && ctx && <VisitorsTab ctx={ctx} refreshKey={box?.receipts_seq ?? 0} />}
      {tab === "handover" && ctx && box && <HandoverTab ctx={ctx} box={box} onChanged={() => void refresh()} />}
      {false && <p className="note">[NOT FINISHED] This tab is built next.</p>}
      {txs.length > 0 && (
        <details className="card"><summary>Recorded on chain ({txs.length} transactions)</summary>
          <table><tbody>{txs.map((t) => <tr key={t.txHash}><td>{t.step}</td><td><a href={txLink(t.txHash)} target="_blank" rel="noreferrer">{t.txHash.slice(0, 10)}…</a></td></tr>)}</tbody></table>
        </details>
      )}
    </div>
  );
}

function Files({ ctx, box, man, afterAdd }: { ctx: Ctx; box: BoxView; man: Manifest | null; afterAdd: (t: Receipt[]) => Promise<void> }) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [notes, setNotes] = useState<string[]>([]);
  const [preview, setPreview] = useState<{ item: ItemRecord; urls: { kind: string; src: string }[] } | null>(null);

  const onFile = async (f: File) => {
    setErr(""); setNotes([]);
    try {
      setBusy("Preparing…");
      const bytes = new Uint8Array(await f.arrayBuffer());
      const plan = await planItem({ name: f.name, mime: f.type, bytes }, browserRenderers);
      setNotes(plan.notes);
      const res = await addItem({ ...ctx, progress: setBusy }, man ?? { version: 1, boxId: ctx.boxId, epoch: ctx.epoch, seq: 0, items: [] }, box, { name: f.name, mime: f.type || "application/octet-stream", kind: plan.kind, size: bytes.length, parts: plan.parts });
      await afterAdd(res.txs);
      setBusy("");
    } catch (e) { setErr(e instanceof FileRefused ? e.message : `Could not add the file: ${(e as Error).message}`); setBusy(""); }
  };

  const open = async (item: ItemRecord) => {
    setErr("");
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
    try {
      const bytes = await readOriginal(ctx, item);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([bytes.slice()], { type: item.mime }));
      a.download = item.name; a.click();
    } catch (e) { setErr(`Could not download it: ${(e as Error).message}`); }
  };

  return (
    <div>
      {man?.items.map((it) => (
        <div className="card" key={it.uid}>
          <div className="row"><strong className="grow">{it.name}</strong><span className="pill">{it.kind}</span>
            <span className={`pill ${it.shareable ? "ok" : "warn"}`}>{it.shareable ? "can be shared" : "only you"}</span></div>
          <p className="note">{(it.size / 1024).toFixed(1)} KB · {it.segments.filter((s) => s.role === "page").length || it.segments.length} parts, encrypted</p>
          <div className="row">{it.segments.some((s) => s.role === "page") && <button className="ghost" onClick={() => open(it)}>Open</button>}<button className="ghost" onClick={() => download(it)}>Download</button></div>
        </div>
      ))}
      {man && man.items.length === 0 && <p className="note">This safe is empty. Add a file: it is encrypted on this device before anything leaves it.</p>}
      <div className="card">
        <input type="file" disabled={!!busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ""; }} />
        <p className="note">Any file type. Up to 25 MB in this demo. PDFs and images can be shared; other files stay with you.</p>
        {busy && <p className="note">{busy}</p>}
        {notes.map((n) => <p className="note" key={n}>{n}</p>)}
      </div>
      {err && <p className="err">{err}</p>}
      {preview && (
        <div className="card"><div className="row"><strong className="grow">{preview.item.name}</strong><button className="ghost" onClick={() => setPreview(null)}>Close</button></div>
          {preview.urls.map((u, i) => u.kind === "img" ? <img key={i} src={u.src} style={{ maxWidth: "100%", display: "block", margin: "8px 0" }} /> : <pre key={i} style={{ whiteSpace: "pre-wrap" }}>{u.src}</pre>)}
        </div>
      )}
    </div>
  );
}
