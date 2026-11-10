import type {
  BlobView, BoxView, ConfigView, DealView, GrantArgs, GrantView, KeyholeEvent, SessionView, TxResult, ValidView,
} from "./types.js";

/** The chain (RPC) cannot be reached or is not final. Services fail closed on this (spec 05 section 7.5). */
export class ChainUnavailable extends Error {
  constructor(message = "chain unavailable") {
    super(message);
    this.name = "ChainUnavailable";
  }
}

/** The contract rejected a call (panic message preserved). */
export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

/**
 * Read access to the contract at FINAL finality only. Authorization decisions in services and nodes use
 * nothing else, and time comes only from `finalTimeMs` (never the local clock).
 * Every method throws ChainUnavailable if the answer cannot be obtained at final.
 */
export interface ChainReader {
  readonly chainId: string;
  readonly contractId: string;
  /** Timestamp (ms) of the latest final block. */
  finalTimeMs(): Promise<number>;
  config(): Promise<ConfigView>;
  box(boxId: string): Promise<BoxView | null>;
  grant(grantId: string): Promise<GrantView | null>;
  grantValid(grantId: string): Promise<ValidView>;
  session(sessionId: string): Promise<SessionView | null>;
  blob(blobId: string): Promise<BlobView | null>;
  deal(dealId: string): Promise<DealView | null>;
  /** Keyhole events emitted by a transaction, once it is final; null if the transaction is unknown or not final. */
  txEvents(txHash: string, signerId: string): Promise<KeyholeEvent[] | null>;
  /** True if `pkHex` (Ed25519 public key, hex) is a full-access key of `account` at final. */
  hasFullAccessKey(account: string, pkHex: string): Promise<boolean>;
}

/**
 * Calls the contract as one account. Each call resolves when the transaction is FINAL, with its events,
 * and rejects with ContractError if the contract panicked.
 */
export interface ChainWriter {
  readonly account: string;
  // anyone may call (relayer)
  openSession(a: { grantId: string; sessionId: string; sessionPk: string; tsMs: number; reqSig?: string }): Promise<TxResult>;
  closeSession(a: { sessionId: string; logRoot: string; closedAtMs: number; rsIdx: number; rsSig: string }): Promise<TxResult>;
  certifyBlob(blobId: string, acks: { idx: number; sig: string }[]): Promise<TxResult>;
  attestErasure(blobId: string, idx: number, sig: string): Promise<TxResult>;
  // box owner
  createBox(a: { boxId: string; kind: "Bound" | "Handover"; wrappedBmk: Uint8Array; maxGrantMs: number }): Promise<TxResult>;
  createGrant(g: GrantArgs): Promise<TxResult>;
  revokeGrant(grantId: string): Promise<TxResult>;
  registerBlob(a: { blobId: string; boxId: string; size: number; days: number }): Promise<TxResult>;
  activateBlob(blobId: string): Promise<TxResult>;
  commitManifest(a: { boxId: string; manifestBlob: string; seq: number }): Promise<TxResult>;
  retireBlob(blobId: string): Promise<TxResult>;
}

export interface DealArgs {
  dealId: string;
  boxId: string;
  buyer: string;
  priceYocto: string;
  waitingMs: number;
  offerExpiresAtMs: number;
  bmkCommit: string;
  envelopeBlob: string;
  s2Commit: string;
}

/** Deal methods (spec 06). Implemented by the real writer; FakeChain only has `setDeal` for now. */
export interface DealApi {
  readonly account: string;
  createDeal(a: DealArgs): Promise<TxResult>;
  fundDeal(dealId: string, priceYocto: string): Promise<TxResult>;
  cancelDeal(dealId: string): Promise<TxResult>;
  completeDeal(dealId: string): Promise<TxResult>;
  expireDeal(dealId: string): Promise<TxResult>;
  claim(): Promise<TxResult>;
}
