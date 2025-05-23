import { contractCall } from '@neardefi/shade-agent-js';
import { EthereumVM } from '../../utils/ethereum';
import { ethContractAbi } from '../../utils/ethereum';
import { getEthereumPriceUSD } from '../../utils/fetch-eth-price';

const ethRpcUrl = 'https://sepolia.drpc.org';
const contractId = process.env.NEXT_PUBLIC_contractId;
const ethContractAddress = '0xb8d9b079F1604e9016137511464A1Fe97F8e2Bd8';

const Evm = new EthereumVM(ethRpcUrl);

export default async function sendTransaction(req, res) {

  // Get the ETH price
  const ethPrice = await getEthereumPriceUSD();

  // Get the payload and transaction
  const {payload, transaction} = await getPricePayload(ethPrice);

    let verified = false;
    let signRes;
    // Call the near smart contract to get a signature for the payload
    try {
        signRes = await contractCall({
            methodName: 'agent_sign',
            args: {
                payload,
            },
        });
        verified = true;
        
    } catch (e) {
        verified = false;
        console.error('Contract call error:', e);
    }

    if (!verified) {
        res.status(400).json({ verified, error: 'Failed to send price' });
        return;
    }

    // Reconstruct the signed transaction
    const {big_r, s, recovery_id} = signRes;
    const signedTransaction = await Evm.reconstructSignedTransaction(
      big_r,
      s,
      recovery_id,
      transaction
    );

    // Broadcast the signed transaction
    const txHash = await Evm.broadcastTX(signedTransaction);

    res.status(200).json({ verified, txHash });
}

async function getPricePayload(price) {
  const { address: senderAddress } = Evm.deriveAddress(contractId, "ethereum-1");
  const data = Evm.createTransactionData(ethContractAddress, ethContractAbi, 'updatePrice', [price]);
  const { transaction } = await Evm.createTransaction({
    sender: senderAddress,
    receiver: ethContractAddress,
    amount: 0,
    data,
  });
  const payload = await Evm.getPayload({ transaction });
  return {payload, transaction};
}