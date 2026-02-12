# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Shade Agent is a verifiable cross-chain DeFi automation platform enabling trustless, self-custodial operations across Solana, NEAR, and Ethereum. It uses Trusted Execution Environments (TEE) via Phala Cloud and Multi-Party Computation (MPC) chain signatures for secure key management.

**Core Pattern**: Intent Dispatch → Bridge Completion → Destination Action Execution

## Build & Development Commands

```bash
# Development
npm install              # Install dependencies
npm run dev              # Run locally with auto-reload (tsx)
npm run build            # TypeScript compilation to dist/
npm start                # Run built server (requires npm run build first)
npm test                 # Run Vitest unit tests

# Docker
npm run docker:build     # Build amd64 Docker image
npm run docker:push      # Push to registry

# Deployment
npm run phala:deploy     # Deploy to Phala Cloud TEE

# Frontend (separate package)
cd frontend && npm install && npm run dev

# Quality checks
npx madge --circular src/   # Must report zero circular dependencies
```

## Architecture

**Entry Point**: `src/index.ts` - Hono server setup, route mounting, queue consumer startup

**Routes** (`src/routes/`):
- `agentAccount.ts` / `ethAccount.ts` / `solAccount.ts` - Address derivation via chain signatures
- `intents/` - Quote dispatch, quote handlers, submission (directory module with `index.ts`)
- `kaminoPositions.ts` / `burrowPositions.ts` - Query lending positions
- `transaction.ts` - Sign and broadcast Ethereum transactions
- `status.ts` - Intent execution status

