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
  console.log('d value:', d, typeof d);
  const target = ((1n << 64n) - 1n) / BigInt(d);
  console.log('target:', target);

  w._initialize();
  console.log('initialized');
  console.log('memory size:', w.memory.buffer.byteLength);

  let ctx = w.hashwx_alloc(1);
  console.log('ctx (alloc 1):', ctx);
  if (ctx === -1 || ctx === 0) {
    ctx = w.hashwx_alloc(0);
    console.log('ctx (alloc 0):', ctx);
  }
  if (ctx <= 0) throw new Error('hashwx_alloc failed');

  const seedPtr = w.hashwx_seed(ctx);
  console.log('seedPtr:', seedPtr);
  console.log('memory size:', w.memory.buffer.byteLength);

  const mem = new Uint8Array(w.memory.buffer);

  // tulis sebagai string hex (ascii bytes)
  const cStr = c;
  console.log('c string length:', cStr.length);
  for (let i = 0; i < cStr.length; i++) {
    mem[seedPtr + i] = cStr.charCodeAt(i);
  }
  mem[seedPtr + cStr.length] = 0; // null terminate

  console.log('seed written as string, calling hashwx_make...');
  w.hashwx_make(ctx, seedPtr);
  console.log('hashwx_make done');

  let nonce = 0n;
  const start = Date.now();
  while (true) {
    const result = BigInt.asUintN(64, w.hashwx_exec(ctx, nonce));
    if (result <= target) {
      console.log(`Solved! nonce=${nonce} in ${Date.now() - start}ms`);
      return nonce.toString();
    }
    nonce++;
    if (nonce % 100000n === 0n) {
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
