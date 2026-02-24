# Streaming Payments - Fresh Implementation

## Overview
This document outlines the clean, restarted implementation of the Cardano streaming payments application with Lace wallet integration and Helios validator-based on-chain streaming contracts.

## Architecture

### Components

1. **index.html** - UI and wallet connection
   - Connect Address button with robust wallet handling
   - Balance parsing (multi-format support for Lace responses)
   - Exposes globals: `window.walletAPI`, `window.connectedWalletAddress`, `window.walletBalance`
   - Sender and Recipient dashboard views

2. **script.js** - Frontend streaming logic
   - Stream creation with time-based rate calculation
   - Local state management (localStorage)
   - Integration with Helios builders for on-chain operations
   - Claim and cancel transaction submission

3. **streaming-contract.js** - Plutus validator and transaction builders
   - `STREAMING_VALIDATOR` - Helios spending validator script
   - `buildStreamingTransaction()` - Creates initial stream with full amount locked in script
   - `buildClaimTransaction()` - Recipient claims accrued funds
   - `buildCancelTransaction()` - Sender cancels stream and retrieves remaining funds
   - Address parsing (handles both hex and bech32 formats)

4. **index.js** - Module setup
   - Imports Helios and coxylib
   - Exposes streaming functions to global `window.streamingHelios`
   - Loads network parameters for preprod testnet

## Key Features

### Wallet Connection
- Robust Lace integration with CIP-30 API
- Multi-format balance parsing (decimal, CBOR-encoded hex, 0x hex)
- Fallback handling for address format conversion
- Global exposure of wallet API and connected address

### Stream Creation
- Locks full stream amount in Plutus script
- Inline datum contains: sender, recipient, amount, start time, end time, rate
- Rate: lovelace per millisecond (conversion: ADA/sec × 1000)
- Returns transaction hash and script UTxO reference for future operations

### Claiming Funds (Recipient)
- Calculates accrued amount based on elapsed time
- Builds transaction consuming script UTxO with redeemer=0
- Creates two outputs:
  - Accrued amount to recipient
  - Remaining amount back to script (if any)
- Updates inline datum to track claimed amount
- Must be signed by recipient's key

### Cancelling Stream (Sender)
- Calculates accrued amount up to cancellation time
- Builds transaction consuming script UTxO with redeemer=1
- Returns remaining amount to sender
- Must be signed by sender's key

## Data Flow

### Stream Lifecycle

1. **Creation**
   - User enters recipient address, total amount, start/end times
   - Frontend calculates rate based on duration
   - `buildStreamingTransaction()` compiles validator, creates datum, builds tx
   - Transaction locked to script address with inline datum
   - Script UTxO reference stored in stream object

2. **Claiming**
   - Recipient clicks "Claim" button
   - Frontend calls `buildClaimTransaction()` with UTxO reference
   - Validator verifies recipient signature
   - Accrued amount sent to recipient
   - Remaining amount re-locked in script

3. **Cancellation**
   - Sender clicks "Cancel" button
   - Frontend calls `buildCancelTransaction()` with UTxO reference
   - Validator verifies sender signature
   - Remaining amount returned to sender

## File Structure Changes (From Undo)

**Deleted (per user request):**
- index-Ngwenya.html
- index-Ngwenya.js
- script-Ngwenya.js

**Current Working Files:**
- index.html (updated with robust wallet connection)
- index.js (updated with claim/cancel exports)
- script.js (updated with Helios integration)
- streaming-contract.js (cleaned up, with claim/cancel builders)
- coxylib.js, jimba.js, jquery.js, helios.js, styles.css (unchanged)

## Known Limitations & Next Steps

### Current Limitations
1. **UTxO Tracking**: Script UTxO reference must be manually stored after creation. In production, would query blockchain to confirm UTxO creation.
2. **Datum Evolution**: Current implementation stores claimed amount in datum (7th field). Recipient must provide this in claim/cancel transactions.
3. **Preprod Only**: Configured for Cardano preprod testnet.
4. **Mock Fallback**: If Helios builder fails, generates mock tx hash and falls back to local-only mode.

### Recommended Next Steps
1. **UTxO Query Integration**: Use Blockfrost or similar to query script UTxO after creation
2. **Datum Versioning**: Implement proper datum versioning for backward compatibility
3. **Error Recovery**: Add transaction confirmation polling and retry logic
4. **Recipient Address Validation**: Strengthen address parsing and validation
5. **Rate Expression**: Consider allowing variable rates (non-linear streaming)

## Testing Checklist

- [ ] Wallet connection and balance display
- [ ] Stream creation submission to testnet
- [ ] Claim transaction submission
- [ ] Cancel transaction submission
- [ ] Accrual calculation accuracy
- [ ] Address format handling (hex and bech32)
- [ ] Signature verification on-chain
- [ ] Multi-claim scenario
- [ ] Claim after stream end time
- [ ] Cancel with zero accrued
- [ ] Cancel after full accrual

## Validator Script

The Helios validator enforces:
- Claim (redeemer=0): Must be signed by recipient's payment credential
- Cancel (redeemer=1): Must be signed by sender's payment credential

The validator does NOT currently enforce:
- Time-based release curves (beyond what the frontend calculates)
- Minimum claim amounts
- Fee deductions
- Custom redeemer logic

These can be added to the validator as needed.

## Rate Semantics

**Frontend**: Rates expressed as ADA/second
**Validator**: Rates stored as lovelace/millisecond
**Conversion**: `ratePerMs = Math.floor(ratePerSecond * 1000)`

This allows precise calculation of accrued amounts based on millisecond-level timing.
