// Wallet Manager - Handles Lace Wallet Connection (CIP-30 Standard)
// Persists wallet connection state across page navigation

const WALLET_STORAGE_KEY = "wallet_connection_v1";
const CARDANO_NETWORK = "preprod"; // Use preprod testnet

// Minimal bech32 encoding for Cardano addresses
const BECH32_CHARS = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function bech32Encode(hrp, data) {
  const values = data.map(byte => byte & 0xFF);
  const converted = convertBits(values, 8, 5, true);
  if (!converted) return null;

  const checksum = bech32CreateChecksum(hrp, converted);
  const combined = [...converted, ...checksum];
  return hrp + '1' + combined.map(v => BECH32_CHARS[v]).join('');
}

function convertBits(data, fromBits, toBits, pad = true) {
  let acc = 0, bits = 0;
  const ret = [];
  const maxv = (1 << toBits) - 1;
  const max_acc = (1 << (fromBits + toBits - 1)) - 1;
  
  for (let value of data) {
    if (value < 0 || (value >> fromBits)) return null;
    acc = ((acc << fromBits) | value) & max_acc;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >> bits) & maxv);
    }
  }
  
  if (pad) {
    if (bits) ret.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
    return null;
  }
  return ret;
}

function bech32Polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >>> i) & 1) chk ^= BECH32_GEN[i];
    }
  }
  return chk >>> 0;
}

function bech32HrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function bech32CreateChecksum(hrp, data) {
  const values = [...bech32HrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = bech32Polymod(values) ^ 1;
  const ret = [];
  for (let p = 0; p < 6; p++) {
    ret.push((mod >>> (5 * (5 - p))) & 31);
  }
  return ret;
}

// Convert hex string to bytes, handle CBOR if needed
function hexToBytes(hex) {
  let cleaned = hex.replace(/^0x/, '').toLowerCase().trim();
  if (!cleaned || cleaned.length % 2 !== 0) return [];

  const bytes = [];
  for (let i = 0; i < cleaned.length; i += 2) {
    bytes.push(parseInt(cleaned.substr(i, 2), 16));
  }
  return bytes;
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
    payloadLen = (bytes[1] << 8) | bytes[2];
  } else if (first === 0x5a && bytes.length >= 5) {
    headerLen = 5;
    payloadLen = (((bytes[1] << 24) >>> 0) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4]) >>> 0;
  }

  if (headerLen > 0 && bytes.length === headerLen + payloadLen) {
    return bytes.slice(headerLen);
  }
  return bytes;
}

// Attempt to decode address from various formats to bech32
function decodeAddressToBech32(addr) {
  if (!addr) return null;

  // already bech32
  if (typeof addr === 'string' && addr.startsWith('addr')) return addr.trim();

  // Some wallet wrappers expose typed address objects
  if (addr.to_bech32 && typeof addr.to_bech32 === 'function') {
    try {
      return addr.to_bech32();
    } catch (e) {}
  }

  // CIP-30 wallet APIs usually return hex-encoded address bytes.
  if (typeof addr === 'string') {
    try {
      const bytes = unwrapCborBytesIfNeeded(hexToBytes(addr));
      if (bytes.length > 0) {
        const hrp = CARDANO_NETWORK === 'mainnet' ? 'addr' : 'addr_test';
        const bech32Addr = bech32Encode(hrp, bytes);
        if (bech32Addr) return bech32Addr;
      }
    } catch (e) {}
    return addr.replace(/^0x/, '').trim();
  }

  return addr?.toString?.() || null;
}

class WalletManager {
  constructor() {
    this.connectedWallet = null;
    this.walletAddress = null;
    this.walletBalance = null;
    this.isConnected = false;
    this.listeners = [];
  }

  // Check if wallet is already connected (resume from storage)
  async restoreConnection() {
    try {
      const stored = localStorage.getItem(WALLET_STORAGE_KEY);
      if (stored) {
        const data = JSON.parse(stored);
        // Try to reconnect using stored wallet name
        // Wait for wallet injection to appear (some extensions inject slightly later)
        const provider = await this.waitForCardanoAndDetect(data.walletName, 2000);
        if (provider) {
          try {
            const api = await provider.enable();
            this.connectedWallet = api; // store enabled API
            this.provider = provider;
            this.isConnected = true;
            this._walletName = data.walletName;
            await this.updateWalletInfo();
            this.notifyListeners();
            console.log("Wallet connection restored:", data.walletName);
            return true;
          } catch (err) {
            // enable may prompt or fail; treat as not-restored
            console.warn('Could not silently enable stored wallet:', err);
          }
        }
      }
    } catch (error) {
      console.error("Failed to restore wallet connection:", error);
      localStorage.removeItem(WALLET_STORAGE_KEY);
    }
    return false;
  }

