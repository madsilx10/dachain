process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const { ethers } = require('ethers');
const fs = require('fs');
const readline = require('readline');

const BASE_URL = 'https://interstellar.dachain.io';
const CAP_URL = 'https://cap.dachain.tech/74e539aa4f';
const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// ── WASM solver ──────────────────────────────────────────────────────────────
let wasmExports = null;
let subExecFn = null;
let wasmRegPtr = null;
let wasmMemPtr = null;
let wasmCtx = null;

async function initWasm() {
  const buf = fs.readFileSync('hashwx.wasm');
  const { instance } = await WebAssembly.instantiate(buf, {});
  const w = instance.exports;
  w._initialize();
  const ctx = w.hashwx_alloc(1);
  const regPtr = w.hashwx_registers(ctx);
  const memPtr = w.hashwx_memory(ctx);

  // load sub-wasm (butuh dummy make dulu buat generate module)
  const seedPtr = w.hashwx_seed(ctx);
  const mem = new Uint8Array(w.memory.buffer);
  for (let i = 0; i < 32; i++) mem[seedPtr + i] = i + 1;
  w.hashwx_make(ctx, seedPtr);

  const modPtr = w.hashwx_module(ctx);
  const modSize = w.hashwx_module_size(ctx);
  const modBytes = new Uint8Array(w.memory.buffer, modPtr, modSize).slice();
  const subInst = new WebAssembly.Instance(new WebAssembly.Module(modBytes), { env: { memory: w.memory } });

  wasmExports = w;
  subExecFn = subInst.exports.exec;
  wasmRegPtr = regPtr;
  wasmMemPtr = memPtr;
  wasmCtx = ctx;
  console.log('[*] WASM solver ready');
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2)
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return bytes;
}

async function solveHashwx(c, d) {
  const w = wasmExports;
  const target = ((1n << 64n) - 1n) / BigInt(d);
  const seedPtr = w.hashwx_seed(wasmCtx);
  const mem = new Uint8Array(w.memory.buffer);
  mem.set(hexToBytes(c), seedPtr);
  w.hashwx_make(wasmCtx, seedPtr);

  let nonce = 0n;
  while (true) {
    w.hashwx_exec_begin(wasmCtx, nonce);
    subExecFn(wasmRegPtr, wasmMemPtr);
    const result = BigInt.asUintN(64, w.hashwx_exec_final(wasmCtx));
    if (result <= target) return nonce.toString();
    nonce++;
  }
}

// ── Captcha ───────────────────────────────────────────────────────────────────
async function solveCaptcha() {
  // Step 1: dapet challenges
  console.log(`  [cap] fetching challenge...`);
  let chalRes, chalData;
  try {
    chalRes = await fetch(`${CAP_URL}/challenge`, {
      method: 'POST',
      headers: { 'Accept': '*/*', 'Content-Length': '0', 'Origin': BASE_URL, 'Referer': `${BASE_URL}/`, 'User-Agent': UA, 'Connection': 'close' },
      // @ts-ignore
      dispatcher: new (require('undici').Agent)({ allowH2: false }),
    });
    console.log(`  [cap] challenge status: ${chalRes.status}`);
    chalData = await chalRes.json();
  } catch (e) {
    throw new Error(`challenge fetch failed: ${e.message} ${e.cause?.message || ''}`);
  }
  const { token, challenges } = chalData;

  // Step 2: solve tiap hashwx challenge
  const solutions = [];
  for (const ch of challenges) {
    if (ch.protocol === 'hashwx') {
      process.stdout.write(`  [cap] solving hashwx...`);
      const nonce = await solveHashwx(ch.payload.c, ch.payload.d);
      process.stdout.write(` nonce=${nonce}\n`);
      solutions.push({ nonce });
    } else if (ch.protocol === 'instrumentation') {
      // fake instrumentation payload
      solutions.push({
        instr: {
          i: ch.payload.blob.slice(0, 24),
          p: {
            deviceMemory: 8,
            engine: { hasMozInnerScreenX: false, hasChrome: true },
            fontWidths: Array(17).fill(0),
            isExtended: false,
            oscpu: '__undefined',
            outerWH: [360, 640],
            pdfViewerEnabled: false,
            plugins: { length: 0 },
            productSub: '20030107',
            screen: { width: 360, height: 820 },
            tamper: { getParameterWebGL: true, toDataURL: true, getImageData: true, permissionsQuery: true, fnToString: true },
            ua: UA,
            uaData: { mobile: true, brands: [{ brand: 'Mises', version: '141' }, { brand: 'Not?A_Brand', version: '8' }, { brand: 'Chromium', version: '141' }] },
            uaDataPresent: true,
            webdriver: false,
            state: { foi4i963n5sw: 480676, v3sgt65zxvoy: 402523, zoxnl7urwuv8: 977257, pe1mppy2d136: 111445 },
            ts: Date.now(),
            vp: [360, 640],
          },
        },
      });
    }
  }

  // Step 3: redeem
  console.log(`  [cap] redeeming...`);
  let redeemRes, redeemData;
  try {
    redeemRes = await fetch(`${CAP_URL}/redeem`, {
      method: 'POST',
      headers: { 'Accept': '*/*', 'Content-Type': 'application/json', 'Origin': BASE_URL, 'Referer': `${BASE_URL}/`, 'User-Agent': UA, 'Connection': 'close' },
      body: JSON.stringify({ solutions, token }),
      // @ts-ignore
      dispatcher: new (require('undici').Agent)({ allowH2: false }),
    });
    console.log(`  [cap] redeem status: ${redeemRes.status}`);
    redeemData = await redeemRes.json();
    console.log(`  [cap] redeem data:`, JSON.stringify(redeemData).slice(0, 200));
  } catch (e) {
    throw new Error(`redeem fetch failed: ${e.message} ${e.cause?.message || ''}`);
  }
  if (!redeemData.token) throw new Error(`Captcha redeem gagal: ${JSON.stringify(redeemData)}`);
  console.log(`  [cap] token: ${redeemData.token.slice(0, 20)}...`);
  return redeemData.token;
}

