/*
Simple escrow backend
- Stores streams in-memory
- Returns an ESCROW address (configurable via ESCROW_ADDRESS)
- For demo, deposit detection and tx submission are simulated

ENV variables (for production replace with real implementations):
- BLOCKFROST_PROJECT_ID: Blockfrost API key for preprod (required for real tx building)
- ESCROW_ADDRESS: bech32 address where senders deposit funds
- PORT: server port (default 3000)
*/

try {
  require('dotenv').config();
} catch (e) {
  // dotenv not installed; env vars must be set manually
  console.log('[Server] Note: dotenv not installed. Using environment variables only.');
}

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
//serve static files from the "public" directory 
app.use(express.static(path.join(__dirname, "../")));

// Fallback for SPA or direct refresh
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../index.html"));
});
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const NETWORK_ID = process.env.NETWORK_ID || 'preprod';
const ESCROW_ADDRESS = process.env.ESCROW_ADDRESS || '';
const BLOCKFROST_PROJECT_ID = process.env.BLOCKFROST_PROJECT_ID || '';
const ESCROW_SIGNING_KEY = process.env.ESCROW_SIGNING_KEY || process.env.ESCROW_SKEY || '';
const STREAMS_DB_FILE = path.join(__dirname, 'streams.db.json');
const MIN_TRANSFER_LOVELACE = 1_000_000;

function expectedAddressPrefix(networkId) {
  return networkId === 'mainnet' ? 'addr1' : 'addr_test1';
}

function isAddressForNetwork(addr, networkId) {
  if (!addr || typeof addr !== 'string') return false;
  return addr.startsWith(expectedAddressPrefix(networkId));
}

function getAddressPaymentKeyHashHex(csl, bech32Address) {
  const addr = csl.Address.from_bech32(bech32Address);
  const base = csl.BaseAddress.from_address(addr);
  const enterprise = csl.EnterpriseAddress.from_address(addr);
  let paymentCred = null;
  if (base) paymentCred = base.payment_cred();
  if (!paymentCred && enterprise) paymentCred = enterprise.payment_cred();
  if (!paymentCred || !paymentCred.to_keyhash()) return null;
  return Buffer.from(paymentCred.to_keyhash().to_bytes()).toString('hex');
}

function validateEscrowSigningConfigOrThrow() {
  // Validate only when both values are supplied. This keeps demo/offline mode usable.
  if (!ESCROW_ADDRESS || !ESCROW_SIGNING_KEY) return;
  if (!isAddressForNetwork(ESCROW_ADDRESS, NETWORK_ID)) {
    throw new Error('ESCROW_ADDRESS does not match NETWORK_ID=' + NETWORK_ID + '. Expected prefix: ' + expectedAddressPrefix(NETWORK_ID));
  }

  const csl = require('@emurgo/cardano-serialization-lib-nodejs');
  const escrowKey = getEscrowPrivateKey(csl);
  const signingKeyHash = Buffer.from(escrowKey.to_public().hash().to_bytes()).toString('hex');
  const addressKeyHash = getAddressPaymentKeyHashHex(csl, ESCROW_ADDRESS);

  if (!addressKeyHash) {
    throw new Error('ESCROW_ADDRESS must be a key-controlled payment address for server-side signing (not a script-only address).');
  }
  if (addressKeyHash !== signingKeyHash) {
    throw new Error(
      'ESCROW_ADDRESS / ESCROW_SIGNING_KEY mismatch. addressKeyHash=' + addressKeyHash + ', signingKeyHash=' + signingKeyHash
    );
  }
}

function isLikelySameWallet(senderAddress, escrowAddress) {
  if (!senderAddress || !escrowAddress) return false;
  if (senderAddress === escrowAddress) return true;
  try {
    const csl = require('@emurgo/cardano-serialization-lib-nodejs');
    const sAddr = csl.Address.from_bech32(senderAddress);
    const eAddr = csl.Address.from_bech32(escrowAddress);
    const sBase = csl.BaseAddress.from_address(sAddr);
    const eBase = csl.BaseAddress.from_address(eAddr);
    if (sBase && eBase) {
      return sBase.stake_cred().to_hex() === eBase.stake_cred().to_hex();
    }
  } catch (_) {
    // best-effort only
  }
  return false;
}

