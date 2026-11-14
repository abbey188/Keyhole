import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { reader } from "../lib/clients";
import { config } from "../lib/config";
import { AccessEnded, askPages, closeVisit, decodeLink, logAnswer, openVisit, renew, reserveQuestion, viewSegment, REFUSAL } from "../lib/access";
import { askSafe } from "@keyhole/askclaims";
import type { AskResult } from "@keyhole/askclaims";
import { aiClient, visitCredential, FALLBACK_MODEL } from "../lib/ai";
import { buildAnswerPackage } from "../lib/verifyAnswer";
import type { LinkPayload, Services, Visit } from "../lib/access";
import { Logo, SafeIcon, fmtClock } from "./kit";

const svc: Services = { releaseUrl: config.releaseUrl, nodeUrls: config.nodeUrls, chainId: config.chainId, contractId: config.contractId };

type Item = Visit["payload"]["items"][number];
type Seg = Item["segs"][number];
type EndReason = "ended" | "expired" | "done";

const useNow = () => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  return now;
};

const FileIcon = ({ on }: { on?: boolean }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill={on ? "#FFFFFF" : "none"} stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" style={{ flex: "none" }}><path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /></svg>
);

/** The top bar of every recipient screen: blue while the access is live, navy once it has ended. */
function Bar({ tone, label, clock, children }: { tone: "blue" | "navy"; label?: string; clock: ReactNode; children?: ReactNode }) {
  const soft = tone === "blue" ? "#DDE4FA" : "#C3C9E0";
  return (
    <header style={{ height: 66, flex: "none", background: tone === "blue" ? "var(--blue)" : "var(--ink)", color: "#FFFFFF", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 36px", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, minWidth: 0 }}>
        <Logo />
        <span style={{ fontWeight: 700, fontSize: 16, whiteSpace: "nowrap" }}>Shared with you</span>
        {label && <span style={{ fontSize: 14, color: soft, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 16, flex: "none" }}>{clock}{children}</div>
    </header>
  );
}

const LiveClock = ({ ms }: { ms: number }) => (
  <>
    <span className="lbl" style={{ color: "#DDE4FA", fontSize: 10.5 }}>Closes in</span>
    <span className="n" style={{ background: "var(--amber)", color: "var(--ink)", borderRadius: 8, padding: "6px 12px", fontSize: 20 }}>{fmtClock(ms)}</span>
  </>
);
const DeadClock = () => <span className="n" style={{ border: "1px solid #5B6596", color: "#C3C9E0", borderRadius: 8, padding: "6px 12px", fontSize: 20 }}>00:00:00</span>;

const Screen = ({ children }: { children: ReactNode }) => (
  <div className="app"><div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: "100vh" }}>{children}</div></div>
);
const Centre = ({ width = 520, children }: { width?: number; children: ReactNode }) => (
  <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "48px 16px" }}>
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 26, textAlign: "center", width: "100%", maxWidth: width }}>{children}</div>
  </div>
);

const LockedSafe = () => (
  <svg width="132" height="164" viewBox="0 0 132 164" role="img" aria-label="A locked safe door"><rect x="0.75" y="0.75" width="130.5" height="162.5" rx="22" fill="#FFFFFF" stroke="#0E1435" strokeWidth="1.5" /><circle cx="66" cy="70" r="40" fill="none" stroke="#0E1435" strokeWidth="1.5" /><circle cx="66" cy="70" r="33" fill="none" stroke="#0E1435" strokeWidth="3.2" strokeDasharray="0.9 4.2" /><circle cx="66" cy="70" r="24" fill="#0E1435" /><circle cx="66" cy="64" r="6.6" fill="#FFFFFF" /><path d="M63.2 69L59.8 83Q59.4 85 61.4 85H70.6Q72.6 85 72.2 83L68.8 69Z" fill="#FFFFFF" /><rect x="38" y="128" width="56" height="16" rx="4" fill="#E2603A" /><text x="66" y="139.5" textAnchor="middle" fontFamily="Fragment Mono, monospace" fontSize="9.5" letterSpacing="1.4" fill="#FFFFFF">LOCKED</text></svg>
);

const rowStyle = (last: boolean): CSSProperties => ({ display: "flex", justifyContent: "space-between", gap: 16, padding: "12px 16px", borderBottom: last ? "none" : "1px solid var(--line)", fontSize: 14 });

