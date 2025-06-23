/**
 * ===================================================================
 * SEND TRANSACTION API - ETH Price Oracle Update
 * ===================================================================
 * 
 * This API endpoint demonstrates cross-chain functionality where a NEAR account
 * can sign and send Ethereum transactions using Multi-Party Computation (MPC).
 * 
 * WHAT THIS DOES:
 * 1. Fetches current ETH price from multiple sources 
 * 2. Creates an Ethereum transaction to update a smart contract
 * 3. Signs the transaction using NEAR's MPC (no private key exposure!)
 * 4. Broadcasts the signed transaction to Ethereum network
 * 
 * WHY THIS MATTERS:
 * - Shows how to build verifiable price oracles
 * - Demonstrates cross-chain interactions without bridges
 * - Uses NEAR's MPC for secure key management
 * - Runs in TEE for additional security and verifiability
 */

import { signWithAgent } from '@neardefi/shade-agent-js';
import { ethContractAbi, ethContractAddress, ethRpcUrl, Evm } from '../../utils/ethereum';
import { getEthereumPriceUSD } from '../../utils/fetch-eth-price';
import { Contract, JsonRpcProvider } from "ethers";
import { utils } from 'chainsig.js';

// Extract RSV signature components from the MPC signature response
const { toRSV } = utils.cryptography;

// Get the NEAR contract ID from environment variables
// This contract handles the MPC signing functionality
const contractId = process.env.NEXT_PUBLIC_contractId;

/**
 * Main API handler for sending price update transactions
 * This is the core function that orchestrates the entire price oracle update process
 */
export default async function sendTransaction(req, res) {

  // ===================================================================
  // STEP 1: FETCH CURRENT ETH PRICE
  // ===================================================================
  // Get the latest ETH price from multiple sources (Binance + Coinbase)
  // The price is returned as an integer (price * 100) to avoid decimals in smart contracts
  const ethPrice = await getEthereumPriceUSD();

  // ===================================================================
  // STEP 2: PREPARE ETHEREUM TRANSACTION
  // ===================================================================
  // Create the transaction payload that will update the price on the Ethereum contract
  // This includes encoding the function call and preparing it for signing
  const { transaction, hashesToSign} = await getPricePayload(ethPrice);

    let signRes;
    let verified = false;
    
    // ===================================================================
    // STEP 3: SIGN TRANSACTION USING NEAR MPC
    // ===================================================================
    // This is the magic! Instead of using a private key, we use NEAR's MPC
    // to generate a signature. The private key is never exposed or stored.
    try {
        // The path determines which derived key to use for signing
        // 'ethereum-1' creates a deterministic Ethereum address from the NEAR account
        const path = 'ethereum-1';
        
        // The payload is the transaction hash that needs to be signed
        const payload = hashesToSign[0];
        
        // Call NEAR's MPC service to sign the transaction
        // This happens through a network of validators using threshold cryptography
        signRes = await signWithAgent(path, payload);
        console.log('signRes', signRes);
        verified = true;
    } catch (e) {
        console.log('Contract call error:', e);
    }

    // ===================================================================
    // STEP 4: HANDLE SIGNING ERRORS
    // ===================================================================
    // If signing failed, return an error response
    if (!verified) {
        res.status(400).json({ verified, error: 'Failed to send price' });
        return;
    }

    // ===================================================================
    // STEP 5: FINALIZE AND BROADCAST TRANSACTION
    // ===================================================================
    // Take the MPC signature and combine it with the original transaction
    // to create a fully signed Ethereum transaction
    const signedTransaction = Evm.finalizeTransactionSigning({
      transaction,
      rsvSignatures: [toRSV(signRes)], // Convert signature to Ethereum format
    })

    // Send the signed transaction to the Ethereum network
    const txHash = await Evm.broadcastTx(signedTransaction);
    
    // ===================================================================
    // STEP 6: RETURN SUCCESS RESPONSE
    // ===================================================================
    // Send back both the transaction hash and the new price
    // This allows the frontend to show immediate feedback to users
    res.status(200).json({ 
        txHash: txHash.hash,
        newPrice: (ethPrice / 100).toFixed(2) // Convert back to decimal for display
    });
}

/**
 * ===================================================================
 * HELPER FUNCTION: PREPARE PRICE UPDATE PAYLOAD
 * ===================================================================
 * 
 * This function creates the Ethereum transaction that will update the price
 * on the smart contract. It demonstrates how to:
 * 1. Derive an Ethereum address from a NEAR account
 * 2. Encode smart contract function calls
 * 3. Prepare transactions for MPC signing
 * 
 * @param {number} ethPrice - The current ETH price (multiplied by 100)
 * @returns {Object} - Transaction object and hash to sign
 */
async function getPricePayload(ethPrice) {
  // ===================================================================
  // DERIVE ETHEREUM ADDRESS FROM NEAR ACCOUNT
  // ===================================================================
  // This is a key concept: we can deterministically derive an Ethereum address
  // from our NEAR account using the same derivation path used for signing
  const { address: senderAddress } = await Evm.deriveAddressAndPublicKey(
    contractId,    // NEAR contract that manages MPC
    "ethereum-1",  // Derivation path (same as used in signing)
  );
  
  // ===================================================================
  // SET UP ETHEREUM CONTRACT INTERACTION
  // ===================================================================
  // Create connections to the Ethereum network and the price oracle contract
  const provider = new JsonRpcProvider(ethRpcUrl);
  const contract = new Contract(ethContractAddress, ethContractAbi, provider);
  
  // ===================================================================
  // ENCODE THE FUNCTION CALL
  // ===================================================================
  // Convert our price update into the format expected by the smart contract
  // This encodes the 'updatePrice' function call with the new ETH price
  const data = contract.interface.encodeFunctionData('updatePrice', [ethPrice]);
  
  // ===================================================================
  // PREPARE TRANSACTION FOR SIGNING
  // ===================================================================
  // Create the transaction object and generate the hash that needs to be signed
  // The MPC will sign this hash to authorize the transaction
  const { transaction, hashesToSign} = await Evm.prepareTransactionForSigning({
    from: senderAddress,        // Our derived Ethereum address
    to: ethContractAddress,     // The price oracle contract
    data,                       // The encoded function call
  });

  return {transaction, hashesToSign};
}
