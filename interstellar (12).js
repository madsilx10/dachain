process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const { ethers } = require('ethers');
const fs = require('fs');
const readline = require('readline');
const { execFileSync } = require('child_process');

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
        return fullNonce.toString();
      }
    }
    outerIdx++;
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
let instrResolver = null;

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
  sharedPage.on('console', msg => { const t = msg.text(); if (!/^\s*(Error: x|X: x|at\s)/.test(t) && !t.includes('WebGPU')) console.log(`  [browser] ${t}`); });
  // exposeFunction cuma bisa didaftarkan SEKALI per page. Sebelumnya didaftar
  // di tiap getInstrViaPlaywright() — captcha ke-2 (daily) throw
  // "already registered" -> instr null -> daily gagal. Daftar sekali di sini,
  // resolver-nya diganti tiap panggilan.
  await sharedPage.exposeFunction('__onCapInstr', (data) => {
    if (instrResolver) instrResolver(data);
  });
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
    // (tidak pasang listener console kedua di sini — sudah ada di initBrowser,
    //  kalau dipasang lagi tiap baris [browser] muncul 2x)
    // decompress blob di Node.js
    const zlib = require('zlib');
    const raw = Buffer.from(blob, 'base64');
    const script = zlib.inflateRawSync(raw).toString();
    localScriptContent = script;

    // start local server kalo belum
    if (!localServer) await startLocalServer();

    // buka parent page dari same origin sebagai iframe
    await page.goto(`http://127.0.0.1:${localPort}/parent.html`);

    let resolveInstr;
    const instrPromise = new Promise(res => resolveInstr = res);
    instrResolver = resolveInstr;

    // debug deteksi bot
    const botChecks = await page.evaluate(() => ({
      webdriver: navigator.webdriver,
      chrome: !!window.chrome,
      plugins: navigator.plugins.length,
      languages: navigator.languages,
      platform: navigator.platform,
      hardwareConcurrency: navigator.hardwareConcurrency,
    }));
    // botChecks tidak di-log lagi (isinya panjang, cuma buat debug)

    await page.evaluate((port) => {
      window.addEventListener('message', (e) => {
        const d = e.data;
        if (d && d.type === 'cap:instr') {
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
    }, localPort);

    const timeoutP = new Promise(res => setTimeout(() => res({ __timeout: true }), 30000));
    const result = await Promise.race([instrPromise, timeoutP]);
    instrResolver = null;

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
  console.log(`  [cap] solving captcha...`);
  const chalData = await page.evaluate(async ({ capUrl }) => {
    const r = await fetch(`${capUrl}/challenge`, {
      method: 'POST',
      headers: { 'Content-Length': '0', 'Origin': 'https://interstellar.dachain.io' }
    });
    return r.json();
  }, { capUrl: CAP_URL });

  if (!chalData.token) throw new Error(`Challenge gagal: ${JSON.stringify(chalData)}`);

  const { token, challenges } = chalData;
  const instrChallenge = challenges.find(c => c.protocol === 'instrumentation');
  // Step 2: instr dulu
  let instr = null;
  if (instrChallenge) {
    instr = await getInstrViaPlaywright(instrChallenge.payload.blob);
  }


  // Step 3: solve tiap hashwx, susun solutions SEURUTAN challenge (format Cap v2:
  // solutions[i] = {nonce} untuk hashwx, {instr} untuk instrumentation).
  // Sebelumnya skrip ini TIDAK PERNAH memanggil solveHashwx() dan redeem
  // cuma kirim {token, instr} — makanya server balas 400 "Missing required fields".
  const solutions = new Array(challenges.length);
  for (let i = 0; i < challenges.length; i++) {
    const ch = challenges[i];
    if (ch.protocol === 'hashwx') {
      const { c, d, n } = ch.payload;
      const nonce = await solveHashwx(c, d, n);
      solutions[i] = { nonce };
    } else if (ch.protocol === 'instrumentation') {
      if (!instr) throw new Error('Instr gagal / null');
      solutions[i] = { instr };
    } else {
      throw new Error(`Protocol challenge tidak didukung: ${ch.protocol}`);
    }
  }

  // Step 4: redeem via browser — Cap v2 minta {token, solutions}, BUKAN {token, instr}
  const redeemBody = { token, solutions };
  const redeemData = await page.evaluate(async ({ capUrl, body }) => {
    const r = await fetch(`${capUrl}/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://interstellar.dachain.io' },
      body: JSON.stringify(body)
    });
    return r.json();
  }, { capUrl: CAP_URL, body: redeemBody });

  if (!redeemData.token) throw new Error(`Captcha redeem gagal: ${JSON.stringify(redeemData)}`);
  return redeemData.token;
}

// ── SIWE ──────────────────────────────────────────────────────────────────────
// Chain ID 21892 = DAC Quantum Chain mainnet — dari bundle situs sendiri
// (VITE_DAC_CHAIN_ID:`21892`, VITE_DAC_RPC_URL:`https://rpc.dachain.tech`).
// Sebelumnya 1 (Ethereum) -> server balas 400 CHAIN_MISMATCH.
// Template pesan DISAMAKAN PERSIS dengan situs (fungsi MY di bundle situs):
// statement "Sign in to Interstellar. Your wallet is your identity."
// (bukan "Sign in with Ethereum."), dan ADA "Expiration Time: Issued At + 600 detik".
// Pesan lama tidak punya Expiration Time sama sekali -> server menganggap
// pesan sudah kedaluwarsa (MESSAGE_EXPIRED) walau nonce + sign masih segar.
// Format waktu tanpa milidetik, seperti NY()/PY() di situs.
// issuedAt: pakai jam SERVER (dari header Date respons nonce), bukan jam HP.
function buildSiweMessage(address, nonce, issuedAt) {
  const base = issuedAt ? new Date(issuedAt) : new Date();
  const fmt = d => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const at = fmt(base);
  const exp = fmt(new Date(base.getTime() + 600 * 1000));
  return `interstellar.dachain.io wants you to sign in with your Ethereum account:\n${address}\n\nSign in to Interstellar. Your wallet is your identity.\n\nURI: https://interstellar.dachain.io/\nVersion: 1\nChain ID: 21892\nNonce: ${nonce}\nIssued At: ${at}\nExpiration Time: ${exp}`;
}

// ── Main wallet flow ──────────────────────────────────────────────────────────
async function processWallet(privateKey, mode = 'connect', idx = 1, total = 1) {
  const wallet = new ethers.Wallet(privateKey.trim());
  const address = wallet.address;
  console.log(`\n===== Wallet ${idx}/${total} : ${address} =====`);

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

  // Helper API post-login (base /api/v1). cap = token captcha segar (dibutuhkan
  // check-in + redeem kode; buka crate + attempt task tidak butuh captcha).
  async function api(path, { method = 'GET', body, cap } = {}) {
    const res = await fetch(`${BASE_URL}/api/v1${path}`, {
      method,
      headers: getHeaders(cap ? { 'X-Captcha-Token': cap } : {}),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    parseCookies(res.headers);
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  // ── Sesi tersimpan ────────────────────────────────────────────────────────
  // Setelah login pertama, cookie sesi disimpan ke session-<address>.json.
  // Run berikutnya: kalau sesi masih valid, login [1]-[5] (captcha + sign)
  // di-skip — daily tinggal daily, crate tinggal crate. Kalau sesi sudah
  // kedaluwarsa (401), otomatis login ulang. Daily tetap butuh captcha segar
  // tiap kali (aturan situs); buka crate tidak butuh captcha.
  const sessionFile = `session-${address}.json`;
  function saveSession() {
    try { fs.writeFileSync(sessionFile, JSON.stringify(cookies)); } catch (e) {}
  }
  async function trySavedSession() {
    try {
      const saved = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
      if (!saved || typeof saved !== 'object') return false;
      cookies = saved;
      const chk = await fetch(`${BASE_URL}/api/v1/launch/gate/`, { headers: getHeaders() });
      const d = await chk.json().catch(() => ({}));
      if (!(chk.status === 200 && d.success === true)) return false;
      // refresh cookie (mis. csrftoken) lewat launch, sesi tetap dipakai
      const lr = await fetch(`${BASE_URL}/api/v1/ops/launch/`, { headers: getHeaders() });
      parseCookies(lr.headers);
      saveSession();
      return true;
    } catch (e) { return false; }
  }

  // Coba sesi tersimpan dulu — kalau masih valid, skip login [1]-[5].
  let loggedIn = false;
  if (await trySavedSession()) { loggedIn = true; console.log(`[*] Sesi tersimpan masih valid, skip login`); }
  if (!loggedIn) {
  // [1] Launch
  const launchRes = await fetch(`${BASE_URL}/api/v1/ops/launch/`, { headers: { 'User-Agent': UA } });
  parseCookies(launchRes.headers);
  console.log(`[1] Launch: ${launchRes.status}`);

  // [2] Solve captcha DULU — captcha tidak butuh nonce, dan token captcha
  // tahan ~20 menit, jadi aman dikerjakan duluan.
  console.log(`[2] Solving captcha...`);
  let capToken;
  try {
    capToken = await solveCaptcha();
  } catch (e) {
    console.log(`[-] Captcha gagal:`, e.message);
    return;
  }

  // [3] Nonce — diambil SETELAH captcha, jadi nonce + pesan SIWE masih segar
  // pas POST (sebelumnya nonce diambil dulu, captcha ~20 detik, nonce keburu expired).
  const nonceRes = await fetch(`${BASE_URL}/api/v1/auth/siwe/nonce/`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ signer: address }),
  });
  parseCookies(nonceRes.headers);
  const nonceData = await nonceRes.json();
  if (!nonceData.success) { console.log(`[-] Nonce gagal:`, nonceData.error); return; }
  const nonce = nonceData.data.nonce;
  // Jam server dari header Date respons nonce (bukti kalau jam HP meleset)
  const serverDate = nonceRes.headers.get('date');
  const serverIssuedAt = serverDate ? new Date(serverDate).toISOString() : null;

  // [4] Sign — langsung sebelum POST, jadi Issued At masih segar
  const message = buildSiweMessage(address, nonce, serverIssuedAt);
  const signature = await wallet.signMessage(message);
  console.log(`[4] Signed`);

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
  saveSession();
  } // <-- tutup if (!loggedIn): sesi tersimpan mulai run berikutnya

  // [6] Gate
  const gateRes = await fetch(`${BASE_URL}/api/v1/launch/gate/`, { headers: getHeaders() });
  const gateData = await gateRes.json();
  const admitted = !!gateData.data?.admitted;
  console.log(`[6] Gate: admitted=${admitted} own_code=${gateData.data?.own_code}`);

  // [7] Codes (cuma kalau admitted)
  if (admitted) {
    const codesRes = await fetch(`${BASE_URL}/api/v1/launch/codes/`, { headers: getHeaders() });
    const codesData = await codesRes.json();
    console.log(`[7] Codes:`, codesData.data?.codes?.map(c => c.code));
  }

  // ── Mode actions (jalan setelah login) ────────────────────────────────────
  async function doDaily() {
    try {
      const s = await api('/checkin/');
      const d = s.data?.data ?? {};
      const done = d.checked_in ?? d.checkedIn ?? d.today?.checked_in ?? d.claimed ?? false;
      console.log(`[daily] streak=${d.streak ?? 0}, sudah check-in: ${done}`);
      if (done) { console.log(`[daily] sudah check-in hari ini`); return; }
      console.log(`[daily] check-in (captcha baru)...`);
      const cap = await solveCaptcha();
      const r = await api('/checkin/', { method: 'POST', body: {}, cap });
      const rd = r.data?.data ?? {};
      console.log(`[daily] ${r.status}`, r.data?.success ? `OK +${rd.daily_reward ?? ''} QE streak=${rd.streak ?? ''}` : (r.data?.error?.message || r.data?.error || ''));
    } catch (e) { console.log(`[daily] gagal:`, e.message); }
  }

  // Ringkasan hasil open: reward + state baru, biar ketahuan kalau server
  // cuma balas OK tapi crate tidak berubah.
  function openSummary(r) {
    if (!r.data?.success) return r.data?.error?.message || r.data?.error || '';
    const d = r.data?.data ?? {};
    const bits = ['OK'];
    if (d.reward_qe != null) bits.push(`+${d.reward_qe} QE`);
    if (d.award_qe != null) bits.push(`+${d.award_qe} QE`);
    if (d.state) bits.push(`state=${d.state}`);
    if (d.opening) bits.push(`opening=${typeof d.opening === 'string' ? d.opening : (d.opening.id ?? d.opening.public_id ?? '')}`);
    return bits.join(' ');
  }

  async function doCrates() {
    try {
      const s = await api('/crates/');
      const list = s.data?.data?.crates ?? s.data?.data ?? [];
      const arr = Array.isArray(list) ? list : [];
      console.log(`[crate] total: ${arr.length}`);
      for (const c of arr) console.log(`  - ${c.id ?? c.slug ?? c.key} kind=${c.kind ?? c.type} cost=${c.cost ?? c.price ?? 0} state=${c.state ?? c.status} purge=${c.purge_after ?? '-'}`);
      // Daily Base Crate: ada limit harian (remaining/limit) dan tiap open
      // motong QE (field cost di objek daily). Buka semua sisa hari ini,
      // berhenti kalau server nolak (limit habis / QE kurang).
      const daily = s.data?.data?.daily ?? null;
      let remaining = daily?.remaining ?? 1;
      if (daily) console.log(`[crate] daily: cost=${daily.cost ?? '?'} QE, sisa ${remaining}/${daily.limit ?? '?'} hari ini`);
      for (let i = 0; i < 10 && remaining > 0; i++) {
        const d = await api('/crates/daily/open/', { method: 'POST' });
        console.log(`[crate] daily #${i + 1}: ${d.status}`, openSummary(d));
        if (d.status !== 200 || !d.data?.success) break;
        remaining = d.data?.data?.remaining ?? (remaining - 1);
      }
      let n = 0;
      for (const c of arr) {
        if (n >= 3) break;
        const cost = c.cost ?? c.price ?? 0;
        const state = c.state ?? c.status;
        const id = c.id ?? c.slug ?? c.key;
        if (!id || cost > 0) continue; // gratis saja, yang berbayar di-skip
        // Aturan situs (SX): hanya state 'ready' DAN purge_after null.
        // 'opened'/'open' tidak ikut — buka ulang crate yang sudah kebuka
        // cuma dibalas 200 OK tanpa perubahan.
        if (state !== 'ready' || c.purge_after != null) continue;
        const r = await api(`/crates/${id}/open/`, { method: 'POST' });
        console.log(`[crate] ${id}: ${r.status}`, openSummary(r));
        if (r.status === 200 && r.data?.success) n++;
      }
      // Cek ulang: berapa yang masih ready — bukti beneran kebuka atau tidak.
      const s2 = await api('/crates/');
      const list2 = s2.data?.data?.crates ?? s2.data?.data ?? [];
      const arr2 = Array.isArray(list2) ? list2 : [];
      const readyNow = arr2.filter(c => (c.state ?? c.status) === 'ready' && c.purge_after == null).length;
      console.log(`[crate] dibuka: ${n} (gratis, max 3), masih ready: ${readyNow}`);
    } catch (e) { console.log(`[crate] gagal:`, e.message); }
  }

  async function doTasks() {
    try {
      const s = await api('/launch/tasks/');
      const tasks = s.data?.data?.tasks ?? s.data?.data ?? [];
      const arr = Array.isArray(tasks) ? tasks : [];
      console.log(`[tasks] total: ${arr.length}`);
      for (const t of arr) console.log(`  - ${t.slug ?? t.id} status=${t.status ?? t.state} reward_qe=${t.reward_qe ?? '-'} cost=${t.cost ?? t.price ?? 0} free=${t.free ?? '-'}`);
      for (const t of arr) {
        const slug = t.slug ?? t.id;
        const st = String(t.status ?? t.state ?? '').toLowerCase();
        if (!slug || /complete|claim|done|locked/.test(st)) continue;
        const cost = t.cost ?? t.price ?? 0;
        if (cost > 0 && !t.free) continue; // berbayar di-skip
        try {
          const r = await api(`/launch/tasks/${slug}/attempt/`, { method: 'POST', body: {} });
          console.log(`[tasks] ${slug}: ${r.status}`, r.data?.success ? 'OK' : (r.data?.error?.message || r.data?.error || ''));
        } catch (e) { console.log(`[tasks] ${slug} gagal:`, e.message); }
      }
    } catch (e) { console.log(`[tasks] gagal:`, e.message); }
  }

  // Campaign partner (nodiens-crate): claim semua task yang belum done
  // (POST /partners/campaigns/{slug}/tasks/{id}/claim/ {complete:true}),
  // lalu open crate campaign (POST .../open/, tanpa body). Open cuma 1x
  // per hari dan butuh semua task done (unlocked) — server yang nolak
  // kalau belum, hasilnya dicetak apa adanya.
  async function doCampaign(slug = 'nodiens-crate') {
    try {
      const cs = await api('/partners/campaigns/');
      const campaigns = cs.data?.data?.campaigns ?? cs.data?.campaigns ?? [];
      const camp = (Array.isArray(campaigns) ? campaigns : []).find(c => c.slug === slug);
      if (!camp) { console.log(`[nodiens] campaign ${slug} tidak ketemu`); return; }
      const tasks = camp.tasks ?? [];
      console.log(`[nodiens] ${slug}: ${tasks.length} task`);
      const ms = await api('/partners/campaigns/me/');
      const mine = (ms.data?.data?.campaigns ?? ms.data?.campaigns ?? []).find(c => c.slug === slug);
      const entries = mine?.entries ?? [];
      const doneActs = new Set(entries.filter(e => e.status === 'completed' || e.state === 'done').map(e => e.activity));
      for (const t of tasks) {
        const act = t.activity?.slug ?? t.activity;
        const done = !!(act && doneActs.has(act));
        console.log(`  - task ${t.id} ${act ?? ''}${done ? ' (sudah)' : ''}`);
        if (done) continue;
        const r = await api(`/partners/campaigns/${slug}/tasks/${t.id}/claim/`, { method: 'POST', body: { complete: true } });
        const rd = r.data?.data ?? {};
        console.log(`[nodiens] task ${t.id}: ${r.status}`, r.data?.success ? `OK +${rd.reward_final ?? ''}` : (r.data?.error?.message || r.data?.error || ''));
      }
      const o = await api(`/partners/campaigns/${slug}/open/`, { method: 'POST' });
      const od = o.data?.data ?? {};
      console.log(`[nodiens] open: ${o.status}`, o.data?.success ? `state=${od.state ?? ''} +${od.consolation_qe ?? od.amount ?? ''} ${od.amount != null ? (od.symbol ?? '') : 'QE'}` : (o.data?.error?.message || o.data?.error || ''));
    } catch (e) { console.log(`[nodiens] gagal:`, e.message); }
  }

  // Campaign Blockrium (blockrium-crate-2): claim semua task + open crate.
  // Task X/link = klik saja (self-declared, claim langsung). Task Telegram:
  // kalau claim ditolak VERIFICATION_NOT_MET (belum connect), jalanin flow
  // connect: POST /auth/social/telegram/start/ -> token bot @dac_agent ->
  // helper interstellar_tg.py (start bot + join grup) -> claim ulang.
  async function connectTelegram(group) {
    try {
      const s = await api('/auth/social/telegram/start/', { method: 'POST', body: {} });
      const url = s.data?.data?.authorization_url || '';
      const token = (url.split('start=')[1] || '').trim();
      if (!token) { console.log(`[blockrium] connect telegram: token tidak ada (${s.status})`); return false; }
      console.log(`[blockrium] connect telegram via bot @dac_agent...`);
      const out = execFileSync('python3', ['interstellar_tg.py', token, group], { encoding: 'utf-8', timeout: 180000 });
      out.split('\n').filter(Boolean).forEach(l => console.log('  ' + l));
      return true;
    } catch (e) {
      const so = (e.stdout || '').toString();
      if (so) so.split('\n').filter(Boolean).forEach(l => console.log('  ' + l));
      console.log(`[blockrium] helper telegram gagal: ${e.message}`);
      return false;
    }
  }

  async function doBlockrium() {
    const slug = 'blockrium-crate-2';
    try {
      const cs = await api('/partners/campaigns/');
      const campaigns = cs.data?.data?.campaigns ?? cs.data?.campaigns ?? [];
      const camp = (Array.isArray(campaigns) ? campaigns : []).find(c => c.slug === slug);
      if (!camp) { console.log(`[blockrium] campaign ${slug} tidak ketemu`); return; }
      const tasks = camp.tasks ?? [];
      console.log(`[blockrium] ${slug}: ${tasks.length} task, status=${camp.status}`);
      const ms = await api('/partners/campaigns/me/');
      const mine = (ms.data?.data?.campaigns ?? ms.data?.campaigns ?? []).find(c => c.slug === slug);
      const entries = mine?.entries ?? [];
      const doneActs = new Set(entries.filter(e => e.status === 'completed' || e.state === 'done').map(e => e.activity));
      for (const t of tasks) {
        const act = t.activity?.slug ?? t.activity;
        const done = !!(act && doneActs.has(act));
        console.log(`  - task ${t.id} ${t.title}${done ? ' (sudah)' : ''}`);
        if (done) continue;
        let r = await api(`/partners/campaigns/${slug}/tasks/${t.id}/claim/`, { method: 'POST', body: { complete: true } });
        if (!r.data?.success && t.kind === 'telegram') {
          const group = (t.activity?.display?.url || 'https://t.me/blockrium').replace('https://t.me/', '');
          const ok = await connectTelegram(group);
          if (ok) {
            await new Promise(res => setTimeout(res, 3000));
            r = await api(`/partners/campaigns/${slug}/tasks/${t.id}/claim/`, { method: 'POST', body: { complete: true } });
          }
        }
        const rd = r.data?.data ?? {};
        console.log(`[blockrium] task ${t.id}: ${r.status}`, r.data?.success ? `OK +${rd.reward_final ?? ''}` : (r.data?.error?.message || r.data?.error || ''));
      }
      const o = await api(`/partners/campaigns/${slug}/open/`, { method: 'POST' });
      const od = o.data?.data ?? {};
      console.log(`[blockrium] open: ${o.status}`, o.data?.success ? `state=${od.state ?? ''} +${od.consolation_qe ?? od.amount ?? ''} ${od.amount != null ? (od.symbol ?? '') : 'QE'}` : (o.data?.error?.message || o.data?.error || ''));
    } catch (e) { console.log(`[blockrium] gagal:`, e.message); }
  }

  // ── Dispatch mode ─────────────────────────────────────────────────────────
  if (mode === 'kode') {
    if (admitted) { console.log(`[*] Sudah admitted, kode tidak perlu`); return; }
    let code = '';
    try { code = fs.readFileSync('code.txt', 'utf-8').trim(); } catch (e) {}
    if (!code) code = await ask('Launch code: ');
    console.log(`[*] Redeem kode (captcha baru)...`);
    const cap2 = await solveCaptcha();
    const r = await api('/launch/gate/', { method: 'POST', body: { code }, cap: cap2 });
    console.log(`[kode] ${r.status}`, r.data?.success ? 'OK' : (r.data?.error?.message || r.data?.error || ''));
    const g2 = await api('/launch/gate/');
    console.log(`[6b] Gate: admitted=${g2.data?.data?.admitted}`);
    saveSession();
    return;
  }
  if (!admitted) { console.log(`[-] Belum admitted — pakai mode 4 (kode) dulu`); return; }
  if (mode === 'daily' || mode === 'semua') await doDaily();
  if (mode === 'crate' || mode === 'semua') await doCrates();
  if (mode === 'tasks' || mode === 'semua') await doTasks();
  if (mode === 'nodiens' || mode === 'semua') await doCampaign();
  if (mode === 'blockrium' || mode === 'semua') await doBlockrium();
  saveSession();
}

// ── Menu ──────────────────────────────────────────────────────────────────────
function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(r => rl.question(q, a => { rl.close(); r(a.trim()); }));
}

// ── Menu mode ───────────────────────────────────────────────────────────────
const MODES = { '1': 'daily', '2': 'crate', '3': 'tasks', '4': 'kode', '5': 'semua', '6': 'nodiens', '7': 'blockrium',
  'daily': 'daily', 'crate': 'crate', 'tasks': 'tasks', 'kode': 'kode', 'semua': 'semua', 'nodiens': 'nodiens', 'blockrium': 'blockrium', 'connect': 'connect' };

async function pickMode() {
  const arg = (process.argv[2] || '').toLowerCase();
  if (MODES[arg]) return MODES[arg];
  console.log(`\nPilih mode:\n  1 daily (check-in)\n  2 crate (buka crate gratis + daily)\n  3 tasks (board + kerjakan yg free)\n  4 kode (redeem launch code)\n  5 semua (daily + crate + tasks + nodiens + blockrium)\n  6 nodiens (campaign: claim task + open crate)\n  7 blockrium (campaign: claim task + connect telegram + open crate)`);
  const m = await ask('Mode (1-7): ');
  if (!MODES[m]) { console.log('Mode invalid'); process.exit(1); }
  return MODES[m];
}

async function main() {
  await initWasm();
  await startLocalServer();
  await initBrowser();

  const keys = fs.readFileSync('wallet.txt', 'utf-8').split('\n').map(l => l.trim()).filter(Boolean);
  console.log(`[*] Total wallet: ${keys.length}`);
  const runMode = await pickMode();
  console.log(`[*] Mode: ${runMode}`);
  console.log(`\nPilih akun:\n  1. Satu akun\n  2. Semua akun\n  3. Dari index X sampai akhir`);

  const sel = await ask('\nPilihan (1/2/3): ');
  let selected = [];

  if (sel === '1') {
    // (list alamat wallet dihapus — urutan nomor = urutan baris di wallet.txt)
    const idx = parseInt(await ask('Pilih nomor: ')) - 1;
    if (isNaN(idx) || idx < 0 || idx >= keys.length) { console.log('Index invalid'); process.exit(1); }
    selected = [keys[idx]];
  } else if (sel === '2') {
    selected = keys;
  } else if (sel === '3') {
    const from = parseInt(await ask(`Mulai dari index (1-${keys.length}): `)) - 1;
    if (isNaN(from) || from < 0 || from >= keys.length) { console.log('Index invalid'); process.exit(1); }
    selected = keys.slice(from);
    console.log(`[*] Proses ${selected.length} wallet`);
  } else {
    console.log('Pilihan invalid'); process.exit(1);
  }

  for (let i = 0; i < selected.length; i++) {
    try {
      await processWallet(selected[i], runMode, i + 1, selected.length);
    } catch (e) {
      console.log(`[-] Error:`, e.message);
    }
  }

  // Bersihin browser + server lokal biar proses beneran berhenti
  // dan terminal balik ke prompt folder.
  try { if (typeof sharedBrowser !== 'undefined' && sharedBrowser) await sharedBrowser.close(); } catch (e) {}
  try { if (localServer) localServer.close(); } catch (e) {}
  console.log('[*] Selesai.');
  process.exit(0);
}

main().catch(console.error);
