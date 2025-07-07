declare module '@neardefi/shade-agent-js' {
  export interface AgentAccount {
    workerAccountId: string;
  }

  export interface Balance {
    available: string;
  }

  export function getAgentAccount(): Promise<AgentAccount>;
  export function getBalance(accountId: string): Promise<Balance>;
  export function signWithAgent(path: string, hashToSign: any): Promise<any>;
} 