**Flows** (`src/flows/`) — see [Flow Plugin Architecture](#flow-plugin-architecture) below:
- Each flow is a single file exporting a `FlowDefinition<M>` object
- `registry.ts` / `catalog.ts` - Plugin registry with `findMatch()` dispatch
- `index.ts` - Wires all flows into `createDefaultFlowCatalog()`
- `types.ts` - Shared types: `FlowContext`, `FlowResult`, `BridgeBackResult`
- `context.ts` - Factory for `FlowContext`, dry-run helpers

**Queue System** (`src/queue/`):
- `consumer.ts` - Intent processing worker with retries and exponential backoff
- `intentsPoller.ts` - Monitors Defuse API for bridge completion
- `validation.ts` - Intent validation using flow catalog metadata
- Redis-backed with dead-letter queue for failed intents

**Utilities** (`src/utils/`) — shared, stateless helpers:
- `chainSignature.ts` - MPC signing requests
- `solana.ts` - Connection singleton, key derivation, tx signing helpers, `createKaminoRpc`
- `near.ts` - Provider singleton, account derivation, `NearAgentAccount`, tx execution
- `nearRpc.ts` - Low-level NEAR RPC calls (`getFtBalance`, `nearViewCall`)
- `evmChains.ts` - Multi-chain EVM config, signing, balance queries
- `evmLending.ts` - Shared EVM lending constants and helpers (Aave addresses, Morpho addresses, allowance, transfer, bridge-back)
- `refFinance.ts` - Ref Finance SDK wrapper (`buildRefSwapTransactions`, `init_env` at module scope)
- `intents.ts` - Defuse 1-Click SDK helpers
- `common.ts` - Generic helpers (`delay`, `base58Decode`, `isNativeEvmToken`)
- `http.ts` - `fetchWithTimeout`, `fetchWithRetry` (imports `delay` from `common.ts`)

**Infrastructure** (`src/infra/`):
- `chainSignature.ts` - Singleton `ChainSignatureContract`
- `redis.ts` - Shared ioredis client for state (NOT for queue blocking ops)

## Flow Plugin Architecture

Flows are the core extensibility mechanism. Each flow is a self-contained `FlowDefinition<M>` object.

### Adding a new flow

1. **Define metadata type** in `src/queue/types.ts` — add an interface and include it in the `IntentMetadata` union
2. **Register action** in `src/types/actions.ts` — add to `FLOW_ACTIONS` const
3. **Create flow file** at `src/flows/myNewFlow.ts` — export a `FlowDefinition<MyMetadata>` with `action`, `isMatch`, `execute`, etc.
4. **Wire it** in `src/flows/index.ts` — import and add to `defaultFlows` array
5. **(Optional)** Add a quote handler in `src/routes/intents/quotes/` if the flow needs custom quoting

The queue consumer, MCP tools, and validation all discover flows automatically via the registry.

### North star

The goal is **single-file flow addition**: a new flow should ideally only require creating one file. The `FLOW_ACTIONS` enum and `IntentMetadata` union are the remaining friction points — they exist for type safety but break the single-file ideal. Future work should explore whether these can be made self-registering (e.g., flows declare their own action string and metadata type, and the registry infers the union).

### FlowDefinition interface

```typescript
interface FlowDefinition<M extends IntentMetadata> {
  action: FlowAction;           // Unique identifier
  name: string;                 // Human-readable name
  description: string;
  supportedChains: { source: IntentChain[]; destination: IntentChain[] };
  requiredMetadataFields: string[];
  optionalMetadataFields?: string[];
  isMatch(intent): boolean;     // Type guard for dispatch routing
  execute(intent, ctx): Promise<FlowResult>;
  validateAuthorization?(intent, ctx): Promise<void>;
  validateMetadata?(metadata): void;
}
```

## Coding Conventions

### Style
- TypeScript targeting ES2022 with CommonJS modules, strict mode enabled
- Prefer async/await; keep route handlers small, delegate logic to `src/utils`
- Naming: camelCase for variables/functions, PascalCase for classes/types, kebab-case for files
- 2-space indent, imports ordered (node/third-party/local)

### Deduplication rules
- **Constants**: protocol addresses, chain lists, gas values — define once in the appropriate `src/utils/` file, import everywhere. Never duplicate a constant across flow files.
- **Shared types**: types used by 2+ flows (`BridgeBackResult`, `NearAgentAccount`) belong in `src/flows/types.ts` or the relevant `src/utils/` file, not as local interfaces.
- **Utility functions**: if a helper is used in 2+ files, extract to `src/utils/`. Examples: `delay` → `common.ts`, `createKaminoRpc` → `solana.ts`, `buildRefSwapTransactions` → `refFinance.ts`.
- **SDK wrappers**: Ref Finance init + swap logic lives in `refFinance.ts`. Defuse quote helpers live in `intents.ts`. Don't inline SDK ceremony in flow files.

### Type safety
- Avoid `as any`. When unavoidable at SDK boundaries (chainsig.js, NEAR SDK, @solana/kit, MCP SDK Zod compat), add a comment explaining why.
- Prefer narrow casts: `as IntentChain`, `as Record<string, unknown>`, `as { depositAddress?: string }` over `as any`.
- Flow dispatch uses `as any` in the heterogeneous registry pattern (`intentProcessor.ts`, `mcp/server.ts`) — this is justified and should have a comment.

### Route handler patterns
- Quote handlers use `QuoteContext` — a shared context object containing `c`, `payload`, `defuseQuoteFields`, `isDryRun`, `sourceChain`, `userDestination`, `metadata`.
- All quote handlers receive `(ctx: QuoteContext, ...typedParams)` — never loose positional args.
- Dispatch lives in `src/routes/intents/dispatch.ts`, individual handlers in `src/routes/intents/quotes/`.

### Dependency management
- `src/infra/` owns singletons (Redis, ChainSignature). Queue's `RedisQueueClient` has its own Redis connection for blocking ops (BRPOPLPUSH).
- `src/utils/` files must be stateless or use module-scoped singletons (`getSolanaConnection()`, `getNearProvider()`).
- No circular dependencies. Run `npx madge --circular src/` to verify.

## Testing

- Tests in `src/**/*.(spec|test).ts` using Vitest
- Mock external RPC/REST calls in tests
- Live swap test: `src/flows/solSwap.live.test.ts` runs only when `RUN_LIVE_SOL=1`
- After any refactor: `npm run build && npm test && npx madge --circular src/`

## Key Environment Variables

Copy `.env.development.local.example` to `.env.development.local`:

- `NEXT_PUBLIC_contractId` - NEAR contract ID (required for signing/derivation)
- `NEAR_ACCOUNT_ID`, `NEAR_SEED_PHRASE` - NEAR account credentials
- `SOL_RPC_URL`, `ETH_RPC_URL` - Chain RPC endpoints
- `REDIS_URL` - Queue backend (default `redis://127.0.0.1:6379`)
- `DRY_RUN_SWAPS=true` - Skip on-chain sends during development
- `ENABLE_QUEUE=false` - Disable queue consumer (defaults to disabled on testnet)
- `CHAIN_SIGNATURE_CONTRACT_ID`, `NEAR_NETWORK` - Chain signature config

Queue tuning: `MAX_INTENT_ATTEMPTS`, `INTENT_RETRY_BACKOFF_MS`, `STATUS_TTL_SECONDS`

## Intent Pipeline

1. `/api/intents` validates payload and enqueues to Redis
2. Consumer BRPOPs from Redis, validates, sets status to `processing`
3. Flow registry matches intent → executes flow
4. Updates status to `succeeded`/`failed`, moves failures to dead-letter queue
5. Status tracked in Redis with 24-hour TTL

## Protocol Integrations

- **Kamino Finance** - Solana lending (deposit/withdraw)
- **Burrow Protocol** - NEAR lending (deposit/withdraw)
- **Aave V3** - EVM lending on Ethereum, Base, Arbitrum (deposit/withdraw)
- **Morpho Blue** - EVM lending on Ethereum, Base (deposit/withdraw)
- **Jupiter** - Solana DEX aggregator
- **Ref Finance** - NEAR DEX aggregator
- **Defuse Intents** - Cross-chain swaps and bridging

Supported chains: NEAR, Solana, Ethereum, Base, Arbitrum
