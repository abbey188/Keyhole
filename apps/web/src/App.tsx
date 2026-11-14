import { useEffect, useState } from "react";
import type { Identity } from "./lib/keys";
import { reader } from "./lib/clients";
import { listSafes } from "./lib/safe";
import type { SafeCard } from "./lib/safe";
import { config } from "./lib/config";
import { safeInfo, safeName } from "./lib/safemeta";
import type { SafeInfo } from "./lib/safemeta";
import { SafePage } from "./ui/SafePage";
import { Recipient } from "./ui/Recipient";
import { Verify } from "./ui/Verify";
import { Showcase } from "./ui/Showcase";
import { SignIn } from "./ui/SignIn";
import { SafesPage } from "./ui/Safes";

export function App() {
  const [id, setId] = useState<Identity | null>(null);
  if (location.hash.startsWith("#verify") || location.pathname.startsWith("/verify")) return <Verify />;
  if (config.showcase && !location.hash.startsWith("#open=")) return <div className="legacy"><main><h1>Keyhole</h1><p className="sub">A safe for your files. You hold the keys; every visit is recorded.</p><Showcase /></main></div>;
  if (location.hash.startsWith("#open=")) return <Recipient />;
  if (!id) return <SignIn onIdentity={setId} />;
  return <Owner id={id} onLock={() => setId(null)} />;
}

/** The signed-in owner: the safes list, or one safe. Everything shown is read from the chain and decrypted on this device. */
function Owner({ id, onLock }: { id: Identity; onLock: () => void }) {
  const [cards, setCards] = useState<SafeCard[] | null>(null);
  const [infos, setInfos] = useState<Record<string, SafeInfo>>({});
  const [open, setOpen] = useState<{ boxId: string; action?: "give" } | null>(null);
  const loadInfo = async (boxId: string) => {
    const b = await reader.box(boxId);
    if (!b) return;
    const info = await safeInfo(id, reader, b);
    setInfos((p) => ({ ...p, [boxId]: info }));
  };
  const refresh = async () => {
    const cs = await listSafes(reader, id.accountId);
    setCards(cs);
    await Promise.all(cs.map((c) => loadInfo(c.boxId).catch(() => undefined)));
  };
  useEffect(() => { refresh().catch(() => setCards([])); }, []);
  const rail = (cards ?? []).map((c) => ({ boxId: c.boxId, serial: c.serial, name: safeName(infos[c.boxId]?.manifest, c.serial) }));

  if (open) {
    const c = cards?.find((x) => x.boxId === open.boxId);
    return <SafePage key={open.boxId} id={id} boxId={open.boxId} serial={c?.serial ?? 0} info={infos[open.boxId]} rail={rail} initial={open.action}
      onSafe={(b) => setOpen({ boxId: b })} onBack={() => { setOpen(null); void refresh(); }} onChanged={() => void loadInfo(open.boxId)} />;
  }
  return <SafesPage id={id} cards={cards} infos={infos} rail={rail} onOpen={(b, a) => setOpen({ boxId: b, ...(a ? { action: a } : {}) })} onCreated={async () => { await refresh(); }} onLock={onLock} />;
}
