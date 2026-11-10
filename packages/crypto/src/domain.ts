import { concatBytes, utf8 } from "./bytes.js";

export const PREFIX = "keyhole/v1/";

/** `keyhole/v1/<purpose>` followed by a zero byte. */
export function tag(purpose: string): Uint8Array {
  return concatBytes(utf8(PREFIX + purpose), new Uint8Array([0]));
}
