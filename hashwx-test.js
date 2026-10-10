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

async function solveHashwx(w, execFn, regPtr, memPtr, ctx, c, d) {
  const target = ((1n << 64n) - 1n) / BigInt(d);

  const seedPtr = w.hashwx_seed(ctx);
  const mem = new Uint8Array(w.memory.buffer);

  // tulis c sebagai raw bytes
  const cBytes = hexToBytes(c);
  mem.set(cBytes, seedPtr);
  w.hashwx_make(ctx, seedPtr);

  let nonce = 0n;
  const start = Date.now();
  while (true) {
    w.hashwx_exec_begin(ctx, nonce);
    execFn(regPtr, memPtr);
    const result = BigInt.asUintN(64, w.hashwx_exec_final(ctx));
    if (result <= target) {
      console.log(`  Solved! nonce=${nonce} in ${Date.now() - start}ms`);
      return nonce.toString();
    }
    nonce++;
    if (nonce % 100000n === 0n) {
      process.stdout.write(`\r  Trying nonce ${nonce}...`);
    }
  }
}

async function main() {
  const w = await loadHashwx();
  console.log('WASM loaded');
  w._initialize();

  const ctx = w.hashwx_alloc(1);
  const regPtr = w.hashwx_registers(ctx);
  const memPtr = w.hashwx_memory(ctx);

  // load compiled sub-wasm
  w.hashwx_make(ctx, w.hashwx_seed(ctx)); // dummy make buat generate module
  const modPtr = w.hashwx_module(ctx);
  const modSize = w.hashwx_module_size(ctx);
  const modBytes = new Uint8Array(w.memory.buffer, modPtr, modSize).slice();
  const subInst = new WebAssembly.Instance(new WebAssembly.Module(modBytes), { env: { memory: w.memory } });
  const execFn = subInst.exports.exec;
  console.log('Sub-wasm loaded');

  // test pakai challenge dari screenshot
  const challenges = [
    { c: 'a31b5e22ffb229f219352daa979cd2543b4af8049fc6b6dce01dcc78a00197d6', d: 362500 },
    { c: 'da21cd9ed4da23c39ebc57e34d7e01266ffb1c1b6187502dbeafdb180e212fc6', d: 362500 },
    { c: '77d4cec2052c912a4edf7e4ed6651273b225b01a54d291dbcd1ed7c2a36143c3', d: 362500 },
    { c: '3e1da8fb272226373c8011f9ca0e2b335528897566956d663d45618bff079752', d: 362500 },
  ];

  for (const ch of challenges) {
    console.log(`Solving c=${ch.c.slice(0,8)}...`);
    const nonce = await solveHashwx(w, execFn, regPtr, memPtr, ctx, ch.c, ch.d);
    console.log('  nonce:', nonce);
  }
}

main().catch(console.error);