/** The recipient's whole flow: landing, opening securely, viewer, ended. No account, no sign-in. */
export function Recipient() {
  const [payload, setPayload] = useState<LinkPayload | null>(null);
  const [err, setErr] = useState("");
  const [state, setState] = useState<"landing" | "opening" | "viewing" | "ended">("landing");
  const [why, setWhy] = useState<EndReason>("ended");
  const [visit, setVisit] = useState<Visit | null>(null);
  const [asked, setAsked] = useState<number | null>(null);
  const now = useNow();
  useEffect(() => { try { setPayload(decodeLink(location.hash)); } catch (e) { const m = (e as Error).message; setErr(m.startsWith("This ") ? m : "This link is damaged."); } }, []);

  const open = async () => {
    if (!payload) return;
    setState("opening"); setErr("");
    try { setVisit(await openVisit(payload, reader, svc)); setState("viewing"); }
    catch (e) { setErr((e as Error).message); if (e instanceof AccessEnded) { setWhy(Date.now() >= payload.exp ? "expired" : "ended"); setState("ended"); } else setState("landing"); }
  };
  const ended = (r: EndReason) => { setWhy(r); setState("ended"); };

  if (err && !payload) return (
    <Screen>
      <Bar tone="navy" clock={<DeadClock />} />
      <Centre>
        <LockedSafe />
        <div><h1 className="h1" style={{ fontSize: 36, lineHeight: "40px" }}>This link can't be used</h1><p className="err" style={{ margin: "12px 0 0", fontSize: 17, lineHeight: "26px" }}>{err}</p></div>
        <a className="btn btn-g" href="/" style={{ fontSize: 14, textDecoration: "underline", textUnderlineOffset: 4 }}>What is Keyhole?</a>
      </Centre>
    </Screen>
  );
  if (!payload) return null;
  const label = payload.l ? `For ${payload.l}` : undefined;
  const files = payload.items;

  if (state === "ended") {
    const sentence = why === "done" ? "You closed this visit. Opening the link again starts a new visit, recorded like this one, while the access lasts."
      : why === "expired" ? "The time on this link ran out. Nothing from this safe can be opened with this link."
      : "The owner ended it, or the time ran out. Nothing from this safe can be opened with this link.";
    return (
      <Screen>
        <Bar tone="navy" label={label} clock={<DeadClock />} />
        <Centre>
          <LockedSafe />
          <div><h1 className="h1" style={{ fontSize: 36, lineHeight: "40px" }}>This access has ended</h1><p className="mute" style={{ margin: "12px 0 0", fontSize: 17, lineHeight: "26px" }}>{sentence}</p></div>
          {asked !== null && (
            <div className="panel" style={{ width: "100%", borderRadius: 12, textAlign: "left" }}>
              <div style={rowStyle(true)}><span className="mute">Questions asked</span><span>{asked}</span></div>
            </div>
          )}
          <a className="btn btn-g" href="/" style={{ fontSize: 14, textDecoration: "underline", textUnderlineOffset: 4 }}>What is Keyhole?</a>
        </Centre>
      </Screen>
    );
  }

  if (state === "opening") return (
    <Screen>
      <Bar tone="blue" label={label} clock={<LiveClock ms={payload.exp - now} />} />
      <Centre>
        <SafeIcon size={96} label="Safe" />
        <div><h1 className="h1" style={{ fontSize: 36, lineHeight: "40px" }}>Opening securely…</h1><p className="mute" style={{ margin: "12px 0 0", fontSize: 17, lineHeight: "26px" }}>Your visit is being recorded first. Nothing is shown until that is confirmed.</p></div>
      </Centre>
    </Screen>
  );

  if (state === "viewing" && visit) return <Viewer visit={visit} label={label} onEnded={ended} onAsked={setAsked} />;

  const mins = Math.max(1, Math.round((payload.exp - now) / 60000));
  const facts: ReactNode[] = [
    "It opens in your browser. There is no download button.",
    "Your visit is recorded where nobody can edit it, including the time.",
    "A watermark with your name is on every page. A photo of the screen can't be prevented.",
    ...(payload.q ? [`You can ask up to ${payload.q.budget} question${payload.q.budget === 1 ? "" : "s"}. The owner can see every question you ask.`] : []),
    <>If this is a claim, you can check its signature on the <a href="/verify" target="_blank" rel="noreferrer" style={{ textDecoration: "underline", textUnderlineOffset: 3 }}>Verify page</a>.</>,
    "The person who shared it can end your access at any time.",
  ];
  return (
    <Screen>
      <Bar tone="blue" label={label} clock={<LiveClock ms={payload.exp - now} />} />
      <Centre width={560}>
        <SafeIcon size={96} label="Safe" />
        <div>
          <h1 className="h1" style={{ fontSize: 36, lineHeight: "40px" }}>{payload.l ? `${payload.l}, you've been given access` : "You've been given access"}</h1>
          <p className="mute" style={{ margin: "12px 0 0", fontSize: 17, lineHeight: "26px" }}>You can view {files.length === 1 ? "this file" : `these ${files.length} files`} for {payload.exp > now ? `about ${mins} more minute${mins === 1 ? "" : "s"}` : "a short time"}.</p>
        </div>
        <div className="panel" style={{ width: "100%", borderRadius: 12, textAlign: "left" }}>
          <div className="fl" style={{ padding: "12px 16px 0", margin: 0 }}>Shared files</div>
          {files.map((f, i) => (
            <div key={f.u} style={{ ...rowStyle(i === files.length - 1), alignItems: "center" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}><FileIcon /><strong style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.n}</strong></span>
              <span className="m faint" style={{ fontSize: 12, flex: "none" }}>{f.segs.length} page{f.segs.length === 1 ? "" : "s"}</span>
            </div>
          ))}
        </div>
        <div className="well" style={{ width: "100%", textAlign: "left", padding: "4px 16px" }}>
          {facts.map((t, i) => <div key={i} style={{ padding: "9px 0", borderBottom: i === facts.length - 1 ? "none" : "1px solid var(--line)", fontSize: 14, lineHeight: "20px" }} className="mute">{t}</div>)}
        </div>
        <button className="btn btn-p btn-lg" style={{ minWidth: 180, justifyContent: "center" }} onClick={open}>Open</button>
        {err && <p className="err">{err}</p>}
      </Centre>
    </Screen>
  );
}

