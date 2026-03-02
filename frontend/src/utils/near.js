import { JsonRpcProvider } from "@near-js/providers";
import { NEAR_NETWORK } from "../config.js";
import { getAgentContractId } from "./agent.js";

const NEAR_RPC_URL =
  NEAR_NETWORK === "mainnet"
    ? "https://free.rpc.fastnear.com"
    : "https://test.rpc.fastnear.com";

const provider = new JsonRpcProvider({ url: NEAR_RPC_URL });

export async function getIsTee() {
  try {
    const contractId = await getAgentContractId();
    const res = await provider.callFunction(
      contractId,
      "get_contract_info",
      {},
    );
    return res?.requires_tee ?? false;
  } catch (error) {
    console.error("Failed to get contract info:", error);
    return null;
  }
}

export async function getApprovedPpids() {
  try {
    const contractId = await getAgentContractId();
    const res = await provider.callFunction(contractId, "get_approved_ppids", {
      from_index: null,
      limit: null,
    });
    return res ?? [];
  } catch (error) {
    console.error("Failed to get approved PPIDs:", error);
    return [];
  }
}

export async function getApprovedMeasurements() {
  try {
    const contractId = await getAgentContractId();
    const res = await provider.callFunction(
      contractId,
      "get_approved_measurements",
      {
        from_index: null,
        limit: null,
      },
    );
    return res ?? [];
  } catch (error) {
    console.error("Failed to get approved measurements:", error);
    return [];
  }
}

export async function getAgents() {
  try {
    const contractId = await getAgentContractId();
    const res = await provider.callFunction(contractId, "get_agents", {
      from_index: null,
      limit: null,
    });
    return res ?? [];
  } catch (error) {
    console.error("Failed to get agents:", error);
    return [];
  }
}
