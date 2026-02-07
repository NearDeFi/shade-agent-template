# Shade Agent - Memory

## Project Structure
- Entry: `src/index.ts` (Hono server)
- Routes: `src/routes/` (API endpoints)
- Flows: `src/flows/` (DeFi operation logic - solSwap, kaminoDeposit, burrowDeposit, evmSwap, etc.)
- Queue: `src/queue/` (Redis-backed intent processing with consumer, pollers)
- Utils: `src/utils/` (chain-specific helpers, signatures, RPC)
- Config loaded by `src/config.ts` which calls dotenv itself

## Key Patterns
- Flows self-register via `flowRegistry.register()` in their module scope
- `RedisQueueClient` creates a new Redis connection per instance - avoid creating in loops
- Chain signatures via MPC (chainsig.js) with per-user derivation paths for custody isolation
- Intent pipeline: enqueue -> consumer BRPOP -> validate -> execute flow -> status update

## Build / Test
- `npm run build` - TypeScript compilation (tsc)
- `npm test` - Vitest (259 tests as of 2026-02-05)
- Tests mock external dependencies (RPC, chain signatures)

## Common Pitfalls Found (2026-02-05)
- Solana: `getSignatureStatuses` is non-blocking; must poll in a loop for confirmation
- Solana: `broadcastSolanaTx` should use the tx's own blockhash for confirmation, not a new one
- NEAR: `writeU64` must handle full 64-bit range via BigInt (nonces can exceed 32 bits)
- Redis: Don't create `new RedisQueueClient()` per request/poll - use shared module-scoped instance
- Amount deductions (ATA rent, gas reserves) must check token type before subtracting
- Auto-enqueue failures must not be silently swallowed if user gets a deposit address
