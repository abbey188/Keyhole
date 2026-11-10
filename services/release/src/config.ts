import { ConfigError, accountVar, hexVar, intVar, requireVar, rpcUrls, testnetOnly } from "@keyhole/node";

export { ConfigError };

export interface ReleaseConfig {
  contractId: string;
  chainId: "testnet";
  rpcUrls: string[];
  /** Release-service signing seed; its public key is in the contract's `rs_keys` at `idx`. */
  seed: Uint8Array;
  idx: number;
  /** 32-byte key that encrypts grant material and deal key halves at rest. Separate from the signing seed. */
  storeKey: Uint8Array;
  port: number;
  host: string;
  dataDir: string;
  segmentsPerMinute: number;
  perIpPerMinute: number;
  relayerAccount: string;
  relayerKey: string;
}

type Env = Record<string, string | undefined>;

export function loadReleaseConfig(env: Env): ReleaseConfig {
  const seed = hexVar(env, "RS_SIGNING_SEED", 32);
  const storeKey = hexVar(env, "RS_STORE_KEY", 32);
  if (Buffer.from(seed).equals(Buffer.from(storeKey))) throw new ConfigError("RS_STORE_KEY must differ from RS_SIGNING_SEED");
  return {
    contractId: accountVar(env, "KEYHOLE_CONTRACT"),
    chainId: testnetOnly(env),
    rpcUrls: rpcUrls(env),
    seed,
    idx: intVar(env, "RS_IDX", 0, 0, 15),
    storeKey,
    port: intVar(env, "RELEASE_PORT", 8788, 1, 65535),
    host: env.RELEASE_HOST ?? "127.0.0.1",
    dataDir: env.RELEASE_DATA_DIR ?? "./data/release",
    segmentsPerMinute: intVar(env, "RS_SEGMENTS_PER_MINUTE", 30, 1, 10_000),
    perIpPerMinute: intVar(env, "RS_PER_IP_PER_MINUTE", 600, 1, 1_000_000),
    relayerAccount: accountVar(env, "RELAYER_ACCOUNT"),
    relayerKey: requireVar(env, "RELAYER_PRIVATE_KEY"),
  };
}
