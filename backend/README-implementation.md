Off-chain streaming escrow — implementation notes

This backend folder contains a demo Express server (`server.js`) that simulates stream creation, deposit detection, and claiming.

Next steps to implement a production-capable off-chain service:

1) Install dependencies

```bash
cd backend
npm install
```

2) Environment variables

- `PORT` - server port (default 3000)
- `ESCROW_ADDRESS` - optional: address used by demo
- `BLOCKFROST_PROJECT_ID` - (recommended) your Blockfrost Project ID for testnet/mainnet

3) Replace demo flows with real transaction building

- Use `@emurgo/cardano-serialization-lib-nodejs` to build raw transactions.
- Use `@blockfrost/blockfrost-js` or a full node provider to fetch UTXOs and submit signed transactions.
- Implement `txBuilder.js` functions: `buildDepositTx` and `buildClaimTx` (stubs provided).

4) Signing strategy

- Custodial approach: backend holds an account/key to build and sign transactions to move funds into the script. Securely store signing keys (HSM / Key Vault) and audit access.
- Wallet-assisted approach: require the sender to sign deposit tx in the browser via CIP-30 wallet (recommended for non-custodial deposits).

5) Validator/script

- The Helios template is at `../helios/streaming.helios` — compile it to PlutusV2 using Helios toolchain and derive the script address.
- Ensure the datum layout and redeemer bytes used off-chain match the on-chain validator's expectations.

6) Tests

- Write unit tests for `txBuilder` and integration tests using a testnet faucet.

7) Security & monitoring

- Enforce rate limits, authentication for admin endpoints, and logging/alerting for suspicious activity.

This file documents the next engineering tasks; implementers should follow Cardano best practices and audit the validator code before deploying.
