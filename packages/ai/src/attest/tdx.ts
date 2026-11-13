/**
 * Intel TDX quote (v4, ECDSA-P256 attestation key) parser and local signature-chain verifier.
 *
 * What verifyQuoteSignatures() proves, locally and without a network:
 *   - the TD report body (measurements, report_data) is signed by the attestation key in the quote;
 *   - the attestation key is bound to a Quoting Enclave report that is signed by the PCK leaf;
 *   - the PCK leaf chains (signatures, validity at `now`) to a root whose public key matches the
 *     pinned Intel SGX Root CA key.
 * What it does NOT prove: TCB level / advisory status of the platform, certificate revocation (CRLs),
 * QE identity (QE measurement policy), or PCK extension values (FMSPC, PCESVN). Those need Intel PCS
 * collateral; see AttestOptions.collateralVerifier.
 */
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesEqual, bytesToHex, concatBytes } from "../hex.js";
import { OID_EC_PUBLIC_KEY, OID_P256, OID_ECDSA_SHA256, parseX509, pemToDers, type X509 } from "./der.js";

/**
 * SHA-256 of the SubjectPublicKeyInfo DER of "Intel SGX Root CA" (the trust anchor of PCK chains).
 * Pinned from the chain inside a real NEAR AI quote on 2026-11-13 and cross-checked against the PEM
 * published by Intel at certificates.trustedservices.intel.com (see test/intel-root.test.ts, live).
 */
export const INTEL_SGX_ROOT_SPKI_SHA256 = "a0af031289f5d5d4132f9186068a7fc13628633ba235777472e29b6b6c67a49e";

