import { useState } from "react";
import type { ChainWriter, DealApi, DealView } from "@keyhole/chain";
import { HttpNodeApi } from "@keyhole/store";
import type { Identity } from "../lib/keys";
import { ensureFunded, reader, writerFor } from "../lib/clients";
import { config } from "../lib/config";
import { acceptAndFund, completeHandover, handoverAddress, parseDealCode, readDeal, receiveKey } from "../lib/handover";
import { relock } from "../lib/relock";
import type { Ctx } from "../lib/upload";
import type { Services } from "../lib/access";

const svc: Services = { releaseUrl: config.releaseUrl, nodeUrls: config.nodeUrls, chainId: config.chainId, contractId: config.contractId };
const NEAR = 10n ** 24n;
const fmt = (y: string) => (y === "0" ? "free" : `${Number((BigInt(y) * 10000n) / NEAR) / 10000} NEAR`);

/** The new owner's side: copy your address, paste the handover code, accept, wait, receive the key, re-lock. */
export function Receive({ id, onDone }: { id: Identity; onDone: () => void }) {
  const [code, setCode] = useState("");
  const [deal, setDeal] = useState<DealView | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  const writer = writerFor(id) as ChainWriter & DealApi;

  const look = async () => {
    setErr("");
    try { const { dealId } = parseDealCode(code); const d = await readDeal(reader, dealId); if (!d) throw new Error("No such handover."); if (d.buyer !== id.accountId) throw new Error("This handover is for a different address."); setDeal(d); }
    catch (e) { setErr((e as Error).message); }
  };
  const accept = async () => {
    if (!deal) return; setErr("");
    try {
      await ensureFunded(id, setBusy);
      setBusy("Accepting…"); await acceptAndFund(writer, deal);
      let d = (await readDeal(reader, deal.deal_id))!;
      while ((await reader.finalTimeMs()) < (d.waiting_until ?? 0)) { setBusy(`Waiting period: ${Math.max(0, Math.ceil(((d.waiting_until ?? 0) - Date.now()) / 1000))} s`); await new Promise((r) => setTimeout(r, 2000)); }
      setBusy("Completing the handover…"); await completeHandover(writer, deal.deal_id);
      d = (await readDeal(reader, deal.deal_id))!;
      setBusy("Receiving the key…");
      const nodes = svc.nodeUrls.map((u, i) => new HttpNodeApi(`node${i}`, u));
      const bmk = await receiveKey({ id, reader, svc, nodes, deal: d });
      const box = (await reader.box(d.box_id))!;
      const ctx: Ctx = { id, reader, writer, nodes, boxId: d.box_id, bmk, epoch: box.key_epoch - 1, progress: setBusy };
      await relock(ctx, box, async () => undefined, box.key_epoch);
      setDone(true); setBusy(""); onDone();
    } catch (e) { setErr(`Did not finish: ${(e as Error).message}`); setBusy(""); }
  };
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Receive a safe</h3>
      <p className="note">1. Give the sender your handover address. 2. Paste the code they send you.</p>
      <input readOnly value={handoverAddress(id)} onFocus={(e) => e.target.select()} />
      <div className="row" style={{ margin: "8px 0" }}><button className="ghost" onClick={() => void navigator.clipboard?.writeText(handoverAddress(id))}>Copy my address</button></div>
      <div className="row"><input className="grow" placeholder="Handover code from the sender" value={code} onChange={(e) => setCode(e.target.value)} /><button className="ghost" onClick={look}>Look up</button></div>
      {deal && !done && (
        <div style={{ marginTop: 12 }}>
          <p>A safe is being handed to you for <strong>{fmt(deal.price)}</strong>. State: {deal.state}. {deal.state === "Ready" && "When you accept, the price (if any) is held by the contract and paid to the sender only when ownership moves."}</p>
          {deal.state === "Ready" && <button disabled={!!busy} onClick={accept}>Accept the safe</button>}
          {deal.state !== "Ready" && <p className="note">This handover is {deal.state.toLowerCase()}.</p>}
        </div>
      )}
      {busy && <p className="note">{busy}</p>}
      {done && <p><span className="pill ok">received and re-locked</span> It's in your list now, under keys only you hold.</p>}
      {err && <p className="err">{err}</p>}
    </div>
  );
}
