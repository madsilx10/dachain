const fs = require('fs');
const crypto = require('crypto');
const buf = fs.readFileSync('hashwx.wasm');

async function test(label, nonces) {
  const {instance: w} = await WebAssembly.instantiate(buf, {});
  w.exports._initialize();
  const ctx = w.exports.hashwx_alloc(1);
  const seedPtr = w.exports.hashwx_seed(ctx);
  const regPtr = w.exports.hashwx_registers(ctx);
  const memPtr = w.exports.hashwx_memory(ctx);
  const mem = new Uint8Array(w.exports.memory.buffer);

  const modPtr = w.exports.hashwx_module(ctx);
  const modSize = w.exports.hashwx_module_size(ctx);
  const modBytes = new Uint8Array(w.exports.memory.buffer, modPtr, modSize).slice();
  const sub = new WebAssembly.Instance(new WebAssembly.Module(modBytes), {env:{memory:w.exports.memory}});

  const c = 'a31b5e22ffb229f219352daa979cd2543b4af8049fc6b6dce01dcc78a00197d6';
  const d = 362500;
  const target = ((1n << 64n) - 1n) / BigInt(d);

  // c sebagai 32 raw bytes
  const cBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) cBytes[i] = parseInt(c.slice(2*i, 2*i+2), 16);

  for (const nonce of nonces) {
    // seed = cBytes + nonce (8 bytes little-endian)
    const seed40 = new Uint8Array(40);
    seed40.set(cBytes, 0);
    let n = nonce;
    for (let e = 0; e < 8; e++) { seed40[32+e] = n & 0xff; n = Math.floor(n/256); }

    // SHA-256(seed40) → x (32 bytes)
    const x = new Uint8Array(crypto.createHash('sha256').update(seed40).digest());

    // set x ke seedPtr, call hashwx_make
    mem.set(x, seedPtr);
    w.exports.hashwx_make(ctx, seedPtr);

    // exec
    w.exports.hashwx_exec_begin(ctx, BigInt(nonce));
    sub.exports.exec(regPtr, memPtr);
    const result = BigInt.asUintN(64, w.exports.hashwx_exec_final(ctx));
    console.log(`${label} nonce=${nonce}: valid=${result <= target} result=${result.toString().slice(0,10)}`);
  }
}

(async () => {
  await test('sha256+wasm', [275363, 224451, 302954, 421520]);
})();
