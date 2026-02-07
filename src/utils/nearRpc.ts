import { config, isTestnet } from "../config";
import { fetchWithRetry } from "./http";
import { createLogger } from "./logger";

const log = createLogger("nearRpc");

const DEFAULT_NEAR_RPC = isTestnet
  ? "https://rpc.testnet.near.org"
  : "https://rpc.mainnet.near.org";

function getNearRpcUrl(): string {
  return config.nearRpcUrls[0] || DEFAULT_NEAR_RPC;
}

interface NearRpcResponse<T> {
  jsonrpc: string;
  id: string;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface ViewAccountResult {
  amount: string;
  locked: string;
  code_hash: string;
  storage_usage: number;
  storage_paid_at: number;
  block_height: number;
  block_hash: string;
}

interface ViewCallResult {
  result: number[];
  logs: string[];
  block_height: number;
  block_hash: string;
}

export async function nearViewAccount(accountId: string): Promise<ViewAccountResult> {
  const rpcUrl = getNearRpcUrl();
  const response = await fetchWithRetry(
    rpcUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "dontcare",
        method: "query",
        params: {
          request_type: "view_account",
          finality: "final",
          account_id: accountId,
        },
      }),
    },
    3,
    500,
  );

  const data = (await response.json()) as NearRpcResponse<ViewAccountResult>;
  if (data.error) {
    throw new Error(`NEAR RPC error: ${data.error.message}`);
  }
  if (!data.result) {
    throw new Error("NEAR RPC returned no result");
  }
  return data.result;
}

export async function nearViewCall<T = unknown>(
  contractId: string,
  methodName: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const rpcUrl = getNearRpcUrl();
  const argsBase64 = Buffer.from(JSON.stringify(args)).toString("base64");

  const response = await fetchWithRetry(
    rpcUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "dontcare",
        method: "query",
        params: {
          request_type: "call_function",
          finality: "final",
          account_id: contractId,
          method_name: methodName,
          args_base64: argsBase64,
        },
      }),
    },
    3,
    500,
  );

  const data = (await response.json()) as NearRpcResponse<ViewCallResult>;
  if (data.error) {
    throw new Error(`NEAR RPC error: ${data.error.message}`);
  }
  if (!data.result) {
    throw new Error("NEAR RPC returned no result");
  }

  // Decode the result from bytes to JSON
  const resultBytes = new Uint8Array(data.result.result);
  const resultStr = new TextDecoder().decode(resultBytes);
  return JSON.parse(resultStr) as T;
}

export async function getNearBalance(accountId: string): Promise<string> {
  const account = await nearViewAccount(accountId);
  return account.amount;
}

export async function getFtBalance(
  tokenContractId: string,
  accountId: string,
): Promise<string> {
  try {
    const balance = await nearViewCall<string>(tokenContractId, "ft_balance_of", {
      account_id: accountId,
    });
    return balance;
  } catch (err) {
    log.warn(`getFtBalance failed for ${tokenContractId}/${accountId}`, { err: String(err) });
    return "0";
  }
}

export interface FtMetadata {
  spec: string;
  name: string;
  symbol: string;
  icon: string | null;
  reference: string | null;
  reference_hash: string | null;
  decimals: number;
}

export async function getFtMetadata(tokenContractId: string): Promise<FtMetadata> {
  return nearViewCall<FtMetadata>(tokenContractId, "ft_metadata", {});
}
