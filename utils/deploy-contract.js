import fs from 'fs';
import * as dotenv from 'dotenv';
dotenv.config({ path: './.env.development.local' });
import * as nearAPI from 'near-api-js';
const { Near, Account, KeyPair, keyStores } = nearAPI;

// NEEDS TO MATCH docker-compose.yaml CODEHASH
const codehash =
'45a107361c3ccacdbd39b8b9d5115375e267519b9c4c8f1599d560a29863af8b';

const networkId = 'testnet';
const accountId = process.env.NEXT_PUBLIC_accountId;
const contractId = process.env.NEXT_PUBLIC_contractId;
console.log(accountId, contractId);

const keyStore = new keyStores.InMemoryKeyStore();
const keyPair = KeyPair.fromString(process.env.NEXT_PUBLIC_secretKey);
keyStore.setKey(networkId, accountId, keyPair);
keyStore.setKey(networkId, contractId, keyPair);
console.log(keyStore);

const config = {
    networkId,
    nodeUrl: 'https://test.rpc.fastnear.com',
    keyStore,
};
const near = new Near(config);
const { connection } = near;
const gas = BigInt('300000000000000');

export const getAccount = (id) => new Account(connection, id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const deploy = async () => {
    try {
        const account = getAccount(contractId);
        await account.deleteAccount(accountId);
    } catch (e) {
        console.log('error deleteAccount', e);
    }

    await sleep(1000);

    try {
        const account = getAccount(accountId);
        console.log(account);
        await account.createAccount(
            contractId,
            keyPair.getPublicKey(),
            nearAPI.utils.format.parseNearAmount('10'),
        );
    } catch (e) {
        console.log('error createAccount', e);
    }

    await sleep(1000);

    const file = fs.readFileSync('./contract/target/near/contract.wasm');
    let account = getAccount(contractId);
    await account.deployContract(file);
    console.log('deployed bytes', file.byteLength);
    const balance = await account.getAccountBalance();
    console.log('contract balance', balance);

    await sleep(1000);

    const initRes = await account.functionCall({
        contractId,
        methodName: 'init',
        args: { owner_id: accountId },
        gas,
        serializationType: 'borsh'
    });

    console.log('initRes', initRes);

    await sleep(1000);

    account = getAccount(accountId);
    const approveRes = await account.functionCall({
        contractId,
        methodName: 'approve_codehash',
        args: {
            codehash,
        },
        gas,
    });

    console.log('approveRes', approveRes);
};

deploy();