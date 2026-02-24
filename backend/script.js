// Streaming Payments — Frontend Simulation
// Stores streams in localStorage under key "streams_v1" (wallet-specific)

const STORAGE_KEY_PREFIX = "streams_v1_";
let STORAGE_KEY = "streams_v1"; // Default (local storage)

let streams = [];
let interval = null;
let currentWallet = null;
// Backend URL for escrow service (change if backend runs elsewhere)
let BACKEND_URL = 'http://localhost:4000';
let backendKnownReachable = false;
let backendResolvePromise = null;
const CLAIMABLE_STATUSES = new Set(['Active', 'Cancelled', 'Paid']);

// Fixed rate (per minute) used for all streams, independent of duration
const FIXED_PER_MINUTE = 1; // R1 per 1 minute

async function fetchJsonOrThrow(url, options = {}, label = 'Request') {
  await ensureBackendReachable();

  const originalUrl = url;
  const rewrittenUrl = rewriteUrlToBackend(originalUrl, BACKEND_URL);
  let requestUrl = rewrittenUrl;
  let resp;
  try {
    resp = await fetch(requestUrl, options);
    backendKnownReachable = true;
  } catch (err) {
    const previousBase = BACKEND_URL;
    await ensureBackendReachable(true);
    if (BACKEND_URL !== previousBase) {
      requestUrl = rewriteUrlToBackend(originalUrl, BACKEND_URL);
      try {
        resp = await fetch(requestUrl, options);
        backendKnownReachable = true;
      } catch (retryErr) {
        const checked = buildBackendCandidates().join(', ');
        throw new Error(label + ' network error: ' + (retryErr?.message || retryErr) + '. Checked backends: ' + checked);
      }
    } else {
      const checked = buildBackendCandidates().join(', ');
      throw new Error(label + ' network error: ' + (err?.message || err) + '. Checked backends: ' + checked);
    }
  }

  const text = await resp.text();
  const maybeJson = () => {
    try { return text ? JSON.parse(text) : null; } catch (_) { return null; }
  };

  if (!resp.ok) {
    const parsed = maybeJson();
    const detail = parsed && (parsed.error || parsed.message)
      ? (parsed.error || parsed.message)
      : (text || ('HTTP ' + resp.status));
    throw new Error(label + ' failed (' + resp.status + '): ' + detail);
  }

  const parsed = maybeJson();
  return parsed || {};
}

function dedupeStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function buildBackendCandidates() {
  const host = window.location.hostname || 'localhost';
  const hosts = dedupeStrings([host, 'localhost', '127.0.0.1']);
  const ports = ['4000', '3000'];
  const out = [BACKEND_URL];
  for (const h of hosts) {
    for (const p of ports) {
      out.push('http://' + h + ':' + p);
    }
  }
  return dedupeStrings(out);
}

function splitAbsoluteUrl(url) {
  try {
    const parsed = new URL(url, window.location.href);
    return { origin: parsed.origin, path: parsed.pathname + parsed.search + parsed.hash };
  } catch (_) {
    return null;
  }
}

function rewriteUrlToBackend(url, backendBase) {
  const parts = splitAbsoluteUrl(url);
  if (!parts) return url;
  const candidates = buildBackendCandidates();
  if (!candidates.includes(parts.origin)) return url;
  return backendBase.replace(/\/+$/, '') + parts.path;
}

async function probeBackend(base) {
  try {
    const r = await fetch(base + '/streams', { method: 'GET' });
    return !!r && r.ok;
  } catch (_) {
    return false;
  }
}