// ── SIWE ──────────────────────────────────────────────────────────────────────
function buildSiweMessage(address, nonce) {
  return `interstellar.dachain.io wants you to sign in with your Ethereum account:\n${address}\n\nSign in with Ethereum.\n\nURI: https://interstellar.dachain.io/\nVersion: 1\nChain ID: 1\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
}

// ── Main wallet flow ──────────────────────────────────────────────────────────
async function processWallet(privateKey) {
  const wallet = new ethers.Wallet(privateKey.trim());
  const address = wallet.address;
  console.log(`\n[*] Wallet: ${address}`);

  let cookies = {};

  function parseCookies(headers) {
    const setCookie = headers.getSetCookie?.() || [];
    for (const c of setCookie) {
      const [pair] = c.split(';');
      const [k, v] = pair.split('=');
      if (k && v) cookies[k.trim()] = v.trim();
    }
  }

  function cookieHeader() {
    return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  function getHeaders(extra = {}) {
    return {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Origin': BASE_URL,
      'Referer': `${BASE_URL}/`,
      'User-Agent': UA,
      'Cookie': cookieHeader(),
      ...(cookies['csrftoken'] ? { 'X-Csrftoken': cookies['csrftoken'] } : {}),
      ...extra,
    };
  }

  // [1] Launch
  const launchRes = await fetch(`${BASE_URL}/api/v1/ops/launch/`, { headers: { 'User-Agent': UA } });
  parseCookies(launchRes.headers);
  console.log(`[1] Launch: ${launchRes.status}`);

  // [2] Nonce
  const nonceRes = await fetch(`${BASE_URL}/api/v1/auth/siwe/nonce/`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ signer: address }),
  });
  parseCookies(nonceRes.headers);
  const nonceData = await nonceRes.json();
  if (!nonceData.success) { console.log(`[-] Nonce gagal:`, nonceData.error); return; }
  const nonce = nonceData.data.nonce;
  console.log(`[2] Nonce: ${nonce}`);

  // [3] Sign
  const message = buildSiweMessage(address, nonce);
  const signature = await wallet.signMessage(message);
  console.log(`[3] Signed`);

  // [4] Solve captcha
  console.log(`[4] Solving captcha...`);
  let capToken;
  try {
    capToken = await solveCaptcha();
  } catch (e) {
    console.log(`[-] Captcha gagal:`, e.message);
    return;
  }

  // [5] SIWE login
  const siweRes = await fetch(`${BASE_URL}/api/v1/auth/siwe/`, {
    method: 'POST',
    headers: getHeaders({ 'X-Captcha-Token': capToken }),
    body: JSON.stringify({ message, signature }),
  });
  parseCookies(siweRes.headers);
  const siweData = await siweRes.json();
  console.log(`[5] SIWE: ${siweRes.status}`, siweData.success ? 'OK' : siweData.error);
  if (!siweData.success) return;

  // [6] Gate
  const gateRes = await fetch(`${BASE_URL}/api/v1/launch/gate/`, { headers: getHeaders() });
  const gateData = await gateRes.json();
  console.log(`[6] Gate: admitted=${gateData.data?.admitted} own_code=${gateData.data?.own_code}`);
  if (!gateData.data?.admitted) { console.log(`[-] Belum admitted`); return; }

  // [7] Codes
  const codesRes = await fetch(`${BASE_URL}/api/v1/launch/codes/`, { headers: getHeaders() });
  const codesData = await codesRes.json();
  console.log(`[7] Codes:`, codesData.data?.codes?.map(c => c.code));
}

// ── Menu ──────────────────────────────────────────────────────────────────────
function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(r => rl.question(q, a => { rl.close(); r(a.trim()); }));
}

async function main() {
  await initWasm();

  const keys = fs.readFileSync('wallet.txt', 'utf-8').split('\n').map(l => l.trim()).filter(Boolean);
  console.log(`[*] Total wallet: ${keys.length}`);
  console.log(`\nPilih mode:\n  1. Satu akun\n  2. Semua akun\n  3. Dari index X sampai akhir`);

  const mode = await ask('\nPilihan (1/2/3): ');
  let selected = [];

  if (mode === '1') {
    keys.forEach((k, i) => console.log(`  [${i + 1}] ${new ethers.Wallet(k).address}`));
    const idx = parseInt(await ask('Pilih nomor: ')) - 1;
    if (isNaN(idx) || idx < 0 || idx >= keys.length) { console.log('Index invalid'); process.exit(1); }
    selected = [keys[idx]];
  } else if (mode === '2') {
    selected = keys;
  } else if (mode === '3') {
    const from = parseInt(await ask(`Mulai dari index (1-${keys.length}): `)) - 1;
    if (isNaN(from) || from < 0 || from >= keys.length) { console.log('Index invalid'); process.exit(1); }
    selected = keys.slice(from);
    console.log(`[*] Proses ${selected.length} wallet`);
  } else {
    console.log('Pilihan invalid'); process.exit(1);
  }

  for (const key of selected) {
    try {
      await processWallet(key);
    } catch (e) {
      console.log(`[-] Error:`, e.message);
    }
  }
}

main().catch(console.error);
