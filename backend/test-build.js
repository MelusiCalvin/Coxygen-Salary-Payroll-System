// test-build.js — demo runner for txBuilder
// Usage:
//   set BLOCKFROST_PROJECT_ID=your_key  (Windows CMD)
//   $env:BLOCKFROST_PROJECT_ID='your_key' (PowerShell)
//   export BLOCKFROST_PROJECT_ID=your_key (POSIX)
//   node test-build.js

const { buildDepositTx, buildClaimTx } = require('./txBuilder');

async function run() {
  const BF = process.env.BLOCKFROST_PROJECT_ID;
  if (!BF) {
    console.error('Please set BLOCKFROST_PROJECT_ID in your environment before running this test.');
    process.exit(1);
  }

  // Provide addresses via env or replace with your test addresses
  const SENDER = process.env.TEST_SENDER_ADDR || process.env.SENDER_ADDR || 'addr_test1vr...';
  const SCRIPT = process.env.TEST_SCRIPT_ADDR || process.env.SCRIPT_ADDR || 'addr_test1xz...';

  console.log('Using Blockfrost project:', BF ? 'present' : 'MISSING');
  console.log('Sender:', SENDER);
  console.log('Script:', SCRIPT);

  try {
    const depositPlan = await buildDepositTx({
      senderAddress: SENDER,
      scriptAddress: SCRIPT,
      datum: { note: 'demo-datum' },
      amountLovelace: 10000000, // 10 ADA
      ttl: null,
      networkId: 'preprod'
    });
    console.log('\nbuildDepositTx result:\n', JSON.stringify(depositPlan, null, 2));
  } catch (e) {
    console.error('\nbuildDepositTx error:\n', e && e.message ? e.message : e);
  }

  // demo claim: you can provide a real scriptUtxo via env or use a placeholder
  const fakeScriptUtxo = {
    tx_hash: process.env.DEMO_SCRIPT_TX || process.env.SCRIPT_TX_HASH || 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    tx_index: Number(process.env.SCRIPT_TX_INDEX || 0),
    lovelace: Number(process.env.SCRIPT_LOVELACE || 20000000),
    address: SCRIPT
  };

  try {
    const claimPlan = await buildClaimTx({
      scriptUtxo: fakeScriptUtxo,
      datum: { scriptAddress: SCRIPT, sender: SENDER, recipient: SENDER, start: Math.floor(Date.now()/1000), end: Math.floor(Date.now()/1000) + 3600, total: 20000000, claimed: 0 },
      claimAmount: 1000000, // 1 ADA
      recipientAddress: SENDER,
      redeemer: 'Claim',
      networkId: 'preprod',
      collateralProviderAddress: SENDER
    });
    console.log('\nbuildClaimTx result:\n', JSON.stringify(claimPlan, null, 2));
  } catch (e) {
    console.error('\nbuildClaimTx error:\n', e && e.message ? e.message : e);
  }
}

run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
