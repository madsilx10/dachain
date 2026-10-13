const crypto = require('crypto');
const fs = require('fs');

async function solveHashwx(c, d, n, wasmBuf) {
  const { instance: w } = await WebAssembly.instantiate(wasmBuf, {});
  w.exports._initialize();
  const ctx = w.exports.hashwx_alloc(1);
  const seedPtr = w.exports.hashwx_seed(ctx);
  const regPtr = w.exports.hashwx_registers(ctx);
  const memPtr = w.exports.hashwx_memory(ctx);
  const mem = new Uint8Array(w.exports.memory.buffer);
  const target = ((1n << 64n) - 1n) / BigInt(d);
  const W = BigInt(n);

  const cBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) cBytes[i] = parseInt(c.slice(2*i, 2*i+2), 16);
  const seed40 = new Uint8Array(40);
  seed40.set(cBytes, 0);

  let outerIdx = 0;
  while (true) {
    let tmp = outerIdx;
    for (let e = 0; e < 8; e++) { seed40[32+e] = tmp & 0xff; tmp = Math.floor(tmp/256); }
    const x = new Uint8Array(crypto.createHash('sha256').update(seed40).digest());
    mem.set(x, seedPtr);
    w.exports.hashwx_make(ctx, seedPtr);

    const modPtr = w.exports.hashwx_module(ctx);
    const modSize = w.exports.hashwx_module_size(ctx);
    const modBytes = new Uint8Array(w.exports.memory.buffer, modPtr, modSize).slice();
    const subExec = new WebAssembly.Instance(new WebAssembly.Module(modBytes), { env: { memory: w.exports.memory } }).exports.exec;

    const base = BigInt(outerIdx) * W;
    for (let inner = 0n; inner < W; inner++) {
      const fullNonce = base + inner;
      w.exports.hashwx_exec_begin(ctx, fullNonce);
      subExec(regPtr, memPtr);
      const result = BigInt.asUintN(64, w.exports.hashwx_exec_final(ctx));
      if (result <= target) return fullNonce.toString();
    }
    outerIdx++;
  }
}

// verify nonce dari browser
async function verify(c, d, n, expectedNonce, wasmBuf) {
  const { instance: w } = await WebAssembly.instantiate(wasmBuf, {});
  w.exports._initialize();
  const ctx = w.exports.hashwx_alloc(1);
  const seedPtr = w.exports.hashwx_seed(ctx);
  const regPtr = w.exports.hashwx_registers(ctx);
  const memPtr = w.exports.hashwx_memory(ctx);
  const mem = new Uint8Array(w.exports.memory.buffer);
  const target = ((1n << 64n) - 1n) / BigInt(d);
  const W = BigInt(n);

  const cBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) cBytes[i] = parseInt(c.slice(2*i, 2*i+2), 16);
  const seed40 = new Uint8Array(40);
  seed40.set(cBytes, 0);

  const outerIdx = Math.floor(expectedNonce / n);
  let tmp = outerIdx;
  for (let e = 0; e < 8; e++) { seed40[32+e] = tmp & 0xff; tmp = Math.floor(tmp/256); }
  const x = new Uint8Array(crypto.createHash('sha256').update(seed40).digest());
  mem.set(x, seedPtr);
  w.exports.hashwx_make(ctx, seedPtr);

  const modPtr = w.exports.hashwx_module(ctx);
  const modSize = w.exports.hashwx_module_size(ctx);
  const modBytes = new Uint8Array(w.exports.memory.buffer, modPtr, modSize).slice();
  const subExec = new WebAssembly.Instance(new WebAssembly.Module(modBytes), { env: { memory: w.exports.memory } }).exports.exec;

  const fullNonce = BigInt(expectedNonce);
  w.exports.hashwx_exec_begin(ctx, fullNonce);
  subExec(regPtr, memPtr);
  const result = BigInt.asUintN(64, w.exports.hashwx_exec_final(ctx));
  return { valid: result <= target, result };
}

(async () => {
  const wasmBuf = fs.readFileSync('hashwx.wasm');
  const challenges = [
    { c: '8be43d390fbf42420235de8fa6f66c6ef11f62e4834ba9ee5ab7d62825ba919c', d: 362500, n: 65536 },
    { c: '3ea6422e047b001e0fa23e21902122c86ffd2bf4db9fe26b485f85a0faf5e18e', d: 362500, n: 65536 },
    { c: '78287bc745cba9a6af9ffdfeccf28269ba12794082503d460cec65acb53164dc', d: 362500, n: 65536 },
    { c: '057482770f33f6185c18585f235a0ec87be4962fe6ac025f26381acc74c7296c', d: 362500, n: 65536 },
  ];
  const expectedNonces = [494114, 281321, 407971, 354805];

  console.log('=== VERIFY browser nonces ===');
  for (let i = 0; i < challenges.length; i++) {
    const { c, d, n } = challenges[i];
    const r = await verify(c, d, n, expectedNonces[i], wasmBuf);
    console.log(`CH${i} nonce=${expectedNonces[i]}: valid=${r.valid} result=${r.result.toString().slice(0,12)}`);
  }

  console.log('\n=== SOLVE with our algo ===');
  for (let i = 0; i < challenges.length; i++) {
    const { c, d, n } = challenges[i];
    const nonce = await solveHashwx(c, d, n, wasmBuf);
    console.log(`CH${i}: nonce=${nonce} expected=${expectedNonces[i]} match=${nonce==expectedNonces[i]}`);
  }
})();
