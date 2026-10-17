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

const crypto = require('crypto');

async function solveHashwx(c, d, n = 65536) {
  const w = wasmExports;
  const target = ((1n << 64n) - 1n) / BigInt(d);
  const W = BigInt(n);

  const seedPtr = w.hashwx_seed(wasmCtx);
  const mem = new Uint8Array(w.memory.buffer);

  const cBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) cBytes[i] = parseInt(c.slice(2*i, 2*i+2), 16);

  // seed40 = c (32 bytes) || outerIdx (8 bytes LE) — diupdate tiap outer
  const seed40 = new Uint8Array(40);
  seed40.set(cBytes, 0);

  let outerIdx = 0;
  const start = Date.now();

  while (true) {
    // encode outerIdx sebagai little-endian 8 bytes
    let tmp = outerIdx;
    for (let e = 0; e < 8; e++) { seed40[32 + e] = tmp & 0xff; tmp = Math.floor(tmp / 256); }

    // SHA256(c || outerIdx) → seed untuk hashwx_make
    const x = new Uint8Array(crypto.createHash('sha256').update(seed40).digest());
    mem.set(x, seedPtr);
    w.hashwx_make(wasmCtx, seedPtr);

    // async compile sub-wasm — fix hang di Termux (sync WebAssembly.Module bisa ngehang)
    const modPtr = w.hashwx_module(wasmCtx);
    const modSize = w.hashwx_module_size(wasmCtx);
    const modBytes = new Uint8Array(w.memory.buffer, modPtr, modSize).slice();
    const subMod = await WebAssembly.compile(modBytes);
    const subInst = await WebAssembly.instantiate(subMod, { env: { memory: w.memory } });
    const subExec = subInst.exports.exec;

    // inner loop: nonces [outerIdx*n, outerIdx*n + n)
    const base = BigInt(outerIdx) * W;
    for (let inner = 0n; inner < W; inner++) {
      const fullNonce = base + inner;
      w.hashwx_exec_begin(wasmCtx, fullNonce);
      subExec(wasmRegPtr, wasmMemPtr);
      const result = BigInt.asUintN(64, w.hashwx_exec_final(wasmCtx));
      if (result <= target) {
        console.log(` solved in ${Date.now()-start}ms, nonce=${fullNonce} (outer=${outerIdx})`);
        return fullNonce.toString();
      }
    }
    outerIdx++;
    process.stdout.write(`\r  [hashwx] outer=${outerIdx} nonce=${outerIdx * n}...`);
  }
}

// ── HTTP helper (force HTTP/1.1) ──────────────────────────────────────────────
const https = require('https');
const httpsAgent = new https.Agent({ keepAlive: false, rejectUnauthorized: false });

