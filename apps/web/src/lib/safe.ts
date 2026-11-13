// Safe (box) operations for the owner's device. Pure logic over the ChainReader/ChainWriter interfaces so it can be
// tested against the mock chain and run against the real one.
import { aead, bytesToHex, concatBytes, hexToBytes, kdf, randomBytes, u32le } from "@keyhole/crypto";
import type { BoxView, ChainReader, ChainWriter } from "@keyhole/chain";
import type { Identity } from "./keys";

/** Longest grant a safe allows (one day). */
export const MAX_GRANT_MS = 24 * 3_600_000;

const wrapAad = (boxId: Uint8Array, epoch: number) => concatBytes(new TextEncoder().encode("keyhole/v1/wrap\0"), boxId, u32le(epoch));

export function wrapBmk(id: Identity, boxIdHex: string, bmk: Uint8Array, epoch = 0): Uint8Array {
  const boxId = hexToBytes(boxIdHex);
  return aead.seal(kdf.boxWrapKey(id.dataRoot, boxId), bmk, wrapAad(boxId, epoch));
}

/** Recovers the box master key from the on-chain wrapped key. Throws "invalid" for the wrong identity or epoch. */
export function unwrapBmk(id: Identity, box: Pick<BoxView, "box_id" | "wrapped_bmk" | "key_epoch">): Uint8Array {
  const boxId = hexToBytes(box.box_id);
  const wrapped = Uint8Array.from(atob(box.wrapped_bmk), (c) => c.charCodeAt(0));
  return aead.open(kdf.boxWrapKey(id.dataRoot, boxId), wrapped, wrapAad(boxId, box.key_epoch));
}

export interface CreatedSafe {
  boxId: string;
  txHash: string;
}

export async function createSafe(id: Identity, writer: ChainWriter): Promise<CreatedSafe> {
  const boxId = bytesToHex(randomBytes(16));
  const bmk = randomBytes(32);
  const tx = await writer.createBox({ boxId, kind: "Handover", wrappedBmk: wrapBmk(id, boxId, bmk), maxGrantMs: MAX_GRANT_MS });
  return { boxId, txHash: tx.txHash };
}

/** The safe's public face, composed from contract views only (no names, no contents). */
export interface SafeCard {
  serial: number;
  boxId: string;
  owner: string;
  state: "open" | "in_handover";
  activeGrants: number;
  openings: number; // receipts: opens and closes
  logHead: string;
  epoch: number;
  hasManifest: boolean;
}

export async function listSafes(reader: ChainReader, accountId: string): Promise<SafeCard[]> {
  const boxes = await reader.boxesOf(accountId);
  return boxes.map((b, i) => ({
    serial: i + 1,
    boxId: b.box_id,
    owner: b.owner,
    state: b.in_deal ? "in_handover" : "open",
    activeGrants: b.live_grants,
    openings: b.receipts_seq,
    logHead: b.receipts_head,
    epoch: b.key_epoch,
    hasManifest: b.manifest_blob !== null,
  }));
}
