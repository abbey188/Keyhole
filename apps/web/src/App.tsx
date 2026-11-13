import { useEffect, useState } from "react";
import { identityFromPassphrase, newSalt, passkeyCreate, passkeyUnlock, PrfUnsupported } from "./lib/keys";
import type { Identity } from "./lib/keys";
import { ensureFunded, reader, writerFor } from "./lib/clients";
import { createSafe, listSafes } from "./lib/safe";
import type { SafeCard } from "./lib/safe";
import { config, txLink } from "./lib/config";
import { bytesToHex, hexToBytes } from "@keyhole/crypto";
import { SafePage } from "./ui/SafePage";
import { Recipient } from "./ui/Recipient";
import { Receive } from "./ui/Receive";
import { Verify } from "./ui/Verify";
import { Judge } from "./judge/Judge";

const LS = { cred: "keyhole.credId", salt: "keyhole.salt", mode: "keyhole.mode" };
const get = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const put = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

export function App() {
  const [id, setId] = useState<Identity | null>(null);
  if (location.hash.startsWith("#judge")) return <main><h1>Keyhole</h1><Judge /></main>;
  if (location.hash.startsWith("#verify")) return <main><h1>Keyhole</h1><Verify /></main>;
  if (location.hash.startsWith("#open=")) return <main><h1>Keyhole</h1><Recipient /></main>;
  return (
    <main>
      <h1>Keyhole</h1>
      <p className="sub">A safe for your files. You hold the keys; every visit is recorded.</p>
      {id ? <Safes id={id} onLock={() => setId(null)} /> : <SignIn onIdentity={setId} />}
    </main>
  );
}

function SignIn({ onIdentity }: { onIdentity: (i: Identity) => void }) {
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [pass, setPass] = useState("");
  const [fallback, setFallback] = useState(false);
  const hasPasskey = !!get(LS.cred);
  const run = async (f: () => Promise<Identity>) => { setBusy(true); setErr(""); try { onIdentity(await f()); } catch (e) { setErr(e instanceof PrfUnsupported ? "This device can't derive keys from a passkey. Use a passphrase instead (weaker)." : (e as Error).message); if (e instanceof PrfUnsupported) setFallback(true); } finally { setBusy(false); } };
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>{hasPasskey ? "Unlock your safes" : "Create your safe"}</h2>
      {!fallback && (
        <div className="row">
          <button disabled={busy} onClick={() => run(async () => {
            if (hasPasskey) return passkeyUnlock(Uint8Array.from(atob(get(LS.cred)!), (c) => c.charCodeAt(0)));
            const { credId, identity } = await passkeyCreate("Keyhole safe");
            put(LS.cred, btoa(String.fromCharCode(...credId))); put(LS.mode, "passkey");
            return identity;
          })}>{hasPasskey ? "Unlock with passkey" : "Create with passkey"}</button>
          <button className="ghost" onClick={() => setFallback(true)}>Use a passphrase instead</button>
        </div>
      )}
      {fallback && (
        <div>
          <p className="note"><span className="pill warn">weaker</span> A passphrase can be guessed offline by someone who gets your data. A passkey cannot. Use a long one.</p>
          <input type="password" placeholder="Passphrase (8+ characters)" value={pass} onChange={(e) => setPass(e.target.value)} />
          <div className="row" style={{ marginTop: 12 }}>
            <button disabled={busy || pass.length < 8} onClick={() => run(async () => {
              let salt = get(LS.salt);
              if (!salt) { salt = bytesToHex(newSalt()); put(LS.salt, salt); }
              put(LS.mode, "passphrase");
              return identityFromPassphrase(pass, hexToBytes(salt));
            })}>{get(LS.salt) ? "Unlock" : "Create"}</button>
            <button className="ghost" onClick={() => setFallback(false)}>Back</button>
          </div>
        </div>
      )}
      {busy && <p className="note">Working… (a passphrase takes a few seconds)</p>}
      {err && <p className="err">{err}</p>}
      <p className="note">Testnet demo. No real money, and nothing here is audited: don't store real sensitive files.</p>
    </div>
  );
}

function Safes({ id, onLock }: { id: Identity; onLock: () => void }) {
  const [cards, setCards] = useState<SafeCard[] | null>(null);
  const [status, setStatus] = useState("");
  const [err, setErr] = useState("");
  const [last, setLast] = useState("");
  const [open, setOpen] = useState<SafeCard | null>(null);
  const refresh = async () => setCards(await listSafes(reader, id.accountId));
  useEffect(() => { refresh().catch((e) => setErr((e as Error).message)); }, []);
  const create = async () => {
    setErr(""); setStatus("Creating…");
    try {
      await ensureFunded(id, setStatus);
      setStatus("Creating your safe…");
      const r = await createSafe(id, writerFor(id));
      setLast(r.txHash); await refresh(); setStatus("");
    } catch (e) { setErr((e as Error).message); setStatus(""); }
  };
  if (open) return <SafePage id={id} boxId={open.boxId} serial={open.serial} onBack={() => { setOpen(null); void refresh(); }} />;
  return (
    <div>
      <div className="row"><h2 className="grow" style={{ margin: 0 }}>Your safes</h2><button className="ghost" onClick={onLock}>Lock</button></div>
      <p className="mono">account {id.accountId.slice(0, 16)}… · contract {config.contractId} {id.mode === "passphrase" && <span className="pill warn">passphrase mode</span>}</p>
      {cards?.map((c) => (
        <div className="card" key={c.boxId} style={{ cursor: "pointer" }} onClick={() => setOpen(c)}>
          <div className="row"><strong className="grow">Safe #{c.serial}</strong>
            <span className={`pill ${c.state === "open" ? "ok" : "warn"}`}>{c.state === "open" ? "locked to you" : "being handed over"}</span></div>
          <p className="note">{c.activeGrants} people have access · {c.openings} recorded visits · key set {c.epoch}</p>
          <p className="mono">{c.boxId}</p>
        </div>
      ))}
      {cards?.length === 0 && <p className="note">No safes yet.</p>}
      <Receive id={id} onDone={() => void refresh()} />
      <div className="row"><button disabled={!!status} onClick={create}>New safe</button>{status && <span className="note">{status}</span>}</div>
      {last && <p className="note">Recorded: <a href={txLink(last)} target="_blank" rel="noreferrer">transaction</a></p>}
      {err && <p className="err">{err}</p>}
    </div>
  );
}
