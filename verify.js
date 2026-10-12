const fs = require('fs');
const buf = fs.readFileSync('hashwx.wasm');
WebAssembly.instantiate(buf).then(async ({instance: w}) => {
  w.exports._initialize();
  const ctx = w.exports.hashwx_alloc(1);
  const seedPtr = w.exports.hashwx_seed(ctx);
  const mem = new Uint8Array(w.exports.memory.buffer);
  const c = 'a31b5e22ffb229f219352daa979cd2543b4af8049fc6b6dce01dcc78a00197d6';

  // raw bytes
  for (let i = 0; i < c.length; i += 2) mem[seedPtr + i/2] = parseInt(c.slice(i, i+2), 16);
  w.exports.hashwx_make(ctx, seedPtr);

  // regenerate sub-wasm SETELAH make dengan seed yang benar
  const modPtr = w.exports.hashwx_module(ctx);
  const modSize = w.exports.hashwx_module_size(ctx);
  const modBytes = new Uint8Array(w.exports.memory.buffer, modPtr, modSize).slice();
  console.log('modSize:', modSize);
  const sub = new WebAssembly.Instance(new WebAssembly.Module(modBytes), {env:{memory:w.exports.memory}});
  const regPtr = w.exports.hashwx_registers(ctx);
  const memPtr = w.exports.hashwx_memory(ctx);
  const target = ((1n << 64n) - 1n) / 362500n;

  for (const n of [275363n, 224451n, 302954n, 421520n]) {
    w.exports.hashwx_exec_begin(ctx, n);
    sub.exports.exec(regPtr, memPtr);
    const r = BigInt.asUintN(64, w.exports.hashwx_exec_final(ctx));
    console.log('nonce:', n.toString(), 'valid:', r <= target, 'r:', r);
  }
});
