import { base_decode } from 'near-api-js/lib/utils/serialize';
import { ec as EC } from 'elliptic';
import { keccak256 } from "viem";
import { sha3_256 } from 'js-sha3'
import { Web3 } from "web3";
import { bytesToHex } from "@ethereumjs/util";
import { FeeMarketEIP1559Transaction } from "@ethereumjs/tx";
import { Contract, JsonRpcProvider } from "ethers";

const MPC_KEY = 'secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8fGBiJB8TBtFMP5WWXz6B89Ac1fbpzPwAvoyQebemHFwx3';

export const ethContractAbi = [
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "_price",
        "type": "uint256"
      }
    ],
    "name": "updatePrice",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "getPrice",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  }
]  

function generateEthAddress({ accountId, derivation_path }) {
  const publicKey = deriveChildPublicKey(najPublicKeyStrToUncompressedHexPoint(), accountId, derivation_path);
  const address = uncompressedHexPointToEvmAddress(publicKey);
  return { publicKey: Buffer.from(publicKey, 'hex'), address };
}

function najPublicKeyStrToUncompressedHexPoint() {
  const res = '04' + Buffer.from(base_decode(MPC_KEY.split(':')[1])).toString('hex');
  return res;
}

function deriveChildPublicKey(
  parentUncompressedPublicKeyHex,
  signerId,
  path = ''
) {
  const ec = new EC("secp256k1");
  const scalarHex = sha3_256(
    `near-mpc-recovery v0.1.0 epsilon derivation:${signerId},${path}`
  );

  const x = parentUncompressedPublicKeyHex.substring(2, 66);
  const y = parentUncompressedPublicKeyHex.substring(66);

  // Create a point object from X and Y coordinates
  const oldPublicKeyPoint = ec.curve.point(x, y);

  // Multiply the scalar by the generator point G
  const scalarTimesG = ec.g.mul(scalarHex);

  // Add the result to the old public key point
  const newPublicKeyPoint = oldPublicKeyPoint.add(scalarTimesG);
  const newX = newPublicKeyPoint.getX().toString("hex").padStart(64, "0");
  const newY = newPublicKeyPoint.getY().toString("hex").padStart(64, "0");
  return "04" + newX + newY;
}

function uncompressedHexPointToEvmAddress(uncompressedHexPoint) {
  const addressHash = keccak256(`0x${uncompressedHexPoint.slice(2)}`);

  // Ethereum address is last 20 bytes of hash (40 characters), prefixed with 0x
  return ("0x" + addressHash.substring(addressHash.length - 40));
}

export class EthereumVM {
  constructor(chain_rpc) {
    this.web3 = new Web3(new Web3.providers.HttpProvider(chain_rpc));
    this.provider = new JsonRpcProvider(chain_rpc);
    this.queryGasPrice();
  }

  deriveAddress(accountId, derivation_path) {
    const { address, publicKey } = generateEthAddress({
      accountId,
      derivation_path,
    });
    return { address, publicKey };
  }

  async queryGasPrice() {
    const block = await this.web3.eth.getBlock("latest");
    const maxPriorityFeePerGas = await this.web3.eth.getMaxPriorityFeePerGas();
    const maxFeePerGas = block.baseFeePerGas * 2n + maxPriorityFeePerGas;
    return { maxFeePerGas, maxPriorityFeePerGas };
  }

  async getBalance(accountId) {
    const balance = await this.web3.eth.getBalance(accountId);
    return this.web3.utils.fromWei(balance, 'ether');
  }

  async getContractViewFunction(receiver, abi, methodName, args = []) {
    const contract = new Contract(receiver, abi, this.provider);

    return await contract[methodName](...args);
  }

  createTransactionData(receiver, abi, methodName, args = []) {
    const contract = new Contract(receiver, abi);

    return contract.interface.encodeFunctionData(methodName, args);
  }

  async createTransaction({ sender, receiver, amount, data = undefined }) {
    // Get the nonce & gas price
    const nonce = await this.web3.eth.getTransactionCount(sender);
    const { maxFeePerGas, maxPriorityFeePerGas } = await this.queryGasPrice();

    const { chainId } = await this.provider.getNetwork();

    // Construct transaction
    const transactionData = {
      nonce,
      gasLimit: 50_000,
      maxFeePerGas,
      maxPriorityFeePerGas,
      to: receiver,
      data: data,
      value: BigInt(this.web3.utils.toWei(amount, "ether")),
      chainId: chainId,
    };

    // Create a transaction
    const transaction = FeeMarketEIP1559Transaction.fromTxData(
      transactionData,
      {}
    );

    return { transaction };
  }

  async getPayload({
    transaction,
  }) {
    const payload = Array.from(transaction.getHashedMessageToSign());
    return payload;
  }

  async reconstructSignedTransaction(big_r, S, recovery_id, transaction) {
    // reconstruct the signature
    const r = Buffer.from(big_r.affine_point.substring(2), "hex");
    const s = Buffer.from(S.scalar, "hex");
    const v = recovery_id;

    const signedTx = transaction.addSignature(v, r, s);

    if (signedTx.getValidationErrors().length > 0)
      throw new Error("Transaction validation errors");
    if (!signedTx.verifySignature()) throw new Error("Signature is not valid");
    return signedTx;
  }

  // This code can be used to actually relay the transaction to the Ethereum network
  async broadcastTX(signedTransaction) {
    const serializedTx = bytesToHex(signedTransaction.serialize());
    const relayed = this.web3.eth.sendSignedTransaction(serializedTx);
    let txHash;
    await relayed.on("transactionHash", (hash) => {
      txHash = hash;
    });
    return txHash;
  }
}