async function ensureBackendReachable(force = false) {
  if (!force && backendKnownReachable) return BACKEND_URL;
  if (backendResolvePromise) return backendResolvePromise;

  backendResolvePromise = (async () => {
    const candidates = buildBackendCandidates();
    for (const base of candidates) {
      const ok = await probeBackend(base);
      if (!ok) continue;
      if (base !== BACKEND_URL) {
        console.warn('[backend] Switched API base URL to ' + base);
      }
      BACKEND_URL = base;
      backendKnownReachable = true;
      return BACKEND_URL;
    }
    backendKnownReachable = false;
    return BACKEND_URL;
  })();

  try {
    return await backendResolvePromise;
  } finally {
    backendResolvePromise = null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJsonWithRetry(url, options = {}, label = 'Request', retries = 2, delayMs = 600) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchJsonOrThrow(url, options, label);
    } catch (err) {
      lastErr = err;
      const msg = String(err && err.message ? err.message : err);
      const isNetwork = msg.toLowerCase().includes('network error');
      if (!isNetwork || attempt === retries) break;
      await sleep(delayMs * (attempt + 1));
    }
  }
  throw lastErr;
}

// Initialize wallet manager
async function initWalletListener() {
  // Restore previous connection if available
  await walletManager.restoreConnection();
  currentWallet = walletManager.getState();
  updateStorageKeyForWallet();
  migrateLegacyWalletStorageIfNeeded();
  streams = loadStreams();

  // Listen for wallet changes
  walletManager.onChange((state) => {
    currentWallet = state;
    updateStorageKeyForWallet();
    migrateLegacyWalletStorageIfNeeded();
    // Reload streams when wallet changes
    streams = loadStreams();
    renderAll();
    updateWalletDisplay();
  });

  renderAll();
  updateWalletDisplay();
}

// Update storage key based on connected wallet
function updateStorageKeyForWallet() {
  if (walletManager.isConnected && walletManager.getFullAddress()) {
    const addr = walletManager.getFullAddress().toLowerCase();
    STORAGE_KEY = STORAGE_KEY_PREFIX + addr;
  } else {
    STORAGE_KEY = "streams_v1"; // Fallback to local storage
  }
}

function migrateLegacyWalletStorageIfNeeded() {
  if (!walletManager.isConnected) return;
  const shortAddr = walletManager.getShortenedAddress();
  if (!shortAddr) return;
  const legacyKey = STORAGE_KEY_PREFIX + shortAddr;
  if (legacyKey === STORAGE_KEY) return;
  const current = localStorage.getItem(STORAGE_KEY);
  const legacy = localStorage.getItem(legacyKey);
  if (!current && legacy) {
    localStorage.setItem(STORAGE_KEY, legacy);
  }
}

// Update wallet display across pages
function updateWalletDisplay() {
  const state = walletManager.getState();
  const btn = document.getElementById('connectWalletBtn');
  const walletInfo = document.getElementById('walletInfo');

  if (state.isConnected && btn) {
    btn.textContent = `Connected: ${state.shortenedAddress}`;
    btn.className = 'btn btn-success';
    btn.disabled = true;
  } else if (btn) {
    btn.textContent = 'Connect Wallet';
    btn.className = 'btn btn-primary';
    btn.disabled = false;
  }

  if (walletInfo) {
    if (state.isConnected) {
      walletInfo.innerHTML = `
        <div class="alert alert-success" role="alert">
          <strong>Connected:</strong> ${state.shortenedAddress}
          ${state.balance !== null ? `<br><strong>Balance:</strong> ${state.balance.toFixed(2)} ADA` : ''}
          <button class="btn btn-sm btn-outline-danger ms-3" onclick="disconnectWallet()">Disconnect</button>
        </div>
      `;
    } else {
      walletInfo.innerHTML = `
        <div class="alert alert-warning" role="alert">
          <strong>Wallet not connected.</strong> Data will be stored locally only.
        </div>
      `;
    }
  }
}

function loadStreams(){
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return [];
    return JSON.parse(raw).map(s => ({...s, start: new Date(s.start), end: new Date(s.end), cancelledAt: s.cancelledAt ? new Date(s.cancelledAt) : null}));
  } catch(e){
    console.error("load error", e);
    return [];
  }
}

function saveStreams(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(streams));
}

