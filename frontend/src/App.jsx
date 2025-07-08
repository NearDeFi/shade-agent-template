import { useState, useEffect } from 'react';
import '../styles/globals.css';
import { getContractPrice, convertToDecimal } from './ethereum';
import Overlay from './Overlay';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const API_URL = 'http://localhost:3000';

export default function Home() {
    const [message, setMessage] = useState('');
    const [accountId, setAccountId] = useState();
    const [balance, setBalance] = useState('0');
    const [ethAddress, setEthAddress] = useState('');
    const [ethBalance, setEthBalance] = useState('0');
    const [contractPrice, setContractPrice] = useState(null);
    const [lastTxHash, setLastTxHash] = useState(null);
    const [error, setError] = useState('');

    const setMessageHide = async (message, dur = 3000, success = false) => {
      setMessage({ text: message, success });
      await sleep(dur);
      setMessage('');
  };

  const getPrice = async () => {
      try {
          const price = await getContractPrice();
          const displayPrice = (parseInt(price.toString()) / 100).toFixed(2);
          setContractPrice(displayPrice);
      } catch (error) {
          console.log('Error fetching contract price:', error);
          setError('Failed to fetch contract price');
      }
  };

    const getAgentAccount = async () => {
      try {
      const res = await fetch(`${API_URL}/api/agent-account`).then((r) => r.json());
      setAccountId(res.accountId);
      const formattedBalance = convertToDecimal(res.balance, 24);
      setBalance(formattedBalance);
      } catch (error) {
          console.log('Error getting worker account:', error);
          setError('Failed to get worker account details');
      }
  };

  const getEthAccount = async () => {
    try {
          const res = await fetch(`${API_URL}/api/eth-account`).then((r) => r.json());
          setEthAddress(res.senderAddress);
          const formattedBalance = convertToDecimal(res.balance, 18);
          setEthBalance(formattedBalance);
      } catch (error) {
          console.log('Error fetching ETH info:', error);
          setError('Failed to fetch ETH account details');
      }
  };

  const setPrice = async () => {
    try {
      const res = await fetch(`${API_URL}/api/transaction`).then((r) => r.json());
      setContractPrice(res.newPrice);
      setLastTxHash(res.txHash);
      setMessageHide('Successfully set the ETH price!', 3000, true);
    } catch (error) {
      setMessageHide('Failed to set price. Check that both accounts are funded.', 3000, true);
      console.log('Error setting price:', error);
      setError('Failed to set price');
    }
  };

    useEffect(() => {
        getAgentAccount();
        getEthAccount();
        getPrice();
    }, []);

    return (
        <div className="container">
            <div>
                <title>ETH Price Oracle</title>
                <link rel="icon" href="/favicon.ico" />
            </div>
            <Overlay message={message} />

            <main className="main">
                <h1 className="title">ETH Price Oracle</h1>
                <div className="subtitleContainer">
                    <h2 className="subtitle">Powered by Shade Agents</h2>
                </div>
                <p>
                    This is a simple example of a verifiable price oracle for an ethereum smart contract using Shade Agents.
                </p>
                <ol>
                    <li>
                        Keep the worker account funded with testnet NEAR tokens
                    </li>
                    <li>
                        Fund the Ethereum Sepolia account (0.001 ETH will do)
                    </li>
                    <li>
                        Send the ETH price to the Ethereum contract
                    </li>
                </ol>

                {contractPrice !== null && (
                    <div className="contract-price-box">
                        <h3 className="contract-price-title">Current Set ETH Price</h3>
                        <p className="contract-price-value">
                            ${contractPrice}
                        </p>
                    </div>
                )}
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

                <div className="grid">
                    <div className="card">
                        <h3>Fund Worker Account</h3>
                        <p>
                            <br />
                            {accountId?.length >= 24
                                ? `${accountId.substring(0, 10)}...${accountId.substring(accountId.length - 4)}`
                                : accountId}
                            <br />
                            <button
                                className="btn"
                                onClick={() => {
                                    try {
                                        if(navigator.clipboard && navigator.clipboard.writeText) {
                                            navigator.clipboard.writeText(accountId);
                                            setMessageHide('Copied', 500, true);
                                        } else {
                                            setMessageHide('Clipboard not supported', 3000, true);
                                        }
                                    } catch (e) {
                                        setMessageHide('Copy failed', 3000, true);
                                    }
                                }}
                            >
                                copy
                            </button>
                            <br />
                            <br />
                            balance:{' '}
                            {(() => {
                                if (!balance) {
                                    return '0';
                                }
                                try {
                                    return balance;
                                } catch (error) {
                                    console.error('Error formatting balance:', error);
                                    return '0';
                                }
                            })()}
                            <br />
                            <a 
                                href="https://near-faucet.io/" 
                                target="_blank" 
                                rel="noopener noreferrer"
                                style={{ 
                                    color: '#0070f3', 
                                    textDecoration: 'none',
                                    fontSize: '0.9rem'
                                }}
                            >
                                Get Testnet NEAR tokens from faucet →
                            </a>
                        </p>
                    </div>

                    <div className="card">
                        <h3>Fund Sepolia Account</h3>
                        <p>
                            <br />
                            {ethAddress ? (
                                <>
                                    {ethAddress.substring(0, 10)}...{ethAddress.substring(ethAddress.length - 4)}
                                    <br />
                                    <button
                                        className="btn"
                                        onClick={() => {
                                            try {
                                                if(navigator.clipboard && navigator.clipboard.writeText) {
                                                    navigator.clipboard.writeText(ethAddress);
                                                    setMessageHide('Copied', 500, true);
                                                } else {
                                                    setMessageHide('Clipboard not supported', 3000, true);
                                                }
                                            } catch (e) {
                                                setMessageHide('Copy failed', 3000, true);
                                            }
                                        }}
                                    >
                                        copy
                                    </button>
                                    <br />
                                    <br />
                                    Balance: {ethBalance ? ethBalance : '0'} ETH
                                    <br />
                                    <a 
                                        href="https://cloud.google.com/application/web3/faucet/ethereum/sepolia" 
                                        target="_blank" 
                                        rel="noopener noreferrer"
                                        style={{ 
                                            color: '#0070f3', 
                                            textDecoration: 'none',
                                            fontSize: '0.9rem'
                                        }}
                                    >
                                        Get Sepolia ETH from faucet →
                                    </a>
                                </>
                            ) : (
                                'Loading...'
                            )}
                        </p>
                    </div>

                    <a
                        href="#"
                        className="card"
                        onClick={async () => {
                            setMessage({ 
                                text: 'Querying and sending the ETH price to the Ethereum contract...',
                                success: false
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

            <footer className="footer">
                <a
                    href="https://proximity.dev"
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    <img
                        src="/symbol.svg"
                        alt="Proximity Logo"
                        className="logo"
                    />
                    <img
                        src="/wordmark_black.svg"
                        alt="Proximity Logo"
                        className="wordmark"
                    />
                </a>
            </footer>
            {error && (
                <div className="error-toast">
                    {error}
                </div>
            )}
        </div>
    );
}