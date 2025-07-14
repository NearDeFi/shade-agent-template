import { useState, useEffect } from "react";
import "../styles/globals.css";
import { getContractPrice, formatBalance } from "./ethereum";
import Overlay from "./Overlay";
import { API_URL } from "./config";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default function Home() {
  const [message, setMessage] = useState("");
  const [agentAddress, setAgentAddress] = useState();
  const [agentBalance, setAgentBalance] = useState("0");
  const [ethAddress, setEthAddress] = useState("");
  const [ethBalance, setEthBalance] = useState("0");
  const [contractPrice, setContractPrice] = useState(null);
  const [lastTxHash, setLastTxHash] = useState(null);
  const [error, setError] = useState("");

  const setMessageHide = async (message, dur = 3000, success = false) => {
    setMessage({ text: message, success });
    await sleep(dur);
    setMessage("");
  };

  // Get the current price from the value in the Ethereum contract
  const getPrice = async () => {
    try {
      const price = await getContractPrice();
      const displayPrice = (parseInt(price.toString()) / 100).toFixed(2);
      setContractPrice(displayPrice);
    } catch (error) {
      console.log("Error fetching contract price:", error);
      setError("Failed to fetch contract price");
    }
  };

  // Call the API to get the agent account details
  const getAgentAccount = async () => {
    try {
      const res = await fetch(`${API_URL}/api/agent-account`).then((r) =>
        r.json(),
      );
      setAgentAddress(res.accountId);
      const formattedBalance = formatBalance(res.balance, 24);
      setAgentBalance(formattedBalance);
    } catch (error) {
      console.log("Error getting agent account:", error);
      setError("Failed to get agent account details");
    }
  };

  // Call the API to get the Ethereum account details
  const getEthAccount = async () => {
    try {
      const res = await fetch(`${API_URL}/api/eth-account`).then((r) =>
        r.json(),
      );
      setEthAddress(res.senderAddress);
      const formattedBalance = formatBalance(res.balance, 18);
      setEthBalance(formattedBalance);
    } catch (error) {
      console.log("Error fetching ETH info:", error);
      setError("Failed to fetch ETH account details");
    }
  };

  // Call the API to set the price in the Ethereum contract
  const setPrice = async () => {
    try {
      const res = await fetch(`${API_URL}/api/transaction`).then((r) =>
        r.json(),
      );
      setContractPrice(res.newPrice);
      setLastTxHash(res.txHash);
      setMessageHide("Successfully set the ETH price!", 3000, true);
    } catch (error) {
      setMessageHide(
        "Failed to set price. Check that both accounts are funded.",
        3000,
        true,
      );
      console.log("Error setting price:", error);
      setError("Failed to set price");
    }
  };

  // Set up the initial state
  useEffect(() => {
    getAgentAccount();
    getEthAccount();
    getPrice();
  }, []);

  return (
    <div className="container">
      <div>
        <title>ETH Price Oracle</title>
      </div>
      <Overlay message={message} />

      <main className="main">
        <h1 className="title">ETH Price Oracle</h1>
        <div className="subtitleContainer">
          <h2 className="subtitle">Powered by Shade Agents</h2>
        </div>
        <p>
          This is a simple example of a Verifiable Price Oracle for an Ethereum
          smart contract using Shade Agents.
        </p>
        <ol>
          <li>Keep the agent account funded with testnet NEAR tokens</li>
          <li>Fund the Ethereum Sepolia account (0.001 ETH will do)</li>
          <li>Send the ETH price to the Ethereum contract</li>
        </ol>

        {/* Display the current price in the Ethereum contract */}
        {contractPrice !== null && (
          <div className="contract-price-box">
            <h3 className="contract-price-title">Current Set ETH Price</h3>
            <p className="contract-price-value">${contractPrice}</p>
          </div>
        )}

        {/* Display the etherscan link after the price is set */}
        {lastTxHash && (
          <div className="tx-link-box">
            <a
              href={`https://sepolia.etherscan.io/tx/${lastTxHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="tx-link"
            >
              View the transaction on Etherscan
            </a>
          </div>
        )}

        {/* Display the agent account details */}
        <div className="grid">
          <div className="card">
            <h3>Fund Agent Account</h3>
            <p>
              <br />
              {agentAddress?.length >= 24
                ? `${agentAddress.substring(0, 10)}...${agentAddress.substring(agentAddress.length - 4)}`
                : agentAddress}
              <br />
              <button
                className="btn"
                onClick={() => {
                  try {
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                      navigator.clipboard.writeText(agentAddress);
                      setMessageHide("Copied", 500, true);
                    } else {
                      setMessageHide("Clipboard not supported", 3000, true);
                    }
                  } catch (e) {
                    setMessageHide("Copy failed", 3000, true);
                  }
                }}
              >
                copy
              </button>
              <br />
              <br />
              balance:{" "}
              {(() => {
                if (!agentBalance) {
                  return "0";
                }
                try {
                  return agentBalance;
                } catch (error) {
                  console.error("Error formatting balance:", error);
                  return "0";
                }
              })()}
              <br />
              <a
                href="https://near-faucet.io/"
                target="_blank"
                rel="noopener noreferrer"
                className="faucet-link"
              >
                Get Testnet NEAR tokens from faucet →
              </a>
            </p>
          </div>

          {/* Display the Ethereum account details */}
          <div className="card">
            <h3>Fund Sepolia Account</h3>
            <p>
              <br />
              {ethAddress ? (
                <>
                  {ethAddress.substring(0, 10)}...
                  {ethAddress.substring(ethAddress.length - 4)}
                  <br />
                  <button
                    className="btn"
                    onClick={() => {
                      try {
                        if (
                          navigator.clipboard &&
                          navigator.clipboard.writeText
                        ) {
                          navigator.clipboard.writeText(ethAddress);
                          setMessageHide("Copied", 500, true);
                        } else {
                          setMessageHide("Clipboard not supported", 3000, true);
                        }
                      } catch (e) {
                        setMessageHide("Copy failed", 3000, true);
                      }
                    }}
                  >
                    copy
                  </button>
                  <br />
                  <br />
                  Balance: {ethBalance ? ethBalance : "0"} ETH
                  <br />
                  <a
                    href="https://cloud.google.com/application/web3/faucet/ethereum/sepolia"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="faucet-link"
                  >
                    Get Sepolia ETH from faucet →
                  </a>
                </>
              ) : (
                "Loading..."
              )}
            </p>
          </div>

          {/* Display the button to set the price in the Ethereum contract */}
          <a
            href="#"
            className="card"
            onClick={async () => {
              setMessage({
                text: "Querying and sending the ETH price to the Ethereum contract...",
                success: false,
              });
              await setPrice();
            }}
          >
            <h3>Set ETH Price</h3>
            <p className="code">
              Click to set the ETH price in the smart contract
            </p>
          </a>
        </div>
      </main>

      {/* Display the terms of use link */}
      <div className="terms-link-box">
        <a
          href="https://fringe-brow-647.notion.site/Terms-for-Price-Oracle-1fb09959836d807a9303edae0985d5f3"
          target="_blank"
          rel="noopener noreferrer"
          className="terms-link"
        >
          Terms of Use
        </a>
      </div>

      {/* Display the footer */}
      <footer className="footer">
        <a
          href="https://proximity.dev"
          target="_blank"
          rel="noopener noreferrer"
        >
          <img src="/symbol.svg" alt="Proximity Logo" className="logo" />
          <img
            src="/wordmark_black.svg"
            alt="Proximity Logo"
            className="wordmark"
          />
        </a>
      </footer>

      {/* Display the error message */}
      {error && <div className="error-toast">{error}</div>}
    </div>
  );
}
