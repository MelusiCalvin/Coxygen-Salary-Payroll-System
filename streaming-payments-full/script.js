// Streaming Payments — Frontend Simulation
// Stores streams in localStorage under key "streams_v1"

import { Tx, TxOutput, Value, Address, Cip30Wallet, NetworkParams } from './helios.js';

const STORAGE_KEY = "streams_v1";

let streams = loadStreams();
let interval = null;
// Fixed rate (per minute) used for all streams, independent of duration
const FIXED_PER_MINUTE = 1; // R1 per 1 minute

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

function createStreamObject(recipient, start, end, totalAda = null){
  const startMs = start.getTime();
  const endMs = end.getTime();
  const seconds = Math.max(1, (endMs - startMs)/1000);
  const minutes = seconds / 60;
  
  // If totalAda provided (from wallet), use it; otherwise use fixed rate
  let total, rate;
  if(totalAda !== null && totalAda > 0){
    total = totalAda;
    rate = totalAda / seconds; // per-second rate in ADA
  } else {
    const perMinute = FIXED_PER_MINUTE;
    total = perMinute * minutes;
    rate = perMinute / 60; // per-second rate
  }
  
  return {
    id: uid(),
    sender: "You (Local)",
    recipient,
    total,
    rate,
    start: startMs,
    end: endMs,
    cancelledAt: null,
    claimed: 0,
    status: "Active",
    createdAt: Date.now()
  };
}

// UI bindings
const btnSender = document.getElementById('btnSender');
const btnRecipient = document.getElementById('btnRecipient');
const senderView = document.getElementById('senderView');
const recipientView = document.getElementById('recipientView');

// Lace wallet UI
// const connectBtn = document.getElementById('connectBtn');
// const walletAddressSpan = document.getElementById('walletAddress');

btnSender.onclick = ()=>{ showView('sender'); }
btnRecipient.onclick = ()=>{ showView('recipient'); }

function showView(v){
  if(v==='sender'){ senderView.classList.remove('hidden'); recipientView.classList.add('hidden'); btnSender.classList.add('active'); btnRecipient.classList.remove('active'); }
  else { recipientView.classList.remove('hidden'); senderView.classList.add('hidden'); btnRecipient.classList.add('active'); btnSender.classList.remove('active'); }
}

// Submit a streaming payment transaction to Cardano
// Using Helios-based transaction building
async function submitStreamTransaction(senderAddress, recipientAddress, amountAda) {
  try {
    if (!window.laceApi) {
      throw new Error('Wallet API not available');
    }

    console.log('Building transaction with Helios...');

    const amountLovelace = BigInt(Math.floor(amountAda * 1000000));
    const wallet = new Cip30Wallet(window.laceApi);
    const tx = Tx.new();

    // Parse recipient address (try bech32 first, then hex)
    let recipientAddr;
    try {
      recipientAddr = Address.fromBech32(recipientAddress);
    } catch(e) {
      try {
        recipientAddr = Address.fromHex(recipientAddress);
      } catch(e2) {
        throw new Error(`Invalid recipient address: ${recipientAddress}`);
      }
    }
    tx.addOutput(new TxOutput(recipientAddr, new Value(amountLovelace)));

    // Get network params
    const networkParams = new NetworkParams(await fetch('https://d1t0d7c2nekuk0.cloudfront.net/preprod.json').then(r => r.json()));

    // Parse sender address (try bech32 first, then hex)
    let changeAddress;
    try {
      changeAddress = Address.fromBech32(senderAddress);
    } catch(e) {
      try {
        changeAddress = Address.fromHex(senderAddress);
      } catch(e2) {
        throw new Error(`Invalid sender address: ${senderAddress}`);
      }
    }
    // Fetch UTXOs and filter out any undefined entries
    const spareUtxos = (await wallet.utxos).filter(u => u !== undefined);

    await tx.finalize(networkParams, changeAddress, spareUtxos);

    const sigs = await wallet.signTx(tx);
    if (Array.isArray(sigs)) {
      for (const sig of sigs) {
        tx.witnesses.addSignature(sig);
      }
    }

    const txId = await wallet.submitTx(tx);

    console.log('Transaction submitted successfully:', txId);
    return txId;

  } catch (error) {
    console.error('Transaction submission error:', error);
    throw error;
  }
}

