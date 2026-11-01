// Thin LiteSVM adapter shared by the test files.
const { LiteSVM } = require('litesvm');
const kit = require('@solana/kit');
const { PublicKey } = require('@solana/web3.js');

// LiteSVM 1.x speaks @solana/kit; the app speaks @solana/web3.js. This thin adapter lets the
// tests send exactly the transactions the website builds (serialized to wire format).
function makeSvm({ sigverify = true } = {}) {
  const raw = new LiteSVM().withNativeMints().withSigverify(sigverify);
  const A = (pk) => kit.address(new PublicKey(pk).toBase58());
  const dec = kit.getTransactionDecoder();
  return {
    addProgramFromFile: (pk, file) => raw.addProgramFromFile(A(pk), file),
    airdrop: (pk, l) => raw.airdrop(A(pk), kit.lamports(BigInt(l))),
    raw,
    sendTransaction: (tx) => raw.sendTransaction(dec.decode(tx.serialize())),
    sendRaw: (bytes) => raw.sendTransaction(dec.decode(bytes)),
    simulateRaw: (bytes) => raw.simulateTransaction(dec.decode(bytes)),
    latestBlockhash: () => raw.latestBlockhash(),
    expireBlockhash: () => raw.expireBlockhash(),
    getClock: () => raw.getClock(),
    setClock: (c) => raw.setClock(c),
    minimumBalanceForRentExemption: (n) => raw.minimumBalanceForRentExemption(BigInt(n)),
    getAccount(pk) {
      const a = raw.getAccount(A(pk));
      if (!a.exists) return null;
      return { lamports: Number(a.lamports), data: Uint8Array.from(a.data), owner: new PublicKey(a.programAddress), executable: a.executable };
    },
    setAccount(pk, a) {
      raw.setAccount({ address: A(pk), data: Uint8Array.from(a.data), lamports: kit.lamports(BigInt(a.lamports)),
        programAddress: A(a.owner), executable: !!a.executable, space: BigInt(a.data.length) });
    },
  };
}

module.exports = { makeSvm };
