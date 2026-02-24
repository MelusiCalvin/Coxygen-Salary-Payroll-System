// txBuilder.js - Off-chain transaction builder helpers (stubs & safe fallbacks)
// This module attempts to provide clear entry points for building deposit and
// claim transactions. For safety the functions either perform a best-effort
// using installed libraries or return informative errors explaining what's
// missing.

const BFProjectId = process.env.BLOCKFROST_PROJECT_ID || null;
const MIN_DEPOSIT_LOVELACE = 1_000_000;

function ensureCSL() {
  try {
    // eslint-disable-next-line global-require
    const csl = require('@emurgo/cardano-serialization-lib-nodejs');
    return csl;
  } catch (err) {
    throw new Error('cardano-serialization-lib not installed. Run `npm install @emurgo/cardano-serialization-lib-nodejs`');
  }
}

function ensureBlockfrost() {
  if (!BFProjectId) throw new Error('BLOCKFROST_PROJECT_ID not set. Set env var to use Blockfrost operations.');
  try {
    // eslint-disable-next-line global-require
    const mod = require('@blockfrost/blockfrost-js');
    // Support both CJS and ESM-shaped exports across library versions.
    const Blockfrost =
      mod.BlockFrostAPI ||
      (mod.default && mod.default.BlockFrostAPI) ||
      mod.default ||
      mod;
    if (typeof Blockfrost !== 'function') {
      throw new Error('Unsupported @blockfrost/blockfrost-js export shape.');
    }
    return new Blockfrost({ projectId: BFProjectId });
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') {
      throw new Error('blockfrost-js not installed. Run `npm install @blockfrost/blockfrost-js`');
    }
    throw new Error('Failed to initialize Blockfrost client: ' + (err && err.message ? err.message : String(err)));
  }
}

function expectedAddressPrefix(networkId) {
  return networkId === 'mainnet' ? 'addr1' : 'addr_test1';
}

function isHexString(value) {
  return typeof value === 'string' && /^[0-9a-fA-F]+$/.test(value);
}

function unwrapCborBytesIfNeeded(bytes) {
  if (!bytes || bytes.length === 0) return bytes;
  const first = bytes[0];
  let headerLen = 0;
  let payloadLen = 0;

  if (first >= 0x40 && first <= 0x57) {
    headerLen = 1;
    payloadLen = first - 0x40;
  } else if (first === 0x58 && bytes.length >= 2) {
    headerLen = 2;
    payloadLen = bytes[1];
  } else if (first === 0x59 && bytes.length >= 3) {
    headerLen = 3;
    payloadLen = bytes.readUInt16BE(1);
  } else if (first === 0x5a && bytes.length >= 5) {
    headerLen = 5;
    payloadLen = bytes.readUInt32BE(1);
  }

  if (headerLen > 0 && bytes.length === headerLen + payloadLen) {
    return bytes.slice(headerLen);
  }
  return bytes;
}

function normalizeAddressForNetwork(csl, label, address, networkId) {
  if (!address || typeof address !== 'string') {
    throw new Error(label + ' is required and must be bech32 (addr...) or CIP-30 hex.');
  }

  const trimmed = address.trim();
  let parsedAddress;

  if (trimmed.startsWith('addr1') || trimmed.startsWith('addr_test1')) {
    try {
      parsedAddress = csl.Address.from_bech32(trimmed);
    } catch (err) {
      throw new Error(label + ' is malformed: ' + (err && err.message ? err.message : String(err)));
    }
  } else {
    const hex = trimmed.replace(/^0x/, '');
    if (!isHexString(hex) || hex.length % 2 !== 0) {
      throw new Error(label + ' must be bech32 (addr...) or valid hex from wallet API.');
    }
    try {
      const raw = Buffer.from(hex, 'hex');
      const unwrapped = unwrapCborBytesIfNeeded(raw);
      parsedAddress = csl.Address.from_bytes(unwrapped);
    } catch (err) {
      throw new Error(label + ' hex could not be decoded as a Cardano address: ' + (err && err.message ? err.message : String(err)));
    }
  }

  const normalized = parsedAddress.to_bech32();
  const prefix = expectedAddressPrefix(networkId);
  if (!normalized.startsWith(prefix)) {
    throw new Error(label + ' is for the wrong network. NETWORK_ID=' + networkId + ' expects prefix ' + prefix + '.');
  }
  return normalized;
}

