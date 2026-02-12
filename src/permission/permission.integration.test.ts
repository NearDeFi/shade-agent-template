/**
 * Integration tests for permission contract with real signatures
 *
 * These tests verify the full permission flow:
 * 1. Register wallet with Solana signature
 * 2. Add allowed operation with signature
 * 3. Verify operation is allowed
 * 4. Verify unauthorized operations are rejected
 * 5. Remove operation
 *
 * Run with: RUN_PERMISSION_TESTS=1 npm test -- src/permission/permission.integration.test.ts
 */

import { describe, it, expect, beforeAll } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { connect, keyStores, KeyPair, Account } from "near-api-js";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  createRegisterWalletMessage,
  createAddOperationMessage,
  createRemoveOperationMessage,
  type AllowedOperationInput,
} from "./types";

// Skip unless RUN_PERMISSION_TESTS=1
const shouldRun = process.env.RUN_PERMISSION_TESTS === "1";

// Contract and network config
const CONTRACT_ID = "permission-shade.testnet";
const NEAR_RPC = "https://rpc.testnet.near.org";

// NEAR account for signing - initialized in beforeAll
let nearAccount: Account;

// Test keypair - generate fresh for each test run
// Using nacl directly for Ed25519 keypair generation
let solanaKeypairSecret: Uint8Array;
let solanaPublicKey: Uint8Array;
let solanaPublicKeyBase58: string;
let derivationPath: string;

// Fallback RPC endpoints to handle rate limiting
const RPC_ENDPOINTS = [
  "https://rpc.testnet.near.org",
  "https://archival-rpc.testnet.near.org",
  "https://test.rpc.fastnear.com",
];

/**
 * Call a NEAR view method with retry on different endpoints
 */
async function nearView(method: string, args: Record<string, unknown>): Promise<unknown> {
  let lastError: Error | null = null;

  for (const rpc of RPC_ENDPOINTS) {
    try {
      const response = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "test",
          method: "query",
          params: {
            request_type: "call_function",
            finality: "final",
            account_id: CONTRACT_ID,
            method_name: method,
            args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
          },
        }),
      });

      const data = await response.json();
      if (data.error) {
        // If rate limited, try next endpoint
        if (data.error.code === -429 || data.error.message?.includes("DEPRECATED")) {
          lastError = new Error(data.error.message);
          continue;
        }
        throw new Error(data.error.message || JSON.stringify(data.error));
      }

      const resultBytes = data.result?.result;
      if (!resultBytes || resultBytes.length === 0) {
        return null;
      }

      return JSON.parse(Buffer.from(resultBytes).toString("utf8"));
    } catch (err: any) {
      lastError = err;
      // Continue to next endpoint on network errors
      continue;
    }
  }

  throw lastError || new Error("All RPC endpoints failed");
}

/**
 * Initialize NEAR connection with credentials
 * Tries multiple RPC endpoints to avoid rate limiting
 */
async function initNearAccount(): Promise<Account> {
  // Load credentials from ~/.near-credentials/testnet/
  const credPath = join(homedir(), ".near-credentials", "testnet", `${CONTRACT_ID}.json`);
  const credData = JSON.parse(readFileSync(credPath, "utf8"));

  const keyStore = new keyStores.InMemoryKeyStore();
  const keyPair = KeyPair.fromString(credData.private_key);
  await keyStore.setKey("testnet", CONTRACT_ID, keyPair);

  // Try fastnear first, then fall back to others
  for (const rpc of ["https://test.rpc.fastnear.com", ...RPC_ENDPOINTS]) {
    try {
      const near = await connect({
        networkId: "testnet",
        nodeUrl: rpc,
        keyStore,
      });
      const account = await near.account(CONTRACT_ID);
      // Test the connection
      await account.state();
      console.log(`Connected to NEAR via ${rpc}`);
      return account;
    } catch {
      // Try next endpoint
      continue;
    }
  }

  throw new Error("Failed to connect to any NEAR RPC endpoint");
}

/**
 * Call a NEAR change method (requires credentials)
 */