function httpPost(url, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body ? JSON.stringify(body) : '';
    const opts = {
      hostname: u.hostname,
      port: 443,
      path: u.pathname,
      method: 'POST',
      agent: httpsAgent,
      headers: {
        'Accept': '*/*',
        'Origin': BASE_URL,
        'Referer': `${BASE_URL}/`,
        'User-Agent': UA,
        'Connection': 'close',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : { 'Content-Length': '0' }),
        ...headers,
      },
    };
    const req = https.request(opts, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(buf) }); }
        catch (e) { reject(new Error(`JSON parse error: ${buf.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Local HTTP server buat serve iframe script ────────────────────────────────
const http = require('http');
let localServer = null;
let localScriptContent = '';
let localPort = 19876;

function startLocalServer() {
  return new Promise((resolve) => {
    localServer = http.createServer((req, res) => {
      console.log(`  [server] ${req.url}`);
      if (req.url.startsWith('/iframe')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><body><script>${localScriptContent}<\/script></body></html>`);
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><body></body></html>`);
      }
    });
    localServer.listen(localPort, '127.0.0.1', () => resolve());
  });
}

// ── Playwright stealth buat ambil instr ──────────────────────────────────────
let sharedBrowser = null;
let sharedPage = null;

async function initBrowser() {
  if (sharedBrowser) return;
  Object.defineProperty(process, 'platform', { get: () => 'linux' });
  const { chromium } = require('playwright-extra');
  const stealth = require('puppeteer-extra-plugin-stealth')();
  chromium.use(stealth);
  sharedBrowser = await chromium.launch({
    executablePath: '/data/data/com.termux/files/usr/bin/chromium-browser',
    headless: true,
    args: [
      '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
      '--disable-gpu','--single-process',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-web-security',
      '--allow-running-insecure-content',
      '--window-size=360,820',
    ]
  });
  sharedPage = await sharedBrowser.newPage();
  sharedPage.on('console', msg => console.log(`  [browser] ${msg.text()}`));
  // intercept request ke cap.dachain.tech, ganti origin header
  await sharedPage.route('**/cap.dachain.tech/**', async (route) => {
    const req = route.request();
    await route.continue({
      headers: {
        ...req.headers(),
        'origin': 'https://interstellar.dachain.io',
        'referer': 'https://interstellar.dachain.io/',
      }
    });
  });

  await sharedPage.goto(`http://127.0.0.1:${localPort}/parent.html`, { waitUntil: 'domcontentloaded' });
  console.log('[*] Stealth browser ready');
}

async function getInstrViaPlaywright(blob) {
  const page = sharedPage;
  try {
    page.on('console', msg => console.log(`  [browser] ${msg.text()}`));

    // decompress blob di Node.js
    const zlib = require('zlib');
    const raw = Buffer.from(blob, 'base64');
    const script = zlib.inflateRawSync(raw).toString();
    localScriptContent = script;
    console.log(`  [cap] iframe script: ${script.length} bytes`);

    // start local server kalo belum
    if (!localServer) await startLocalServer();

    // buka parent page dari same origin sebagai iframe
    await page.goto(`http://127.0.0.1:${localPort}/parent.html`);

    let resolveInstr;
    const instrPromise = new Promise(res => resolveInstr = res);
    await page.exposeFunction('__onCapInstr', (data) => {
      console.log(`  [node] cap:instr received, blocked=${data.blocked}`);
      resolveInstr(data);
    });

    // debug deteksi bot
    const botChecks = await page.evaluate(() => ({
      webdriver: navigator.webdriver,
      chrome: !!window.chrome,
      plugins: navigator.plugins.length,
      languages: navigator.languages,
      platform: navigator.platform,
      hardwareConcurrency: navigator.hardwareConcurrency,
    }));
    console.log(`  [debug] botChecks:`, JSON.stringify(botChecks));

    await page.evaluate((port) => {
      window.addEventListener('message', (e) => {
        const d = e.data;
        if (d && d.type === 'cap:instr') {
          console.log('cap:instr! blocked=' + d.blocked + ' blockReason=' + d.blockReason + ' hasResult=' + !!d.result);
          window.__onCapInstr({
            blocked: d.blocked || false,
            blockReason: d.blockReason,
            result: d.result,
          });
        }
      });

      const iframe = document.createElement('iframe');
      iframe.src = `http://127.0.0.1:${port}/iframe.html`;
      iframe.style.cssText = 'position:absolute;width:360px;height:640px;top:0;left:0;';
      document.body.appendChild(iframe);
      console.log('iframe appended via src');
    }, localPort);

    const timeoutP = new Promise(res => setTimeout(() => res({ __timeout: true }), 30000));
    const result = await Promise.race([instrPromise, timeoutP]);

    if (result.__timeout || result.blocked) return null;
    return { ...result.result, vp: [360, 640] };

  } catch(e) {
    console.log(`  [cap] instr error:`, e.message);
    return null;
  }
}

// ── Captcha ───────────────────────────────────────────────────────────────────
async function solveCaptcha() {
  const page = sharedPage;

  // Step 1: fetch challenge via browser (biar ga keblok)
  console.log(`  [cap] fetching challenge via browser...`);
  const chalData = await page.evaluate(async ({ capUrl }) => {
    const r = await fetch(`${capUrl}/challenge`, {
      method: 'POST',
      headers: { 'Content-Length': '0', 'Origin': 'https://interstellar.dachain.io' }
    });
    return r.json();
  }, { capUrl: CAP_URL });

  if (!chalData.token) throw new Error(`Challenge gagal: ${JSON.stringify(chalData)}`);
  console.log(`  [cap] challenges: ${chalData.challenges?.length}`);

  const { token, challenges } = chalData;
  const hashwxChallenges = challenges.filter(c => c.protocol === 'hashwx');
  const instrChallenge = challenges.find(c => c.protocol === 'instrumentation');
  // Step 2: instr dulu — iframe script sudah ngitung hashwx solutions di instr.state
  let instr = null;
  if (instrChallenge) {
    console.log(`  [cap] getting instr...`);
    instr = await getInstrViaPlaywright(instrChallenge.payload.blob);
    console.log(`  [cap] instr:`, instr ? 'OK' : 'null');
  }

  // server validasi hashwx dari instr.state, solutions array tidak dikirim
  if (instr && instr.state) {
    console.log(`  [cap] instr.state keys:`, Object.keys(instr.state).length, '→', JSON.stringify(instr.state));
  }

  // Step 4: redeem via browser
  const redeemBody = { token, ...(instr ? { instr } : {}) };
  console.log(`  [dbg] full redeem body:`, JSON.stringify(redeemBody));
  console.log(`  [cap] redeeming via browser...`);
  const redeemData = await page.evaluate(async ({ capUrl, body }) => {
    const r = await fetch(`${capUrl}/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://interstellar.dachain.io' },
      body: JSON.stringify(body)
    });
    return r.json();
  }, { capUrl: CAP_URL, body: redeemBody });

  console.log(`  [cap] redeem:`, JSON.stringify(redeemData).slice(0, 150));
  if (!redeemData.token) throw new Error(`Captcha redeem gagal: ${JSON.stringify(redeemData)}`);
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
  await startLocalServer();
  await initBrowser();

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
