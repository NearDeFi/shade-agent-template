import { beforeAll, describe, expect, it } from "vitest";
import { ValidatedIntent } from "../queue/types";

const shouldRunLive =
  process.env.RUN_LIVE_SOL === "1" && process.env.NODE_ENV !== "test";

if (!shouldRunLive) {
  describe.skip("live solana swap (devnet)", () => {
    it("skipped when RUN_LIVE_SOL != 1", () => {
      expect(true).toBe(true);
    });
  });
} else {
  let solSwapFlow: typeof import("./solSwap").solSwapFlow;
  let createFlowContext: typeof import("./context").createFlowContext;
  let config: typeof import("../config").config;

  const outputMint = process.env.LIVE_SOL_OUTPUT_MINT || "";
  const liveIntent: ValidatedIntent = {
    intentId: `live-${Date.now()}`,
    sourceChain: "solana",
    destinationChain: "solana",
    sourceAsset: "So11111111111111111111111111111111111111112", // Wrapped SOL
    intermediateAsset: "So11111111111111111111111111111111111111112",
    finalAsset: outputMint,
    sourceAmount: "100000", // 0.0001 SOL
    destinationAmount: "100000",
    slippageBps: 50,
    userDestination: process.env.LIVE_SOL_DESTINATION || "",
    agentDestination: process.env.LIVE_SOL_AGENT || "",
  };

  describe("live solana swap (devnet)", () => {
    beforeAll(async () => {
      const solSwapMod = await import("./solSwap");
      const contextMod = await import("./context");
      const cfg = await import("../config");
      solSwapFlow = solSwapMod.solSwapFlow;
      createFlowContext = contextMod.createFlowContext;
      config = cfg.config;

      if (!process.env.NEXT_PUBLIC_contractId) {
        throw new Error("NEXT_PUBLIC_contractId required for live swap");
      }
      if (!outputMint) {
        throw new Error("LIVE_SOL_OUTPUT_MINT is required (SPL mint address)");
      }
      if (liveIntent.sourceAsset === outputMint) {
        throw new Error("LIVE_SOL_OUTPUT_MINT must differ from input mint");
      }
      if (!liveIntent.userDestination || !liveIntent.agentDestination) {
        throw new Error("LIVE_SOL_DESTINATION and LIVE_SOL_AGENT are required");
      }
      config.dryRunSwaps = false;
    });

    it(
      "executes a tiny SOL->SOL swap on devnet",
      async () => {
        const ctx = createFlowContext({ intentId: liveIntent.intentId, config });
        const result = await solSwapFlow.execute(liveIntent as any, ctx);
        expect(result.txId).toBeTruthy();
        console.log("Live swap tx:", result.txId);
      },
      60_000,
    );
  });
}