async function nearCall(
  method: string,
  args: Record<string, unknown>,
  gas: bigint = BigInt("100000000000000"), // Default: 100 TGas
): Promise<{ success: boolean; error?: string }> {
  try {
    const result = await nearAccount.functionCall({
      contractId: CONTRACT_ID,
      methodName: method,
      args,
      gas,
    });

    console.log(`[nearCall] ${method} success, tx: ${result.transaction.hash}`);

    // Check if there's a failure in the receipts
    const hasFailure = result.receipts_outcome?.some(
      (r: any) => r.outcome?.status?.Failure
    );

    return { success: !hasFailure };
  } catch (err: any) {
    console.error(`[nearCall] ${method} error:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Generate a Solana-compatible Ed25519 keypair using nacl
 */
function generateSolanaKeypair(): { secretKey: Uint8Array; publicKey: Uint8Array; publicKeyBase58: string } {
  const kp = nacl.sign.keyPair();
  return {
    secretKey: kp.secretKey,
    publicKey: kp.publicKey,
    publicKeyBase58: bs58.encode(kp.publicKey),
  };
}

/**
 * Sign a message with Ed25519 keypair
 */
function signWithSolana(message: string, secretKey: Uint8Array): Uint8Array {
  const messageBytes = new TextEncoder().encode(message);
  return nacl.sign.detached(messageBytes, secretKey);
}

describe.skipIf(!shouldRun)("Permission Contract Integration", () => {
  beforeAll(async () => {
    // Initialize NEAR account for signing
    nearAccount = await initNearAccount();

    // Generate fresh keypair for tests
    const kp = generateSolanaKeypair();
    solanaKeypairSecret = kp.secretKey;
    solanaPublicKey = kp.publicKey;
    solanaPublicKeyBase58 = kp.publicKeyBase58;
    derivationPath = `test-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    console.log("Test setup:");
    console.log("  Derivation path:", derivationPath);
    console.log("  Solana pubkey:", solanaPublicKeyBase58);
  });

  describe("View Methods", () => {
    it("should get contract config", async () => {
      const config = await nearView("get_config", {});
      expect(config).toBeDefined();
      expect((config as any).owner).toBe("permission-shade.testnet");
      expect((config as any).mpc_contract).toBe("v1.signer-prod.testnet");
    });

    it("should return empty operations for new path", async () => {
      const ops = await nearView("get_operations", { derivation_path: derivationPath });
      expect(ops).toEqual([]);
    });

    it("should return false for unknown operation", async () => {
      const allowed = await nearView("is_operation_allowed", {
        derivation_path: derivationPath,
        operation_id: "nonexistent",
      });
      expect(allowed).toBe(false);
    });
  });

  describe("Wallet Registration", () => {
    it("should create valid registration message", () => {
      const message = createRegisterWalletMessage(
        derivationPath,
        "Solana",
        solanaPublicKey,
        solanaPublicKeyBase58,
        1,
      );

      // Message is now a plain string format (not JSON)
      expect(message).toBe(`Register wallet for derivation path: ${derivationPath} with nonce: 1`);
    });

    it("should sign registration message with Solana key", () => {
      const message = createRegisterWalletMessage(
        derivationPath,
        "Solana",
        solanaPublicKey,
        solanaPublicKeyBase58,
        1,
      );

      const signature = signWithSolana(message, solanaKeypairSecret);
      expect(signature.length).toBe(64); // Ed25519 signature is 64 bytes

      // Verify signature locally
      const messageBytes = new TextEncoder().encode(message);
      const isValid = nacl.sign.detached.verify(
        messageBytes,
        signature,
        solanaPublicKey,
      );
      expect(isValid).toBe(true);
    });

    it("should register wallet on contract", async () => {
      const message = createRegisterWalletMessage(
        derivationPath,
        "Solana",
        solanaPublicKey,
        solanaPublicKeyBase58,
        1,
      );

      const signature = signWithSolana(message, solanaKeypairSecret);
      const messageBytes = new TextEncoder().encode(message);

      const result = await nearCall("register_wallet", {
        derivation_path: derivationPath,
        wallet_type: "Solana",
        public_key: Array.from(solanaPublicKey),
        chain_address: solanaPublicKeyBase58,
        signature: Array.from(signature),
        message: Array.from(messageBytes),
        nonce: 1,
      });

      expect(result.success).toBe(true);
    });
  });

  describe("Operation Management", () => {
    let operationId: string;

    it("should add allowed operation with signature", async () => {
      const operation: AllowedOperationInput = {
        operation_type: {
          type: "LimitOrder",
          price_asset: "SOL",
          quote_asset: "USDC",
          trigger_price: "150000000", // $150
          condition: "Above",
          source_asset: "USDC",
          target_asset: "SOL",
          max_amount: "100000000", // 100 USDC
        },
        destination_address: solanaPublicKeyBase58,
        destination_chain: "solana",
        slippage_bps: 100, // 1%
      };

      // Get current nonce (should be 2 after registration)
      const message = createAddOperationMessage(derivationPath, operation, 2);
      const signature = signWithSolana(message, solanaKeypairSecret);
      const messageBytes = new TextEncoder().encode(message);

      const result = await nearCall("add_allowed_operation", {
        derivation_path: derivationPath,
        operation,
        signature: Array.from(signature),
        message: Array.from(messageBytes),
        signer_address: solanaPublicKeyBase58,
      });

      expect(result.success).toBe(true);
    });

    it("should find operation in list", async () => {
      const ops = await nearView("get_operations", { derivation_path: derivationPath });
      expect(Array.isArray(ops)).toBe(true);

      if (Array.isArray(ops) && ops.length > 0) {
        operationId = (ops[0] as any).operation_id;
        console.log("Found operation:", operationId);

        expect((ops[0] as any).operation_type.type).toBe("LimitOrder");
        expect((ops[0] as any).executed).toBe(false);
      }
    });

    it("should return true for allowed operation", async () => {
      // Get operations to find the ID
      const ops = await nearView("get_operations", { derivation_path: derivationPath });

      if (Array.isArray(ops) && ops.length > 0) {
        const opId = (ops[0] as any).operation_id;

        const allowed = await nearView("is_operation_allowed", {
          derivation_path: derivationPath,
          operation_id: opId,
        });
        expect(allowed).toBe(true);
      }
    });

    it("should return false for different operation ID", async () => {
      const allowed = await nearView("is_operation_allowed", {
        derivation_path: derivationPath,
        operation_id: "fake-operation-id",
      });
      expect(allowed).toBe(false);
    });

    it("should return false for different derivation path", async () => {
      const ops = await nearView("get_operations", { derivation_path: derivationPath });

      if (Array.isArray(ops) && ops.length > 0) {
        const opId = (ops[0] as any).operation_id;

        const allowed = await nearView("is_operation_allowed", {
          derivation_path: "different-path",
          operation_id: opId,
        });
        expect(allowed).toBe(false);
      }
    });
  });

  describe("Operation Constraints", () => {
    it("should reject invalid signature", async () => {
      const operation: AllowedOperationInput = {
        operation_type: {
          type: "Swap",
          source_asset: "USDC",
          target_asset: "SOL",
          max_amount: "50000000",
        },
        destination_address: solanaPublicKeyBase58,
        destination_chain: "solana",
        slippage_bps: 50,
      };

      const message = createAddOperationMessage(derivationPath, operation, 3);
      const messageBytes = new TextEncoder().encode(message);

      // Create invalid signature (random bytes)
      const invalidSignature = new Uint8Array(64).fill(1);

      const result = await nearCall("add_allowed_operation", {
        derivation_path: derivationPath,
        operation,
        signature: Array.from(invalidSignature),
        message: Array.from(messageBytes),
        signer_address: solanaPublicKeyBase58,
      });

      // Should fail due to invalid signature
      expect(result.success).toBe(false);
    });

    it("should reject operation for unregistered wallet", async () => {
      // Generate a different keypair that isn't registered for this derivation path
      const unregistered = generateSolanaKeypair();

      const operation: AllowedOperationInput = {
        operation_type: {
          type: "Swap",
          source_asset: "USDC",
          target_asset: "SOL",
          max_amount: "50000000",
        },
        destination_address: unregistered.publicKeyBase58,
        destination_chain: "solana",
        slippage_bps: 50,
      };

      const message = createAddOperationMessage(derivationPath, operation, 99);
      const signature = signWithSolana(message, unregistered.secretKey);
      const messageBytes = new TextEncoder().encode(message);

      const result = await nearCall("add_allowed_operation", {
        derivation_path: derivationPath,
        operation,
        signature: Array.from(signature),
        message: Array.from(messageBytes),
        signer_address: unregistered.publicKeyBase58,
      });

      // Should fail because the signer is not authorized for this derivation path
      expect(result.success).toBe(false);
    });
  });

  describe("Operation Removal", () => {
    let removedOperationId: string | null = null;

    it("should remove operation with valid signature", async () => {
      // First get the operation ID
      const ops = await nearView("get_operations", { derivation_path: derivationPath });
      console.log("Operations before removal:", JSON.stringify(ops, null, 2));

      if (Array.isArray(ops) && ops.length > 0) {
        const opId = (ops[0] as any).operation_id;
        removedOperationId = opId;
        console.log("Removing operation:", opId);

        // Create remove message with next nonce
        const message = createRemoveOperationMessage(derivationPath, opId, 4);
        const signature = signWithSolana(message, solanaKeypairSecret);
        const messageBytes = new TextEncoder().encode(message);

        const result = await nearCall("remove_allowed_operation", {
          derivation_path: derivationPath,
          operation_id: opId,
          signature: Array.from(signature),
          message: Array.from(messageBytes),
          signer_address: solanaPublicKeyBase58,
        });

        console.log("Remove result:", result);
        expect(result.success).toBe(true);
      } else {
        console.log("No operations to remove - test setup issue");
      }
    });

    it("should verify operation was removed", async () => {
      // Wait for NEAR blockchain to sync
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const ops = await nearView("get_operations", { derivation_path: derivationPath });
      console.log("Operations after removal:", JSON.stringify(ops, null, 2));

      if (removedOperationId && Array.isArray(ops)) {
        const found = ops.find((op: any) => op.operation_id === removedOperationId);
        console.log("Looking for:", removedOperationId, "Found:", found);
        expect(found).toBeUndefined();
      }
    });
  });
});

