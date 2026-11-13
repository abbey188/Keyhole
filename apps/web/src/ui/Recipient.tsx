import { useEffect, useRef, useState } from "react";
import { reader } from "../lib/clients";
import { config } from "../lib/config";
import { AccessEnded, closeVisit, decodeLink, openVisit, renew, viewSegment } from "../lib/access";
import type { LinkPayload, Services, Visit } from "../lib/access";

const svc: Services = { releaseUrl: config.releaseUrl, nodeUrls: config.nodeUrls, chainId: config.chainId, contractId: config.contractId };

const fmtLeft = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

/** The recipient's whole flow: landing, opening securely, viewer, ended. No account, no sign-in. */
export function Recipient() {
  const [payload, setPayload] = useState<LinkPayload | null>(null);
  const [err, setErr] = useState("");
  const [state, setState] = useState<"landing" | "opening" | "viewing" | "ended">("landing");
  const [visit, setVisit] = useState<Visit | null>(null);
  useEffect(() => { try { setPayload(decodeLink(location.hash)); } catch (e) { setErr((e as Error).message); } }, []);

  const open = async () => {
    if (!payload) return;
    setState("opening"); setErr("");
    try { setVisit(await openVisit(payload, reader, svc)); setState("viewing"); }
    catch (e) { setErr((e as Error).message); setState(e instanceof AccessEnded ? "ended" : "landing"); }
  };

  if (err && !payload) return <div className="card"><h2 style={{ marginTop: 0 }}>This link can't be used</h2><p className="err">{err}</p></div>;
  if (!payload) return null;
  const files = payload.items.map((i) => i.n);
  const left = payload.exp - Date.now();

  if (state === "ended") return <div className="card"><h2 style={{ marginTop: 0 }}>This access has ended</h2><p className="note">The person who shared this with you ended it, or the time ran out. Ask them for a new link if you still need it.</p></div>;
  if (state === "opening") return <div className="card"><h2 style={{ marginTop: 0 }}>Opening securely…</h2><p className="note">Your visit is being recorded first. Nothing is shown until that is confirmed. This takes a few seconds.</p></div>;
  if (state === "viewing" && visit) return <Viewer visit={visit} onEnded={() => setState("ended")} />;
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>{payload.l ? `${payload.l}, you've been given access` : "You've been given access"}</h2>
      <p>You can view {files.length === 1 ? <strong>{files[0]}</strong> : <><strong>{files.length} files</strong> ({files.join(", ")})</>} for {left > 0 ? `about ${Math.max(1, Math.round(left / 60000))} more minutes` : "a short time"}.</p>
      <ul className="note"><li>It opens in your browser. There is no download button.</li><li>If this is a claim, you can check its signature on the <a href="#verify" target="_blank" rel="noreferrer">Verify page</a>.</li><li>Your visit is recorded where nobody can edit it, including the time.</li><li>A watermark with your name is on every page. A photo of the screen can't be prevented.</li><li>The person who shared it can end your access at any time.</li></ul>
      <button onClick={open}>Open</button>
      {err && <p className="err">{err}</p>}
    </div>
  );
}

function Viewer({ visit, onEnded }: { visit: Visit; onEnded: () => void }) {
  const [now, setNow] = useState(Date.now());
  const [lease, setLease] = useState(visit.leaseExp);
  const [err, setErr] = useState("");
  const [loaded, setLoaded] = useState(0);
  const end = Math.min(visit.payload.exp, lease);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => {
    const t = setInterval(async () => { try { setLease(await renew(visit, svc)); } catch (e) { if (e instanceof AccessEnded) onEnded(); } }, 60_000);
    const bye = () => void closeVisit(visit, svc);
    window.addEventListener("pagehide", bye);
    return () => { clearInterval(t); window.removeEventListener("pagehide", bye); };
  }, []);
  const total = visit.payload.items.reduce((n, i) => n + i.segs.length, 0);
  return (
    <div>
      <div className="row"><strong className="grow">{visit.payload.l ? `Viewing as ${visit.payload.l}` : "Viewing"}</strong>
        <span className="pill ok">recorded · visit #{visit.seq}</span><span className="pill">{fmtLeft(end - now)} left</span>
        <button className="ghost" onClick={() => { void closeVisit(visit, svc).then(onEnded); }}>I'm done</button></div>
      {loaded < total && !err && <p className="note">Loading {loaded + 1} of {total}…</p>}
      {err && <p className="err">{err}</p>}
      {visit.payload.items.map((it) => (
        <div key={it.u}><h2>{it.n}</h2>
          {it.segs.map((seg) => <Page key={seg.s} visit={visit} item={it} seg={seg} onLoaded={() => setLoaded((n) => n + 1)} onError={(e) => { if (e instanceof AccessEnded) onEnded(); else setErr(e.message); }} />)}
        </div>
      ))}
    </div>
  );
}

function Page({ visit, item, seg, onLoaded, onError }: { visit: Visit; item: Visit["payload"]["items"][number]; seg: Visit["payload"]["items"][number]["segs"][number]; onLoaded: () => void; onError: (e: Error) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const bytes = await viewSegment(visit, item, seg, svc);
        if (dead || !ref.current) return;
        await draw(ref.current, bytes, seg.m, `${visit.payload.l || "visitor"} · ${new Date().toLocaleString()} · ${visit.tail}`);
        onLoaded();
      } catch (e) { onError(e as Error); }
    })();
    return () => { dead = true; };
  }, []);
  return <canvas ref={ref} style={{ maxWidth: "100%", display: "block", margin: "10px 0", background: "#fff", borderRadius: 6 }} onContextMenu={(e) => e.preventDefault()} />;
}

/** Draws a page (image or text) and bakes the watermark into the pixels, so it is part of any screenshot. */
async function draw(c: HTMLCanvasElement, bytes: Uint8Array, mime: string, mark: string): Promise<void> {
  let w: number, h: number;
  const g = c.getContext("2d")!;
  if (mime.startsWith("image/")) {
    const bmp = await createImageBitmap(new Blob([bytes.slice()], { type: mime }));
    w = bmp.width; h = bmp.height; c.width = w; c.height = h;
    g.drawImage(bmp, 0, 0);
  } else {
    const text = new TextDecoder().decode(bytes);
    w = 900; c.width = w; g.font = "20px system-ui";
    const lines: string[] = [];
    for (const para of text.split("\n")) { let line = ""; for (const word of para.split(" ")) { if (g.measureText(line + word).width > w - 60) { lines.push(line); line = ""; } line += word + " "; } lines.push(line); }
    h = Math.max(300, 60 + lines.length * 28); c.height = h;
    g.fillStyle = "#fff"; g.fillRect(0, 0, w, h); g.fillStyle = "#111"; g.font = "20px system-ui";
    lines.forEach((l, i) => g.fillText(l, 30, 50 + i * 28));
  }
  g.save();
  g.globalAlpha = 0.16; g.fillStyle = "#b00020"; g.font = `${Math.max(16, Math.round(w / 38))}px system-ui`; g.rotate(-Math.PI / 7);
  for (let y = -h; y < h * 2; y += Math.max(70, h / 7)) for (let x = -w; x < w * 2; x += Math.max(340, w / 2.2)) g.fillText(mark, x, y);
  g.restore();
  g.globalAlpha = 1; g.fillStyle = "rgba(0,0,0,.6)"; g.fillRect(0, h - 26, w, 26); g.fillStyle = "#fff"; g.font = "14px system-ui"; g.fillText(mark, 10, h - 8);
}
