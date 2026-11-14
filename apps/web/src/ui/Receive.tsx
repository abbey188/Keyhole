import { Working } from "./kit";
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
import { HandoverDiagram, fmtWhen, periodWords, shortAccount } from "./HandoverTab";

// The buyer's side of design A11: the same labels, fields, orange card and buttons, without a separate artboard.

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
  const mine = handoverAddress(id);

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
      setDeal(d);
      while ((await reader.finalTimeMs()) < (d.waiting_until ?? 0)) { setBusy(`Waiting period: ${Math.max(0, Math.ceil(((d.waiting_until ?? 0) - Date.now()) / 1000))} s`); await new Promise((r) => setTimeout(r, 2000)); }
      setBusy("Completing the handover…"); await completeHandover(writer, deal.deal_id);
      d = (await readDeal(reader, deal.deal_id))!;
      setDeal(d);
      setBusy("Receiving the key…");
      const nodes = svc.nodeUrls.map((u, i) => new HttpNodeApi(`node${i}`, u));
      const bmk = await receiveKey({ id, reader, svc, nodes, deal: d });
      const box = (await reader.box(d.box_id))!;
      const ctx: Ctx = { id, reader, writer, nodes, boxId: d.box_id, bmk, epoch: box.key_epoch - 1, progress: setBusy };
      await relock(ctx, box, async () => undefined, box.key_epoch);
      setDone(true); setBusy(""); onDone();
    } catch (e) { setErr(`Did not finish: ${(e as Error).message}`); setBusy(""); }
  };

  const seconds = (deal?.waiting_ms ?? 0) < 3_600_000;
  return (
    <div className="panel" style={{ padding: 26, display: "grid", gridTemplateColumns: deal ? "minmax(0,1fr) minmax(0,420px)" : "minmax(0,1fr)", gap: 32, alignItems: "start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 20, minWidth: 0, maxWidth: 560 }}>
        <div>
          <div className="lbl" style={{ color: "var(--orange)" }}>[ Hand over ]</div>
          <h2 className="h2" style={{ marginTop: 8 }}>Receive a safe</h2>
        </div>
        <div>
          <div className="fl">Your handover address</div>
          <div style={{ display: "flex", gap: 10 }}>
            <input className="input m" style={{ fontSize: 13 }} readOnly value={mine} onFocus={(e) => e.target.select()} />
            <button className="btn btn-s" onClick={() => void navigator.clipboard?.writeText(mine)}>Copy my address</button>
          </div>
        </div>
        <div>
          <div className="fl">Handover code</div>
          <div style={{ display: "flex", gap: 10 }}>
            <input className="input m" style={{ fontSize: 13 }} placeholder="Handover code from the sender" value={code} onChange={(e) => setCode(e.target.value)} spellCheck={false} />
            <button className="btn btn-s" onClick={look}>Look up</button>
          </div>
        </div>
        {deal && !done && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ fontSize: 17, lineHeight: "24px" }}>A safe is being handed to you for <b>{fmt(deal.price)}</b>.</div>
            {deal.state === "Ready" && <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}><button className="btn btn-of btn-lg" disabled={!!busy} onClick={accept}>Accept the safe <span className="m">→</span></button>{busy && <Working>{busy}</Working>}</div>}
            {deal.state !== "Ready" && busy && <Working>{busy}</Working>}
            {deal.state !== "Ready" && !busy && <span className="chip chip-m" style={{ alignSelf: "flex-start" }}>This handover is {deal.state.toLowerCase()}</span>}
          </div>
        )}
        {done && <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", fontSize: 15 }}><span className="chip chip-b">received and re-locked</span><span>It is in your list now, under keys only you hold.</span></div>}
        {err && <p className="err">{err}</p>}
      </div>
      {deal && (
        <HandoverDiagram from={shortAccount(deal.seller)} to="You" over={`After ${periodWords(deal.waiting_ms)}`} rows={[
          { k: "Price", v: fmt(deal.price), tone: "num" },
          ...(deal.price !== "0" ? [{ k: "Paid to the sender", v: "When ownership moves" }] : []),
          { k: "State", v: done ? "Re-locked" : deal.state },
          { k: "Their access", v: "Ends", tone: "orange" },
          { k: "Visitor log", v: "Comes with the safe" },
          { k: "New keys", v: "Only yours" },
          ...(deal.waiting_until ? [{ k: "Yours from", v: fmtWhen(deal.waiting_until, seconds), tone: "num" as const }] : []),
        ]} />
      )}
    </div>
  );
}