function uid(){ return Date.now() + Math.floor(Math.random()*1000); }

function escJsSingleQuoted(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function toIso(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

function streamSnapshotForBackend(s) {
  return {
    id: s.id,
    senderAddress: s.senderAddress,
    recipient: s.recipient,
    total: Number(s.total || 0),
    claimed: Number(s.claimed || 0),
    refunded: Number(s.refunded || 0),
    start: toIso(s.start),
    end: toIso(s.end),
    createdAt: toIso(s.createdAt || Date.now()),
    cancelledAt: s.cancelledAt ? toIso(s.cancelledAt) : null,
    status: s.status,
    depositAddress: s.depositAddress || null,
    depositTx: s.depositTx || null,
    refundTx: s.refundTx || null
  };
}

function applyBackendStreamToLocal(local, backendStream) {
  if (!local || !backendStream) return;
  if (backendStream.start) local.start = new Date(backendStream.start).getTime();
  if (backendStream.end) local.end = new Date(backendStream.end).getTime();
  if (backendStream.total !== undefined) local.total = Number(backendStream.total);
  const seconds = Math.max(1, (new Date(local.end).getTime() - new Date(local.start).getTime()) / 1000);
  local.rate = Number(local.total || 0) / seconds;
  local.status = backendStream.status || local.status;
  local.claimed = Number(backendStream.claimed ?? local.claimed ?? 0);
  local.refunded = Number(backendStream.refunded ?? local.refunded ?? 0);
  local.cancelledAt = backendStream.cancelledAt ? new Date(backendStream.cancelledAt) : local.cancelledAt;
  local.depositTx = backendStream.depositTx || local.depositTx;
  local.refundTx = backendStream.refundTx || local.refundTx;
}

function shortAddress(addr) {
  if (!addr || typeof addr !== 'string') return 'Unknown';
  return addr.length > 15 ? (addr.slice(0, 10) + '...' + addr.slice(-5)) : addr;
}

function backendStreamToLocal(backendStream) {
  const startMs = new Date(backendStream.start).getTime();
  const endMs = new Date(backendStream.end).getTime();
  const seconds = Math.max(1, (endMs - startMs) / 1000);
  const total = Number(backendStream.total || 0);
  return {
    id: backendStream.id,
    sender: shortAddress(backendStream.senderAddress),
    senderAddress: backendStream.senderAddress || 'unknown',
    recipient: backendStream.recipient || '',
    total,
    rate: total / seconds,
    start: startMs,
    end: endMs,
    cancelledAt: backendStream.cancelledAt ? new Date(backendStream.cancelledAt) : null,
    claimed: Number(backendStream.claimed || 0),
    refunded: Number(backendStream.refunded || 0),
    status: backendStream.status || 'AwaitingDeposit',
    depositAddress: backendStream.depositAddress || null,
    depositTx: backendStream.depositTx || null,
    refundTx: backendStream.refundTx || null,
    createdAt: backendStream.createdAt ? new Date(backendStream.createdAt).getTime() : Date.now()
  };
}

async function hydrateStreamsFromBackend() {
  try {
    const resp = await fetch(BACKEND_URL + '/streams');
    if (!resp.ok) return;
    const backendStreams = await resp.json();
    if (!Array.isArray(backendStreams)) return;
    streams = backendStreams.map(backendStreamToLocal);
    saveStreams();
    renderAll();
  } catch (err) {
    console.warn('[sync] Failed to hydrate streams from backend:', err.message || err);
  }
}

function createStreamObject(recipient, start, end, total){
  const startMs = start.getTime();
  const endMs = end.getTime();
  const seconds = Math.max(1, (endMs - startMs)/1000);
  // rate per second computed from provided total
  const rate = Number(total) / seconds;
  return {
    id: uid(),
    sender: currentWallet ? walletManager.getShortenedAddress() : "You (Local)",
    senderAddress: currentWallet ? walletManager.getFullAddress() : "local",
    recipient,
    total: Number(total),
    rate,
    start: startMs,
    end: endMs,
    cancelledAt: null,
    claimed: 0,
    refunded: 0,
    status: "AwaitingDeposit",
    depositAddress: null,
    depositTx: null,
    refundTx: null,
    createdAt: Date.now()
  };
}

// Create stream
const createStreamBtn = document.getElementById('createStreamBtn') || document.getElementById('createBtn');
if (createStreamBtn) {
  createStreamBtn.addEventListener('click', async ()=>{
    const recipient = document.getElementById('recipientAddressInput')?.value.trim() || document.getElementById('recipientNameInput')?.value.trim();
    const totalStr = document.getElementById('totalAmountInput')?.value || document.getElementById('totalInput')?.value;
    const startVal = document.getElementById('startInput').value;
    const endVal = document.getElementById('endInput').value;
    if(!recipient || !startVal || !endVal || !totalStr){ alert('Please fill all fields'); return; }
    const total = parseFloat(totalStr);
    if (!(total > 0)) { alert('Enter valid total amount'); return; }
    if (total < 1) { alert('Minimum stream total is 1 ADA.'); return; }
    const start = new Date(startVal);
    const end = new Date(endVal);
    if(end<=start){ alert('End must be after start'); return; }

    // Require wallet to be connected for deposit
    if (!walletManager.isConnected || !walletManager.getFullAddress()) {
      alert('Please connect your Lace wallet first to create and fund a stream.');
      return;
    }

    const s = createStreamObject(recipient, start, end, total);
    try {
      const body = await fetchJsonOrThrow(BACKEND_URL + '/create-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ senderAddress: walletManager.getFullAddress(), recipient, total, start: start.toISOString(), end: end.toISOString() })
      }, 'Create stream');
      s.id = body.id;
      s.depositAddress = body.depositAddress;
      // Keep local stream in sync metadata early in case backend notify call fails later.
      s.status = (body.stream && body.stream.status) ? body.stream.status : s.status;
      s.createdAt = body.stream && body.stream.createdAt ? new Date(body.stream.createdAt).getTime() : s.createdAt;
      
      // Immediately submit deposit from wallet (blocking/synchronous)
      console.log('Submitting deposit of ' + s.total.toFixed(2) + ' ADA from your connected wallet...');
      const txHash = await submitDepositUsingWallet(s);
      
      // Only add stream after successful deposit
      s.status = 'Active';
      s.depositTx = txHash;
      streams.push(s);
      saveStreams();
      renderAll();
      alert('Stream created and deposit submitted successfully!\nTransaction: ' + txHash);
    } catch (e) {
      console.error(e);
      // Best-effort cleanup: remove unfunded backend draft stream.
      if (s && s.id) {
        try {
          await fetchJsonOrThrow(BACKEND_URL + '/discard-stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: s.id })
          }, 'Discard unfunded stream');
        } catch (_) {
          // ignore; stream may already be funded or missing
        }
      }
      alert('Failed to create and fund stream: ' + (e.message || e));
    }
  });
}