function Viewer({ visit, label, onEnded, onAsked }: { visit: Visit; label?: string; onEnded: (r: EndReason) => void; onAsked: (n: number) => void }) {
  const now = useNow();
  const [, setLease] = useState(visit.leaseExp);
  const [err, setErr] = useState("");
  const [loaded, setLoaded] = useState(0);
  const [cur, setCur] = useState(0);
  const [signed, setSigned] = useState<Record<string, string>>({});
  useEffect(() => {
    const t = setInterval(async () => { try { setLease(await renew(visit, svc)); } catch (e) { if (e instanceof AccessEnded) onEnded("ended"); } }, 60_000);
    const bye = () => void closeVisit(visit, svc);
    window.addEventListener("pagehide", bye);
    return () => { clearInterval(t); window.removeEventListener("pagehide", bye); };
  }, []);
  const left = visit.payload.exp - now;
  useEffect(() => { if (left <= 0) void closeVisit(visit, svc).then(() => onEnded("expired")); }, [left <= 0]);

  const items = visit.payload.items;
  const pages = items.flatMap((it, fi) => it.segs.map((seg, pi) => ({ it, seg, fi, pi, key: `${it.u}:${seg.s}` })));
  const total = pages.length;
  const page = pages[cur];
  const go = (i: number) => setCur(Math.max(0, Math.min(total - 1, i)));
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.target as HTMLElement)?.tagName === "INPUT") return; if (e.key === "ArrowLeft") setCur((c) => Math.max(0, c - 1)); if (e.key === "ArrowRight") setCur((c) => Math.min(total - 1, c + 1)); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [total]);
  const fail = (e: Error) => { if (e instanceof AccessEnded) onEnded("ended"); else setErr(e.message); };
  const claim = page ? signed[page.key] : undefined;
  const ask = !!visit.payload.q;

  return (
    <div className="app">
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", height: "100vh" }}>
        <Bar tone="blue" label={label} clock={<LiveClock ms={left} />}>
          <button className="btn" style={{ border: "1px solid #FFFFFF", color: "#FFFFFF", background: "transparent", padding: "7px 14px" }} onClick={() => { void closeVisit(visit, svc).then(() => onEnded("done")); }}>I'm done</button>
        </Bar>
        <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: ask ? "clamp(180px, 17vw, 240px) minmax(0,1fr) clamp(300px, 28vw, 400px)" : "clamp(180px, 17vw, 240px) minmax(0,1fr)" }}>
          <aside style={{ borderRight: "1px solid var(--line)", padding: "22px 18px", display: "flex", flexDirection: "column", gap: 6, minHeight: 0, overflowY: "auto" }}>
            <div className="fl">Shared files</div>
            {items.map((it, fi) => {
              const on = page?.fi === fi;
              return (
                <button key={it.u} title={it.n} onClick={() => go(pages.findIndex((p) => p.fi === fi))}
                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 10px", borderRadius: 8, border: 0, textAlign: "left", width: "100%", fontSize: 14, background: on ? "var(--sky2)" : "transparent", color: on ? "var(--blue-d)" : "var(--ink)", fontWeight: on ? 600 : 400 }}>
                  <FileIcon on={on} /><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.n}</span>
                </button>
              );
            })}
            <div style={{ marginTop: "auto", paddingTop: 16, fontSize: 13, lineHeight: "20px" }} className="mute">View only. Your visit #{visit.seq} is recorded.</div>
          </aside>
          <section style={{ padding: "22px 28px", display: "flex", flexDirection: "column", gap: 12, minWidth: 0, minHeight: 0, background: "var(--paper2)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{page?.it.n}</h2>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flex: "none" }}>
                {loaded < total && !err && <span className="m faint" style={{ fontSize: 12 }}>Loading {loaded + 1} of {total}…</span>}
                <button className="btn btn-s" aria-label="Previous page" style={{ padding: "6px 12px", fontSize: 13 }} disabled={cur === 0} onClick={() => go(cur - 1)}>←</button>
                <span className="m" style={{ fontSize: 12, minWidth: 40, textAlign: "center" }}>{page ? `${page.pi + 1} / ${page.it.segs.length}` : ""}</span>
                <button className="btn btn-s" aria-label="Next page" style={{ padding: "6px 12px", fontSize: 13 }} disabled={cur >= total - 1} onClick={() => go(cur + 1)}>→</button>
              </div>
            </div>
            {err && <p className="err" style={{ margin: 0 }}>{err}</p>}
            <div style={{ flex: 1, minHeight: 0, background: "#FFFFFF", border: "1px solid var(--line2)", borderRadius: 6, overflow: "auto" }}>
              {pages.map((p, i) => <Page key={p.key} visit={visit} item={p.it} seg={p.seg} shown={i === cur} onLoaded={() => setLoaded((n) => n + 1)} onSigned={(t) => setSigned((s) => ({ ...s, [p.key]: t }))} onError={fail} />)}
            </div>
            {claim && (
              <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 14 }}>
                <CopyButton text={claim} label="Copy the signed claim" />
                <a href="/verify" target="_blank" rel="noreferrer" style={{ textDecoration: "underline", textUnderlineOffset: 3 }}>Verify page</a>
              </div>
            )}
          </section>
          {ask && <AskPanel visit={visit} onAsked={onAsked} />}
        </div>
      </div>
    </div>
  );
}

