/**
 * ===================================================================
 * GET WORKER ACCOUNT API - NEAR Account & Balance Management
 * ===================================================================
 * 
 * This API endpoint shows how to interact with NEAR accounts and check balances.
 * In the context of Shade Agents and MPC, the "worker account" is the NEAR account
 * that has permission to request signatures from the MPC network.
 * 
 * WHAT THIS DOES:
 * - Retrieves the NEAR account ID that's running this agent
 * - Checks the account's NEAR token balance
 * - Returns both pieces of information for monitoring/debugging
 * 
 * WHY THIS MATTERS:
 * - The worker account needs NEAR tokens to pay for MPC signature requests
 * - Each signature operation costs NEAR tokens (usually very small amounts)
 * - Monitoring balance helps ensure the oracle can continue operating
 * - Provides transparency about which account is performing operations
 * 
 * EDUCATIONAL CONCEPTS:
 * - NEAR account management
 * - Gas/fee economics in blockchain applications
 * - Account-based vs UTXO blockchain models
 * - Operational monitoring for automated systems
 */

import { getAgentAccount, getBalance } from '@neardefi/shade-agent-js';

/**
 * API handler to get information about the NEAR worker account
 * This helps monitor the account that's running our price oracle
 */
export default async function handler(req, res) {
    try {
        // ===================================================================
        // GET THE WORKER ACCOUNT INFORMATION
        // ===================================================================
        // The "worker account" is the NEAR account that's authorized to request
        // MPC signatures. This is typically the account that deployed the agent.
        const accountId = await getAgentAccount();
        console.log('Worker account:', accountId.workerAccountId);
        
        // ===================================================================
        // CHECK ACCOUNT BALANCE
        // ===================================================================
        // Get the current NEAR token balance for this account
        // This balance is used to pay for MPC signature requests
        const balance = await getBalance(accountId.workerAccountId);
        console.log('Balance:', balance.available);
        
        // ===================================================================
        // IMPORTANT CONCEPTS FOR STUDENTS:
        // ===================================================================
        // 1. WORKER ACCOUNT: The NEAR account that runs automated operations
        // 2. BALANCE MONITORING: Essential for keeping oracles/agents running
        // 3. MPC COSTS: Each signature request costs a small amount of NEAR
        // 4. OPERATIONAL TRANSPARENCY: Users can verify which account is operating
        
        // Return both the account ID and available balance
        res.status(200).json({ 
            accountId: accountId.workerAccountId, 
            balance: balance.available 
        });
        
    } catch (error) {
        // ===================================================================
        // ERROR HANDLING & DEBUGGING
        // ===================================================================
        // Log detailed error information for development/debugging
        console.log('Error getting worker account:', error);
        
        // Return a descriptive error message that includes the original error
        // This helps with troubleshooting during development
        res.status(500).json({ 
            error: 'Failed to get worker account ' + error 
        });
    }
} 

/**
 * ===================================================================
 * LEARNING NOTES FOR HACKATHON STUDENTS:
 * ===================================================================
 * 
 * 1. **Account Economics**: Unlike Ethereum where you pre-fund addresses with ETH,
 *    NEAR uses an account-based model where accounts hold balances directly.
 * 
 * 2. **MPC Pricing**: Each MPC signature request costs NEAR tokens. The exact cost
 *    depends on network conditions, but it's typically very affordable (fractions
 *    of a cent).
 * 
 * 3. **Operational Monitoring**: For production oracles/agents, you'd want to:
 *    - Monitor balance levels
 *    - Set up alerts when balance gets low  
 *    - Implement automatic top-up mechanisms
 *    - Track spending patterns
 * 
 * 4. **Account Management**: The worker account should be:
 *    - Properly secured (using hardware wallets for production)
 *    - Well-funded for continuous operation
 *    - Monitored for suspicious activity
 *    - Backed up with proper key management
 * 
 * 5. **Scaling Considerations**: For high-frequency operations, you might:
 *    - Use multiple worker accounts
 *    - Implement rate limiting
 *    - Optimize transaction batching
 *    - Monitor network congestion
 * 
 * 6. **Try This**:
 *    - Call this endpoint to see your worker account
 *    - Note the balance format (NEAR uses yoctoNEAR internally)
 *    - Run some transactions and check how the balance changes
 *    - Consider: what happens if the balance reaches zero?
 */ 