describe.skipIf(!shouldRun)("MPC Signing Flow", () => {
  let testDerivationPath: string;
  let testSecretKey: Uint8Array;
  let testPublicKey: Uint8Array;
  let testPublicKeyBase58: string;
  let testOperationId: string;

  beforeAll(async () => {
    // Initialize NEAR account if not already done
    if (!nearAccount) {
      nearAccount = await initNearAccount();
    }
    const kp = generateSolanaKeypair();
    testSecretKey = kp.secretKey;
    testPublicKey = kp.publicKey;
    testPublicKeyBase58 = kp.publicKeyBase58;
    testDerivationPath = `mpc-test-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  });

  it("should register wallet for MPC test", async () => {
    const message = createRegisterWalletMessage(
      testDerivationPath,
      "Solana",
      testPublicKey,
      testPublicKeyBase58,
      1,
    );

    const signature = signWithSolana(message, testSecretKey);
    const messageBytes = new TextEncoder().encode(message);

    const result = await nearCall("register_wallet", {
      derivation_path: testDerivationPath,
      wallet_type: "Solana",
      public_key: Array.from(testPublicKey),
      chain_address: testPublicKeyBase58,
      signature: Array.from(signature),
      message: Array.from(messageBytes),
      nonce: 1,
    });

    console.log("MPC test - wallet registered:", result.success);
    expect(result.success).toBe(true);
  }, 30000); // 30 second timeout for blockchain calls

  it("should add a Swap operation for MPC test", async () => {
    const operation: AllowedOperationInput = {
      operation_type: {
        type: "Swap",
        source_asset: "USDC",
        target_asset: "SOL",
        max_amount: "1000000", // 1 USDC
      },
      destination_address: testPublicKeyBase58,
      destination_chain: "solana",
      slippage_bps: 100,
    };

    const message = createAddOperationMessage(testDerivationPath, operation, 2);
    const signature = signWithSolana(message, testSecretKey);
    const messageBytes = new TextEncoder().encode(message);

    const result = await nearCall("add_allowed_operation", {
      derivation_path: testDerivationPath,
      operation,
      signature: Array.from(signature),
      message: Array.from(messageBytes),
      signer_address: testPublicKeyBase58,
    });

    console.log("MPC test - operation added:", result.success);
    expect(result.success).toBe(true);

    // Wait for blockchain to sync before fetching
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Get the operation ID
    const ops = await nearView("get_operations", { derivation_path: testDerivationPath });
    console.log("MPC test - operations found:", ops);
    if (Array.isArray(ops) && ops.length > 0) {
      testOperationId = (ops[0] as any).operation_id;
      console.log("MPC test - operation ID:", testOperationId);
    }
    expect(testOperationId).toBeDefined();
  }, 30000); // 30 second timeout

  it("should call sign_allowed and get MPC signature", async () => {
    if (!testOperationId) {
      console.log("Skipping - no operation ID from previous test");
      return;
    }

    // Create a test payload (32 bytes - typical for Ed25519 signing)
    // In real usage, this would be actual transaction bytes
    const testPayload = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      testPayload[i] = i;
    }

    console.log("MPC test - calling sign_allowed with:");
    console.log("  derivation_path:", testDerivationPath);
    console.log("  operation_id:", testOperationId);
    console.log("  payload length:", testPayload.length);

    // Call sign_allowed - this makes a cross-contract call to MPC
    // Note: This requires the contract to have enough NEAR for the MPC fee
    // Using 300 TGas (max) because MPC cross-contract calls are expensive
    const result = await nearCall("sign_allowed", {
      derivation_path: testDerivationPath,
      operation_id: testOperationId,
      payload: Array.from(testPayload),
      key_type: "Eddsa",
      tee_price: null,
      tee_timestamp: null,
    }, BigInt("300000000000000")); // 300 TGas for MPC cross-contract call

    console.log("MPC test - sign_allowed result:", result);

    // The call should succeed - MPC contract signs and returns signature
    expect(result.success).toBe(true);
  }, 60000); // 60 second timeout for MPC call

  it("should mark operation as executed after signing", async () => {
    if (!testOperationId) {
      console.log("Skipping - no operation ID");
      return;
    }

    // Wait for blockchain to sync
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Check that the operation is now marked as executed
    const allowed = await nearView("is_operation_allowed", {
      derivation_path: testDerivationPath,
      operation_id: testOperationId,
    });

    console.log("MPC test - operation still allowed:", allowed);

    // After sign_allowed, the operation should be marked as executed
    // so is_operation_allowed should return false
    expect(allowed).toBe(false);
  }, 30000); // 30 second timeout
});

describe.skipIf(!shouldRun)("Signature Verification", () => {
  it("should verify Solana Ed25519 signature", () => {
    const kp = nacl.sign.keyPair();
    const message = "test message for signing";
    const messageBytes = new TextEncoder().encode(message);

    const signature = nacl.sign.detached(messageBytes, kp.secretKey);

    const isValid = nacl.sign.detached.verify(
      messageBytes,
      signature,
      kp.publicKey,
    );

    expect(isValid).toBe(true);
  });

  it("should fail for tampered message", () => {
    const kp = nacl.sign.keyPair();
    const message = "original message";
    const messageBytes = new TextEncoder().encode(message);

    const signature = nacl.sign.detached(messageBytes, kp.secretKey);

    const tamperedMessage = new TextEncoder().encode("tampered message");
    const isValid = nacl.sign.detached.verify(
      tamperedMessage,
      signature,
      kp.publicKey,
    );

    expect(isValid).toBe(false);
  });

  it("should fail for wrong public key", () => {
    const kp1 = nacl.sign.keyPair();
    const kp2 = nacl.sign.keyPair();
    const message = "test message";
    const messageBytes = new TextEncoder().encode(message);

    const signature = nacl.sign.detached(messageBytes, kp1.secretKey);

    const isValid = nacl.sign.detached.verify(
      messageBytes,
      signature,
      kp2.publicKey,
    );

    expect(isValid).toBe(false);
  });
});