// Export CSV (payslips)
const exportCsvBtn = document.getElementById('exportCsvBtn');
if (exportCsvBtn) {
  exportCsvBtn.addEventListener('click', ()=>{
    if(streams.length===0){ alert('No streams to export'); return; }
  const rows = [
    ['Recipient','Total','Claimed','Accrued','Start','End','Status']
  ];
  const now = Date.now();
  streams.forEach(s=>{
    const accrued = calcAccrued(s, now);
    rows.push([s.recipient, s.total.toFixed(2), s.claimed.toFixed(2), accrued.toFixed(2), new Date(s.start).toLocaleString(), new Date(s.end).toLocaleString(), s.status]);
  });
  const csv = rows.map(r=>r.map(cell=>`"${String(cell).replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], {type:'text/csv'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'payslips.csv'; document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  });
}

const exportPdfBtn = document.getElementById('exportPdfBtn');
if (exportPdfBtn) {
  exportPdfBtn.addEventListener('click', async () => {
    try {
      await ensureBackendReachable();
      const resp = await fetch(BACKEND_URL + '/report/streams.pdf');
      const text = !resp.ok ? await resp.text() : null;
      if (!resp.ok) {
        let detail = text || ('HTTP ' + resp.status);
        try {
          const parsed = text ? JSON.parse(text) : null;
          if (parsed && (parsed.error || parsed.message)) detail = parsed.error || parsed.message;
        } catch (_) {}
        throw new Error('Export report failed (' + resp.status + '): ' + detail);
      }

      const blob = await resp.blob();
      const cd = resp.headers.get('content-disposition') || '';
      const filenameMatch = cd.match(/filename="?([^"]+)"?/i);
      const filename = filenameMatch && filenameMatch[1] ? filenameMatch[1] : 'streams-report.pdf';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error(e);
      alert('PDF export failed: ' + (e.message || e));
    }
  });
}

// Start polling backend for deposit activation
function startDepositPoll(streamId) {
  const pollId = setInterval(async ()=>{
    try {
      const r = await fetch(BACKEND_URL + '/stream/' + streamId);
      if (!r.ok) return;
      const js = await r.json();
      if (js.status === 'Active'){
        const local = streams.find(x=>x.id===streamId);
        if (local){ local.status = 'Active'; local.depositTx = js.depositTx; saveStreams(); renderAll(); }
        clearInterval(pollId);
      }
    } catch (err) {}
  }, 2000);
}

// Build deposit via backend, sign with connected wallet, submit, and notify backend
async function submitDepositUsingWallet(stream) {
  const senderAddr = walletManager.getFullAddress();
  if (!senderAddr) throw new Error('Wallet address not available');

  console.log('[Deposit] Step 1: Building unsigned transaction on backend...');
  // Request backend to build unsigned deposit
  let body;
  try {
    body = await fetchJsonWithRetry(BACKEND_URL + '/build-deposit', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ senderAddress: senderAddr, scriptAddress: stream.depositAddress, datum: { streamId: stream.id }, amountLovelace: Math.round(stream.total * 1000000) })
    }, 'Build deposit', 2, 700);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (msg.toLowerCase().includes('network error')) {
      let backendReachable = false;
      try {
        await fetchJsonOrThrow(BACKEND_URL + '/streams', { method: 'GET' }, 'Backend health check');
        backendReachable = true;
      } catch (healthErr) {
        backendReachable = false;
      }
      if (backendReachable) {
        throw new Error('Build deposit request dropped before response. Backend is reachable; check backend terminal logs for /build-deposit.');
      }
      throw new Error('Build deposit network error: backend unreachable at ' + BACKEND_URL + '. Is the backend running?');
    }
    throw err;
  }
  const result = body.result || body;
  console.log('[Deposit] Build result:', result);

  if (result.unsignedTxHex) {
    const unsignedHex = result.unsignedTxHex;
    console.log('[Deposit] Step 2: Got unsigned TX (', unsignedHex.length, 'chars ). Requesting wallet signature...');
    
    // sign with wallet (CIP-30)
    const api = walletManager.connectedWallet;
    if (!api || !api.signTx) throw new Error('Connected wallet does not support signTx');
    
    // Many wallets expect hex string; second arg indicates partial sign in some implementations
    const witnessSetHex = await api.signTx(unsignedHex, true);
    console.log('[Deposit] Step 3: Witness set signed. Submitting via backend...');

    // CIP-30 signTx returns witness set CBOR, not a full tx.
    // Backend merges witness set into unsigned tx and submits to Blockfrost.
    const submitBody = await fetchJsonOrThrow(BACKEND_URL + '/submit-signed-deposit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unsignedTxHex: unsignedHex, witnessSetHex })
    }, 'Submit signed deposit');
    const txHash = submitBody.txHash;
    if (!txHash) throw new Error('submit-signed-deposit did not return txHash');
    console.log('[Deposit] Step 4: Transaction submitted with tx hash:', txHash);

    // Notify backend about deposit
    console.log('[Deposit] Step 5: Notifying backend...');
    try {
      const notifyResp = await fetch(BACKEND_URL + '/notify-deposit', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ id: stream.id, txId: txHash })
      });
      if (!notifyResp.ok) {
        const notifyTxt = await notifyResp.text();
        console.warn('[Deposit] notify-deposit failed (non-blocking):', notifyTxt);
      }
    } catch (err) {
      console.warn('[Deposit] notify-deposit fetch failed (non-blocking):', err?.message || err);
    }
    console.log('[Deposit] Deposit flow complete!');

    return txHash;
  } else if (result.plan) {
    // Backend returned a plan instead of unsigned tx; include detailed backend note.
    const reason = result.note || body.note || 'CSL assembly incomplete or Blockfrost not configured.';
    const msg = 'Backend returned a build plan: ' + reason;
    console.warn('[Deposit]', msg);
    throw new Error(msg);
  } else {
    console.error('[Deposit] Unexpected build-deposit response:', result);
    throw new Error('Unexpected build-deposit response');
  }
}

const claimAllBtn = document.getElementById('claimAllBtn');
if (claimAllBtn) {
  claimAllBtn.addEventListener('click', async ()=>{
    const recipientAddress = walletManager.getFullAddress();
    if(!recipientAddress){ alert('Connect your wallet first.'); return; }
    let totalClaimed = 0;
    const eligible = streams.filter(s =>
      String(s.recipient || '').toLowerCase() === recipientAddress.toLowerCase() &&
      CLAIMABLE_STATUSES.has(String(s.status || ''))
    );

    for (const s of eligible) {
      const out = await claimForStream(s.id, recipientAddress, { silent: true });
      totalClaimed += Number(out?.claimed || 0);
    }

    renderRecipient();
    renderAll();
    alert('Claimed '+ totalClaimed.toFixed(5) +' ADA for connected wallet');
  });
}

async function fundAwaitingStream(id) {
  const s = streams.find((x) => String(x.id) === String(id));
  if (!s) return;
  if (s.status !== 'AwaitingDeposit') {
    alert('Only AwaitingDeposit streams can be funded.');
    return;
  }
  if (!walletManager.isConnected || !walletManager.getFullAddress()) {
    alert('Please connect your Lace wallet first.');
    return;
  }
  try {
    const txHash = await submitDepositUsingWallet(s);
    s.status = 'Active';
    s.depositTx = txHash;
    saveStreams();
    renderAll();
    alert('Stream funded successfully.\nTransaction: ' + txHash);
  } catch (e) {
    console.error(e);
    alert('Funding failed: ' + (e.message || e));
  }
}

// helper: calc accrued up to now (not subtracting claimed)
function calcAccrued(s, now=Date.now()){
  const start = new Date(s.start).getTime();
  const end = new Date(s.end).getTime();
  if(now <= start) return 0;
  const cancelledAtMs = s.cancelledAt ? new Date(s.cancelledAt).getTime() : null;
  const effectiveEnd = cancelledAtMs ? Math.min(end, cancelledAtMs) : end;
  const elapsed = Math.min(now, effectiveEnd) - start;
  const accrued = s.rate * (elapsed/1000);
  return Math.min(accrued, s.total);
}

async function cancelStream(id){
  const s = streams.find(x => String(x.id) === String(id));
  if(!s) return;
  if(s.status!=='Active'){ alert('Not active'); return; }
  try {
    const body = await fetchJsonOrThrow(BACKEND_URL + '/cancel-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: s.id, streamSnapshot: streamSnapshotForBackend(s) })
    }, 'Cancel stream');
    applyBackendStreamToLocal(s, body.stream);
    saveStreams();
    renderAll();
    const noteText = body.note ? ('\n' + body.note) : '';
    alert('Stream cancelled. Refunded ' + Number(body.refunded || 0).toFixed(5) + ' ADA to sender wallet (tx: ' + (body.txHash || 'n/a') + ').' + noteText);
  } catch (e) {
    console.error(e);
    alert('Cancel failed: ' + e.message);
  }
}

async function claimForStream(id, recipient, options = {}){
  const silent = !!options.silent;
  const s = streams.find(x => String(x.id) === String(id));
  if(!s) return { claimed: 0, txHash: null };
  // Ensure the caller (recipient argument) matches the stream recipient
  if(!recipient || recipient.toLowerCase() !== String(s.recipient).toLowerCase()){
    if (!silent) alert('Only the stream recipient can claim funds.');
    return { claimed: 0, txHash: null };
  }
  const now = Date.now();
  const accrued = calcAccrued(s, now);
  const claimable = Math.max(0, accrued - s.claimed);
  if (claimable <= 0) {
    if (!silent) alert('Nothing to claim');
    return { claimed: 0, txHash: null };
  }
  if (!CLAIMABLE_STATUSES.has(String(s.status || ''))) {
    if (!silent) alert('This stream is not active yet. Wait for deposit confirmation.');
    return { claimed: 0, txHash: null, error: 'stream not active' };
  }

  // Call backend to perform payout from escrow
  try {
    const body = await fetchJsonOrThrow(BACKEND_URL + '/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: s.id,
        recipientAddress: walletManager.getFullAddress() || recipient,
        streamSnapshot: streamSnapshotForBackend(s)
      })
    }, 'Claim stream');
    const claimed = Number(body.claimed || 0);
    applyBackendStreamToLocal(s, body.stream);
    if (!body.stream) {
      s.claimed += claimed;
      if (s.claimed + 1e-6 >= s.total) s.status = 'Paid';
    }
    saveStreams();
    renderRecipient();
    renderAll();
    if (claimed <= 0 && body.note) {
      if (!silent) alert(body.note);
      return { claimed: 0, txHash: null, note: body.note };
    }
    if (!silent) {
      alert('Claimed '+ claimed.toFixed(5) +' ADA (tx: '+ (body.txHash||'n/a') +')');
    }
    return { claimed, txHash: body.txHash || null };
  } catch (e) {
    console.error(e);
    if (!silent) alert('Claim failed: ' + e.message);
    return { claimed: 0, txHash: null, error: e.message };
  }
}

// Rendering
function renderAll(){
  updateStatuses();
  renderSenderStats();
  renderStreamsTable();
  renderRecipient();
}

// Update stream statuses based on claimability (not just end-time).
function updateStatuses(){
  const now = Date.now();
  const eps = 1e-6;
  let changed = false;
  streams.forEach((s) => {
    const accrued = calcAccrued(s, now);
    const fullyClaimed = Number(s.claimed || 0) + eps >= accrued;

    if (fullyClaimed && s.status !== 'Paid') {
      s.status = 'Paid';
      changed = true;
      return;
    }

    // Recover from stale local state where stream was marked Paid but still has claimable balance.
    if (!fullyClaimed && s.status === 'Paid') {
      s.status = s.cancelledAt ? 'Cancelled' : 'Active';
      changed = true;
    }
  });
  if(changed) saveStreams();
}

function renderSenderStats(){
  const totalDeposited = streams.reduce((a,b)=>a + (b.total||0),0);
  const totalClaimed = streams.reduce((a,b)=>a + (b.claimed||0),0);
  const activeCount = streams.filter(s=>s.status==='Active').length;
  const tdEl = document.getElementById('totalDeposited');
  const tcEl = document.getElementById('totalClaimed');
  const acEl = document.getElementById('activeCount');
  if (tdEl) tdEl.innerText = totalDeposited.toFixed(2);
  if (tcEl) tcEl.innerText = totalClaimed.toFixed(2);
  if (acEl) acEl.innerText = activeCount;
}

function renderStreamsTable(){
  const tbody = document.querySelector('#streamsTable tbody');
  if (!tbody) return; // nothing to render on pages without the streams table
  tbody.innerHTML = '';
  const now = Date.now();
  streams.forEach(s=>{
    const tr = document.createElement('tr');
    const accrued = calcAccrued(s, now);
    const claimable = Math.max(0, accrued - s.claimed);
    const startStr = new Date(s.start).toLocaleString();
    const endStr = new Date(s.end).toLocaleString();
    // Format rate as R{perMinute}/1 minute (show integer if whole)
    const perMinute = s.rate * 60;
    const perMinuteStr = Number.isInteger(perMinute) ? perMinute.toString() : perMinute.toFixed(2);
    tr.innerHTML = `
      <td>${s.recipient}</td>
      <td>R${perMinuteStr}/1 minute</td>
      <td>${accrued.toFixed(2)}</td>
      <td>${s.claimed.toFixed(2)}</td>
      <td>${startStr}</td>
      <td>${endStr}</td>
      <td>${s.status}</td>
      <td>
        ${s.status==='AwaitingDeposit' ? `<button onclick="fundAwaitingStream('${escJsSingleQuoted(s.id)}')">Fund</button>` : ''}
        ${s.status==='Active' ? `<button onclick="cancelStream('${escJsSingleQuoted(s.id)}')">Cancel</button>` : ''}
        ${ (claimable>0 && CLAIMABLE_STATUSES.has(String(s.status || '')) && s.sender!=='You (Local)') ? `<button onclick="claimForStream('${escJsSingleQuoted(s.id)}', '${escJsSingleQuoted(s.recipient)}')">Claim ${claimable.toFixed(2)}</button>` : ''}
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function renderRecipient(){
  const tbody = document.querySelector('#recipientTable tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  const recipientAddress = walletManager.getFullAddress();
  const balEl = document.getElementById('recipientBalance');
  if (!recipientAddress) {
    if (balEl) balEl.innerText = '0.00';
    return;
  }
  const now = Date.now();
  let balance = 0;
  streams.filter(s => String(s.recipient || '').toLowerCase() === recipientAddress.toLowerCase()).forEach(s=>{
    const accrued = calcAccrued(s, now);
    const claimable = Math.max(0, accrued - s.claimed);
    balance += claimable;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${s.sender}</td>
      <td>${accrued.toFixed(2)}</td>
      <td>${s.claimed.toFixed(2)}</td>
      <td>${new Date(s.start).toLocaleString()}</td>
      <td>${new Date(s.end).toLocaleString()}</td>
      <td>${s.status}</td>
      <td>${(claimable>0 && CLAIMABLE_STATUSES.has(String(s.status || '')))? `<button onclick="claimForStream('${escJsSingleQuoted(s.id)}', '${escJsSingleQuoted(recipientAddress)}')">Claim ${claimable.toFixed(2)}</button>` : ''}</td>
    `;
    tbody.appendChild(tr);
  });
  if (balEl) balEl.innerText = balance.toFixed(2);
}

// Initialize app on page load
(async function bootstrapApp() {
  await initWalletListener();
  await ensureBackendReachable();
  await hydrateStreamsFromBackend();
  if (interval) clearInterval(interval);
  interval = setInterval(renderAll, 1000);
})();

// Connect wallet button (on index.html)
const connectBtn = document.getElementById('connectWalletBtn');
if (connectBtn) {
  connectBtn.addEventListener('click', async () => {
    const result = await walletManager.connectWallet('lace');
    if (!result.success) {
      alert('Failed to connect wallet: ' + result.error);
    }
  });
}

// Global function to disconnect wallet
function disconnectWallet() {
  walletManager.disconnectWallet();
  streams = loadStreams();
  renderAll();
}
