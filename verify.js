const fs = require('fs');
const buf = fs.readFileSync('hashwx.wasm');

async function test(label, writeSeed) {
  const {instance: w} = await WebAssembly.instantiate(buf, {});
  w.exports._initialize();
  const ctx = w.exports.hashwx_alloc(1);
  const seedPtr = w.exports.hashwx_seed(ctx);
  const mem = new Uint8Array(w.exports.memory.buffer);
  
  writeSeed(mem, seedPtr);
  w.exports.hashwx_make(ctx, seedPtr);
  
  const modPtr = w.exports.hashwx_module(ctx);
  const modSize = w.exports.hashwx_module_size(ctx);
  const modBytes = new Uint8Array(w.exports.memory.buffer, modPtr, modSize).slice();
  const sub = new WebAssembly.Instance(new WebAssembly.Module(modBytes), {env:{memory:w.exports.memory}});
  const regPtr = w.exports.hashwx_registers(ctx);
  const memPtr = w.exports.hashwx_memory(ctx);
  const target = ((1n << 64n) - 1n) / 362500n;
  
  const n = 275363n;
  w.exports.hashwx_exec_begin(ctx, n);
  sub.exports.exec(regPtr, memPtr);
  const r = BigInt.asUintN(64, w.exports.hashwx_exec_final(ctx));
  console.log(label, ':', r <= target ? 'VALID!' : 'invalid', r.toString().slice(0,8));
}

const c = 'a31b5e22ffb229f219352daa979cd2543b4af8049fc6b6dce01dcc78a00197d6';

(async () => {
  // cara 1: raw bytes
  await test('raw bytes', (mem, p) => {
    for (let i = 0; i < c.length; i += 2) mem[p + i/2] = parseInt(c.slice(i, i+2), 16);
  });
  
  // cara 2: ascii string
  await test('ascii string', (mem, p) => {
    for (let i = 0; i < c.length; i++) mem[p+i] = c.charCodeAt(i);
    mem[p+c.length] = 0;
  });
  
  // cara 3: raw bytes + null terminate
  await test('raw bytes + null', (mem, p) => {
    for (let i = 0; i < c.length; i += 2) mem[p + i/2] = parseInt(c.slice(i, i+2), 16);
    mem[p + c.length/2] = 0;
  });

  // cara 4: hashwx_make dipanggil dengan ptr ke ascii, bukan seedPtr
  await test('make with alloc ptr', (mem, p) => {
    for (let i = 0; i < c.length; i++) mem[p+i] = c.charCodeAt(i);
  });

  // cara 5: uppercase hex
  await test('uppercase ascii', (mem, p) => {
    const cu = c.toUpperCase();
    for (let i = 0; i < cu.length; i++) mem[p+i] = cu.charCodeAt(i);
    mem[p+cu.length] = 0;
  });
})();
