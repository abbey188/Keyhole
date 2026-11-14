import { useEffect, useState } from "react";
import { config, txLink } from "../lib/config";
import { rpcCall } from "../lib/clients";
import { CLAIMS } from "./claims";
import original from "../../../../deploy/testnet.json";
import attack from "../../../../deploy/attack-lab-testnet.json";
import smoke from "../../../../deploy/smoke-testnet.json";
import smokeDeal from "../../../../deploy/smoke-deal-testnet.json";
import smokeNamed from "../../../../deploy/smoke-named-testnet.json";

const record = config.deploy;

type Tx = { label: string; method: string; ok: boolean; txHash: string; gasTgas: number; submitToFinalMs: number };
const ALL: Tx[] = [...(smoke as { transactions: Tx[] }).transactions, ...(smokeDeal as { transactions: Tx[] }).transactions, ...(smokeNamed as { transactions: Tx[] }).transactions];

function resolve(p: string): { text: string; href?: string } {
  const m = p.match(/^tx:(attack-lab|deploy):(.+)$/);
  if (!m) return { text: p };
  if (m[1] === "attack-lab") { const a = (attack as { results: { id: string; txHash: string | null }[] }).results.find((r) => r.id === m[2]); return a?.txHash ? { text: `attack ${m[2]} transaction`, href: txLink(a.txHash) } : { text: p }; }
  const r = record as unknown as { launch: { txHash: string }; deploy: { txHash: string } };
  return { text: m[2] === "launch" ? "launch transaction (keys deleted)" : "deploy transaction", href: txLink(m[2] === "launch" ? r.launch.txHash : r.deploy.txHash) };
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0; };

