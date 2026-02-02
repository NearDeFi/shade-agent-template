/**
 * Integration tests for the permission module
 *
 * These tests verify the TypeScript types and message creation.
 * For full integration with NEAR, deploy the contract to testnet first.
 */

import { describe, it, expect } from "vitest";
import {
  createRegisterWalletMessage,
  createAddOperationMessage,
  createRemoveOperationMessage,
  type AllowedOperationInput,
  type WalletType,
} from "./types";

describe("Permission Types", () => {
  describe("createRegisterWalletMessage", () => {
    it("should create a valid registration message", () => {
      const publicKey = new Uint8Array(32).fill(1);
      const message = createRegisterWalletMessage(
        "solana-1,order-123",
        "Solana",
        publicKey,
        "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
        1
      );

      expect(message).toBe(
        "Register wallet for derivation path: solana-1,order-123 with nonce: 1"
      );
    });

    it("should support different wallet types", () => {
      const publicKey = new Uint8Array(32);

      const nearMsg = createRegisterWalletMessage("near-1,user", "Near", publicKey, "user.near", 1);
      expect(nearMsg).toBe("Register wallet for derivation path: near-1,user with nonce: 1");

      const evmMsg = createRegisterWalletMessage("evm-1,user", "Evm", publicKey, "0x123...", 1);
      expect(evmMsg).toBe("Register wallet for derivation path: evm-1,user with nonce: 1");
    });
  });

  describe("createAddOperationMessage", () => {
    it("should create a valid add operation message for limit order", () => {
      const operation: AllowedOperationInput = {
        operation_type: {
          type: "LimitOrder",
          price_asset: "SOL",
          quote_asset: "USDC",
          trigger_price: "150000000",
          condition: "Above",
          source_asset: "USDC_MINT",
          target_asset: "SOL_MINT",
          max_amount: "100000000",
        },
        destination_address: "user_wallet",
        destination_chain: "solana",
        slippage_bps: 100,
      };

      const message = createAddOperationMessage(
        "solana-1,order-123",
        operation,
        1
      );

      const parsed = JSON.parse(message);
      expect(parsed.action).toBe("add_operation");
      expect(parsed.derivation_path).toBe("solana-1,order-123");
      expect(parsed.nonce).toBe(1);
      expect(parsed.operation.operation_type.type).toBe("LimitOrder");
      expect(parsed.operation.operation_type.trigger_price).toBe("150000000");
      expect(parsed.operation.operation_type.condition).toBe("Above");
    });

    it("should create a valid add operation message for stop-loss", () => {
      const operation: AllowedOperationInput = {
        operation_type: {
          type: "StopLoss",
          price_asset: "SOL",
          quote_asset: "USDC",
          trigger_price: "100000000",
          source_asset: "SOL_MINT",
          target_asset: "USDC_MINT",
          max_amount: "1000000000",
        },
        destination_address: "user_wallet",
        destination_chain: "solana",
        slippage_bps: 200,
      };

      const message = createAddOperationMessage(
        "solana-1,order-123",
        operation,
        1
      );

      const parsed = JSON.parse(message);
      expect(parsed.operation.operation_type.type).toBe("StopLoss");
    });

    it("should create a valid add operation message for take-profit", () => {
      const operation: AllowedOperationInput = {
        operation_type: {
          type: "TakeProfit",
          price_asset: "SOL",
          quote_asset: "USDC",
          trigger_price: "200000000",
          source_asset: "SOL_MINT",
          target_asset: "USDC_MINT",
          max_amount: "1000000000",
        },
        destination_address: "user_wallet",
        destination_chain: "solana",
        slippage_bps: 100,
      };

      const message = createAddOperationMessage(
        "solana-1,order-456",
        operation,
        2
      );

      const parsed = JSON.parse(message);
      expect(parsed.operation.operation_type.type).toBe("TakeProfit");
      expect(parsed.nonce).toBe(2);
    });

    it("should create a valid add operation message for swap", () => {
      const operation: AllowedOperationInput = {
        operation_type: {
          type: "Swap",
          source_asset: "USDC_MINT",
          target_asset: "SOL_MINT",
          max_amount: "100000000",
        },
        destination_address: "user_wallet",
        destination_chain: "solana",
        slippage_bps: 50,
      };

      const message = createAddOperationMessage(
        "solana-1,order-789",
        operation,
        1
      );

      const parsed = JSON.parse(message);
      expect(parsed.operation.operation_type.type).toBe("Swap");
      expect(parsed.operation.slippage_bps).toBe(50);
    });

    it("should include expiry when provided", () => {
      const expiresAt = Date.now() + 86400000;
      const operation: AllowedOperationInput = {
        operation_type: {
          type: "Swap",
          source_asset: "USDC",
          target_asset: "SOL",
          max_amount: "100",
        },
        destination_address: "user",
        destination_chain: "solana",
        slippage_bps: 50,
        expires_at: expiresAt,
      };

      const message = createAddOperationMessage("path", operation, 1);
      const parsed = JSON.parse(message);
      expect(parsed.operation.expires_at).toBe(expiresAt);
    });
  });

  describe("createRemoveOperationMessage", () => {
    it("should create a valid remove operation message", () => {
      const message = createRemoveOperationMessage(
        "solana-1,order-123",
        "op-1234567890",
        2
      );

      const parsed = JSON.parse(message);
      expect(parsed.action).toBe("remove_operation");
      expect(parsed.derivation_path).toBe("solana-1,order-123");
      expect(parsed.operation_id).toBe("op-1234567890");
      expect(parsed.nonce).toBe(2);
    });
  });
});

describe("Operation Type Validation", () => {
  it("should validate LimitOrder has required fields", () => {
    const op: AllowedOperationInput = {
      operation_type: {
        type: "LimitOrder",
        price_asset: "SOL",
        quote_asset: "USDC",
        trigger_price: "150",
        condition: "Above",
        source_asset: "USDC",
        target_asset: "SOL",
        max_amount: "100",
      },
      destination_address: "user",
      destination_chain: "solana",
      slippage_bps: 100,
    };

    expect(op.operation_type.type).toBe("LimitOrder");
    if (op.operation_type.type === "LimitOrder") {
      expect(op.operation_type.condition).toBe("Above");
    }
  });

  it("should validate StopLoss has required fields", () => {
    const op: AllowedOperationInput = {
      operation_type: {
        type: "StopLoss",
        price_asset: "SOL",
        quote_asset: "USDC",
        trigger_price: "100",
        source_asset: "SOL",
        target_asset: "USDC",
        max_amount: "1",
      },
      destination_address: "user",
      destination_chain: "solana",
      slippage_bps: 200,
    };

    expect(op.operation_type.type).toBe("StopLoss");
  });

  it("should validate Swap has no price conditions", () => {
    const op: AllowedOperationInput = {
      operation_type: {
        type: "Swap",
        source_asset: "USDC",
        target_asset: "SOL",
        max_amount: "100",
      },
      destination_address: "user",
      destination_chain: "solana",
      slippage_bps: 50,
    };

    expect(op.operation_type.type).toBe("Swap");
    // Swap should not have trigger_price
    expect((op.operation_type as any).trigger_price).toBeUndefined();
  });
});

describe("Wallet Type Mapping", () => {
  it("should use correct wallet type strings", () => {
    const nearType: WalletType = "Near";
    const solanaType: WalletType = "Solana";
    const evmType: WalletType = "Evm";

    expect(nearType).toBe("Near");
    expect(solanaType).toBe("Solana");
    expect(evmType).toBe("Evm");
  });
});
