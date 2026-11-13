/**
 * Minimal DER / X.509 reader, only what chain verification needs: tbsCertificate bytes, issuer and
 * subject (raw), validity, EC public key, signature algorithm OID and signature value.
 * It does NOT parse extensions and does NOT check key usage or basic constraints.
 */
import { bytesToHex } from "../hex.js";

export interface Tlv {
  tag: number;
  /** full encoding (header + body) */
  raw: Uint8Array;
  body: Uint8Array;
}

export function readTlv(buf: Uint8Array, off = 0): { tlv: Tlv; next: number } {
  if (off + 2 > buf.length) throw new Error("DER: truncated");
  const tag = buf[off] as number;
  let len = buf[off + 1] as number;
  let p = off + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error("DER: unsupported length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + (buf[p++] as number);
  }
  if (p + len > buf.length) throw new Error("DER: length exceeds buffer");
  return { tlv: { tag, raw: buf.subarray(off, p + len), body: buf.subarray(p, p + len) }, next: p + len };
}

export function children(t: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let off = 0;
  while (off < t.body.length) {
    const { tlv, next } = readTlv(t.body, off);
    out.push(tlv);
    off = next;
  }
  return out;
}

export function oidToString(body: Uint8Array): string {
  const parts: number[] = [];
  let v = 0;
  for (const b of body) {
    v = v * 128 + (b & 0x7f);
    if (!(b & 0x80)) {
      parts.push(v);
      v = 0;
    }
  }
  const first = parts.shift() as number;
  const a = first < 80 ? Math.floor(first / 40) : 2;
  return [a, first - a * 40, ...parts].join(".");
}

function parseTime(t: Tlv): number {
  const s = new TextDecoder().decode(t.body);
  let m: RegExpMatchArray | null;
  let y: number;
  if (t.tag === 0x17) {
    m = s.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/);
    if (!m) throw new Error("DER: bad UTCTime");
    const yy = Number(m[1]);
    y = yy >= 50 ? 1900 + yy : 2000 + yy;
  } else if (t.tag === 0x18) {
    m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/);
    if (!m) throw new Error("DER: bad GeneralizedTime");
    y = Number(m[1]);
  } else throw new Error("DER: not a time");
  const g = (i: number) => Number((m as RegExpMatchArray)[i]);
  const idx = t.tag === 0x17 ? 2 : 2;
  return Date.UTC(y, g(idx) - 1, g(idx + 1), g(idx + 2), g(idx + 3), g(idx + 4));
}

export interface X509 {
  der: Uint8Array;
  tbs: Uint8Array;
  issuerHex: string;
  subjectHex: string;
  notBefore: number;
  notAfter: number;
  sigAlgOid: string;
  /** DER ECDSA-Sig-Value */
  signature: Uint8Array;
  spkiAlgOid: string;
  spkiCurveOid: string;
  /** uncompressed EC point 0x04||X||Y */
  publicKey: Uint8Array;
  spkiDer: Uint8Array;
}

export function parseX509(der: Uint8Array): X509 {
  const cert = readTlv(der, 0).tlv;
  if (cert.tag !== 0x30) throw new Error("X509: not a SEQUENCE");
  const [tbs, sigAlg, sigVal] = children(cert);
  if (!tbs || !sigAlg || !sigVal || sigVal.tag !== 0x03) throw new Error("X509: bad structure");
  const f = children(tbs);
  let i = 0;
  if ((f[0] as Tlv).tag === 0xa0) i++; // version
  i++; // serial
  i++; // signature alg
  const issuer = f[i++] as Tlv;
  const validity = children(f[i++] as Tlv);
  const subject = f[i++] as Tlv;
  const spki = f[i++] as Tlv;
  if (!issuer || validity.length !== 2 || !subject || !spki) throw new Error("X509: bad TBS");
  const [spkiAlg, spkiKey] = children(spki);
  if (!spkiAlg || !spkiKey || spkiKey.tag !== 0x03) throw new Error("X509: bad SPKI");
  const algParts = children(spkiAlg);
  const sigAlgOid = oidToString((children(sigAlg)[0] as Tlv).body);
  return {
    der,
    tbs: tbs.raw,
    issuerHex: bytesToHex(issuer.raw),
    subjectHex: bytesToHex(subject.raw),
    notBefore: parseTime(validity[0] as Tlv),
    notAfter: parseTime(validity[1] as Tlv),
    sigAlgOid,
    signature: sigVal.body.subarray(1),
    spkiAlgOid: oidToString((algParts[0] as Tlv).body),
    spkiCurveOid: algParts[1] ? oidToString(algParts[1].body) : "",
    publicKey: spkiKey.body.subarray(1),
    spkiDer: spki.raw,
  };
}

export function pemToDers(pem: string): Uint8Array[] {
  const out: Uint8Array[] = [];
  const re = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pem))) {
    const b64 = (m[1] as string).replace(/\s+/g, "");
    const bin = atob(b64);
    const d = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) d[i] = bin.charCodeAt(i);
    out.push(d);
  }
  return out;
}

export const OID_EC_PUBLIC_KEY = "1.2.840.10045.2.1";
export const OID_P256 = "1.2.840.10045.3.1.7";
export const OID_P384 = "1.3.132.0.34";
export const OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2";
export const OID_ECDSA_SHA384 = "1.2.840.10045.4.3.3";
