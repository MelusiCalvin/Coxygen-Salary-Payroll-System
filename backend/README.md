Demo Escrow Backend

This backend is a simple demonstration of a custodial escrow that holds deposited ADA for streaming payments and releases claimable amounts to recipients on request.

NOT FOR PRODUCTION.

Setup

1. Install dependencies:

```bash
cd backend
npm install
```

2. Start server (examples)

- POSIX / Git Bash / WSL:

```bash
PORT=3000 ESCROW_ADDRESS=addr_test1... npm start
```

- Windows PowerShell:

```powershell
$env:PORT = '3000'
$env:ESCROW_ADDRESS = 'addr_test1...'
npm start
```

- Windows CMD:

```cmd
set PORT=3000
set ESCROW_ADDRESS=addr_test1...
npm start
```

Notes:
- To enable Blockfrost/CSL-backed flows set `BLOCKFROST_PROJECT_ID`.
- If `BLOCKFROST_PROJECT_ID` is not set the backend will run in demo mode and simulate payouts.

API

- POST /create-stream
  body: { senderAddress, recipient, total, start, end }
  returns: { id, depositAddress, stream }

- POST /notify-deposit
  body: { id, txId }
  -> marks stream Active

- POST /claim
  body: { id, recipientAddress }
  -> computes claimable and returns { claimed, txHash }

Quick testing (curl examples)

- Create a stream:

```bash
curl -X POST http://localhost:3000/create-stream \
  -H "Content-Type: application/json" \
  -d '{"senderAddress":"addr_test1...","recipient":"addr_test1...","total":10000000,"start":"2026-02-11T00:00:00Z","end":"2026-03-11T00:00:00Z"}'
```

- Mark deposit detected (simulate indexer webhook):

```bash
curl -X POST http://localhost:3000/notify-deposit -H "Content-Type: application/json" -d '{"id":"<STREAM_ID>","txId":"demo-deposit-tx"}'
```

- Claim for a stream:

```bash
curl -X POST http://localhost:3000/claim -H "Content-Type: application/json" -d '{"id":"<STREAM_ID>","recipientAddress":"addr_test1..."}'
```

Build unsigned transaction endpoints (for wallet signing)

- Build deposit (backend returns unsigned CBOR or plan):

```bash
curl -X POST http://localhost:3000/build-deposit -H "Content-Type: application/json" \
  -d '{"senderAddress":"addr_test1...","scriptAddress":"addr_test1...","datum":{"note":"demo"},"amountLovelace":10000000}'
```

- Build claim (backend returns unsigned CBOR or plan):

```bash
curl -X POST http://localhost:3000/build-claim -H "Content-Type: application/json" \
  -d '{"scriptUtxo":{"tx_hash":"...","tx_index":0,"lovelace":20000000,"address":"addr_test1..."},"datum":{},"claimAmount":1000000,"recipientAddress":"addr_test1..."}'
```

Frontend signing with a CIP-30 wallet (example outline)

1. Request build from backend to get `unsignedTxHex` (CBOR hex) or a `plan`.
2. If backend returns a `plan`, use `@emurgo/cardano-serialization-lib` in the browser to assemble the transaction using the selected UTXOs and outputs from the plan.
3. Use the wallet provider's `signTx` and `submitTx` methods to sign and submit the completed transaction. Example pseudo-code:

```javascript
// Assuming `wallet` is the enabled CIP-30 API and `csl` is cardano-serialization-lib in browser
const unsignedHex = result.unsignedTxHex; // from backend
// Some wallets accept signTx(unsignedTxHex, true) where true indicates partialSign
const signed = await wallet.signTx(unsignedHex, true);
// submitTx expects hex
const txHash = await wallet.submitTx(signed);
```

Notes:
- Wallet APIs differ: some expect the transaction body only, others expect a partially-signed transaction; adapt code for your wallet (Lace docs).
- For greater reliability assemble the tx in-browser with CSL and let the wallet sign all required witness sets (recommended for non-custodial flows).

- GET /streams
- GET /report/streams.pdf
  -> generates a PDF report of all streams using Puppeteer

This demo simulates deposits and payouts. In production replace deposit detection and tx submission with Blockfrost or a full node + signature handling and secure key management.