// Create stream
document.getElementById('createBtn').addEventListener('click', async ()=>{
  const recipient = document.getElementById('recipientNameInput').value.trim();
  const startVal = document.getElementById('startInput').value;
  const endVal = document.getElementById('endInput').value;
  const totalAdaAmount = parseFloat(document.getElementById('totalAmountInput').value);
  
  if(!recipient){ alert('Please enter recipient address'); return; }
  if(isNaN(totalAdaAmount) || totalAdaAmount <= 0){ alert('Please enter a valid amount'); return; }
  if(!window.connectedAddress){ alert('Please connect your wallet first'); return; }
  if(!window.laceApi){ alert('Wallet API not available'); return; }
  
  // Validate recipient address
  if(!recipient){ alert('Please enter recipient address'); return; }
  
  // Submit transaction to Lace wallet
  try {
    const createBtn = document.getElementById('createBtn');
    createBtn.disabled = true;
    createBtn.textContent = 'Sending...';
    
    const txHash = await submitStreamTransaction(window.connectedAddress, recipient, totalAdaAmount);
    
    if (txHash && txHash.hex) {
      alert('Transaction sent successfully!\nTransaction: ' + txHash.hex.slice(0, 10) + '...\nAmount: ₳' + totalAdaAmount.toFixed(2));
      
      // Reset form
      document.getElementById('recipientNameInput').value = '';
      document.getElementById('totalAmountInput').value = '';
      document.getElementById('startInput').value = '';
      document.getElementById('endInput').value = '';
    } else {
      alert('Failed to submit transaction. Please try again.');
    }
    
    createBtn.disabled = false;
    createBtn.textContent = 'Send Funds';
  } catch (error) {
    console.error('Send error:', error);
    alert('Error sending funds: ' + (error?.message || error));
    document.getElementById('createBtn').disabled = false;
    document.getElementById('createBtn').textContent = 'Send Funds';
  }
});

