const fs = require('fs');

async function loadHashwx() {
  const wasmBuf = fs.readFileSync('hashwx.wasm');
  const { instance } = await WebAssembly.instantiate(wasmBuf, {});
  return instance.exports;
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

async function solveHashwx(w, c, d) {
  const target = ((1n << 64n) - 1n) / BigInt(d);

  // alloc context
  let ctx = w.hashwx_alloc(1);
  if (ctx === -1 || ctx === 0) {
    ctx = w.hashwx_alloc(0);
  }
  if (ctx <= 0) throw new Error('hashwx_alloc failed');

  const seedPtr = w.hashwx_seed(ctx);
  const mem = new Uint8Array(w.memory.buffer);

  // tulis seed dari c (hex string → bytes)
  const cBytes = hexToBytes(c);
  mem.set(cBytes, seedPtr);

  w.hashwx_make(ctx, seedPtr);

  let nonce = 0;
  const start = Date.now();
  while (true) {
    const result = BigInt.asUintN(64, w.hashwx_exec(ctx, nonce));
    if (result <= target) {
      console.log(`Solved! nonce=${nonce} in ${Date.now() - start}ms`);
      return nonce.toString();
    }
    nonce++;
    if (nonce % 100000 === 0) {
      console.log(`Trying nonce ${nonce}...`);
    }
  }
}

async function main() {
  const w = await loadHashwx();
  console.log('WASM loaded');

  // test pakai challenge dari screenshot
  const c = 'a31b5e22ffb229f219352daa979cd2543b4af8049fc6b6dce01dcc78a00197d6';
  const d = 362500;

  const nonce = await solveHashwx(w, c, d);
  console.log('Result nonce:', nonce);
}

main().catch(console.error);
