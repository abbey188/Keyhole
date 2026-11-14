import { Check } from "./kit";
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
    <div className="panel" style={{ padding: 22, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><div><div className="lbl" style={{ color: "var(--blue)" }}>[ Hide details ]</div><div className="h2" style={{ marginTop: 6 }}>{item.name}</div></div><button className="btn btn-s" onClick={onClose}>Close</button></div>
      {text === null && !err && <p className="mute" style={{ margin: 0 }}>Reading the text…</p>}
      {text !== null && (
        <>
          <p className="mute" style={{ margin: 0, fontSize: 14 }}>Tick what to hide. The copy is plain text with the hidden parts blocked out. The original stays in your safe.</p>
          {spans.length === 0 && <p className="mute" style={{ margin: 0, fontSize: 14 }}>Nothing that looks sensitive was found. You can still type a value to hide.</p>}
          {spans.length > 0 && <div className="panel" style={{ overflow: "hidden" }}>
            {spans.map((s, i) => <div key={i} className="tr redact-span" style={{ gridTemplateColumns: "1fr", padding: "10px 14px" }}><Check on={!off[i]} onChange={(v) => setOff({ ...off, [i]: !v })} label={`Hide ${s.value}`}><span className="chip chip-m">{s.kind.replace("_", " ")}</span> <span className="m" style={{ fontSize: 13 }}>{s.value.length > 40 ? `${s.value.slice(0, 40)}…` : s.value}</span></Check></div>)}
          </div>}
          <input className="input" placeholder="Also hide this text (a name, an address line)" value={custom} onChange={(e) => setCustom(e.target.value)} />
          <details><summary className="lbl faint" style={{ cursor: "pointer" }}>Preview of the copy</summary><pre className="well" style={{ whiteSpace: "pre-wrap", padding: 14, fontFamily: "'Fragment Mono', monospace", fontSize: 13 }}>{redacted}</pre></details>
          <p style={{ margin: 0, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}><span className={`chip ${test?.ok ? "chip-b" : "chip-r"}`}>{test?.ok ? "Self-test passed" : "Self-test failed"}</span> <span className="mute" style={{ fontSize: 14 }}>{test?.ok ? `${chosen.length} part${chosen.length === 1 ? "" : "s"} hidden; no hidden value is readable in the copy and nothing else changed.` : test?.failures.join(" ")}</span></p>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}><button className="btn btn-p" disabled={!test?.ok || !!busy || chosen.length === 0} onClick={save}>Save redacted copy</button>{busy && <span className="mute" style={{ fontSize: 13 }}>{busy}</span>}</div>
        </>
      )}
      {err && <p className="err">{err}</p>}
    </div>
  );
}