export interface TdxQuote {
  version: number;
  attKeyType: number;
  teeType: number;
  /** header (48) + TD report body (584): the bytes the attestation key signs */
  signedBytes: Uint8Array;
  teeTcbSvn: Uint8Array;
  mrSeam: Uint8Array;
  tdAttributes: Uint8Array;
  xfam: Uint8Array;
  mrTd: Uint8Array;
  mrConfigId: Uint8Array;
  mrOwner: Uint8Array;
  rtmr: [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
  reportData: Uint8Array;
  // signature data
  ecdsaSig: Uint8Array;
  attestKey: Uint8Array;
  qeReport: Uint8Array;
  qeReportSig: Uint8Array;
  qeAuthData: Uint8Array;
  pckChainPem: string;
}

const HEADER = 48;
const BODY = 584;

export function parseTdxQuote(q: Uint8Array): TdxQuote {
  const dv = new DataView(q.buffer, q.byteOffset, q.byteLength);
  if (q.length < HEADER + BODY + 4) throw new Error("quote too short");
  const version = dv.getUint16(0, true);
  const attKeyType = dv.getUint16(2, true);
  const teeType = dv.getUint32(4, true);
  if (version !== 4) throw new Error(`unsupported quote version ${version}`);
  if (teeType !== 0x81) throw new Error(`not a TDX quote (tee_type 0x${teeType.toString(16)})`);
  if (attKeyType !== 2) throw new Error(`unsupported attestation key type ${attKeyType}`);
  let o = HEADER;
  const take = (n: number) => {
    if (o + n > q.length) throw new Error("quote truncated");
    const s = q.subarray(o, o + n);
    o += n;
    return s;
  };
  const teeTcbSvn = take(16);
  const mrSeam = take(48);
  take(48); // mr_signer_seam
  take(8); // seam_attributes
  const tdAttributes = take(8);
  const xfam = take(8);
  const mrTd = take(48);
  const mrConfigId = take(48);
  const mrOwner = take(48);
  take(48); // mr_owner_config
  const rtmr: Uint8Array[] = [take(48), take(48), take(48), take(48)];
  const reportData = take(64);
  if (o !== HEADER + BODY) throw new Error("internal: body size");
  const sigLen = dv.getUint32(o, true);
  o += 4;
  if (o + sigLen > q.length) throw new Error("signature data length exceeds quote");
  const ecdsaSig = take(64);
  const attestKey = take(64);
  const certType = dv.getUint16(o, true);
  o += 2;
  const certSize = dv.getUint32(o, true);
  o += 4;
  if (certType !== 6) throw new Error(`unsupported certification data type ${certType}`);
  const cd = take(certSize);
  if (cd.length < 384 + 64 + 2) throw new Error("QE certification data too short");
  const cdv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const qeReport = cd.subarray(0, 384);
  const qeReportSig = cd.subarray(384, 448);
  const authLen = cdv.getUint16(448, true);
  const qeAuthData = cd.subarray(450, 450 + authLen);
  let p = 450 + authLen;
  const innerType = cdv.getUint16(p, true);
  const innerSize = cdv.getUint32(p + 2, true);
  p += 6;
  if (innerType !== 5) throw new Error(`unsupported inner certification data type ${innerType}`);
  if (p + innerSize > cd.length) throw new Error("PCK chain truncated");
  const pckChainPem = new TextDecoder().decode(cd.subarray(p, p + innerSize)).replace(/\0+$/, "");
  return {
    version,
    attKeyType,
    teeType,
    signedBytes: q.subarray(0, HEADER + BODY),
    teeTcbSvn,
    mrSeam,
    tdAttributes,
    xfam,
    mrTd,
    mrConfigId,
    mrOwner,
    rtmr: rtmr as TdxQuote["rtmr"],
    reportData,
    ecdsaSig,
    attestKey,
    qeReport,
    qeReportSig,
    qeAuthData,
    pckChainPem,
  };
}

export interface QuoteSigCheck {
  name: "quote_signature" | "qe_report_binding" | "qe_report_signature" | "pck_chain" | "pck_root_pinned";
  ok: boolean;
  detail: string;
}

const uncompressed = (xy: Uint8Array) => concatBytes(new Uint8Array([4]), xy);

function p256Verify(sig: Uint8Array, msg: Uint8Array, pub: Uint8Array, der = false): boolean {
  try {
    return p256.verify(sig, msg, pub, { lowS: false, ...(der ? { format: "der" as const } : {}) });
  } catch {
    return false;
  }
}

function certSigOk(child: X509, issuer: X509): boolean {
  if (child.sigAlgOid !== OID_ECDSA_SHA256) return false;
  if (issuer.spkiAlgOid !== OID_EC_PUBLIC_KEY || issuer.spkiCurveOid !== OID_P256) return false;
  return p256Verify(child.signature, child.tbs, issuer.publicKey, true);
}

export function verifyQuoteSignatures(
  q: TdxQuote,
  opts: { now: number; pinnedRootSpkiSha256?: string },
): QuoteSigCheck[] {
  const out: QuoteSigCheck[] = [];
  out.push({
    name: "quote_signature",
    ok: p256Verify(q.ecdsaSig, q.signedBytes, uncompressed(q.attestKey)),
    detail: "ECDSA-P256 over quote header + TD report body with the quote's attestation key",
  });

  let chain: X509[] = [];
  let chainErr = "";
  try {
    chain = pemToDers(q.pckChainPem).map(parseX509);
    if (chain.length < 2) chainErr = `PCK chain has ${chain.length} certificate(s)`;
  } catch (e) {
    chainErr = `PCK chain unparsable: ${(e as Error).message}`;
  }

  // QE report data = SHA256(attestation key || QE auth data) || 32 zero bytes
  const qeRd = q.qeReport.subarray(320, 384);
  const expect = concatBytes(sha256(concatBytes(q.attestKey, q.qeAuthData)), new Uint8Array(32));
  out.push({
    name: "qe_report_binding",
    ok: bytesEqual(qeRd, expect),
    detail: "QE report data = SHA-256(attestation key || QE auth data), binding the attestation key to the QE report",
  });

  const leaf = chain[0];
  out.push({
    name: "qe_report_signature",
    ok: !!leaf && !chainErr && p256Verify(q.qeReportSig, q.qeReport, leaf.publicKey),
    detail: chainErr || "ECDSA-P256 over the 384-byte QE report with the PCK leaf certificate key",
  });

  if (chainErr) {
    out.push({ name: "pck_chain", ok: false, detail: chainErr });
    out.push({ name: "pck_root_pinned", ok: false, detail: chainErr });
    return out;
  }
  const problems: string[] = [];
  for (let i = 0; i < chain.length; i++) {
    const c = chain[i] as X509;
    if (opts.now < c.notBefore || opts.now > c.notAfter) problems.push(`cert ${i} not valid at the check time`);
    const issuer = i + 1 < chain.length ? (chain[i + 1] as X509) : c;
    if (!certSigOk(c, issuer)) problems.push(`cert ${i} signature does not verify under its issuer`);
    if (i + 1 < chain.length && c.issuerHex !== (chain[i + 1] as X509).subjectHex) problems.push(`cert ${i} issuer name != next subject`);
  }
  const root = chain[chain.length - 1] as X509;
  if (root.issuerHex !== root.subjectHex) problems.push("last certificate is not self-signed");
  out.push({
    name: "pck_chain",
    ok: problems.length === 0,
    detail: problems.length ? problems.join("; ") : `${chain.length} certificates, signatures and validity checked; revocation (CRL) NOT checked`,
  });
  const pin = opts.pinnedRootSpkiSha256 ?? INTEL_SGX_ROOT_SPKI_SHA256;
  const got = bytesToHex(sha256(root.spkiDer));
  out.push({
    name: "pck_root_pinned",
    ok: got === pin,
    detail: got === pin ? "root public key equals the pinned Intel SGX Root CA key" : `root SPKI sha256 ${got} != pinned ${pin}`,
  });
  return out;
}
