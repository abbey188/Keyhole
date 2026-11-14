// Sign in (design A01): passkey first, passphrase as the weaker fallback.
import { useState } from "react";
import { bytesToHex, hexToBytes } from "@keyhole/crypto";
import { identityFromPassphrase, newSalt, passkeyCreate, passkeyUnlockWithId, PrfUnsupported } from "../lib/keys";
import type { Identity } from "../lib/keys";
import { Logo } from "./kit";

export const LS = { cred: "keyhole.credId", salt: "keyhole.salt", mode: "keyhole.mode" };
const get = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const put = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function SignIn({ onIdentity }: { onIdentity: (i: Identity) => void }) {
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [pass, setPass] = useState("");
  const [fallback, setFallback] = useState(false);
  const stored = get(LS.cred);
  const run = async (label: string, f: () => Promise<Identity>) => {
    setBusy(label); setErr("");
    try { onIdentity(await f()); }
    catch (e) {
      if (e instanceof PrfUnsupported) { setErr("This device can't make keys from a passkey. Use a passphrase instead."); setFallback(true); }
      else setErr((e as Error).message);
    } finally { setBusy(""); }
  };
  const create = () => run("Waiting for your passkey…", async () => {
    const { credId, identity } = await passkeyCreate("Keyhole safe");
    put(LS.cred, b64(credId)); put(LS.mode, "passkey");
    return identity;
  });
  const unlock = () => run("Waiting for your passkey…", async () => {
    const { identity, credId } = await passkeyUnlockWithId(stored ? unb64(stored) : undefined);
    put(LS.cred, b64(credId)); put(LS.mode, "passkey");
    return identity;
  });
  const withPassphrase = () => run("Making your keys…", async () => {
    let salt = get(LS.salt);
    if (!salt) { salt = bytesToHex(newSalt()); put(LS.salt, salt); }
    put(LS.mode, "passphrase");
    return identityFromPassphrase(pass, hexToBytes(salt));
  });

  return (
    <div className="app" style={{ minHeight: "100vh" }}>
      <section style={{ width: "50%", maxWidth: 720, minWidth: 420, flex: "none", background: "var(--blue)", color: "#FFFFFF", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "40px 56px", minHeight: "100vh" }}>
        <a href="/" style={{ display: "flex", alignItems: "center", gap: 11, fontWeight: 700, fontSize: 20 }}><Logo size={24} />Keyhole</a>
        <svg viewBox="0 0 440 440" width="440" height="440" role="img" aria-label="A vault door drawn in line, with a clear keyhole" style={{ alignSelf: "center", maxWidth: "100%", height: "auto" }}>
          <defs><pattern id="sd" width="6" height="6" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="1" fill="#A9C2EC" /></pattern><mask id="sm"><circle cx="220" cy="220" r="150" fill="#FFFFFF" /><circle cx="207" cy="207" r="148" fill="#000000" /></mask></defs>
          <rect x="30" y="30" width="380" height="380" rx="30" fill="none" stroke="#FFFFFF" strokeWidth="1.5" /><rect x="46" y="46" width="348" height="348" rx="20" fill="none" stroke="#FFFFFF" strokeOpacity="0.45" />
          <circle cx="220" cy="220" r="150" fill="none" stroke="#FFFFFF" strokeWidth="1.5" />
          <circle cx="220" cy="220" r="132" fill="none" stroke="#FFFFFF" strokeOpacity="0.75" strokeWidth="5" strokeDasharray="1.2 9.2" /><circle cx="220" cy="220" r="78" fill="#FFFFFF" />
          <circle cx="220" cy="204" r="17" fill="#0E1435" /><path d="M213.4 213.5L203.6 257.5Q202.6 262.5 207.8 262.5H232.2Q237.4 262.5 236.4 257.5L226.6 213.5Z" fill="#0E1435" />
        </svg>
        <div>
          <div style={{ fontSize: 44, lineHeight: "46px", fontWeight: 700, letterSpacing: "-1.8px", maxWidth: 560, textWrap: "balance" } as React.CSSProperties}>Share the answer, not the document.</div>
          <div className="lbl" style={{ marginTop: 18, color: "#A9C2EC" }}>Runs on NEAR testnet</div>
        </div>
      </section>
      <section style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div style={{ width: 420, maxWidth: "100%", display: "flex", flexDirection: "column", gap: 22 }}>
          <div>
            <div className="lbl" style={{ color: "var(--blue)" }}>[ Welcome ]</div>
            <h1 className="h1" style={{ marginTop: 10, fontSize: 36, lineHeight: "40px" }}>{fallback ? "Use a passphrase" : "Make your safe"}</h1>
            <p style={{ margin: "12px 0 0", fontSize: 16, lineHeight: "25px" }} className="mute">{fallback ? "Choose a long passphrase. Anyone who guesses it can open your safes." : "Use the fingerprint, face or PIN you already use on this device."}</p>
          </div>
          {!fallback && <>
            <button className="btn btn-p btn-lg" style={{ justifyContent: "space-between", width: "100%" }} disabled={!!busy} onClick={create}>Create with a passkey <span className="m">→</span></button>
            <button className="btn btn-s btn-lg" style={{ justifyContent: "space-between", width: "100%" }} disabled={!!busy} onClick={unlock}>I already have a safe <span className="m">→</span></button>
            <div className="hr" />
            <button className="btn btn-g" style={{ paddingLeft: 0, justifyContent: "flex-start", textDecoration: "underline", textUnderlineOffset: 4, fontWeight: 500, background: "transparent", border: 0, alignSelf: "flex-start" }} onClick={() => setFallback(true)}>Use a passphrase instead</button>
          </>}
          {fallback && <>
            <div><div className="fl">Passphrase</div><input className="input" type="password" placeholder="At least 8 characters" value={pass} onChange={(e) => setPass(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && pass.length >= 8) void withPassphrase(); }} /></div>
            <button className="btn btn-p btn-lg" style={{ justifyContent: "space-between", width: "100%" }} disabled={!!busy || pass.length < 8} onClick={withPassphrase}>{get(LS.salt) ? "Unlock" : "Create"} <span className="m">→</span></button>
            <button className="btn btn-g" style={{ paddingLeft: 0, background: "transparent", border: 0, alignSelf: "flex-start", textDecoration: "underline", textUnderlineOffset: 4, fontWeight: 500 }} onClick={() => setFallback(false)}>Use a passkey instead</button>
          </>}
          {busy && <p className="mute" style={{ margin: 0, fontSize: 14 }}>{busy}</p>}
          {err && <p className="err">{err}</p>}
        </div>
      </section>
    </div>
  );
}
