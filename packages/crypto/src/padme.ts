function log2Floor(n: number): number {
  let l = 0;
  let v = n;
  while (v >= 2) {
    v = Math.floor(v / 2);
    l++;
  }
  return l;
}

/** Padmé padded length (Nikitin et al., PoPETs 2019). */
export function padmeLen(len: number): number {
  if (len < 2) return len;
  const L = log2Floor(len);
  const s = log2Floor(L) + 1;
  const lastBits = L - s;
  const unit = 2 ** lastBits;
  return Math.ceil(len / unit) * unit;
}

/** Appends 0x80 then zeros up to padmeLen(len + 1). */
export function pad(msg: Uint8Array): Uint8Array {
  const target = padmeLen(msg.length + 1);
  const out = new Uint8Array(target);
  out.set(msg, 0);
  out[msg.length] = 0x80;
  return out;
}

export function unpad(padded: Uint8Array): Uint8Array {
  let i = padded.length;
  while (i > 0 && padded[i - 1] === 0) i--;
  if (i === 0 || padded[i - 1] !== 0x80) throw new Error("invalid");
  return padded.slice(0, i - 1);
}
