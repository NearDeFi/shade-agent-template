export declare const ethRpcUrl = "https://sepolia.drpc.org";
export declare const ethContractAddress = "0xb8d9b079F1604e9016137511464A1Fe97F8e2Bd8";
export declare const ethContractAbi: readonly [{
    readonly inputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "_price";
        readonly type: "uint256";
    }];
    readonly name: "updatePrice";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "getPrice";
    readonly outputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}];
export declare const Evm: any;
export declare function getContractPrice(): Promise<bigint>;
export declare function convertToDecimal(bigIntValue: bigint, decimals: number, decimalPlaces?: number): string;
//# sourceMappingURL=ethereum.d.ts.map