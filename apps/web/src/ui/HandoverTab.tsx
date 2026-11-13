import { useEffect, useState } from "react";
import type { ChainWriter, DealApi, DealView } from "@keyhole/chain";
import type { Ctx } from "../lib/upload";
import { cancelHandover, offerHandover, readDeal } from "../lib/handover";
import type { Offer } from "../lib/handover";
import { config, txLink } from "../lib/config";
import type { Services } from "../lib/access";
import type { BoxView } from "@keyhole/chain";

const svc: Services = { releaseUrl: config.releaseUrl, nodeUrls: config.nodeUrls, chainId: config.chainId, contractId: config.contractId };
const NEAR = 10n ** 24n;
const toYocto = (s: string) => { const [a, b = ""] = s.trim().split("."); return (BigInt(a || "0") * NEAR + BigInt((b + "0".repeat(24)).slice(0, 24))).toString(); };

export function HandoverTab({ ctx, box, onChanged }: { ctx: Ctx; box: BoxView; onChanged: () => void }) {
  const [addr, setAddr] = useState("");
  const [price, setPrice] = useState("0");
  const [wait, setWait] = useState(15_000);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [offer, setOffer] = useState<Offer | null>(null);
  const [deal, setDeal] = useState<DealView | null>(null);
  useEffect(() => {
    let dead = false;
    const poll = async () => { if (box.in_deal) { const d = await readDeal(ctx.reader, box.in_deal).catch(() => null); if (!dead) setDeal(d); } else if (!dead) setDeal(null); };
    void poll(); const t = setInterval(poll, 5000); return () => { dead = true; clearInterval(t); };
  }, [box.in_deal, box.key_epoch]);
  const writer = ctx.writer as ChainWriter & DealApi;

  const start = async () => {
    setErr("");
    try { setOffer(await offerHandover({ ctx: { ...ctx, progress: setBusy }, writer, svc, buyerAddress: addr, priceYocto: toYocto(price), waitingMs: wait })); onChanged(); }
    catch (e) { setErr((e as Error).message); }
    setBusy("");
  };
  const cancel = async () => { setBusy("Cancelling…"); try { await cancelHandover(writer, box.in_deal!); setOffer(null); onChanged(); } catch (e) { setErr((e as Error).message); } setBusy(""); };

  if (box.in_deal || offer) {
    const code = offer?.code ?? `${box.in_deal}.${box.box_id}`;
    return (
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Handover in progress</h3>
        <p><span className="pill warn">{deal?.state === "Funded" ? "funded: waiting period running" : deal?.state === "Ready" ? "waiting for the new owner to accept" : deal?.state ?? "…"}</span></p>
        <p className="note">Send this code to the new owner. The safe is frozen until the handover finishes or you cancel.</p>
        <input readOnly value={code} onFocus={(e) => e.target.select()} />
        <div className="row" style={{ marginTop: 10 }}><button onClick={() => void navigator.clipboard?.writeText(code)}>Copy code</button><button className="ghost" disabled={!!busy} onClick={cancel}>Cancel handover</button>{busy && <span className="note">{busy}</span>}</div>
        {offer && <details style={{ marginTop: 10 }}><summary className="note">Recorded on chain</summary>{offer.txs.map((t) => <div className="note" key={t.txHash}>{t.step}: <a href={txLink(t.txHash)} target="_blank" rel="noreferrer">{t.txHash.slice(0, 10)}…</a></div>)}</details>}
        {err && <p className="err">{err}</p>}
      </div>
    );
  }
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Hand this safe over</h3>
      <p className="note">The new owner gets the safe and everything in it. Every access link you gave out stops working the moment it completes. They then re-lock it with keys you never had. You can add a price: it is held by the contract and paid to you only when ownership moves.</p>
      <input placeholder="The new owner's handover address (they copy it from their Keyhole)" value={addr} onChange={(e) => setAddr(e.target.value)} />
      <div className="row" style={{ marginTop: 10 }}>
        <input style={{ width: 160 }} value={price} onChange={(e) => setPrice(e.target.value)} placeholder="Price in NEAR (0 = free)" />
        <select style={{ width: 220 }} value={wait} onChange={(e) => setWait(Number(e.target.value))}>
          <option value={15_000}>15 second waiting period (demo)</option><option value={3_600_000}>1 hour</option><option value={86_400_000}>24 hours</option></select>
      </div>
      <p className="note">The waiting period gives you time to cancel if the wrong address was used or an account was stolen. Testnet money only.</p>
      <div className="row"><button disabled={!!busy || addr.length < 129} onClick={start}>Offer the safe</button>{busy && <span className="note">{busy}</span>}</div>
      {err && <p className="err">{err}</p>}
    </div>
  );
}
