# Shade Agent Template

> [!WARNING]  
> This technology has not yet undergone a formal audit. Use at your own risk. Please conduct your own due diligence and exercise caution before integrating or relying on it in production environments.

This is a monorepo template for the Shade Agent Stack with all the code and tools for deploying a Shade Agent on NEAR and Phala Cloud.

This template is a simple verifiable ETH Price Oracle that pushes prices to an Ethereum contract. 

For full instructions on this repository please refer to our [docs](https://docs.near.org/ai/shade-agents/production/production-deploying).

## TEE Deployment

These set of instructions will guide you to deploy your Shade Agent within a TEE.

### Configuring the worker agent 

- Enter the repository and run `yarn` to install the dependencies.

- Update the `docker:image` and `docker:push` scripts within your `package.json` file to match your repo path.

- Configure your `.env.development.local` file with the following:
  - Your NEAR account ID.
  - The seed phrase for this account.
  - Set the contract ID to your account ID prefixed with `contract.` (the contract account will be created during deployment, you should not create this before).

- Set the exact same variables in your `.env` file.

- Open Docker Desktop (you don't need to do anything here, it's just to start up Docker).

- Run `yarn docker:image` followed by `yarn docker:push` to build your Docker image.

- The CLI will print out your `code hash`, which will look something like `sha256:c085606f55354054408f45a9adee8ba4c0a4421d8e3909615b72995b83ad0b84`. You can also check this code hash on Docker Desktop, under the image Id. Take this code hash and update the hash in your [docker-compose.yaml](https://github.com/PiVortex/shade-agent-template/blob/main/docker-compose.yaml#L4) and [utils/deploy-contract.js](https://github.com/PiVortex/shade-agent-template/blob/main/utils/deploy-contract.js#L9).

### Deploying the Agent Contract 

- To build and deploy the agent contract, run `yarn contract:deploy` or `yarn contract:deploy:mac` depending on which system you're using. For deployment on Mac, the script builds a Docker container and installs tools to build the agent contract, since the contract has dependencies that cannot be built on Mac.

- Make sure to keep your account topped up with testnet NEAR. You can get additional NEAR from the [faucet](https://near-faucet.io/) or by asking in our [Dev Group](https://t.me/shadeagents).

### Deploying to Phala

- Make sure you `commit` and `push` your recent changes to GitHub.

- Go to the Phala Cloud dashboard https://cloud.phala.network/dashboard.

- Click deploy > docker-compose.yml > paste in your docker-compose.yaml, and click deploy. You do not need to enter any environment variables here.

- Once the deployment is finished, click on your deployment, then head to the `network tab` and open the endpoint.

Now you can interact with the Shade Agent. 

If you are having problems deploying your Docker image to Phala, make sure that your node version in your [Dockerfile](https://github.com/PiVortex/shade-agent-template/blob/main/Dockerfile#L3) matches the one on your machine.

### Using the Shade Agent

- You will need to first fund the worker agent with a small amount of `testnet NEAR`. This can be done from the NEAR CLI or a testnet wallet. This account needs testnet NEAR to call the agent contract to register and send transactions.

```bash
near tokens <accountId> send-near <workerAccountId> '1 NEAR' network-config testnet
```

- Next, fund the Sepolia account from a wallet. You can get `Sepolia ETH` from this [faucet](https://cloud.google.com/application/web3/faucet/ethereum/sepolia). This account needs Sepolia ETH to call the Ethereum smart contract to update the stored value.

- Then register the worker agent by clicking the step 3 box.

- Now the worker agent is registered, you can click to update the stored price of ETH in the Ethereum smart contract.

The RPCs being used are rate-limited, so the agent may throw errors if the update price box is clicked too often.

### Iterative Flow 

Each time you update the worker code, you need to deploy a new image to Phala Cloud as the code hash will have changed. To do this, follow these steps:

- Build the new image `yarn docker:image` followed by `yarn docker:push`.

- Update the stored codehash in your [docker-compose.yaml](https://github.com/PiVortex/shade-agent-template/blob/main/docker-compose.yaml#L4) file and then the code hash (no sha256: prefix) in the agent contract using the NEAR CLI: 

```bash
near contract call-function as-transaction <contractId> approve_codehash json-args '{"codehash": "<yourNewCodeHash>"}' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' sign-as <accountId> network-config testnet 
```

- Update your Phala deployment by clicking on the three little dots, clicking update, and pasting your new `docker-compose.yaml` file.

If you have made changes to the agent contract, you will need to redeploy the contract with the new hash. Update [utils/deploy-contract.js](https://github.com/PiVortex/shade-agent-template/blob/main/utils/deploy-contract.js#L9) and run `yarn contract:deploy` or `yarn contract:deploy:mac`.

---

## Local Development 

Developing locally is much easier for quickly iterating on and testing your agent. You can test all the flows except for the agent registration and valid agent gating.

- To develop locally, comment out the valid worker agent gating from the `sign_tx` method in the [lib.rs](https://github.com/PiVortex/shade-agent-template/blob/main/contract/src/lib.rs#L70C1-L71C71) file of the agent contract.

```rust
    pub fn sign_tx(
        &mut self,
        payload: Vec<u8>,
        derivation_path: String,
        key_version: u32,
    ) -> Promise {
        // Comment out this line for local development
        //self.require_registered_worker();

        // Call the MPC contract to get a signature for the payload
        ecdsa::get_sig(payload, derivation_path, key_version)
    }
```

This means now any account, not just valid worker agents, can call this method and get signatures.

- Next, redeploy your agent contract with `yarn contract:deploy` or `yarn contract:deploy:mac`.

- Now you can run your agent locally `yarn dev`.
