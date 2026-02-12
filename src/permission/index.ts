/**
 * Permission module for self-custodial operations
 *
 * This module provides the interface to the NEAR permission contract
 * that wraps the ChainSignatureContract for MPC signing. Users register
 * allowed operations with signatures, and the TEE can only sign for
 * operations that are on the user's allowlist.
 */

// Types
export type {
  DerivationPath,
  WalletType,
  ContractPriceCondition,
  AllowedOperationType,
  SwapOperation,
  LimitOrderOperation,
  StopLossOperation,
  TakeProfitOperation,
  AllowedOperation,
  AllowedOperationInput,
  RegisteredWallet,
  UserPermissionsView,
  RegisterWalletArgs,
  AddAllowedOperationArgs,
  RemoveAllowedOperationArgs,
  SignAllowedArgs,
  GetActiveOperationsResult,
} from "./types";

export {
  createRegisterWalletMessage,
  createAddOperationMessage,
  createRemoveOperationMessage,
} from "./types";

// Client
export {
  // View methods
  getPermissions,
  getOperation,
  getActiveOperations,
  isOperationAllowed,
  getDerivationPathForWallet,
  // Change methods
  registerWallet,
  addAllowedOperation,
  removeAllowedOperation,
  signAllowed,
  // Helpers
  createLimitOrderOperation,
  createStopLossOperation,
  createTakeProfitOperation,
  createSwapOperation,
  parseWalletType,
  getPermissionContractId,
} from "./client";
