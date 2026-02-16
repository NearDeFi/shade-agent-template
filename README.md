# Shade Agent - Verifiable Cross-Chain DeFi Automation

> [!WARNING]  
> The Shade Agent Framework is experimental and contains known critical vulnerabilities.
> 
> It must not be used in production or on mainnet and is intended solely for testing and non-critical use on testnet.
> 
> No representations or warranties are made regarding security, correctness, or fitness for any purpose. Use of this software is entirely at your own risk.
> 
> A production-ready version of the framework is currently in development.

A **verifiable execution environment** for cross-chain DeFi operations, leveraging **Trusted Execution Environments (TEE)**, **Multi-Party Computation (MPC)** chain signatures, and **intent-based architecture** to enable secure, self-custodial automation across Solana, NEAR, and Ethereum.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Core Technologies](#core-technologies)
  - [Verifiable Execution via Shade Agents](#verifiable-execution-via-shade-agents)
  - [Chain Abstraction & Self-Custody](#chain-abstraction--self-custody)
  - [Cryptographic Security](#cryptographic-security)
- [Integrated Protocols](#integrated-protocols)
- [Intent Processing System](#intent-processing-system)
- [API Reference](#api-reference)
- [Getting Started](#getting-started)
- [Deployment](#deployment)

---

## Overview

This Shade Agent enables **trustless DeFi automation** where:

- **Users maintain self-custody** - Private keys never leave the user's wallet
- **Execution is verifiable** - Code runs in TEE with cryptographic attestation
- **Cross-chain is seamless** - Single interface for Solana, NEAR, and EVM chains
- **Signatures are distributed** - MPC-based signing prevents single points of failure

### Key Capabilities

| Feature | Description |
|---------|-------------|
| **Kamino Lending** | Deposit/withdraw on Solana's Kamino Finance |
| **Burrow Lending** | Supply/withdraw on NEAR's Burrow Protocol |
| **Cross-Chain Swaps** | Bridge + swap via Defuse Intents |
| **Jupiter DEX** | Optimal routing on Solana |
| **Meta-Transactions** | Gasless NEAR transactions |

---

## Architecture

### High-Level Flow: Intent Dispatch → Bridge Completion → Arbitrary Destination Actions

The core pattern is **intent-driven cross-chain execution**: users sign an intent specifying what they want to happen on a destination chain, the agent dispatches cross-chain bridging, monitors for completion, then executes arbitrary actions on the destination.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                            CROSS-CHAIN INTENT FLOW                              │
└─────────────────────────────────────────────────────────────────────────────────┘

   ORIGIN CHAIN                      BRIDGE                    DESTINATION CHAIN
   (e.g., NEAR)                    (Defuse)                     (e.g., Solana)
        │                             │                              │
        │  1. User signs intent       │                              │
        │     specifying:             │                              │
        │     - source asset/amount   │                              │
        │     - destination chain     │                              │
        │     - final action (e.g.,   │                              │
        │       Kamino deposit)       │                              │
        ▼                             │                              │
   ┌─────────┐                        │                              │
   │ Deposit │  2. Funds sent to      │                              │
   │ to      │────Defuse deposit ────▶│                              │
   │ Bridge  │     address            │                              │
   └─────────┘                        │                              │
        │                             │                              │
        │                        ┌────┴────┐                         │
        │                        │ DEFUSE  │  3. Cross-chain         │
        │                        │ INTENTS │     swap/bridge         │
        │                        │ NETWORK │     executes            │
        │                        └────┬────┘                         │
        │                             │                              │
        │                             │  4. Funds arrive at          │
        │                             │     agent's derived          │
        │                             │     address on destination   │
        │                             │                              ▼
        │                             │                    ┌──────────────────┐
        │                             └───────────────────▶│ Agent's Derived  │
        │                                                  │ Solana Address   │
        │                                                  │ (per-user)       │
        │                                                  └────────┬─────────┘
        │                                                           │
        │                                                           │ 5. Agent detects
        │                                                           │    bridge completion
        │                                                           ▼
        │                                                  ┌──────────────────┐
        │                                                  │  EXECUTE FINAL   │
        │                                                  │     ACTION       │
        │                                                  │                  │
        │                                                  │ • Kamino deposit │
        │                                                  │ • Jupiter swap   │
        │                                                  │ • Any protocol   │
        │                                                  │ • Custom logic   │
        │                                                  └────────┬─────────┘
        │                                                           │
        │                                                           │ 6. Sign with MPC
        │                                                           │    chain signatures
        │                                                           ▼
        │                                                  ┌──────────────────┐
        │                                                  │   DESTINATION    │
        │                                                  │   PROTOCOL       │
        │                                                  │   (e.g., Kamino) │
        │                                                  └──────────────────┘
```

### Key Insight: Arbitrary Destination Actions

The **metadata.action** field in an intent determines what happens after bridging completes. This is **extensible** - new actions can be added without changing the core architecture:

```typescript
// Current supported actions
type IntentAction =
  | "kamino-deposit"    // Deposit to Solana lending
  | "kamino-withdraw"   // Withdraw from Solana lending
  | "burrow-deposit"    // Deposit to NEAR lending
  | "burrow-withdraw"   // Withdraw from NEAR lending
  | "swap"              // Jupiter swap on Solana
  | /* ...any new action */;

// The flow executor routes to the appropriate handler
switch (intent.metadata.action) {
  case "kamino-deposit":  return executeKaminoDeposit(intent);
  case "burrow-deposit":  return executeBurrowDeposit(intent);
  case "swap":            return executeSolanaSwap(intent);
  // Add new actions here - the architecture supports arbitrary extensions
}
```

### System Architecture

```
                              USER WALLET
                                  │
                                  │ Signs intent with private key
                                  │ (NEP-413 for NEAR, Ed25519 for Solana)
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     SHADE AGENT (TEE - Phala Cloud)                         │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        HTTP API (Hono)                              │   │
│  │  POST /api/intents      - Submit signed intents                     │   │
│  │  POST /api/intents/quote - Get cross-chain quotes                   │   │
│  │  GET  /api/kamino-positions - View Solana lending positions         │   │
│  │  GET  /api/burrow-positions - View NEAR lending positions           │   │
│  │  GET  /api/status/:id   - Check intent execution status             │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │              SIGNATURE VERIFICATION LAYER                           │   │
│  │                                                                     │   │
│  │  • NEP-413 Verification (NEAR)                                      │   │
│  │    - Borsh serialization with tag 2^31 + 413                        │   │
│  │    - SHA-256 hash → Ed25519 verify                                  │   │
│  │                                                                     │   │
│  │  • Ed25519 Verification (Solana)                                    │   │
│  │    - Raw message → Ed25519 verify                                   │   │
│  │                                                                     │   │
│  │  • Public Key Matching                                              │   │
│  │    - Ensures signer matches claimed userDestination                 │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │              INTENT QUEUE + BRIDGE POLLER                           │   │
│  │                                                                     │   │
│  │  ┌─────────────────┐          ┌─────────────────────────────────┐  │   │
│  │  │  Redis Queue    │          │     Intents Poller (5s)         │  │   │
│  │  │                 │          │                                 │  │   │
│  │  │ • Pending       │◀─────────│ Monitors Defuse API for bridge  │  │   │
│  │  │ • Processing    │  re-queue│ completion. When funds arrive,  │  │   │
│  │  │ • Dead-letter   │  on done │ re-enqueues intent for final    │  │   │
│  │  └────────┬────────┘          │ action execution.               │  │   │
│  │           │                   └─────────────────────────────────┘  │   │
│  │           │                                                        │   │
│  │           ▼                                                        │   │
│  │  ┌─────────────────────────────────────────────────────────────┐  │   │
│  │  │            FLOW EXECUTOR (Worker Pool)                      │  │   │
│  │  │                                                             │  │   │
│  │  │  Concurrency: 5 workers │ Retry: 3 attempts, exp. backoff   │  │   │
│  │  │                                                             │  │   │
│  │  │  ┌─────────────────────────────────────────────────────┐   │  │   │
│  │  │  │              DESTINATION CHAIN ACTIONS              │   │  │   │
│  │  │  │         (Executed after bridge completion)          │   │  │   │
│  │  │  │                                                     │   │  │   │
│  │  │  │  ┌────────────┐ ┌────────────┐ ┌────────────┐      │   │  │   │
│  │  │  │  │  Kamino    │ │  Burrow    │ │  Jupiter   │      │   │  │   │
│  │  │  │  │  Deposit   │ │  Deposit   │ │   Swap     │      │   │  │   │
│  │  │  │  └────────────┘ └────────────┘ └────────────┘      │   │  │   │
│  │  │  │  ┌────────────┐ ┌────────────┐ ┌────────────┐      │   │  │   │
│  │  │  │  │  Kamino    │ │  Burrow    │ │  Custom    │      │   │  │   │
│  │  │  │  │  Withdraw  │ │  Withdraw  │ │  Action... │      │   │  │   │
│  │  │  │  └────────────┘ └────────────┘ └────────────┘      │   │  │   │
│  │  │  └─────────────────────────────────────────────────────┘   │  │   │
│  │  └─────────────────────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │           CHAIN SIGNATURE LAYER (MPC Signing)                       │   │
│  │                                                                     │   │
│  │  • Deterministic key derivation per user                            │   │
│  │  • Path format: "solana-1,{userDestination}"                        │   │
│  │  • EdDSA for NEAR/Solana, ECDSA for Ethereum                        │   │
│  │  • Private keys NEVER exposed to agent                              │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
        ▼                           ▼                           ▼
┌──────────────┐           ┌──────────────┐           ┌──────────────┐
│    SOLANA    │           │     NEAR     │           │   ETHEREUM   │
│              │           │              │           │              │
│ • Kamino     │           │ • Burrow     │           │ • Price      │
│ • Jupiter    │           │ • Meta-Tx    │           │   Oracle     │
│ • SPL Tokens │           │ • NEP-141    │           │ • Chain Sig  │
└──────────────┘           └──────────────┘           └──────────────┘
        │                           │                           │
        │                           │                           │
        └─────────────┬─────────────┴─────────────┬─────────────┘
                      │                           │
                      ▼                           ▼
             ┌──────────────┐            ┌──────────────┐
             │    DEFUSE    │            │   FUTURE     │
             │   INTENTS    │            │   BRIDGES    │
             │              │            │              │
             │ Cross-chain  │            │ Extensible   │
             │   bridging   │            │ architecture │
             └──────────────┘            └──────────────┘
```

### Intent Lifecycle with Bridge Monitoring

```
┌──────────┐     ┌───────────┐     ┌─────────────────┐     ┌──────────────┐     ┌───────────┐
│ PENDING  │────▶│PROCESSING │────▶│AWAITING_INTENTS │────▶│  PROCESSING  │────▶│ SUCCEEDED │
└──────────┘     └───────────┘     └─────────────────┘     └──────────────┘     └───────────┘
                      │                    │                      │
   Intent queued      │    Bridge          │    Poller detects    │    Final action
                      │    dispatched      │    funds arrived     │    executed
                      │                    │                      │
                      │                    │                      │
                      ▼                    ▼                      ▼
                 ┌──────────┐        ┌──────────┐           ┌──────────┐
                 │  FAILED  │        │  Polling │           │  FAILED  │
                 └──────────┘        │  (5s)    │           └──────────┘
                                     └──────────┘
```

---

## Core Technologies

### Verifiable Execution via Shade Agents

**Shade Agents** run inside **Trusted Execution Environments (TEE)** provided by [Phala Cloud](https://cloud.phala.network), using [Dstack](https://docs.phala.network/overview/phala-network/dstack) technology.

#### What Makes Execution Verifiable?

1. **Hardware Isolation**: Code runs in encrypted memory (Intel SGX/TDX enclaves)
2. **Remote Attestation**: Third parties can cryptographically verify what code is running
3. **No Operator Access**: Even the server operator cannot inspect or modify execution
4. **Deterministic Builds**: Docker images can be audited and hash-verified

#### Shade Agent Integration

```typescript
import { agentAccountId, requestSignature } from "@neardefi/shade-agent-js";

// Agent has a NEAR account for on-chain operations
const { accountId } = await agentAccountId();
// => "ac-sandbox.user.near"

// Request MPC signature without exposing private keys
const signature = await requestSignature({
  path: "solana-1,user.near",      // Derivation path with custody isolation
  payload: txHashHex,               // What to sign
  keyType: "Eddsa",                 // Ed25519 for Solana
});
```

#### Security Properties

| Property | How It's Achieved |
|----------|-------------------|
| **Code Integrity** | TEE prevents runtime modification |
| **Data Confidentiality** | Encrypted memory regions |
| **Verifiability** | Remote attestation reports |
| **Key Protection** | MPC signatures, no raw key access |

---

### Chain Abstraction & Self-Custody

The system implements **true self-custody** through deterministic key derivation. Users control their funds across all chains while delegating only execution.

#### Custody Isolation Architecture

Each user gets **unique derived addresses** on each chain, ensuring:
- User A's Solana address ≠ User B's Solana address
- User A's NEAR address ≠ User B's NEAR address
- Even if using the same agent, funds are completely isolated

```typescript
// Derivation path includes user identifier for isolation
const derivationPath = `solana-1,${userDestination}`;
//                      └─ chain ─┘ └─ user addr ─┘

// Same user always gets the same derived address
const pubkey1 = await deriveAgentPublicKey("solana-1", "alice.near");
const pubkey2 = await deriveAgentPublicKey("solana-1", "alice.near");
// pubkey1 === pubkey2 (deterministic)

// Different users get different addresses
const pubkeyAlice = await deriveAgentPublicKey("solana-1", "alice.near");
const pubkeyBob = await deriveAgentPublicKey("solana-1", "bob.near");
// pubkeyAlice !== pubkeyBob (isolated)
```

#### Multi-Chain Address Derivation

| Chain | Derivation Path | Key Type | Account Format |
|-------|----------------|----------|----------------|
| **Solana** | `solana-1,{user}` | Ed25519 | Base58 PublicKey |
| **NEAR** | `near-1,{user}` | Ed25519 | 64-char hex (implicit) |
| **Ethereum** | `ethereum-1,{user}` | secp256k1 | 0x-prefixed address |

#### NEAR Implicit Accounts

For NEAR, the agent uses **implicit accounts** - accounts whose ID is the hex-encoded public key:

```typescript
const { accountId, publicKey } = await deriveNearImplicitAccount(
  "near-1",           // base path
  undefined,          // optional nearPublicKey
  "alice.near"        // userDestination for isolation
);
// accountId: "a1b2c3d4...64chars...e5f6" (hex pubkey)
// publicKey: "ed25519:ABC123..." (base58)
```

---

### Cryptographic Security

#### NEP-413 Signature Verification (NEAR)

The agent verifies NEAR signatures using [NEP-413](https://github.com/near/NEPs/blob/master/neps/nep-0413.md) standard:

```typescript
// NEP-413 prevents signature replay and transaction confusion
const NEP413_TAG = 2147484061; // 2^31 + 413

interface NEP413Payload {
  message: string;      // Intent details
  nonce: Uint8Array;    // 32-byte unique nonce
  recipient: string;    // Agent contract ID
  callbackUrl?: string; // Optional callback
}

// Verification process:
// 1. Borsh-serialize payload with NEP-413 tag prefix
const serialized = serializeNEP413Payload(NEP413_TAG, payload);

// 2. SHA-256 hash the serialized bytes
const hash = crypto.createHash("sha256").update(serialized).digest();

// 3. Verify Ed25519 signature against hash
const isValid = nacl.sign.detached.verify(hash, signature, publicKey);
```

#### Solana Signature Verification

For Solana wallets, raw Ed25519 verification:

```typescript
// Solana signs raw messages (no hashing)
const messageBytes = new TextEncoder().encode(message);
const isValid = nacl.sign.detached.verify(
  messageBytes,
  signatureBytes,
  publicKeyBytes
);
```

#### MPC Chain Signatures

Private keys are distributed across MPC nodes - **no single party has access**:

```typescript
// Request signature from MPC network
const signRes = await requestSignature({
  path: derivationPath,           // Deterministic key derivation
  payload: uint8ArrayToHex(hash), // What to sign
  keyType: "Eddsa",               // Ed25519 for Solana/NEAR
});

// Signature returned as r,s components or hex string
// Agent NEVER has access to private key material
```

#### Security Summary

| Attack Vector | Mitigation |
|--------------|------------|
| **Key Extraction** | MPC - keys never assembled |
| **Signature Replay** | NEP-413 nonce + recipient binding |
| **Transaction Confusion** | NEP-413 tag prefix (2^31 + 413) |
| **Unauthorized Execution** | Signature verification before processing |
| **Cross-User Access** | Deterministic path-based isolation |
| **Agent Compromise** | TEE prevents key/data extraction |

---

## Integrated Protocols

### Kamino Finance (Solana)

[Kamino](https://kamino.finance) is a Solana lending protocol. The agent supports:

```typescript
interface KaminoDepositMetadata {
  action: "kamino-deposit";
  marketAddress: string;    // Kamino market (e.g., main market)
  mintAddress: string;      // Token to deposit (SPL mint)
  useIntents?: boolean;     // Bridge from other chain first
  targetDefuseAssetId?: string; // Source asset for bridging
  slippageTolerance?: number;   // Slippage for intermediate swap
}

interface KaminoWithdrawMetadata {
  action: "kamino-withdraw";
  marketAddress: string;
  mintAddress: string;      // Token to withdraw
  cTokenMint: string;       // Collateral token mint
  liquidityAmount: string;  // Amount to withdraw
}
```

**Flow:**
1. User signs intent with their wallet
2. Agent verifies signature
3. If `useIntents`, wait for cross-chain bridge
4. Build Kamino deposit/withdraw transaction
5. Sign with MPC chain signatures
6. Broadcast to Solana

### Burrow Protocol (NEAR)

[Burrow](https://burrow.finance) is NEAR's native lending protocol:

```typescript
interface BurrowDepositMetadata {
  action: "burrow-deposit";
  tokenId: string;         // NEP-141 token (e.g., "wrap.near")
  isCollateral?: boolean;  // Use as collateral
  useIntents?: boolean;    // Bridge from other chain first
}

interface BurrowWithdrawMetadata {
  action: "burrow-withdraw";
  tokenId: string;
  withdrawAmount: string;  // Amount in base units
}
```

**Flow (with Meta-Transactions):**
1. User signs intent
2. Agent derives user's NEAR implicit account
3. Build DelegateAction (meta-transaction)
4. Sign DelegateAction with MPC
5. Relayer account submits (pays gas)
6. User's account executes the action

### Jupiter DEX (Solana)

[Jupiter](https://jup.ag) provides optimal swap routing on Solana:

```typescript
// Agent queries Jupiter for best route
const quote = await jupiterApi.quoteGet({
  inputMint: "So111...",      // SOL
  outputMint: "EPjF...",      // USDC
  amount: 1000000,            // In base units
  slippageBps: 300,           // 3%
});

// Build and sign swap transaction
const swapTx = await jupiterApi.swapPost({ quoteResponse: quote });
```

### Defuse Intents (Cross-Chain)

[Defuse](https://defuse.org) enables atomic cross-chain swaps:

```typescript
// User deposits on origin chain → Defuse handles bridging → Agent receives on destination

// Polling for completion
const status = await OneClickService.getExecutionStatus(
  depositAddress,
  depositMemo
);

if (status === "success") {
  // Funds arrived, continue with Kamino deposit / swap
}
```

---

## Intent Processing System

### Intent Lifecycle

```
┌──────────┐    ┌───────────┐    ┌────────────────┐    ┌───────────┐
│ PENDING  │───▶│PROCESSING │───▶│AWAITING_INTENTS│───▶│ SUCCEEDED │
└──────────┘    └───────────┘    └────────────────┘    └───────────┘
                      │                   │                   ▲
                      │                   │                   │
                      ▼                   ▼                   │
                ┌──────────┐        ┌──────────┐              │
                │  FAILED  │        │PROCESSING│──────────────┘
                └──────────┘        └──────────┘
                                    (re-enqueue)
```

### Intent Message Structure

```typescript
interface IntentMessage {
  intentId: string;                    // Unique identifier (UUID)

  // Source chain details
  sourceChain: "near" | "solana" | "ethereum" | "base" | "arbitrum";
  sourceAsset: string;                 // Asset ID (e.g., "nep141:wrap.near")
  sourceAmount: string;                // Amount in base units

  // Destination chain details
  destinationChain: "near" | "solana" | "ethereum" | "base" | "arbitrum";
  finalAsset: string;                  // Output asset

  // Routing
  slippageBps?: number;                // Slippage tolerance (basis points)
  intermediateAsset?: string;          // For multi-hop swaps

  // Addresses
  userDestination: string;             // User's address on destination
  agentDestination?: string;           // Agent's derived address

  // Cross-chain (optional)
  intentsDepositAddress?: string;      // Defuse deposit address
  depositMemo?: string;                // Defuse memo
  originTxHash?: string;               // Proof of deposit

  // Protocol-specific
  metadata?: KaminoDepositMetadata | KaminoWithdrawMetadata
           | BurrowDepositMetadata | BurrowWithdrawMetadata;

  // Authorization
  userSignature?: {
    message: string;
    signature: string;
    publicKey: string;
    nonce: string;       // NEP-413
    recipient: string;   // NEP-413
  };
}
```

### Worker Pool Architecture

```typescript
// Consumer configuration
const CONCURRENCY = 5;           // Parallel workers
const MAX_ATTEMPTS = 3;          // Retry limit
const RETRY_BACKOFF_MS = 1000;   // Base backoff

// Processing loop
while (true) {
  if (activeWorkers < CONCURRENCY) {
    const { intent, raw } = await queue.fetchNextIntent();

    activeWorkers++;
    processWithRetry(intent, raw)
      .finally(() => activeWorkers--);
  }
}

// Retry with exponential backoff
async function processWithRetry(intent, raw) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await executeFlow(intent);
      await setStatus(intent.intentId, { state: "succeeded" });
      return;
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) {
        await queue.moveToDeadLetter(raw);
        await setStatus(intent.intentId, { state: "failed", error: err.message });
      }
      await delay(RETRY_BACKOFF_MS * attempt);
    }
  }
}
```

---

## API Reference

### POST `/api/intents`

Submit a signed intent for execution.

**Request:**
```json
{
  "intentId": "550e8400-e29b-41d4-a716-446655440000",
  "sourceChain": "near",
  "destinationChain": "solana",
  "sourceAsset": "nep141:wrap.near",
  "finalAsset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "sourceAmount": "1000000000000000000000000",
  "slippageBps": 300,
  "userDestination": "alice.near",
  "metadata": {
    "action": "kamino-deposit",
    "marketAddress": "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
    "mintAddress": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
  },
  "userSignature": {
    "message": "Deposit 1 NEAR to Kamino",
    "signature": "base64-encoded-signature",
    "publicKey": "ed25519:ABC123...",
    "nonce": "base64-32-byte-nonce",
    "recipient": "agent.near"
  }
}
```

**Response:**
```json
{
  "status": "queued",
  "intentId": "550e8400-e29b-41d4-a716-446655440000"
}
```

### POST `/api/intents/quote`

Get a quote for cross-chain swap.

**Request:**
```json
{
  "originAsset": "nep141:wrap.near",
  "destinationAsset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "amount": "1000000000000000000000000",
  "swapType": "EXACT_INPUT",
  "slippageTolerance": 300,
  "recipient": "HN7cABqLq46Es1jh92dQQisAq662SmxELLTPRP6DMAvf",
  "recipientType": "DESTINATION_CHAIN"
}
```

### GET `/api/status/:intentId`

Check intent execution status.

**Response:**
```json
{
  "intentId": "550e8400-e29b-41d4-a716-446655440000",
  "state": "succeeded",
  "txId": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp...",
  "updatedAt": "2024-01-15T10:30:00Z"
}
```

### GET `/api/kamino-positions/:marketAddress`

Get user's Kamino lending positions.

**Query Parameters:**
- `userDestination` - User's NEAR account or Solana address

**Response:**
```json
{
  "obligations": [
    {
      "pubkey": "obligation-pubkey",
      "deposits": [
        {
          "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          "symbol": "USDC",
          "amount": "1000.00",
          "value": "$1000.00"
        }
      ],
      "borrows": []
    }
  ]
}
```

### GET `/api/burrow-positions`

Get user's Burrow lending positions on NEAR.

**Query Parameters:**
- `userDestination` - User's NEAR account

---

## Getting Started

### Prerequisites

- Node.js 18+
- Docker (for deployment)
- Redis (for queue processing)
- NEAR account with seed phrase

### Installation

```bash
# Clone the repository
git clone https://github.com/NearDeFi/shade-agent
cd shade-agent

# Install dependencies
npm install

# Install CLI tools
npm i -g @neardefi/shade-agent-cli
```

### Configuration

Copy `.env.development.local.example` to `.env.development.local`:

```bash
# NEAR Configuration
NEXT_PUBLIC_contractId=ac-proxy.your-account.near
NEAR_SEED_PHRASE="your twelve word seed phrase here"

# Chain Signature Configuration
CHAIN_SIGNATURE_NETWORK=testnet
CHAIN_SIGNATURE_CONTRACT_ID=v1.signer-prod.testnet
CHAIN_SIGNATURE_MPC_KEY=secp256k1:...

# Redis Queue
REDIS_URL=redis://localhost:6379
ENABLE_QUEUE=true

# Solana RPC
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
```

### Local Development

```bash
# Terminal 1: Start Shade Agent CLI (handles TEE simulation)
shade-agent-cli

# Terminal 2: Start the server
npm run dev
```

Server runs at `http://localhost:3000`

---

## Deployment

### Docker Build

```bash
# Build for TEE deployment
npm run docker:build

# Push to registry
npm run docker:push
```

### Phala Cloud Deployment

```bash
# Deploy to Phala Cloud TEE
npm run phala:deploy
```

Configuration in `docker-compose.yaml`:
```yaml
services:
  app:
    image: your-registry/shade-agent:latest
    environment:
      - NEXT_PUBLIC_contractId=ac-sandbox.your-account.near
      - ENABLE_QUEUE=true
    ports:
      - "3000:3000"
```

### Production Checklist

- [ ] Update `NEXT_PUBLIC_contractId` prefix to `ac-sandbox.`
- [ ] Configure production Redis
- [ ] Set production RPC URLs
- [ ] Verify Phala Cloud API key
- [ ] Fund agent NEAR account for gas

---

## Tech Stack

| Category | Technology |
|----------|------------|
| **Runtime** | Node.js, TypeScript |
| **Framework** | Hono (HTTP server) |
| **Queue** | Redis (ioredis) |
| **Solana** | @solana/web3.js, @kamino-finance/klend-sdk |
| **NEAR** | @near-js/*, near-api-js |
| **Ethereum** | ethers.js |
| **Cryptography** | tweetnacl, chainsig.js |
| **Cross-Chain** | @defuse-protocol/one-click-sdk |
| **TEE** | Phala Cloud (Dstack) |
| **Testing** | Vitest |

---

## Security Considerations

1. **Never expose seed phrases** - Use environment variables, never commit
2. **Verify signatures** - Always validate before processing intents
3. **Monitor dead-letter queue** - Failed intents may indicate issues
4. **Rate limit APIs** - Prevent DoS attacks
5. **Audit TEE attestation** - Verify code integrity in production

---

## Resources

- [NEAR Documentation](https://docs.near.org)
- [Shade Agents Guide](https://docs.near.org/ai/shade-agents/sandbox/sandbox-deploying)
- [Phala Cloud](https://cloud.phala.network)
- [NEP-413 Standard](https://github.com/near/NEPs/blob/master/neps/nep-0413.md)
- [Kamino Finance](https://docs.kamino.finance)
- [Burrow Protocol](https://docs.burrow.finance)
- [Defuse Protocol](https://docs.defuse.org)

---

## License

MIT
