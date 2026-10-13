process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');

const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: false });

function httpPost(path, body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = https.request({
      hostname: 'cap.dachain.tech', port: 443,
      path, method: 'POST', agent,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data || ''),
        'Origin': 'https://interstellar.dachain.io',
        'Connection': 'close',
      }
    }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => resolve(JSON.parse(buf)));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function solveOne(c, d, n) {
  const wasmBuf = fs.readFileSync('hashwx.wasm');
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

(async () => {
  // fetch fresh challenge
  const chal = await httpPost('/74e539aa4f/challenge');
  console.log('raw:', JSON.stringify(chal).slice(0, 200));
  if (!chal.token) { console.log('no token, exit'); return; }
  
  const hashwxChallenges = chal.challenges.filter(c => c.protocol === 'hashwx');
  console.log('challenges:', hashwxChallenges.length);

  const solutions = [];
  for (const ch of hashwxChallenges) {
    console.log(`solving c=${ch.payload.c.slice(0,16)}... d=${ch.payload.d} n=${ch.payload.n}`);
    const nonce = await solveOne(ch.payload.c, ch.payload.d, ch.payload.n);
    console.log('nonce:', nonce);
    solutions.push({ nonce: parseInt(nonce) });
  }

  // redeem tanpa instr
  console.log('\nredeeming without instr...');
  const r1 = await httpPost('/74e539aa4f/redeem', { token: chal.token, solutions });
  console.log('result:', JSON.stringify(r1));
})().catch(console.error);
