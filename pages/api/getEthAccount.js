/**
 * ===================================================================
 * GET ETHEREUM ACCOUNT API - Cross-Chain Address Derivation
 * ===================================================================
 * 
 * This API endpoint demonstrates one of the most powerful features of NEAR's MPC:
 * the ability to deterministically derive addresses on other blockchains.
 * 
 * WHAT THIS DOES:
 * - Takes a NEAR account and derives a corresponding Ethereum address
 * - Uses the same derivation path that will be used for signing transactions
 * - Returns the address that can receive ETH and interact with Ethereum contracts
 * 
 * WHY THIS MATTERS:
 * - No need to manage separate private keys for different chains
 * - One NEAR account can control addresses on multiple blockchains
 * - Enables seamless cross-chain applications
 * - The derived address is always the same for the same NEAR account + path
 * 
 * EDUCATIONAL CONCEPTS:
 * - Hierarchical Deterministic (HD) wallets
 * - Cross-chain key derivation
 * - Multi-Party Computation for key management
 */

import { Evm } from '../../utils/ethereum';

// Get the NEAR contract ID from environment variables
// This contract handles the MPC functionality and key derivation
const contractId = process.env.NEXT_PUBLIC_contractId;

/**
 * API handler to get the Ethereum address derived from our NEAR account
 * This address can be used to receive ETH, interact with contracts, etc.
 */
export default async function handler(req, res) {
    try {
        // ===================================================================
        // DERIVE ETHEREUM ADDRESS FROM NEAR ACCOUNT
        // ===================================================================
        // This is the core magic: we can create an Ethereum address that's
        // controlled by our NEAR account through MPC signing
        
        const { address: senderAddress } = await Evm.deriveAddressAndPublicKey(
            contractId,    // The NEAR contract that manages our MPC keys
            "ethereum-1",  // Derivation path - this creates a unique address
                          // You could use "ethereum-2", "ethereum-3", etc. for multiple addresses
        );
        
        // ===================================================================
        // IMPORTANT CONCEPTS FOR STUDENTS:
        // ===================================================================
        // 1. DETERMINISTIC: Same contractId + path = same address every time
        // 2. SECURE: No private key is ever exposed or stored locally
        // 3. CROSS-CHAIN: This Ethereum address is fully functional
        // 4. MPC-CONTROLLED: Signatures are generated through NEAR's validator network
        
        // Return the derived Ethereum address
        res.status(200).json({ senderAddress });
        
    } catch (error) {
        // ===================================================================
        // ERROR HANDLING
        // ===================================================================
        // Log the error for debugging (important for development)
        console.log('Error getting worker account:', error);
        
        // Return a user-friendly error message
        res.status(500).json({ error: 'Failed to get worker account' });
    }
} 

/**
 * ===================================================================
 * LEARNING NOTES FOR HACKATHON STUDENTS:
 * ===================================================================
 * 
 * 1. **Address Derivation**: This process uses cryptographic derivation to create
 *    an Ethereum address from a NEAR account. The same inputs always produce
 *    the same output, making it predictable and reliable.
 * 
 * 2. **No Private Key Management**: Traditional apps require managing private keys
 *    securely. With NEAR MPC, the "private key" is distributed across validators
 *    and never exists in one place.
 * 
 * 3. **Cross-Chain Architecture**: This enables building apps that span multiple
 *    blockchains without complex bridge protocols or wrapped tokens.
 * 
 * 4. **Practical Use Cases**:
 *    - Multi-chain wallets
 *    - Cross-chain DeFi protocols  
 *    - Universal account abstraction
 *    - Chain-agnostic dApps
 * 
 * 5. **Try This**: 
 *    - Call this endpoint and note the returned address
 *    - Call it again - you'll get the same address
 *    - Change the derivation path to "ethereum-2" - you'll get a different address
 *    - Fund this address with Sepolia ETH and it will work like any Ethereum wallet!
 */ 