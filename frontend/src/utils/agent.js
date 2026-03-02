import { API_URL } from "../config.js";

let agentContractIdPromise = null;

export async function getAgentInfo() {
  const res = await fetch(`${API_URL}/api/agent-info`).then((r) => r.json());
  return res;
}

export async function getAgentContractId() {
  if (!agentContractIdPromise) {
    agentContractIdPromise = getAgentInfo().then((res) => res.agentContractId);
  }
  return agentContractIdPromise;
}

export async function getEthInfo() {
  const res = await fetch(`${API_URL}/api/eth-info`).then((r) => r.json());
  return res;
}

export async function submitTransaction() {
  const res = await fetch(`${API_URL}/api/transaction`).then((r) => r.json());
  return res;
}
