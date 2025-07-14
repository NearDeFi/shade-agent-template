import { Contract, JsonRpcProvider } from "ethers";

export const ethRpcUrl = "https://sepolia.drpc.org";
export const ethContractAddress = "0xb8d9b079F1604e9016137511464A1Fe97F8e2Bd8";

export const ethContractAbi = [
  {
    inputs: [
      {
        internalType: "uint256",
        name: "_price",
        type: "uint256",
      },
    ],
    name: "updatePrice",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "getPrice",
    outputs: [
      {
        internalType: "uint256",
        name: "",
        type: "uint256",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
];

const provider = new JsonRpcProvider(ethRpcUrl);
const contract = new Contract(ethContractAddress, ethContractAbi, provider);

// Function to get the price from the Ethereum contract
export async function getContractPrice() {
  return await contract.getPrice();
}

// Function to format account balances
export function formatBalance(balance, decimals, decimalPlaces = 6) {
  let strValue = balance.toString();

  if (strValue.length <= decimals) {
    strValue = strValue.padStart(decimals + 1, "0");
  }

  const decimalPos = strValue.length - decimals;

  const result =
    strValue.slice(0, decimalPos) + "." + strValue.slice(decimalPos);

  return parseFloat(result).toFixed(decimalPlaces);
}