export function Judge() {
  const [keys, setKeys] = useState<string>("checking…");
  useEffect(() => {
    rpcCall<{ keys: unknown[] }>("query", { request_type: "view_access_key_list", finality: "final", account_id: config.contractId })
      .then((j) => setKeys(j.result ? `${j.result.keys.length} access keys` : "could not read")).catch(() => setKeys("could not read"));
  }, []);
  const ok = ALL.filter((t) => t.ok);
  const byMethod = new Map<string, Tx[]>();
  for (const t of ok) byMethod.set(t.method, [...(byMethod.get(t.method) ?? []), t]);
  const rec = record as unknown as { contract: string; wasm: { sha256: string; near_code_hash_base58: string; bytes: number; sourceCommit: string }; deploy: { txHash: string }; launch: { txHash: string } };
  const a = attack as { results: { id: string; attack: string; how: string; got: string; refused: boolean; txHash: string | null; gasTgas: number }[] };
  return (
    <div>
      <h2>Judge page</h2>
      <p className="sub">Every statement on this page links to a test you can run or a transaction you can open. Run <code>./scripts/verify.sh</code> to reproduce the tests. Testnet only; a demo configuration; no external audit.</p>

      {rec.contract !== (original as { contract: string }).contract && <p className="note">This site runs its own deployment of the same contract. The attack and smoke-test results below were run against the original deployment, <a href={`${config.explorer}/accounts/${(original as { contract: string }).contract}`} target="_blank" rel="noreferrer">{(original as { contract: string }).contract}</a>, which has the identical code hash.</p>}
      <div className="card"><h3 style={{ marginTop: 0 }}>The deployed contract</h3>
        <table><tbody>
          <tr><td>Account</td><td><a href={`${config.explorer}/accounts/${rec.contract}`} target="_blank" rel="noreferrer">{rec.contract}</a></td></tr>
          <tr><td>Access keys right now (live from the chain)</td><td><strong>{keys}</strong> {keys.startsWith("0") && <span className="pill ok">keyless</span>}</td></tr>
          <tr><td>Code hash (chain)</td><td className="mono">{rec.wasm.near_code_hash_base58}</td></tr>
          <tr><td>Wasm sha256 ({rec.wasm.bytes.toLocaleString()} bytes)</td><td className="mono">{rec.wasm.sha256}</td></tr>
          <tr><td>Built from commit</td><td className="mono">{rec.wasm.sourceCommit}</td></tr>
          <tr><td>Transactions</td><td><a href={txLink(rec.deploy.txHash)} target="_blank" rel="noreferrer">deploy + init (one transaction)</a> · <a href={txLink(rec.launch.txHash)} target="_blank" rel="noreferrer">launch: keys deleted</a></td></tr>
        </tbody></table></div>

      <h3>Claims and their proof</h3>
      <table><thead><tr><th>Claim</th><th>Status</th><th>Proof</th></tr></thead><tbody>
        {CLAIMS.map((c) => (
          <tr key={c.id}><td><strong>{c.id}</strong> {c.claim}{c.limit && <div className="note">Limit: {c.limit}</div>}</td>
            <td><span className={`pill ${c.status.startsWith("proven") ? "ok" : c.status === "partly" ? "warn" : "bad"}`}>{c.status}</span></td>
            <td>{c.proof.length === 0 ? <span className="note">none: not built</span> : c.proof.map((p) => { const r = resolve(p); return <div key={p} className="note">{r.href ? <a href={r.href} target="_blank" rel="noreferrer">{r.text}</a> : r.text}</div>; })}</td></tr>
        ))}
      </tbody></table>

      <h3>Attack lab: real attacks against the deployed contract</h3>
      <p className="note">Each was attempted on testnet and refused. A refused transaction still has a hash.</p>
      <table><thead><tr><th>#</th><th>Attack</th><th>The contract said</th><th>Transaction</th></tr></thead><tbody>
        {a.results.map((r) => (
          <tr key={r.id}><td>{r.id}</td><td>{r.attack}<div className="note">{r.how}</div></td>
            <td><span className={`pill ${r.refused ? "ok" : "bad"}`}>{r.refused ? "refused" : "NOT REFUSED"}</span><div className="note">{r.got.replace(/^\{.*"ExecutionError":"Smart contract panicked: ([^"]*)".*$/, "$1")}</div></td>
            <td>{r.txHash && <a href={txLink(r.txHash)} target="_blank" rel="noreferrer">{r.txHash.slice(0, 10)}…</a>} <span className="note">{r.gasTgas} Tgas</span></td></tr>
        ))}
      </tbody></table>

      <h3>Numbers (testnet, measured from this machine)</h3>
      <table><thead><tr><th>Call</th><th>Runs</th><th>Gas burnt (Tgas)</th><th>Time to final (median)</th></tr></thead><tbody>
        {[...byMethod.entries()].sort().map(([m, ts]) => <tr key={m}><td>{m}</td><td>{ts.length}</td><td>{Math.min(...ts.map((t) => t.gasTgas)).toFixed(1)}{ts.some((t) => t.gasTgas !== ts[0]!.gasTgas) ? ` to ${Math.max(...ts.map((t) => t.gasTgas)).toFixed(1)}` : ""}</td><td>{(median(ts.map((t) => t.submitToFinalMs)) / 1000).toFixed(1)} s</td></tr>)}
      </tbody></table>
      <p className="note">Opening a link end to end (request, receipt final, keys, first page): about 6 to 8 seconds in the browser runs. Ask my safe: 15 seconds including the attestation checks.</p>

      <h3>Who can see what</h3>
      <table><thead><tr><th>Component</th><th>Sees plaintext?</th><th>What limits it</th></tr></thead><tbody>
        <tr><td>Your device</td><td>Yes, the only place by default</td><td>Passkey-derived keys; open source</td></tr>
        <tr><td>Storage node</td><td>No (ciphertext)</td><td>Merkle proofs against the on-chain blob id</td></tr>
        <tr><td>NEAR contract</td><td>No</td><td>Keyless; public source; Wasm hash above</td></tr>
        <tr><td>Release service</td><td>No, but holds half of each shared key and decides when to give it out</td><td>Reads the chain itself; fails closed; <strong>single trusted party in this build</strong> (threshold release is LATER)</td></tr>
        <tr><td>AI model</td><td>Only the few pages you choose to ask about, end-to-end encrypted</td><td>Attested hardware; the attestation does not prove the model's behaviour or the operator's conduct outside the enclave</td></tr>
        <tr><td>The AI relay</td><td>No (ciphertext and public attestation data only)</td><td>Host allowlist; holds the credential so the browser does not</td></tr>
      </tbody></table>
      <p className="note"><strong>Public on chain:</strong> the safe's serial, owner account, grant windows, receipt times and the receipt chain head, handover terms. <strong>Private:</strong> file contents, names, counts, exact sizes, what was viewed page by page, claims content until you share it. This is confidentiality with public accountability, not anonymity.</p>
    </div>
  );
}
