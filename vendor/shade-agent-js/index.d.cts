import { Account } from '@near-js/accounts';

interface DeriveKeyResponse {
    key: string;
    certificate_chain: string[];
    asUint8Array: (max_length?: number) => Uint8Array;
}
type Hex = `0x${string}`;
type TdxQuoteHashAlgorithms = 'sha256' | 'sha384' | 'sha512' | 'sha3-256' | 'sha3-384' | 'sha3-512' | 'keccak256' | 'keccak384' | 'keccak512' | 'raw';
interface TdxQuoteResponse {
    quote: Hex;
    event_log: string;
    replayRtmrs: () => string[];
}
declare class TappdClient {
    private endpoint;
    constructor(endpoint?: string);
    getInfo(): Promise<any>;
    extendRtmr3(event: string, payload: string | object): Promise<any>;
    deriveKey(path?: string, subject?: string, alt_names?: string[]): Promise<DeriveKeyResponse>;
    tdxQuote(report_data: string | Buffer | Uint8Array, hash_algorithm?: TdxQuoteHashAlgorithms): Promise<TdxQuoteResponse>;
}

declare const parseNearAmount: (amt: any) => bigint;
declare const networkId: string;
/**
 * Sets a key pair for an account in the in-memory keystore
 * @param {string} accountId - NEAR account ID
 * @param {string} secretKey - Account's secret key
 */
declare const setKey: (accountId: any, secretKey: any) => void;
/**
 * Converts a public key string to an implicit account ID
 * @param {string} pubKeyStr - Public key string
 * @returns {string} Implicit account ID (hex encoded)
 */
declare const getImplicit: (pubKeyStr: any) => string;
/**
 * Creates a NEAR Account instance
 * @param {string} [id=_accountId] - NEAR account ID
 * @returns {Account} NEAR Account instance
 */
declare const getAccount: (id?: any) => Account;
/**
 * Returns the current account ID (typically the agent account after setKey has been called in deriveAgentAccount)
 * @returns {String} Agent Account ID
 */
declare const getCurrentAccountId: () => any;
/**
 * Gets the balance of a NEAR account
 * @param {string} accountId - NEAR account ID
 * @returns {Promise<{available: string}>} Account balance
 */
declare const getBalance: (accountId: any) => Promise<bigint>;
/**
 * Calls a view method on a NEAR contract
 * @param {string} [contractId = _contractId] - Contract ID to call, default is the contractId from env, _contractId
 * @param {string} methodName - Contract method name
 * @param {Object} args - Method arguments
 * @returns {Promise<any>} Method result
 */
declare const contractView: ({ contractId, methodName, args, }: {
    contractId?: string;
    methodName: any;
    args?: {};
}) => Promise<any>;
/**
 * Calls a change method on a NEAR contract
 * @param {string} methodName - Contract method name
 * @param {Object} args - Method arguments
 * @param {string} [accountId = _accountId] - Account ID to use for the call, default is the agent account ID, _accountId
 * @param {string} [contractId = _contractId] - Contract ID to call, default is the contractId from env, _contractId
 * @param {bigint} [gas] - gas
 * @param {bigint} [deposit='0'] - near to attach in yoctoNEAR
 * @returns {Promise<any>} Transaction result
 */
declare const contractCall: ({ accountId, contractId, methodName, args, gas, deposit, }: {
    accountId?: any;
    contractId?: string;
    methodName: any;
    args: any;
    gas?: bigint;
    deposit?: bigint;
}) => Promise<any>;

/**
 * Derives a worker account using TEE-based entropy
 * @param {Buffer | undefined} hash - User provided hash for seed phrase generation. When undefined, it will try to use TEE hardware entropy or JS crypto.
 * @returns {Promise<string>} The derived account ID
 */
declare function deriveAgentAccount(hash: Buffer | undefined): Promise<string>;
/**
 * Registers a worker with the contract
 * @param {String | undefined} codehash - User provided codehash for proxy contract, running locally and NOT in a TEE
 * @returns {Promise<boolean>} Result of the registration
 */
declare function registerAgent(codehash: String | undefined): Promise<any>;

/**
 * @typedef {Object} ContractArgs
 * @property {string} methodName - The name of the method to call.
 * @property {Object} args - The arguments to pass to the method.
 */
type ContractArgs = {
    methodName: string;
    args: Record<string, any>;
};
/**
 * Calls a method on the agent account instance inside the API
 *
 * @param {string} methodName - The name of the agent method to call
 * @param {any} args - Arguments to pass to the agent account method
 * @returns A promise that resolves with the result of the agent method call.
 */
declare function agent(methodName: string, args?: any): Promise<any>;
/**
 * Retrieves the account ID of the agent.
 *
 * @returns {Promise<any>} A promise that resolves to the agent's account ID.
 */
declare const agentAccountId: () => Promise<{
    accountId: string;
}>;
/**
 * Retrieves the agent's record from the agent contract
 *
 * @returns {Promise<any>} A promise that resolves to the agent's account ID.
 */
declare const agentInfo: () => Promise<{
    codehash: string;
    checksum: string;
}>;
/**
 * Contract view from agent account inside the API
 *
 * @param {ContractArgs} args - The arguments for the contract view method.
 * @returns A promise that resolves with the result of the view method.
 */
declare const agentView: (args: ContractArgs) => Promise<any>;
/**
 * Contract call from agent account inside the API
 *
 * @param {ContractArgs} args - The arguments for the contract call method.
 * @returns A promise that resolves with the result of the call method.
 */
declare const agentCall: (args: ContractArgs) => Promise<any>;
declare enum SignatureKeyType {
    Eddsa = "Eddsa",
    Ecdsa = "Ecdsa"
}
/**
 * Requests a digital signature from the agent for a given payload and path.
 *
 * @param {Object} params - The parameters for the signature request.
 * @param {string} params.path - The path associated with the signature request.
 * @param {string} params.payload - The payload to be signed.
 * @param {SignatureKeyType} [params.keyType='Ecdsa'] - The type of key to use for signing (default is 'Ecdsa').
 * @returns A promise that resolves with the result of the signature request.
 */
declare const requestSignature: ({ path, payload, keyType, }: {
    path: string;
    payload: string;
    keyType?: SignatureKeyType;
}) => Promise<any>;

export { TappdClient, agent, agentAccountId, agentCall, agentInfo, agentView, contractCall, contractView, deriveAgentAccount, getAccount, getBalance, getCurrentAccountId, getImplicit, networkId, parseNearAmount, registerAgent, requestSignature, setKey };
