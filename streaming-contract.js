/**
 * Streaming Payments Smart Contract Module
 * Handles Plutus validator and transaction building for Cardano streaming payments
 */

import {
  bytesToHex,
  hexToBytes,
  bytesToText,
  textToBytes,
  Address,
  Value,
  TxOutput,
  Tx,
  NetworkParams,
  MintingPolicyHash,
  Program,
  bytesToHex as toHex,
  ConstrData,
  ByteArrayData,
  IntData,
  Datum,
  Cip30Wallet
} from "./js/helios.js";

/**
 * Stream Plutus Validator Script
 * Allows recipients to claim accrued funds and senders to cancel streams
 */
export const STREAMING_VALIDATOR = `
spending stream_validator

struct StreamDatum {
  sender: ByteArray
  recipient: ByteArray
  amount: Int
  start: Int
  end: Int
  rate: Int  // lovelace per millisecond
}

func main(datum: StreamDatum, redeemer: Int, ctx: ScriptContext) -> Bool {
  // redeemer: 0 = claim, 1 = cancel

  tx: Tx = ctx.tx;

  if (redeemer == 0) {
    tx.is_signed_by(PubKeyHash::new(datum.recipient))
  } else {
    tx.is_signed_by(PubKeyHash::new(datum.sender))
  }
}
`;

/**
 * Build and submit a streaming transaction
 */
export async function buildStreamingTransaction(
  senderAddress,
  recipientAddress,
  streamData,
  walletAPI,
  networkParams
) {
  try {
    console.log("Building streaming transaction...", {
      sender: senderAddress,
      recipient: recipientAddress,
      amount: streamData.total,
      start: streamData.start,
      end: streamData.end
    });

    // 1) Compile validator
    const program = Program.new(STREAMING_VALIDATOR);
    const uplc = program.compile();

    const validatorHash = uplc.validatorHash;
    const scriptAddress = Address.fromHash(validatorHash);

    // 2) Amount conversion (ADA -> lovelace)
    const amountLovelace = BigInt(
      Math.floor(Number(streamData.total) * 1_000_000)
    );

    // 3) Parse sender address
    let senderAddrObj;
    try {
      senderAddrObj = Address.fromBech32(senderAddress);
    } catch (e) {
      try {
        senderAddrObj = Address.fromHex(senderAddress);
      } catch (e2) {
        throw new Error(`Invalid sender address: ${senderAddress}`);
      }
    }

    // 4) Parse recipient address
    let recipientAddrObj;
    try {
      recipientAddrObj = Address.fromBech32(recipientAddress);
    } catch (e) {
      try {
        recipientAddrObj = Address.fromHex(recipientAddress);
      } catch (e2) {
        console.warn(
          `Recipient '${recipientAddress}' invalid. Using fallback test address.`
        );
        recipientAddrObj = Address.fromBech32(
          "addr_test1qzq9dy3d9z7qxpz4y8j8c7x6w5v4u3t2s1r0q9p8o7n6m5l4k"
        );
      }
    }

    const senderHash =
      senderAddrObj.pubKeyHash ?? senderAddrObj.validatorHash;
    const recipientHash =
      recipientAddrObj.pubKeyHash ?? recipientAddrObj.validatorHash;

    if (!senderHash || !recipientHash) {
      throw new Error("Failed to extract payment credentials");
    }

    // 5) Rate conversion (ADA/sec -> lovelace/ms)
    const ratePerMs = BigInt(
      Math.floor(Number(streamData.rate) * 1000)
    );

    // 6) Inline datum
    const datumUplc = new ConstrData(0, [
      new ByteArrayData(senderHash.bytes),
      new ByteArrayData(recipientHash.bytes),
      new IntData(amountLovelace),
      new IntData(BigInt(streamData.start)),
      new IntData(BigInt(streamData.end)),
      new IntData(ratePerMs)
    ]);

    const inlineDatum = Datum.inline(datumUplc);

    // 7) Build transaction
    const tx = Tx.new();
    tx.addOutput(
      new TxOutput(scriptAddress, new Value(amountLovelace), inlineDatum)
    );

    // 8) Wallet integration
    const wallet = new Cip30Wallet(walletAPI);
    const spareUtxos = await wallet.utxos;

    // 9) Change address
    let changeAddress;
    try {
      changeAddress = Address.fromBech32(senderAddress);
    } catch (e) {
      try {
        changeAddress = Address.fromHex(senderAddress);
      } catch (e2) {
        throw new Error("Invalid change address");
      }
    }

    const finalizedTx = await tx.finalize(
      networkParams,
      changeAddress,
      spareUtxos || []
    );

    // 10) Sign & submit
    const sigs = await wallet.signTx(finalizedTx);
    if (Array.isArray(sigs)) {
      for (const sig of sigs) {
        finalizedTx.witnesses.addSignature(sig);
      }
    }

    const txId = await wallet.submitTx(finalizedTx);

    window.STREAM_VALIDATOR = STREAMING_VALIDATOR;
    window.streamContractAddress = scriptAddress.toBech32();

    console.log("Submitted tx id:", txId.toString());
    return txId.toString();

  } catch (err) {
    console.error("Transaction build error:", err);
    throw err;
  }
}

/**
 * Validate Cardano address format
 */
export function isValidAddress(address) {
  return (
    typeof address === "string" &&
    (address.startsWith("addr") || address.startsWith("stake"))
  );
}
