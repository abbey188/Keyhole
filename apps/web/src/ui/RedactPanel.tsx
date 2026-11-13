import { useEffect, useMemo, useState } from "react";
import type { BoxView } from "@keyhole/chain";
import { addItem, readSegment } from "../lib/upload";
import type { Ctx } from "../lib/upload";
import type { ItemRecord, Manifest } from "../lib/vault";
import { planItem } from "../lib/files";
import { browserRenderers } from "../lib/render";
import { applyRedactions, findCustom, findSensitive, selfTest } from "../lib/redact";
import type { Span } from "../lib/redact";

const SEP = "\n\n";

/** Hide sensitive values in a file's text and save a redacted copy that can be shared instead. Runs on this device. */
export function RedactPanel({ ctx, box, man, item, onDone, onClose }: { ctx: Ctx; box: BoxView; man: Manifest; item: ItemRecord; onDone: (txs: Awaited<ReturnType<typeof addItem>>["txs"]) => Promise<void>; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [off, setOff] = useState<Record<number, boolean>>({});
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      const segs = item.kind === "text" ? item.segments.filter((s) => s.role === "page") : item.segments.filter((s) => s.role === "text");
      const pages: string[] = [];
      for (const s of segs) pages.push(new TextDecoder().decode(await readSegment(ctx, item, s.s)));
      setText(pages.join(SEP));
    })().catch((e) => setErr(`Could not read the text: ${(e as Error).message}`));
  }, [item.uid]);

  const spans = useMemo<Span[]>(() => {
    if (text === null) return [];
    const base = findSensitive(text);
    const extra = custom.trim() ? findCustom(text, custom) : [];
    const all = [...base, ...extra].sort((a, b) => a.start - b.start || b.end - a.end);
    const out: Span[] = [];
    for (const s of all) if (!out.length || s.start >= out[out.length - 1]!.end) out.push(s);
    return out;
  }, [text, custom]);
  const chosen = spans.filter((_, i) => !off[i]);
  const redacted = text === null ? "" : applyRedactions(text, chosen);
  const test = text === null ? null : selfTest(text, redacted, chosen);

  const save = async () => {
    if (!test?.ok || text === null) return;
    setErr(""); setBusy("Saving the redacted copy…");
    try {
      const bytes = new TextEncoder().encode(redacted);
      const name = `${item.name.replace(/\.[^.]+$/, "")} (redacted).txt`;
      const plan = await planItem({ name, mime: "text/plain", bytes }, browserRenderers);
      const res = await addItem({ ...ctx, progress: setBusy }, man, box, { name, mime: "text/plain", kind: plan.kind, size: bytes.length, parts: plan.parts });
      await onDone(res.txs); onClose();
    } catch (e) { setErr(`Could not save it: ${(e as Error).message}`); }
    setBusy("");
  };

  return (
    <div className="card">
      <div className="row"><strong className="grow">Hide details in {item.name}</strong><button className="ghost" onClick={onClose}>Close</button></div>
      {text === null && !err && <p className="note">Reading the text…</p>}
      {text !== null && (
        <>
          <p className="note">Tick what to hide. The copy is plain text with the hidden parts blocked out; the original stays in your safe. Pages that are only pictures can't be redacted in this version (no text recognition).</p>
          {spans.length === 0 && <p className="note">Nothing that looks sensitive was found. You can still type a value to hide.</p>}
          {spans.map((s, i) => <label key={i} className="row" style={{ margin: "4px 0" }}><input type="checkbox" style={{ width: "auto" }} checked={!off[i]} onChange={(e) => setOff({ ...off, [i]: !e.target.checked })} /> <span className="pill">{s.kind.replace("_", " ")}</span> <span className="mono">{s.value.length > 40 ? `${s.value.slice(0, 40)}…` : s.value}</span></label>)}
          <input style={{ marginTop: 8 }} placeholder="Also hide this text (a name, an address line)" value={custom} onChange={(e) => setCustom(e.target.value)} />
          <details style={{ marginTop: 8 }}><summary className="note">Preview of the copy</summary><pre style={{ whiteSpace: "pre-wrap" }}>{redacted}</pre></details>
          <p style={{ marginTop: 8 }}><span className={`pill ${test?.ok ? "ok" : "bad"}`}>{test?.ok ? "Self-test passed" : "Self-test failed"}</span> <span className="note">{test?.ok ? `${chosen.length} part${chosen.length === 1 ? "" : "s"} hidden; no hidden value is readable in the copy and nothing else changed.` : test?.failures.join(" ")}</span></p>
          <div className="row"><button disabled={!test?.ok || !!busy || chosen.length === 0} onClick={save}>Save redacted copy</button>{busy && <span className="note">{busy}</span>}</div>
        </>
      )}
      {err && <p className="err">{err}</p>}
    </div>
  );
}
