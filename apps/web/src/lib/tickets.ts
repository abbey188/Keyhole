import { bytesToHex, msgs, sig } from "@keyhole/crypto";
import type { Identity } from "./keys";

/** Browser-safe twin of services/node's owner ticket (same JSON shape and signed message). */
export function ownerTicket(id: Identity, blobId: string, expMs: number): string {
  const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
  const s = sig.sign(id.accountSeed, msgs.ticketMsg(hex(blobId), new Uint8Array(16), expMs));
  const json = JSON.stringify({ kind: "owner", account: id.accountId, pk: bytesToHex(sig.publicKey(id.accountSeed)), exp: expMs, sig: bytesToHex(s) });
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
