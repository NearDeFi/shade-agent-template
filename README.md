# shade-agent-template

An example agent that uses shade-agent-js locally.

## Running this example

- Build shade-agent-js

  In shade-agent-framework root

  ```bash
  cd shade-agent-js
  npm i
  npm run build
  cd ..
  ```

- Compile the example contract

  In the shade-agent-framework root

  Linux

  ```bash
  cd shade-contract-template
  cargo near build non-reproducible-wasm --no-abi
  ```

  Mac

  ```bash
  docker run --rm \
  -v "$(pwd)":/workspace \
  -w "/workspace/shade-contract-template" \
  pivortex/near-builder@sha256:cdffded38c6cff93a046171269268f99d517237fac800f58e5ad1bcd8d6e2418 \
  cargo near build non-reproducible-wasm --no-abi
  ```

- Install dependencies

  In shade-agent-framework root

  ```bash
  cd shade-agent-template
  npm i
  ```

- Fill out agent_contract.contract_id and build_docker_image.tag in [deployment.yaml](./deployment.yaml)

- Fill out environment variables in .env file in shade-agent-framework root

  ```env
  AGENT_CONTRACT_ID=
  SPONSOR_ACCOUNT_ID=
  SPONSOR_PRIVATE_KEY=
  ```

- Set up credentials in the CLI

  ```bash
  npm run shade:cli auth set all testnet
  ```

- Run the CLI

  In shade-agent-template root

  ```bash
  npm run shade:cli deploy
  ```

- Start the agent

  In the shade-agent-template root

  ```bash
  npm run dev
  ```

- In another terminal whitelist the agent

  In the shade-agent-template root

  ```bash
  npm run shade:cli whitelist
  ```

### For TEE deployment

- Update environment in [deployment.yaml](./deployment.yaml) to TEE

- Run the CLI

  ```bash
  npm run shade:cli deploy
  ```
