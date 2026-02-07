import { contracts } from "chainsig.js";
import { config } from "../config";

/**
 * Singleton ChainSignatureContract instance.
 * Used by all chain adapters (Solana, Ethereum, NEAR) for MPC signing.
 */
export const chainSignatureContract: InstanceType<
  typeof contracts.ChainSignatureContract
> = new contracts.ChainSignatureContract({
  networkId: config.chainSignatureNetwork as "mainnet" | "testnet",
  contractId: config.chainSignatureContractId,
  masterPublicKey: config.chainSignatureMpcKey,
  fallbackRpcUrls: config.nearRpcUrls,
} as any);