  // Detect available wallet (Lace or other CIP-30 wallets)
  async detectWallet(walletName = "lace") {
    // Safe access: ensure window and window.cardano exist before indexing
    if (typeof window === 'undefined' || !window.cardano) {
      return null;
    }
    const wallet = window.cardano?.[walletName];
    if (!wallet) return null;
    return wallet;
  }

  // Wait until window.cardano exists and then detect the provider by name (timeout in ms)
  async waitForCardanoAndDetect(walletName = 'lace', timeoutMs = 2000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (typeof window !== 'undefined' && window.cardano) {
        const w = this.detectWallet(walletName);
        if (w) return w;
      }
      // small delay
      await new Promise(r => setTimeout(r, 100));
    }
    // final attempt
    return this.detectWallet(walletName);
  }

  // Connect to Lace wallet
  async connectWallet(walletName = "lace") {
    try {
      const wallet = await this.detectWallet(walletName);
      if (!wallet) {
        throw new Error(`Wallet '${walletName}' not available. Please install it.`);
      }

      // Request wallet connection
      const api = await wallet.enable();

      // store provider and enabled API separately
      this.provider = wallet;
      this.connectedWallet = api;
      this.isConnected = true;
      this._walletName = walletName;

      // Store connection info
      localStorage.setItem(WALLET_STORAGE_KEY, JSON.stringify({
        walletName,
        connectedAt: new Date().toISOString()
      }));

      // Get wallet info
      await this.updateWalletInfo();
      this.notifyListeners();

      console.log("Wallet connected successfully:", walletName);
      return {
        success: true,
        walletName,
        address: this.walletAddress
      };
    } catch (error) {
      console.error("Failed to connect wallet:", error);
      this.isConnected = false;
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Disconnect wallet
  disconnectWallet() {
    this.connectedWallet = null;
    this.walletAddress = null;
    this.walletBalance = null;
    this.isConnected = false;
    localStorage.removeItem(WALLET_STORAGE_KEY);
    this.notifyListeners();
    console.log("Wallet disconnected");
  }

  // Update wallet information
  async updateWalletInfo() {
    try {
      if (!this.connectedWallet || !this.isConnected) {
        return;
      }

      // Prefer change address (always available on connected wallets), then fallback.
      let rawAddress = null;
      if (this.connectedWallet.getChangeAddress) {
        rawAddress = await this.connectedWallet.getChangeAddress();
      }
      if (!rawAddress) {
        const addresses = await (this.connectedWallet.getUsedAddresses?.() || this.connectedWallet.getAddresses?.());
        if (addresses && addresses.length > 0) rawAddress = addresses[0];
      }
      this.walletAddress = decodeAddressToBech32(rawAddress);

      // Get balance (some wallets return hex/CBOR; attempt to parse if numeric)
      try {
        const valueHex = await this.connectedWallet.getBalance?.();
        if (valueHex) {
          // Try to coerce to BigInt if it's numeric string
          try {
            const lovelace = BigInt(valueHex);
            this.walletBalance = Number(lovelace) / 1_000_000;
          } catch (e) {
            // Could not parse balance; leave as null
            this.walletBalance = null;
          }
        }
      } catch (e) {
        // ignore balance errors
        this.walletBalance = null;
      }

      this.notifyListeners();
    } catch (error) {
      console.error("Error updating wallet info:", error);
    }
  }

  // Get shortened address for display
  getShortenedAddress() {
    if (!this.walletAddress) return null;
    const addr = typeof this.walletAddress === 'string' ? this.walletAddress : this.walletAddress.toString();
    const start = addr.substring(0, 10);
    const end = addr.substring(addr.length - 5);
    return `${start}...${end}`;
  }

  // Get full address
  getFullAddress() {
    if (!this.walletAddress) return null;
    return typeof this.walletAddress === 'string' ? this.walletAddress : this.walletAddress.toString();
  }

  // Get wallet balance
  getBalance() {
    return this.walletBalance;
  }

  // Subscribe to wallet changes
  onChange(callback) {
    this.listeners.push(callback);
  }

  // Notify all listeners
  notifyListeners() {
    this.listeners.forEach(callback => {
      callback({
        isConnected: this.isConnected,
        address: this.walletAddress,
        shortenedAddress: this.getShortenedAddress(),
        balance: this.walletBalance
      });
    });
  }

  // Get current connection state
  getState() {
    return {
      isConnected: this.isConnected,
      address: this.walletAddress,
      shortenedAddress: this.getShortenedAddress(),
      balance: this.walletBalance
    };
  }
}

// Export singleton instance
const walletManager = new WalletManager();
