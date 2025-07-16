# Shade Agent Template

> [!WARNING]  
> This technology has not yet undergone a formal audit. Please conduct your own due diligence and exercise caution before integrating or relying on it in production environments.

This is a simple template for the Shade Agent Framework with all the code and tools required for deploying a Shade Agent on NEAR and Phala Cloud.

This template is a simple verifiable ETH Price Oracle that pushes prices to an Ethereum contract.

For full instructions on this repository please refer to our [docs](https://docs.near.org/ai/shade-agents/sandbox/sandbox-deploying).

## Prerequisites

- First, `clone` this template.

```bash
git clone https://github.com/NearDeFi/shade-agent-sandbox-template shade-agent
cd shade-agent
```

- Install NEAR and Shade Agent tooling:

```bash
# Install the NEAR CLI
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/near-cli-rs/releases/latest/download/near-cli-rs-installer.sh | sh

# Install the Shade Agent CLI
npm i -g @neardefi/shade-agent-cli
```

- Create a `NEAR testnet account` and record the account name and `seed phrase`:

```bash
near account create-account sponsor-by-faucet-service <example-name.testnet> autogenerate-new-keypair print-to-terminal network-config testnet create
```

replacing <example-name.testnet> with a unique name.

- Set up docker if you have not already:

Install Docker for [Mac](https://docs.docker.com/desktop/setup/install/mac-install/) or [Linux](https://docs.docker.com/desktop/setup/install/linux/) and set up an account.

Log in to docker, `docker login` for Mac or `sudo docker login` for Linux.

- Set up a free Phala Cloud account at https://cloud.phala.network/register then get an API key from https://cloud.phala.network/dashboard/tokens.

What is a Phala Cloud?

Phala Cloud is a service that offers secure and private hosting in a TEE using [Dstack](https://docs.phala.network/overview/phala-network/dstack). Phala Cloud makes it easy to run a TEE, that's why we use it in our template!

---

## Set up

- Rename the `.env.development.local.example` file name to `.env.development.local` and configure your environment variables.

- Start up Docker:

For Mac

Simply open the Docker Desktop application or run:

```bash
open -a Docker
```

For Linux

```bash
sudo systemctl start docker
```

- Install dependencies 

```bash
npm i
```

---

## Local development

- Make sure the `NEXT_PUBLIC_contractId` prefix is set to `ac.proxy.` followed by your NEAR accountId.

- In one terminal, run the Shade Agent CLI:

```bash
shade-agent-cli
```

The CLI on Linux may prompt you to enter your `sudo password`.

- In another terminal, start your app:

```bash
npm run dev
```

Your app will start on https://localhost:3000

---

## TEE Deployment

- Change the `NEXT_PUBLIC_contractId` prefix to `ac.sandbox.` followed by your NEAR accountId.

- Run the Shade Agent CLI

```bash
shade-agent-cli
```

The CLI on Linux may prompt you to enter your `sudo password`.

The last URL the CLI outputs is where your app is hosted.

If your application is not working head over to your App on Phala Dashboard and review the logs.

## Interacting with the Agent

You can interact with your agent via the APIs directly or via a lightweight frontend contained in this repo.

### Direct

For Phala deployments swap localhost:3000 for your deployment URL

Get the Agent account and it's balance:

```
https://localhost:3000/api/agent-account
```

Get the derived Ethereum Sepolia account and it's balance (you will need to fund this):

```
https://localhost:3000/api/eth-account
```

Send a transaction through the Agent to update the price of Eth:

```
https://localhost:3000/api/transaction
```

### Frontend

To run the frontend run:

```bash
cd frontend
npm i
npm run dev
```

To run the frontend with your Phala deployment change the `API_URL` to Phala URL in your [config.js](./frontend/src/config.js) file.
