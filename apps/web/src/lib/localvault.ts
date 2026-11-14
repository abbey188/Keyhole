// The owner's saved access links (they hold key material) are kept in this browser encrypted under a key derived from the
// owner's data root, so reading browser storage alone is not enough to open a shared link. Older plaintext copies are
// converted on first read. If storage is unavailable or the key is wrong, the list is simply empty.
import { aead, bytesToHex, concatBytes, hexToBytes, sha256, tag, utf8 } from "@keyhole/crypto";
import type { Identity } from "./keys";

export interface SavedGrant { grantId: string; label: string; exp: number; files: string[]; link: string }

const storageKey = (boxId: string) => `keyhole.grants.${boxId}`;
const localKey = (id: Identity) => sha256(concatBytes(tag("local-links"), id.dataRoot));
const aad = (boxId: string) => utf8(`keyhole/v1/local-links/${boxId}`);

export function saveGrants(id: Identity, boxId: string, list: SavedGrant[]): void {
  try {
    const sealed = aead.seal(localKey(id), utf8(JSON.stringify(list)), aad(boxId));
    localStorage.setItem(storageKey(boxId), `v1:${bytesToHex(sealed)}`);
  } catch { /* private mode: nothing is saved */ }
}

export function loadGrants(id: Identity, boxId: string): SavedGrant[] {
  try {
    const raw = localStorage.getItem(storageKey(boxId));
    if (!raw) return [];
    if (raw.startsWith("[")) { const old = JSON.parse(raw) as SavedGrant[]; saveGrants(id, boxId, old); return old; } // legacy plaintext, converted now
    if (!raw.startsWith("v1:")) return [];
    return JSON.parse(new TextDecoder().decode(aead.open(localKey(id), hexToBytes(raw.slice(3)), aad(boxId)))) as SavedGrant[];
  } catch { return []; }
}
