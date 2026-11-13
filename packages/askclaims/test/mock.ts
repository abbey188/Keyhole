/**
 * MOCK model client. NOT a model and NOT an enclave: it implements the PrivateChat interface
 * with a scripted reply so offline tests can exercise validation. Every result it returns is
 * labelled MOCK in model id and attestation hash.
 */
import type { ChatRequest, ChatResult } from "@keyhole/ai";
import type { PrivateChat } from "../src/text.js";

export const MOCK_MODEL = "MOCK/model";

export class MockModel implements PrivateChat {
  calls: ChatRequest[] = [];
  constructor(private readonly script: (req: ChatRequest, n: number) => string | Error) {}
  async chatE2ee(req: ChatRequest): Promise<ChatResult> {
    this.calls.push(req);
    const r = this.script(req, this.calls.length);
    if (r instanceof Error) throw r;
    return {
      id: "mock-1",
      model: MOCK_MODEL,
      tier: "private",
      content: r,
      reasoning: "",
      finishReason: "stop",
      e2ee: true,
      attestation: { ok: true, complete: false, model: MOCK_MODEL, signing_algo: "ed25519", signing_address: "MOCK-ADDRESS", report_hash: "MOCK-REPORT-HASH", checks: [], not_checked: [] },
      signature: { status: "unavailable", detail: "MOCK" },
    };
  }
  /** all text the model was sent */
  sentText(): string {
    return this.calls.flatMap((c) => c.messages.map((m) => (typeof m.content === "string" ? m.content : ""))).join("\n");
  }
}