// Export CSV (payslips)
document.getElementById('exportCsvBtn').addEventListener('click', ()=>{
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

// Lookup recipient
document.getElementById('lookupBtn').addEventListener('click', ()=>{
  const name = document.getElementById('recipientLookup').value.trim();
  renderRecipient(name);
});
document.getElementById('claimAllBtn').addEventListener('click', ()=>{
  const name = document.getElementById('recipientLookup').value.trim();
  if(!name){ alert('Enter recipient name'); return; }
  const now = Date.now();
  let totalClaimed = 0;
  streams.forEach(s=>{
    if(s.recipient.toLowerCase()===name.toLowerCase() && (s.status==='Active' || s.status==='Cancelled' || s.status==='Paid')){
      const accrued = calcAccrued(s, now) - s.claimed;
      if(accrued>0){
        s.claimed += accrued;
        totalClaimed += accrued;
        // If claimed reaches full amount, mark Paid
        const eps = 1e-6;
        if(s.claimed + eps >= Math.min(s.total, calcAccrued(s, Date.now()))){
          s.status = 'Paid';
        }
      }
    }
  });
  saveStreams();
  renderRecipient(name);
  renderAll();
  alert('Claimed '+ totalClaimed.toFixed(2) + ' tokens for '+name);
});

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

function cancelStream(id){
  const s = streams.find(x=>x.id===id);
  if(!s) return;
  if(s.status!=='Active'){ alert('Not active'); return; }
  const now = Date.now();
  const accrued = calcAccrued(s, now);
  const returned = s.total - accrued;
  // If recipient has already claimed all accrued funds, treat as Paid instead
  const eps = 1e-6;
  if(s.claimed + eps >= accrued){
    s.status = 'Paid';
    s.cancelledAt = now; // record cancellation time for audit, but status is Paid
  } else {
    s.status = 'Cancelled';
    s.cancelledAt = now;
  }
  // keep claimed as-is; recipient can still claim accrued if not claimed yet
  saveStreams();
  renderAll();
  alert('Stream cancelled. Returned '+ returned.toFixed(2) +' to sender.');
}

function claimForStream(id, recipient){
  const s = streams.find(x=>x.id===id);
  if(!s) return;
  // Ensure the caller (recipient argument) matches the stream recipient
  if(!recipient || recipient.toLowerCase() !== String(s.recipient).toLowerCase()){
    alert('Only the stream recipient can claim funds.');
    return;
  }
  const now = Date.now();
  const accrued = calcAccrued(s, now);
  const claimable = Math.max(0, accrued - s.claimed);
  if(claimable<=0){ alert('Nothing to claim'); return; }
  s.claimed += claimable;
  // If claimed reaches total funds (or accrued at cancel), mark Paid
  const eps = 1e-6;
  if(s.claimed + eps >= Math.min(s.total, calcAccrued(s, Date.now()))){
    s.status = 'Paid';
  }
  saveStreams();
  renderRecipient(recipient);
  renderAll();
  alert('Claimed '+ claimable.toFixed(2) +' tokens.');
}

// Rendering
function renderAll(){
  updateStatuses();
  renderSenderStats();
  renderStreamsTable();
}

// Update stream statuses based on time (e.g., mark Paid when end reached)
function updateStatuses(){
  const now = Date.now();
  let changed = false;
  streams.forEach(s=>{
    if(s.status === 'Active'){
      const end = new Date(s.end).getTime();
      if(now >= end){
        s.status = 'Paid';
        changed = true;
      }
    }
  });
  if(changed) saveStreams();
}

function renderSenderStats(){
  const totalDeposited = streams.reduce((a,b)=>a + (b.total||0),0);
  const totalClaimed = streams.reduce((a,b)=>a + (b.claimed||0),0);
  const activeCount = streams.filter(s=>s.status==='Active').length;
  document.getElementById('totalDeposited').innerText = '₳' + totalDeposited.toFixed(6);
  document.getElementById('totalClaimed').innerText = '₳' + totalClaimed.toFixed(6);
  document.getElementById('activeCount').innerText = activeCount;
}

function renderStreamsTable(){
  const tbody = document.querySelector('#streamsTable tbody');
  tbody.innerHTML = '';
  const now = Date.now();
  streams.forEach(s=>{
    const tr = document.createElement('tr');
    const accrued = calcAccrued(s, now);
    const claimable = Math.max(0, accrued - s.claimed);
    const startStr = new Date(s.start).toLocaleString();
    const endStr = new Date(s.end).toLocaleString();
    // Format rate as ADA/second, display per minute
    const perMinute = s.rate * 60;
    const perMinuteStr = Number.isInteger(perMinute) ? perMinute.toString() : perMinute.toFixed(4);
    tr.innerHTML = `
      <td>${s.recipient.slice(0, 15)}...</td>
      <td>₳${perMinuteStr}/min</td>
      <td>₳${accrued.toFixed(6)}</td>
      <td>₳${s.claimed.toFixed(6)}</td>
      <td>${startStr}</td>
      <td>${endStr}</td>
      <td>${s.status}</td>
      <td>
        ${s.status==='Active'? `<button onclick="cancelStream(${s.id})">Cancel</button>` : ''}
        ${ (claimable>0 && s.sender!=='You (Local)') ? `<button onclick="claimForStream(${s.id}, '${s.recipient.replace(/'/g,"\\'")}')">Claim ₳${claimable.toFixed(6)}</button>` : ''}
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function renderRecipient(name){
  const tbody = document.querySelector('#recipientTable tbody');
  tbody.innerHTML = '';
  if(!name) return;
  const now = Date.now();
  let balance = 0;
  streams.filter(s=>s.recipient.toLowerCase()===name.toLowerCase()).forEach(s=>{
    const accrued = calcAccrued(s, now);
    const claimable = Math.max(0, accrued - s.claimed);
    balance += claimable;
    const tr = document.createElement('tr');
    const senderDisplay = s.sender && s.sender !== 'You (Local)' 
      ? s.sender.slice(0, 15) + '...' 
      : (s.sender || 'Unknown');
    tr.innerHTML = `
      <td>${senderDisplay}</td>
      <td>₳${accrued.toFixed(6)}</td>
      <td>₳${s.claimed.toFixed(6)}</td>
      <td>${new Date(s.start).toLocaleString()}</td>
      <td>${new Date(s.end).toLocaleString()}</td>
      <td>${s.status}</td>
      <td>${claimable>0? `<button onclick="claimForStream(${s.id}, '${name.replace(/'/g,"\\'")}')">Claim ₳${claimable.toFixed(6)}</button>` : ''}</td>
    `;
    tbody.appendChild(tr);
  });
  document.getElementById('recipientBalance').innerText = '₳' + balance.toFixed(6);
}

// Auto-render
renderAll();
setInterval(renderAll, 1000);