function ensureHex(label, value) {
  if (!value || typeof value !== 'string' || !/^[0-9a-fA-F]+$/.test(value) || value.length % 2 !== 0) {
    throw new Error(label + ' must be an even-length hex string.');
  }
}

function blockfrostBase(networkId) {
  return networkId === 'mainnet'
    ? 'https://cardano-mainnet.blockfrost.io/api/v0'
    : 'https://cardano-preprod.blockfrost.io/api/v0';
}

function mergeWitnessSets(csl, baseWs, signedWs) {
  const out = csl.TransactionWitnessSet.new();
  const b = baseWs || csl.TransactionWitnessSet.new();
  const s = signedWs || csl.TransactionWitnessSet.new();

  if (b.vkeys()) out.set_vkeys(b.vkeys());
  if (s.vkeys()) out.set_vkeys(s.vkeys());

  if (b.native_scripts()) out.set_native_scripts(b.native_scripts());
  if (s.native_scripts()) out.set_native_scripts(s.native_scripts());

  if (b.bootstraps()) out.set_bootstraps(b.bootstraps());
  if (s.bootstraps()) out.set_bootstraps(s.bootstraps());

  if (b.plutus_scripts()) out.set_plutus_scripts(b.plutus_scripts());
  if (s.plutus_scripts()) out.set_plutus_scripts(s.plutus_scripts());

  if (b.plutus_data()) out.set_plutus_data(b.plutus_data());
  if (s.plutus_data()) out.set_plutus_data(s.plutus_data());

  if (b.redeemers()) out.set_redeemers(b.redeemers());
  if (s.redeemers()) out.set_redeemers(s.redeemers());

  return out;
}

function assembleSignedTxHex(unsignedTxHex, signedPayloadHex) {
  ensureHex('unsignedTxHex', unsignedTxHex);
  ensureHex('signedPayloadHex', signedPayloadHex);
  const csl = require('@emurgo/cardano-serialization-lib-nodejs');

  // Some wallets may return a full tx. If so, pass it through unchanged.
  try {
    csl.Transaction.from_bytes(Buffer.from(signedPayloadHex, 'hex'));
    return signedPayloadHex;
  } catch (e) {
    // continue: expected for witness-set-only payloads
  }

  const unsignedTx = csl.Transaction.from_bytes(Buffer.from(unsignedTxHex, 'hex'));
  const witnessSetFromWallet = csl.TransactionWitnessSet.from_bytes(Buffer.from(signedPayloadHex, 'hex'));
  const mergedWitnesses = mergeWitnessSets(csl, unsignedTx.witness_set(), witnessSetFromWallet);
  const aux = unsignedTx.auxiliary_data();
  const signedTx = aux
    ? csl.Transaction.new(unsignedTx.body(), mergedWitnesses, aux)
    : csl.Transaction.new(unsignedTx.body(), mergedWitnesses);
  return Buffer.from(signedTx.to_bytes()).toString('hex');
}

async function submitTxToBlockfrost(txHex, networkId) {
  if (!BLOCKFROST_PROJECT_ID) throw new Error('BLOCKFROST_PROJECT_ID is not set.');
  ensureHex('txHex', txHex);
  const res = await fetch(blockfrostBase(networkId) + '/tx/submit', {
    method: 'POST',
    headers: {
      project_id: BLOCKFROST_PROJECT_ID,
      'Content-Type': 'application/cbor'
    },
    body: Buffer.from(txHex, 'hex')
  });
  const text = await res.text();
  if (!res.ok) throw new Error('Blockfrost submit failed (' + res.status + '): ' + text);
  return text.replace(/^"|"$/g, '');
}

function readStreamsFromDisk() {
  try {
    if (!fs.existsSync(STREAMS_DB_FILE)) return {};
    const raw = fs.readFileSync(STREAMS_DB_FILE, 'utf8');
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    console.warn('[streams] Failed to read streams.db.json:', err.message);
    return {};
  }
}

function saveStreamsToDisk(streams) {
  try {
    fs.writeFileSync(STREAMS_DB_FILE, JSON.stringify(streams, null, 2), 'utf8');
  } catch (err) {
    console.warn('[streams] Failed to persist streams.db.json:', err.message);
  }
}