function addInputCompat(csl, txBuilder, address, txHash, txIndex, value, utxo) {
  // CSL method signatures vary by build/version.
  // Try known signatures in strict order and surface failure clearly.
  const input = txBuilder && typeof txBuilder.add_input === 'function'
    ? [
        () => txBuilder.add_input(address, csl.TransactionInput.new(txHash, txIndex), value),
        () => txBuilder.add_input(address, txHash, txIndex, value),
        () => txBuilder.add_input(utxo)
      ]
    : [];

  let lastErr = null;
  for (const fn of input) {
    try {
      fn();
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error('Unable to add input with available CSL signature: ' + (lastErr && lastErr.message ? lastErr.message : 'unknown'));
}

/**
 * Build a deposit transaction that sends `amountLovelace` to `scriptAddress` with `datum`.
 * This is a high-level helper: it will throw unless CSL and Blockfrost/provider are available.
 * Returns: { unsignedTxHex }
 */
async function selectUtxosForAmount(bf, address, amountLovelace, feeBuffer = 1500000) {
  // Fetch UTXOs for address and select enough to cover amount + feeBuffer
  const utxos = await bf.addressesUtxos(address);
  // Blockfrost returns array with latest UTXOs first; map to simple objects
  const mapped = utxos.map(u => {
    const lov = u.amount.find(a => a.unit === 'lovelace');
    return { tx_hash: u.tx_hash, tx_index: u.tx_index, lovelace: Number(lov ? lov.quantity : '0'), raw: u };
  });

  let total = 0;
  const selected = [];
  for (const u of mapped) {
    selected.push(u);
    total += u.lovelace;
    if (total >= (amountLovelace + feeBuffer)) break;
  }
  if (total < (amountLovelace + feeBuffer)) {
    throw new Error('insufficient funds: need ' + (amountLovelace + feeBuffer) + ' lovelace, found ' + total);
  }
  return { selected, total, feeEstimate: feeBuffer };
}

/**
 * BuildDepositTx - Plan-only implementation
 * Returns a plan containing selected UTXOs and outputs to construct with CSL.
 * Final assembly and signing must be done with `@emurgo/cardano-serialization-lib-nodejs`.
 */
async function buildDepositTx({ senderAddress, scriptAddress, datum, amountLovelace, ttl, networkId }) {
  const bf = ensureBlockfrost();
  const csl = ensureCSL();
  const activeNetwork = networkId || 'preprod';

  const normalizedSenderAddress = normalizeAddressForNetwork(csl, 'senderAddress', senderAddress, activeNetwork);
  const normalizedScriptAddress = normalizeAddressForNetwork(csl, 'scriptAddress', scriptAddress, activeNetwork);
  if (!Number.isFinite(Number(amountLovelace)) || Number(amountLovelace) < MIN_DEPOSIT_LOVELACE) {
    throw new Error('amountLovelace must be at least ' + MIN_DEPOSIT_LOVELACE + ' (1 ADA).');
  }

  // select inputs
  const plan = await selectUtxosForAmount(bf, normalizedSenderAddress, amountLovelace);

  // fetch protocol parameters from Blockfrost
  const proto = await fetchProtocolParams(activeNetwork);

  // build TransactionBuilder config
  const linearFee = csl.LinearFee.new(
    csl.BigNum.from_str(String(proto.min_fee_a || proto.min_fee_a || 44)),
    csl.BigNum.from_str(String(proto.min_fee_b || proto.min_fee_b || 155381))
  );

  const txBuilderConfig = csl.TransactionBuilderConfigBuilder.new()
    .fee_algo(linearFee)
    .coins_per_utxo_word(csl.BigNum.from_str(String(proto.coins_per_utxo_word || 34482)))
    .pool_deposit(csl.BigNum.from_str(String(proto.pool_deposit || 500000000)))
    .key_deposit(csl.BigNum.from_str(String(proto.key_deposit || 2000000)))
    .max_value_size(5000)
    .max_tx_size(16384)
    .build();

  const txBuilder = csl.TransactionBuilder.new(txBuilderConfig);
  let addedInputs = 0;

  // add inputs
  for (const u of plan.selected) {
    const txHash = csl.TransactionHash.from_bytes(Buffer.from(u.tx_hash, 'hex'));
    const input = csl.TransactionInput.new(txHash, u.tx_index);
    const addr = csl.Address.from_bech32(normalizedSenderAddress);
    const value = csl.Value.new(csl.BigNum.from_str(String(u.lovelace)));
    const txOut = csl.TransactionOutput.new(addr, value);
    const utxo = csl.TransactionUnspentOutput.new(input, txOut);
    try {
      addInputCompat(csl, txBuilder, addr, txHash, u.tx_index, value, utxo);
      addedInputs += 1;
    }
    catch (e) { console.warn('add_input attempt failed for UTXO', u.tx_hash, e.message); }
  }

  if (addedInputs === 0) {
    return {
      plan,
      note: 'assembly-incomplete: no inputs were added to txBuilder (CSL add_input signature mismatch).'
    };
  }

  // add script output (deposit)
  const scriptAddr = csl.Address.from_bech32(normalizedScriptAddress);
  const outValue = csl.Value.new(csl.BigNum.from_str(String(amountLovelace)));
  const txOutScript = csl.TransactionOutput.new(scriptAddr, outValue);
  // NOTE: attaching datum (inline or datum hash) requires conversion to PlutusData
  try { txBuilder.add_output(txOutScript); } catch (e) { throw new Error('Failed to add escrow output: ' + e.message); }

  // Let CSL compute fee and change; this avoids fixed-fee estimate mismatches.
  try {
    txBuilder.add_change_if_needed(csl.Address.from_bech32(normalizedSenderAddress));
  } catch (e) {
    throw new Error('Failed to add change output: ' + e.message);
  }

  if (ttl && txBuilder.set_ttl) txBuilder.set_ttl(ttl);

  // attempt to build unsigned tx; if incomplete, return plan so caller can assemble locally
  try {
    const txBody = txBuilder.build();
    const tx = csl.Transaction.new(txBody, csl.TransactionWitnessSet.new());
    const cb = tx.to_bytes();
    return { unsignedTxHex: Buffer.from(cb).toString('hex'), plan };
  } catch (err) {
    return { plan, note: 'assembly-incomplete: ' + err.message + ' (inputs added: ' + addedInputs + ')' };
  }
}

/**
 * Build a claim transaction that consumes `scriptUtxo`, pays `claimAmount` to `recipientAddress`,
 * and (optionally) creates a continuation output back to the script with updated datum.
 * Returns: { unsignedTxHex }
 */
/**
 * buildClaimTx - Plan-only implementation
 * For claims we expect a known scriptUtxo (txHash,index,lovelace) and will return
 * a plan describing required inputs (script UTxO + optional collateral) and outputs
 * (claim payout and optional continuation back to script) along with a fee estimate.
 */
async function buildClaimTx({ scriptUtxo, datum, claimAmount, recipientAddress, redeemer, networkId, collateralProviderAddress = null }) {
  const bf = ensureBlockfrost();
  const csl = ensureCSL();

  // fetch protocol params
  const proto = await fetchProtocolParams(networkId || 'preprod');

  const linearFee = csl.LinearFee.new(
    csl.BigNum.from_str(String(proto.min_fee_a || 44)),
    csl.BigNum.from_str(String(proto.min_fee_b || 155381))
  );

  const txBuilderConfig = csl.TransactionBuilderConfigBuilder.new()
    .fee_algo(linearFee)
    .coins_per_utxo_word(csl.BigNum.from_str(String(proto.coins_per_utxo_word || 34482)))
    .pool_deposit(csl.BigNum.from_str(String(proto.pool_deposit || 500000000)))
    .key_deposit(csl.BigNum.from_str(String(proto.key_deposit || 2000000)))
    .max_value_size(5000)
    .max_tx_size(16384)
    .build();

  const txBuilder = csl.TransactionBuilder.new(txBuilderConfig);

  // add script UTXO as input
  const txHash = csl.TransactionHash.from_bytes(Buffer.from(scriptUtxo.txHash || scriptUtxo.tx_hash, 'hex'));
  const input = csl.TransactionInput.new(txHash, scriptUtxo.index || scriptUtxo.tx_index || 0);
  const scriptAddr = csl.Address.from_bech32(datum.scriptAddress || scriptUtxo.address || scriptUtxo.scriptAddress);
  const scriptValue = csl.Value.new(csl.BigNum.from_str(String(scriptUtxo.lovelace || scriptUtxo.amount || 0)));
  const scriptOut = csl.TransactionOutput.new(scriptAddr, scriptValue);
  const scriptUtxoObj = csl.TransactionUnspentOutput.new(input, scriptOut);
  try {
    if (typeof txBuilder.add_input === 'function') {
      try { txBuilder.add_input(scriptUtxoObj); } catch (e) { txBuilder.add_input(scriptAddr, txHash, scriptUtxo.index || scriptUtxo.tx_index || 0, scriptValue); }
    }
  } catch (e) {
    console.warn('add_input(scriptUtxo) failed:', e.message);
  }

  // optional collateral
  if (collateralProviderAddress) {
    const cplan = await selectUtxosForAmount(bf, collateralProviderAddress, 2000000, 200000);
    const cu = cplan.selected[0];
    const chash = csl.TransactionHash.from_bytes(Buffer.from(cu.tx_hash, 'hex'));
    const cinput = csl.TransactionInput.new(chash, cu.tx_index);
    const caddr = csl.Address.from_bech32(collateralProviderAddress);
    const cval = csl.Value.new(csl.BigNum.from_str(String(cu.lovelace)));
    const cout = csl.TransactionOutput.new(caddr, cval);
    const cutxo = csl.TransactionUnspentOutput.new(cinput, cout);
    try { txBuilder.add_collateral(cutxo); } catch (e) { console.warn('add_collateral failed:', e.message); }
  }

  // output to recipient
  const outVal = csl.Value.new(csl.BigNum.from_str(String(claimAmount)));
  const recipientAddr = csl.Address.from_bech32(recipientAddress);
  const recipOut = csl.TransactionOutput.new(recipientAddr, outVal);
  try { txBuilder.add_output(recipOut); } catch (e) { console.warn('add_output(recipient) failed:', e.message); }

  // continuation output: remaining funds back to script with updated datum (placeholder)
  const remaining = (scriptUtxo.lovelace || scriptUtxo.amount || 0) - claimAmount - 300000;
  if (remaining > 0) {
    const remVal = csl.Value.new(csl.BigNum.from_str(String(remaining)));
    const remOut = csl.TransactionOutput.new(scriptAddr, remVal);
    // TODO: set inline datum for remOut
    try { txBuilder.add_output(remOut); } catch (e) { console.warn('add_output(rem) failed:', e.message); }
  }

  try {
    const txBody = txBuilder.build();
    const tx = csl.Transaction.new(txBody, csl.TransactionWitnessSet.new());
    const cb = tx.to_bytes();
    return { unsignedTxHex: Buffer.from(cb).toString('hex'), note: 'Attach redeemer and sign the transaction with wallet' };
  } catch (e) {
    // return plan fallback
    let collateral = null;
    if (collateralProviderAddress) {
      const cplan = await selectUtxosForAmount(bf, collateralProviderAddress, 2000000, 200000);
      collateral = cplan.selected[0];
    }
    const feeEstimate = 300000;
    return {
      type: 'claim-plan',
      scriptUtxo,
      datum,
      claimAmount,
      recipientAddress,
      collateral,
      feeEstimate,
      note: 'Assembly failed: ' + e.message
    };
  }
}

// Helper: fetch protocol params from Blockfrost REST
async function fetchProtocolParams(network = 'preprod') {
  if (!BFProjectId) throw new Error('BLOCKFROST_PROJECT_ID not set');
  const base = network === 'mainnet' ? 'https://cardano-mainnet.blockfrost.io/api/v0' : 'https://cardano-preprod.blockfrost.io/api/v0';
  const fetch = require('node-fetch');
  const res = await fetch(base + '/epochs/latest/parameters', { headers: { project_id: BFProjectId } });
  if (!res.ok) throw new Error('Failed to fetch protocol params: ' + res.statusText);
  const body = await res.json();
  return body;
}

module.exports = { buildDepositTx, buildClaimTx };
