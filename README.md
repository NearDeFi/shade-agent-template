# Shade Agent Template

> [!WARNING]  
> This technology has not yet undergone a formal audit. Use at your own risk. Please conduct your own due diligence and exercise caution before integrating or relying on it in production environments.

This is a monorepo template for the Shade Agent Sadnbox with all the code and tools for deploying a Shade Agent on NEAR and Phala Cloud.

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

# Install the Phala Cloud CLI
npm install -g phala
```

If you already have the NEAR CLI installed, check that you have the `most recent version`.

- Create a `NEAR testnet account` and record the account name and `seed phrase`:

```bash
near account create-account sponsor-by-faucet-service <example-name.testnet> autogenerate-new-keypair print-to-terminal network-config testnet create
```

- Install Docker for [Mac](https://docs.docker.com/desktop/setup/install/mac-install/) or [Linux](https://docs.docker.com/desktop/setup/install/linux/) and set up an account.

- Set up a free Phala Cloud account at https://cloud.phala.network/register then get an API key from https://cloud.phala.network/dashboard/tokens.

What is a Phala Cloud?

Phala Cloud is a service that offers secure and private hosting in a TEE using [Dstack](https://docs.phala.network/overview/phala-network/dstack). Phala Cloud makes it easy to run a TEE, that's why we use it in our template!

---

## Local Development

- Rename the `.env.development.local.example` file name to `.env.development.local` and configure your environment variables.

- Start up Docker:

For Linux

```bash
sudo systemctl start docker
```

For Mac

Simply open the Docker Desktop application or run:

```bash
open -a Docker
```

- Make sure the `NEXT_PUBLIC_contractId` prefix is set to `ac.proxy.` followed by your NEAR accountId.

- In one terminal, run the Shade Agent CLI:

```bash
shade-agent-cli
```

The CLI will prompt you to enter your `sudo password`.

- In another terminal, start the frontend :

```bash
yarn
yarn start
```

---

## TEE Deployment

- Change the `NEXT_PUBLIC_contractId` prefix to `ac.sandbox.` followed by your NEAR accountId.

- Run the Shade Agent CLI

```bash
shade-agent-cli
```

The CLI will prompt you to enter your `sudo password`.

This command will take about 5 minutes to complete.

- Head over to your Phala Cloud dashboard https://cloud.phala.network/dashboard

- Once the deployment is finished, click on your deployment, then head to the `network tab` and open the endpoint that is running on `port 3000`.
