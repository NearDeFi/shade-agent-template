"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Evm = exports.ethContractAbi = exports.ethContractAddress = exports.ethRpcUrl = void 0;
exports.getContractPrice = getContractPrice;
exports.convertToDecimal = convertToDecimal;
const chainsig_js_1 = require("chainsig.js");
const viem_1 = require("viem");
const ethers_1 = require("ethers");
exports.ethRpcUrl = 'https://sepolia.drpc.org';
exports.ethContractAddress = '0xb8d9b079F1604e9016137511464A1Fe97F8e2Bd8';
exports.ethContractAbi = [
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
];
const MPC_CONTRACT = new chainsig_js_1.contracts.ChainSignatureContract({
    networkId: `testnet`,
    contractId: `v1.signer-prod.testnet`,
});
const publicClient = (0, viem_1.createPublicClient)({
    transport: (0, viem_1.http)(exports.ethRpcUrl),
});
exports.Evm = new chainsig_js_1.chainAdapters.evm.EVM({
    publicClient,
    contract: MPC_CONTRACT
});
const provider = new ethers_1.JsonRpcProvider(exports.ethRpcUrl);
const contract = new ethers_1.Contract(exports.ethContractAddress, exports.ethContractAbi, provider);
async function getContractPrice() {
    return await contract.getPrice();
}
function convertToDecimal(bigIntValue, decimals, decimalPlaces = 6) {
    let strValue = bigIntValue.toString();
    if (strValue.length <= decimals) {
        strValue = strValue.padStart(decimals + 1, '0');
    }
    const decimalPos = strValue.length - decimals;
    const result = strValue.slice(0, decimalPos) + '.' + strValue.slice(decimalPos);
    return parseFloat(result).toFixed(decimalPlaces);
}
//# sourceMappingURL=ethereum.js.map