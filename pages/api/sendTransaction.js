import { contractCall } from '@neardefi/shade-agent-js';
import { ethContractAbi, ethContractAddress, ethRpcUrl, Evm } from '../../utils/ethereum';
import { getEthereumPriceUSD } from '../../utils/fetch-eth-price';
import { Contract, JsonRpcProvider } from "ethers";
import { utils } from 'chainsig.js';
const { toRSV } = utils.cryptography;

const contractId = process.env.NEXT_PUBLIC_contractId;

export default async function sendTransaction(req, res) {

  // Get the ETH price
  const ethPrice = await getEthereumPriceUSD();

  // Get the transaction and payload to sign
  const { transaction, hashesToSign} = await getPricePayload(ethPrice);

    let signRes;
    let verified = false;
    // Call the agent contract to get a signature for the payload
    try {
        signRes = await contractCall({
            methodName: 'sign_tx',
            args: {
                payload: hashesToSign[0],
                derivation_path: 'ethereum-1',
                key_version: 0,
            },
        });
        verified = true;
    } catch (e) {
        console.error('Contract call error:', e);
    }

    if (!verified) {
        res.status(400).json({ verified, error: 'Failed to send price' });
        return;
    }

    // Reconstruct the signed transaction
    const signedTransaction = Evm.finalizeTransactionSigning({
      transaction,
      rsvSignatures: [toRSV(signRes)],
    })

    // Broadcast the signed transaction
    const txHash = await Evm.broadcastTx(signedTransaction);
    
    // Send back both the txHash and the new price optimistically
    res.status(200).json({ 
        txHash: txHash.hash,
        newPrice: (ethPrice / 100).toFixed(2) // Format the price the same way as in getPrice
    });
}

async function getPricePayload(ethPrice) {
  const { address: senderAddress } = await Evm.deriveAddressAndPublicKey(
    contractId,
    "ethereum-1",
  );
  const provider = new JsonRpcProvider(ethRpcUrl);
  const contract = new Contract(ethContractAddress, ethContractAbi, provider);
  const data = contract.interface.encodeFunctionData('updatePrice', [ethPrice]);
  const { transaction, hashesToSign} = await Evm.prepareTransactionForSigning({
    from: senderAddress,
    to: ethContractAddress,
    data,
  });

  return {transaction, hashesToSign};
}