function CopyButton({ text, label, small }: { text: string; label: string; small?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <button className="btn btn-s" style={small ? { padding: "5px 10px", fontSize: 12 } : { padding: "7px 14px", fontSize: 13 }}
      onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 2000); }); }}>{done ? "Copied" : label}</button>
  );
}

interface Turn { q: string; kind: "answer" | "refusal" | "error"; text: string; note?: string; cites?: string[]; pkg?: string }

/** Questions the owner allowed. Each one is counted first, logged sealed to the owner, and answered only from the shared files. */
function AskPanel({ visit, onAsked }: { visit: Visit; onAsked: (n: number) => void }) {
  const budget = visit.payload.q?.budget ?? 0;
  const [q, setQ] = useState("");
  const [left, setLeft] = useState(budget);
  const [busy, setBusy] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState("");
  const [pages, setPages] = useState<Awaited<ReturnType<typeof askPages>> | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [turns.length, busy]);
  const name = (id: string, fallback: string) => visit.payload.items.find((i) => i.u === id)?.n ?? fallback;
  const go = async () => {
    const question = q.trim();
    if (!question || busy || left < 1) return;
    setPending(question); setQ(""); setBusy("Reserving your question…");
    let turn: Turn;
    try {
      const p = pages ?? await askPages(visit, svc); setPages(p);
      const r = await reserveQuestion(visit, svc, question); setLeft(r.left); onAsked(Math.max(0, budget - r.left));
      setBusy("Checking the private hardware, then asking…");
      let res: AskResult = await askSafe(question, p, { client: aiClient(visitCredential(visit)) as never });
      if (res.status === "no_answer" && res.reason === "model_error") res = await askSafe(question, p, { client: aiClient(visitCredential(visit)) as never, model: FALLBACK_MODEL });
      const text = res.status === "answer" ? res.answer : res.status === "no_answer" && res.tier === "device" ? REFUSAL : res.message;
      await logAnswer(visit, svc, r.n, { answer: text, status: res.status, ...(res.status === "answer" ? { citations: res.citations, evidence: res.evidence } : {}) });
      turn = res.status === "answer"
        ? { q: question, kind: "answer", text, note: `Private model ${res.evidence.model_id}. Quoted from the shared files.`, cites: [...new Set(res.citations.map((c) => `${name(c.itemId, c.itemName)}, page ${c.page}`))], pkg: JSON.stringify(buildAnswerPackage(visit, question, res)) }
        : { q: question, kind: text === REFUSAL ? "refusal" : "error", text };
    } catch (e) { const m = (e as Error).message; turn = { q: question, kind: m === REFUSAL ? "refusal" : "error", text: m }; }
    setTurns((t) => [...t, turn]); setPending(""); setBusy("");
  };
  const mine: CSSProperties = { alignSelf: "flex-end", background: "var(--ink)", color: "#FFFFFF", borderRadius: "12px 12px 3px 12px", padding: "9px 13px", fontSize: 14, lineHeight: "20px", maxWidth: "85%", overflowWrap: "anywhere" };
  return (
    <aside style={{ borderLeft: "1px solid var(--line)", display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 20px", borderBottom: "1px solid var(--line)" }}>
        <span className="h2" style={{ fontSize: 17 }}>Ask</span><span className="lbl faint" style={{ fontSize: 10 }}>{left} of {budget} left</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "18px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
        {turns.map((t, i) => (
          <div key={i} style={{ display: "contents" }}>
            <div style={mine}>{t.q}</div>
            {t.kind === "answer" ? (
              <div className="ans" style={{ background: "var(--sky2)", borderRadius: "12px 12px 12px 3px", padding: "12px 14px", fontSize: 14, lineHeight: "21px", maxWidth: "90%", overflowWrap: "anywhere" }}>
                <div data-answer="" style={{ fontWeight: 600 }}>{t.text}</div>
                {!!t.cites?.length && <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>{t.cites.map((c) => <span key={c} className="chip chip-s" style={{ background: "#FFFFFF", borderColor: "#FFFFFF", whiteSpace: "normal" }}>{c}</span>)}</div>}
                {t.note && <div className="mute" style={{ marginTop: 8, fontSize: 12, lineHeight: "17px" }}>{t.note}</div>}
                {t.pkg && <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 12 }}><CopyButton small text={t.pkg} label="Copy the answer package" /><a href="/verify" target="_blank" rel="noreferrer" style={{ textDecoration: "underline", textUnderlineOffset: 3 }}>Verify</a></div>}
              </div>
            ) : t.kind === "refusal" ? (
              <div className="mute" style={{ border: "1px dashed var(--faint)", borderRadius: "12px 12px 12px 3px", padding: "11px 14px", fontSize: 14, maxWidth: "90%" }}>{t.text}</div>
            ) : (
              <div className="err" style={{ border: "1px solid var(--red)", borderRadius: "12px 12px 12px 3px", padding: "11px 14px", maxWidth: "90%", margin: 0, overflowWrap: "anywhere" }}>{t.text}</div>
            )}
          </div>
        ))}
        {pending && <div style={mine}>{pending}</div>}
        {busy && <div className="mute" style={{ fontSize: 13 }}>{busy}</div>}
        <div ref={end} />
      </div>
      <form style={{ borderTop: "1px solid var(--line)", padding: 12, display: "flex", gap: 10 }} onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <input className="input" style={{ flex: 1, minWidth: 0, fontSize: 14, padding: "10px 12px" }} placeholder="Ask about the shared files" value={q} disabled={left < 1} onChange={(e) => setQ(e.target.value)} />
        <button type="submit" className="btn btn-p" disabled={!!busy || !q.trim() || left < 1}>Ask</button>
      </form>
    </aside>
  );
}

function Page({ visit, item, seg, shown, onLoaded, onSigned, onError }: { visit: Visit; item: Item; seg: Seg; shown: boolean; onLoaded: () => void; onSigned: (t: string) => void; onError: (e: Error) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const bytes = await viewSegment(visit, item, seg, svc);
        if (dead || !ref.current) return;
        if (seg.m.startsWith("text/")) { const t = new TextDecoder().decode(bytes); if (/"claim"\s*:/.test(t) && /"signature"\s*:/.test(t)) onSigned(t); }
        await draw(ref.current, bytes, seg.m, `${visit.payload.l || "visitor"} · ${new Date().toLocaleString()} · ${visit.tail}`);
        setReady(true);
        onLoaded();
      } catch (e) { onError(e as Error); }
    })();
    return () => { dead = true; };
  }, []);
  return (
    <div style={{ display: shown ? "block" : "none" }}>
      {!ready && <div style={{ padding: "46px 54px" }} className="faint">Opening this page…</div>}
      <canvas ref={ref} style={{ width: "100%", height: "auto", display: ready ? "block" : "none", background: "#fff", userSelect: "none" }} onContextMenu={(e) => e.preventDefault()} />
    </div>
  );
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