function toIsoOrNow(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

function toIsoOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function ensureNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeStreamSnapshot(snapshot) {
  const id = String(snapshot.id || uuidv4());
  return {
    id,
    senderAddress: snapshot.senderAddress || 'local',
    recipient: snapshot.recipient || '',
    total: ensureNumber(snapshot.total, 0),
    start: toIsoOrNow(snapshot.start),
    end: toIsoOrNow(snapshot.end),
    createdAt: toIsoOrNow(snapshot.createdAt || Date.now()),
    claimed: Math.max(0, ensureNumber(snapshot.claimed, 0)),
    refunded: Math.max(0, ensureNumber(snapshot.refunded, 0)),
    status: snapshot.status || 'Active',
    depositAddress: snapshot.depositAddress || ESCROW_ADDRESS,
    depositTx: snapshot.depositTx || null,
    refundTx: snapshot.refundTx || null,
    cancelledAt: toIsoOrNull(snapshot.cancelledAt)
  };
}

function syncOrGetStream(streams, id, streamSnapshot) {
  let s = streams[id];
  if (s) {
    if (streamSnapshot && (streamSnapshot.id || id)) {
      const incoming = normalizeStreamSnapshot({ ...streamSnapshot, id: id || streamSnapshot.id });
      let changed = false;

      // Recover stale backend state (eg. notify-deposit failed after on-chain submit).
      if (
        s.status === 'AwaitingDeposit' &&
        (incoming.status === 'Active' || incoming.status === 'Cancelled' || incoming.status === 'Paid')
      ) {
        s.status = incoming.status;
        changed = true;
      }
      if (!s.depositTx && incoming.depositTx) {
        s.depositTx = incoming.depositTx;
        changed = true;
      }
      if (!s.cancelledAt && incoming.cancelledAt) {
        s.cancelledAt = incoming.cancelledAt;
        changed = true;
      }
      if (!s.senderAddress || s.senderAddress === 'local') {
        s.senderAddress = incoming.senderAddress || s.senderAddress;
        changed = true;
      }
      if (!s.recipient && incoming.recipient) {
        s.recipient = incoming.recipient;
        changed = true;
      }
      // Keep monotonic accounting fields.
      const nextClaimed = Math.max(Number(s.claimed || 0), Number(incoming.claimed || 0));
      const nextRefunded = Math.max(Number(s.refunded || 0), Number(incoming.refunded || 0));
      if (nextClaimed !== Number(s.claimed || 0)) {
        s.claimed = nextClaimed;
        changed = true;
      }
      if (nextRefunded !== Number(s.refunded || 0)) {
        s.refunded = nextRefunded;
        changed = true;
      }
      if (changed) saveStreamsToDisk(streams);
    }
    return s;
  }
  if (streamSnapshot && (streamSnapshot.id || id)) {
    const normalized = normalizeStreamSnapshot({ ...streamSnapshot, id: id || streamSnapshot.id });
    streams[normalized.id] = normalized;
    saveStreamsToDisk(streams);
    return normalized;
  }
  return null;
}

function streamAccruedAda(stream, atMs = Date.now()) {
  const start = new Date(stream.start).getTime();
  const end = new Date(stream.end).getTime();
  const now = Number.isFinite(atMs) ? atMs : Date.now();
  if (!(now > start)) return 0;
  const effectiveEnd = stream.cancelledAt
    ? Math.min(end, new Date(stream.cancelledAt).getTime())
    : end;
  const elapsed = Math.max(0, Math.min(now, effectiveEnd) - start);
  const seconds = Math.max(1, (end - start) / 1000);
  const rate = stream.total / seconds;
  return Math.min(stream.total, rate * (elapsed / 1000));
}

function toLovelace(ada) {
  return Math.max(0, Math.floor(Number(ada) * 1_000_000));
}

function toAda(lovelace) {
  return Math.max(0, Number(lovelace) / 1_000_000);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTimestamp(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString('en-US', { hour12: false });
}

function buildStreamsReportHtml(streamList) {
  const totalStreams = streamList.length;
  const totalDeposited = streamList.reduce((sum, s) => sum + Number(s.total || 0), 0);
  const totalClaimed = streamList.reduce((sum, s) => sum + Number(s.claimed || 0), 0);
  const totalRefunded = streamList.reduce((sum, s) => sum + Number(s.refunded || 0), 0);
  const activeStreams = streamList.filter((s) => s.status === 'Active').length;
  const generatedAt = new Date().toISOString();

  const rows = streamList.map((s) => `
    <tr>
      <td>${escapeHtml(s.id)}</td>
      <td>${escapeHtml(s.senderAddress)}</td>
      <td>${escapeHtml(s.recipient)}</td>
      <td>${Number(s.total || 0).toFixed(6)}</td>
      <td>${Number(s.claimed || 0).toFixed(6)}</td>
      <td>${Number(s.refunded || 0).toFixed(6)}</td>
      <td>${escapeHtml(s.status)}</td>
      <td>${escapeHtml(formatTimestamp(s.start))}</td>
      <td>${escapeHtml(formatTimestamp(s.end))}</td>
      <td>${escapeHtml(formatTimestamp(s.createdAt))}</td>
    </tr>
  `).join('');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Streams Report</title>
  <style>
    body { font-family: Arial, sans-serif; color: #0f172a; margin: 24px; }
    h1 { margin: 0 0 8px 0; font-size: 24px; }
    .meta { margin: 0 0 16px 0; color: #475569; font-size: 12px; }
    .stats { display: grid; grid-template-columns: repeat(5, minmax(120px, 1fr)); gap: 8px; margin-bottom: 16px; }
    .card { border: 1px solid #cbd5e1; border-radius: 8px; padding: 8px; }
    .label { font-size: 11px; color: #64748b; }
    .value { font-size: 16px; font-weight: bold; margin-top: 2px; }
    table { width: 100%; border-collapse: collapse; font-size: 11px; table-layout: fixed; word-wrap: break-word; }
    th, td { border: 1px solid #cbd5e1; padding: 6px; vertical-align: top; }
    th { background: #e2e8f0; text-align: left; }
  </style>
</head>
<body>
  <h1>Streaming Payroll Report</h1>
  <p class="meta">Generated: ${escapeHtml(formatTimestamp(generatedAt))}</p>
  <div class="stats">
    <div class="card"><div class="label">Streams</div><div class="value">${totalStreams}</div></div>
    <div class="card"><div class="label">Active</div><div class="value">${activeStreams}</div></div>
    <div class="card"><div class="label">Deposited (ADA)</div><div class="value">${totalDeposited.toFixed(6)}</div></div>
    <div class="card"><div class="label">Claimed (ADA)</div><div class="value">${totalClaimed.toFixed(6)}</div></div>
    <div class="card"><div class="label">Refunded (ADA)</div><div class="value">${totalRefunded.toFixed(6)}</div></div>
  </div>
  <table>
    <thead>
      <tr>
        <th>ID</th>
        <th>Sender</th>
        <th>Recipient</th>
        <th>Total</th>
        <th>Claimed</th>
        <th>Refunded</th>
        <th>Status</th>
        <th>Start</th>
        <th>End</th>
        <th>Created</th>
      </tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="10">No streams found.</td></tr>'}
    </tbody>
  </table>
</body>
</html>`;
}

function getEscrowPrivateKey(csl) {
  if (!ESCROW_SIGNING_KEY) {
    throw new Error('ESCROW_SIGNING_KEY is not set. Add escrow signing key to backend/.env for on-chain claims/refunds.');
  }
  const key = ESCROW_SIGNING_KEY.trim();
  try {
    if (key.startsWith('ed25519')) return csl.PrivateKey.from_bech32(key);
  } catch (err) {
    // continue
  }
  try {
    return csl.PrivateKey.from_hex(key);
  } catch (err) {
    // continue
  }
  try {
    return csl.PrivateKey.from_normal_bytes(Buffer.from(key, 'hex'));
  } catch (err) {
    // continue
  }
  try {
    return csl.PrivateKey.from_extended_bytes(Buffer.from(key, 'hex'));
  } catch (err) {
    // continue
  }
  throw new Error('Unable to parse ESCROW_SIGNING_KEY. Use bech32 or hex private key bytes.');
}

async function fetchProtocolParams(networkId) {
  const res = await fetch(blockfrostBase(networkId) + '/epochs/latest/parameters', {
    headers: { project_id: BLOCKFROST_PROJECT_ID }
  });
  const text = await res.text();
  if (!res.ok) throw new Error('Failed to fetch protocol params (' + res.status + '): ' + text);
  return JSON.parse(text);
}

async function fetchAddressUtxos(address, networkId) {
  if (!BLOCKFROST_PROJECT_ID) throw new Error('BLOCKFROST_PROJECT_ID is not set.');
  const all = [];
  let page = 1;
  while (true) {
    const url = blockfrostBase(networkId) + '/addresses/' + encodeURIComponent(address) + '/utxos?page=' + page + '&count=100';
    const res = await fetch(url, { headers: { project_id: BLOCKFROST_PROJECT_ID } });
    const text = await res.text();
    if (!res.ok) throw new Error('Failed to fetch escrow UTXOs (' + res.status + '): ' + text);
    const body = JSON.parse(text);
    if (!Array.isArray(body) || body.length === 0) break;
    all.push(...body);
    if (body.length < 100) break;
    page += 1;
  }
  return all.map((u) => {
    const lov = (u.amount || []).find((a) => a.unit === 'lovelace');
    return {
      tx_hash: u.tx_hash,
      tx_index: Number(u.output_index ?? u.tx_index ?? 0),
      lovelace: Number(lov ? lov.quantity : '0')
    };
  }).filter((u) => u.lovelace > 0);
}

function selectUtxos(utxos, neededLovelace, feeBuffer = 1_500_000) {
  let total = 0;
  const selected = [];
  for (const u of utxos) {
    selected.push(u);
    total += u.lovelace;
    if (total >= neededLovelace + feeBuffer) break;
  }
  if (total < neededLovelace + feeBuffer) {
    throw new Error('Escrow balance insufficient. Need ' + (neededLovelace + feeBuffer) + ' lovelace, have ' + total);
  }
  return { selected, total };
}

async function submitEscrowPayout({ toAddress, amountLovelace }) {
  if (!BLOCKFROST_PROJECT_ID) {
    throw new Error('BLOCKFROST_PROJECT_ID is not set.');
  }
  if (!ESCROW_ADDRESS) {
    throw new Error('ESCROW_ADDRESS is not set.');
  }
  if (!isAddressForNetwork(ESCROW_ADDRESS, NETWORK_ID)) {
    throw new Error('ESCROW_ADDRESS does not match NETWORK_ID=' + NETWORK_ID);
  }
  if (!isAddressForNetwork(toAddress, NETWORK_ID)) {
    throw new Error('Destination address does not match NETWORK_ID=' + NETWORK_ID);
  }
  if (amountLovelace < MIN_TRANSFER_LOVELACE) {
    throw new Error('Payout amount must be at least ' + MIN_TRANSFER_LOVELACE + ' lovelace (1 ADA).');
  }
  const csl = require('@emurgo/cardano-serialization-lib-nodejs');
  const escrowKey = getEscrowPrivateKey(csl);
  const proto = await fetchProtocolParams(NETWORK_ID);
  const utxos = await fetchAddressUtxos(ESCROW_ADDRESS, NETWORK_ID);
  const { selected } = selectUtxos(utxos, amountLovelace);

  const linearFee = csl.LinearFee.new(
    csl.BigNum.from_str(String(proto.min_fee_a || 44)),
    csl.BigNum.from_str(String(proto.min_fee_b || 155381))
  );
  const cfg = csl.TransactionBuilderConfigBuilder.new()
    .fee_algo(linearFee)
    .coins_per_utxo_word(csl.BigNum.from_str(String(proto.coins_per_utxo_word || 34482)))
    .pool_deposit(csl.BigNum.from_str(String(proto.pool_deposit || 500000000)))
    .key_deposit(csl.BigNum.from_str(String(proto.key_deposit || 2000000)))
    .max_value_size(5000)
    .max_tx_size(16384)
    .build();

  const txBuilder = csl.TransactionBuilder.new(cfg);
  const keyHash = escrowKey.to_public().hash();

  for (const u of selected) {
    const txHash = csl.TransactionHash.from_bytes(Buffer.from(u.tx_hash, 'hex'));
    const input = csl.TransactionInput.new(txHash, u.tx_index);
    const value = csl.Value.new(csl.BigNum.from_str(String(u.lovelace)));
    txBuilder.add_key_input(keyHash, input, value);
  }

  const outValue = csl.Value.new(csl.BigNum.from_str(String(amountLovelace)));
  txBuilder.add_output(csl.TransactionOutput.new(csl.Address.from_bech32(toAddress), outValue));
  txBuilder.add_change_if_needed(csl.Address.from_bech32(ESCROW_ADDRESS));

  const txBody = txBuilder.build();
  const txHash = csl.hash_transaction(txBody);
  const witnessSet = csl.TransactionWitnessSet.new();
  const vkeys = csl.Vkeywitnesses.new();
  vkeys.add(csl.make_vkey_witness(txHash, escrowKey));
  witnessSet.set_vkeys(vkeys);

  const tx = csl.Transaction.new(txBody, witnessSet);
  const txHex = Buffer.from(tx.to_bytes()).toString('hex');
  const submittedTxHash = await submitTxToBlockfrost(txHex, NETWORK_ID);
  return { txHash: submittedTxHash, txHex };
}

// Persisted streams store (id -> stream)
const streams = readStreamsFromDisk();

// Create stream: returns deposit address and stream id
app.post('/create-stream', (req, res) => {
  const { senderAddress, recipient, total, start, end } = req.body;
  if (!recipient || !total || !start || !end) return res.status(400).json({ error: 'missing' });
  if (!ESCROW_ADDRESS) {
    return res.status(500).json({
      error: 'ESCROW_ADDRESS is not configured. Set ESCROW_ADDRESS in backend/.env to your script bech32 address.'
    });
  }
  if (!isAddressForNetwork(ESCROW_ADDRESS, NETWORK_ID)) {
    return res.status(500).json({
      error: 'ESCROW_ADDRESS does not match NETWORK_ID=' + NETWORK_ID + '. Expected prefix: ' + expectedAddressPrefix(NETWORK_ID)
    });
  }
  if (senderAddress && isAddressForNetwork(senderAddress, NETWORK_ID) && isLikelySameWallet(senderAddress, ESCROW_ADDRESS)) {
    return res.status(400).json({
      error: 'ESCROW_ADDRESS appears to belong to the sender wallet. Use a separate escrow wallet/script address.'
    });
  }
  const id = uuidv4();
  const stream = {
    id,
    senderAddress: senderAddress || 'local',
    recipient,
    total: Number(total),
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    createdAt: new Date().toISOString(),
    claimed: 0,
    refunded: 0,
    status: 'AwaitingDeposit',
    depositAddress: ESCROW_ADDRESS,
    depositTx: null,
    refundTx: null
  };
  streams[id] = stream;
  saveStreamsToDisk(streams);
  console.log('[/create-stream] Created:', { id, from: senderAddress, to: recipient, amount: total });
  return res.json({ id, depositAddress: ESCROW_ADDRESS, stream });
});

// For demo: notify deposit detected (in prod, webhook or indexer should call this)
app.post('/notify-deposit', (req, res) => {
  const { id, txId } = req.body;
  const s = streams[id];
  if (!s) return res.status(404).json({ error: 'not found' });
  s.status = 'Active';
  s.depositTx = txId || 'demo-deposit-tx';
  saveStreamsToDisk(streams);
  console.log('[/notify-deposit] Stream activated:', { id, txId });
  return res.json({ ok: true, stream: s });
});

// Discard an unfunded stream draft to avoid stale AwaitingDeposit records.
app.post('/discard-stream', (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id required' });
  const s = streams[id];
  if (!s) return res.json({ ok: true, deleted: false, reason: 'not found' });
  if (s.status !== 'AwaitingDeposit' || s.depositTx) {
    return res.status(400).json({ error: 'only unfunded AwaitingDeposit streams can be discarded' });
  }
  delete streams[id];
  saveStreamsToDisk(streams);
  console.log('[/discard-stream] Discarded unfunded stream:', id);
  return res.json({ ok: true, deleted: true });
});

// Claim: compute claimable amount and (optionally) build/submit payout
const txBuilder = require('./txBuilder');
app.post('/claim', async (req, res) => {
  const { id, recipientAddress, streamSnapshot } = req.body || {};
  const s = syncOrGetStream(streams, String(id || ''), streamSnapshot);
  if (!s) return res.status(404).json({ error: 'not found' });
  if (s.status !== 'Active' && s.status !== 'Cancelled' && s.status !== 'Paid') {
    return res.status(400).json({ error: 'stream not active' });
  }

  const destination = recipientAddress || s.recipient;
  if (!isAddressForNetwork(destination, NETWORK_ID)) {
    return res.status(400).json({ error: 'recipientAddress must match NETWORK_ID=' + NETWORK_ID });
  }

  const accrued = streamAccruedAda(s, Date.now());
  const claimableAda = Math.max(0, accrued - Number(s.claimed || 0));
  const claimableLovelace = toLovelace(claimableAda);
  if (claimableLovelace <= 0) return res.json({ claimed: 0, txHash: null, stream: s, onChain: false });
  if (claimableLovelace < MIN_TRANSFER_LOVELACE) {
    return res.json({
      claimed: 0,
      txHash: null,
      stream: s,
      onChain: false,
      note: 'Claimable amount is below minimum on-chain transfer (1 ADA).'
    });
  }

  try {
    const payout = await submitEscrowPayout({ toAddress: destination, amountLovelace: claimableLovelace });
    const claimedAda = toAda(claimableLovelace);
    s.claimed = Number(s.claimed || 0) + claimedAda;
    if (s.claimed + 1e-6 >= s.total) s.status = 'Paid';
    saveStreamsToDisk(streams);
    console.log('[/claim] On-chain payout:', { id: s.id, claimedAda, txHash: payout.txHash });
    return res.json({ claimed: claimedAda, txHash: payout.txHash, stream: s, onChain: true });
  } catch (err) {
    console.error('[/claim] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/cancel-stream', async (req, res) => {
  const { id, streamSnapshot } = req.body || {};
  const s = syncOrGetStream(streams, String(id || ''), streamSnapshot);
  if (!s) return res.status(404).json({ error: 'not found' });
  if (s.status !== 'Active' && s.status !== 'Cancelled') {
    return res.status(400).json({ error: 'stream not active' });
  }
  if (!isAddressForNetwork(s.senderAddress, NETWORK_ID)) {
    return res.status(400).json({ error: 'senderAddress must match NETWORK_ID=' + NETWORK_ID });
  }

  if (!s.cancelledAt) s.cancelledAt = new Date().toISOString();
  const cancelMs = new Date(s.cancelledAt).getTime();
  const accruedAtCancelAda = streamAccruedAda(s, cancelMs);
  const refundableAda = Math.max(0, s.total - accruedAtCancelAda - Number(s.refunded || 0));
  const refundableLovelace = toLovelace(refundableAda);

  let refundTxHash = s.refundTx || null;
  let refundedNowAda = 0;
  if (refundableLovelace > 0 && refundableLovelace < MIN_TRANSFER_LOVELACE) {
    s.status = (Number(s.claimed || 0) + 1e-6 >= streamAccruedAda(s, Date.now())) ? 'Paid' : 'Cancelled';
    saveStreamsToDisk(streams);
    return res.json({
      ok: true,
      refunded: 0,
      txHash: null,
      stream: s,
      onChain: false,
      note: 'Refundable remainder is below minimum on-chain transfer (1 ADA).'
    });
  }
  try {
    if (refundableLovelace > 0) {
      const payout = await submitEscrowPayout({ toAddress: s.senderAddress, amountLovelace: refundableLovelace });
      refundTxHash = payout.txHash;
      refundedNowAda = toAda(refundableLovelace);
      s.refunded = Number(s.refunded || 0) + refundedNowAda;
      s.refundTx = refundTxHash;
    }
  } catch (err) {
    console.error('[/cancel-stream] Refund error:', err.message);
    return res.status(500).json({ error: err.message });
  }

  const accruedCappedAda = streamAccruedAda(s, Date.now());
  s.status = (Number(s.claimed || 0) + 1e-6 >= accruedCappedAda) ? 'Paid' : 'Cancelled';
  saveStreamsToDisk(streams);
  console.log('[/cancel-stream] Cancelled:', { id: s.id, refundedNowAda, refundTxHash });
  return res.json({
    ok: true,
    refunded: refundedNowAda,
    txHash: refundTxHash,
    stream: s,
    onChain: true
  });
});

// Build deposit transaction (unsigned) - returns unsignedTxHex or plan
app.post('/build-deposit', async (req, res) => {
  const { senderAddress, scriptAddress, datum, amountLovelace, ttl } = req.body;
  console.log('[/build-deposit] Request:', { senderAddress, scriptAddress, amountLovelace });
  try {
    if (senderAddress && scriptAddress && isAddressForNetwork(senderAddress, NETWORK_ID) && isLikelySameWallet(senderAddress, scriptAddress)) {
      return res.status(400).json({
        ok: false,
        error: 'senderAddress and scriptAddress appear to be from the same wallet. Use a separate escrow wallet/script address.'
      });
    }
    const result = await txBuilder.buildDepositTx({ senderAddress, scriptAddress, datum, amountLovelace, ttl, networkId: NETWORK_ID });
    console.log('[/build-deposit] Result:', result.unsignedTxHex ? 'unsigned TX available (' + result.unsignedTxHex.length + ' chars)' : result);
    return res.json({ ok: true, result });
  } catch (err) {
    console.error('[/build-deposit] Error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Build claim transaction (unsigned) - returns unsignedTxHex or plan
app.post('/build-claim', async (req, res) => {
  const { scriptUtxo, datum, claimAmount, recipientAddress, collateralProviderAddress } = req.body;
  console.log('[/build-claim] Request:', { scriptUtxo, claimAmount, recipientAddress });
  try {
    const result = await txBuilder.buildClaimTx({ scriptUtxo, datum, claimAmount, recipientAddress, redeemer: 'Claim', networkId: NETWORK_ID, collateralProviderAddress });
    console.log('[/build-claim] Result:', result.unsignedTxHex ? 'unsigned TX available (' + result.unsignedTxHex.length + ' chars)' : result);
    return res.json({ ok: true, result });
  } catch (err) {
    console.error('[/build-claim] Error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Assemble and submit a signed deposit tx.
// Wallet signTx() often returns a witness set (not a full tx), so backend merges it.
app.post('/submit-signed-deposit', async (req, res) => {
  const { unsignedTxHex, witnessSetHex, signedPayloadHex } = req.body || {};
  const payload = witnessSetHex || signedPayloadHex;
  console.log('[/submit-signed-deposit] Request received');
  try {
    const finalTxHex = assembleSignedTxHex(unsignedTxHex, payload);
    const txHash = await submitTxToBlockfrost(finalTxHex, NETWORK_ID);
    console.log('[/submit-signed-deposit] Submitted:', txHash);
    return res.json({ ok: true, txHash });
  } catch (err) {
    console.error('[/submit-signed-deposit] Error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/report/streams.pdf', async (req, res) => {
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch (_) {
    return res.status(500).json({
      error: 'puppeteer is not installed. Run "npm install" in backend first.'
    });
  }

  let browser = null;
  try {
    const streamList = Object.values(streams).sort((a, b) => {
      const aTime = new Date(a.createdAt || 0).getTime();
      const bTime = new Date(b.createdAt || 0).getTime();
      return bTime - aTime;
    });
    const html = buildStreamsReportHtml(streamList);

    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.emulateMediaType('screen');
    const pdfBytes = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '12mm', right: '10mm', bottom: '12mm', left: '10mm' }
    });
    const pdfBuffer = Buffer.isBuffer(pdfBytes) ? pdfBytes : Buffer.from(pdfBytes);

    const stamp = new Date().toISOString().replace(/[:]/g, '-').replace(/\..+$/, '');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="streams-report-' + stamp + '.pdf"');
    res.setHeader('Content-Length', String(pdfBuffer.length));
    return res.status(200).end(pdfBuffer);
  } catch (err) {
    console.error('[/report/streams.pdf] Error:', err.message);
    return res.status(500).json({ error: 'Failed to generate streams PDF: ' + err.message });
  } finally {
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
  }
});

app.get('/streams', (req, res) => {
  console.log('[/streams] Fetching all streams (' + Object.keys(streams).length + ' total)');
  return res.json(Object.values(streams));
});

app.get('/stream/:id', (req, res) => {
  const s = streams[req.params.id];
  if (!s) {
    console.log('[/stream/:id] Not found:', req.params.id);
    return res.status(404).json({ error: 'not found' });
  }
  console.log('[/stream/:id] Fetching:', req.params.id);
  return res.json(s);
});

try {
  validateEscrowSigningConfigOrThrow();
} catch (err) {
  console.error('[Server] Fatal config error:', err.message);
  process.exit(1);
}

app.listen(PORT, () => console.log('[Server] Escrow backend listening on http://localhost:' + PORT));
