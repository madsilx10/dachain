const { ethers } = require('ethers');
const fs = require('fs');

const BASE_URL = 'https://interstellar.dachain.io';
const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

function buildSiweMessage(address, nonce, chainId = 1) {
  const domain = 'interstellar.dachain.io';
  const uri = 'https://interstellar.dachain.io/';
  const version = '1';
  const issuedAt = new Date().toISOString();

  return `${domain} wants you to sign in with your Ethereum account:\n${address}\n\nSign in with Ethereum.\n\nURI: ${uri}\nVersion: ${version}\nChain ID: ${chainId}\nNonce: ${nonce}\nIssued At: ${issuedAt}`;
}

async function processWallet(privateKey) {
  const wallet = new ethers.Wallet(privateKey.trim());
  const address = wallet.address;
  console.log(`\n[*] Wallet: ${address}`);

  // Cookie jar sederhana
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

  // Step 1: GET launch (optional, buat dapetin cookie awal)
  const launchRes = await fetch(`${BASE_URL}/api/v1/ops/launch/`, {
    headers: getHeaders({ 'Cookie': '' }),
  });
  parseCookies(launchRes.headers);
  console.log(`[1] Launch: ${launchRes.status}`);

  // Step 2: POST nonce
  const nonceRes = await fetch(`${BASE_URL}/api/v1/auth/siwe/nonce/`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ signer: address }),
  });
  parseCookies(nonceRes.headers);
  const nonceData = await nonceRes.json();
  console.log(`[2] Nonce: ${nonceRes.status}`, nonceData);

  if (!nonceData.success) {
    console.log(`[-] Gagal dapet nonce`);
    return;
  }

  const nonce = nonceData.data.nonce;

  // Step 3: Sign SIWE message
  const message = buildSiweMessage(address, nonce);
  const signature = await wallet.signMessage(message);
  console.log(`[3] Signed`);

  // Step 4: POST siwe login
  const siweRes = await fetch(`${BASE_URL}/api/v1/auth/siwe/`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ message, signature }),
  });
  parseCookies(siweRes.headers);
  const siweData = await siweRes.json();
  console.log(`[4] SIWE: ${siweRes.status}`, siweData);

  if (!siweData.success) {
    console.log(`[-] Login gagal`);
    return;
  }

  // Step 5: GET gate
  const gateRes = await fetch(`${BASE_URL}/api/v1/launch/gate/`, {
    headers: getHeaders(),
  });
  const gateData = await gateRes.json();
  console.log(`[5] Gate: ${gateRes.status}`, gateData.data);

  if (!gateData.data?.admitted) {
    console.log(`[-] Belum admitted`);
    return;
  }

  // Step 6: GET codes (present)
  const codesRes = await fetch(`${BASE_URL}/api/v1/launch/codes/`, {
    headers: getHeaders(),
  });
  const codesData = await codesRes.json();
  console.log(`[6] Codes: ${codesRes.status}`, codesData.data);
}

const readline = require('readline');

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

async function main() {
  const keys = fs.readFileSync('wallet.txt', 'utf-8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);

  console.log(`[*] Total wallet: ${keys.length}`);
  console.log(`\nPilih mode:`);
  console.log(`  1. Satu akun`);
  console.log(`  2. Semua akun`);
  console.log(`  3. Dari index X sampai akhir`);

  const mode = await ask('\nPilihan (1/2/3): ');

  let selected = [];

  if (mode === '1') {
    console.log('\nDaftar wallet:');
    keys.forEach((k, i) => {
      const addr = new ethers.Wallet(k).address;
      console.log(`  [${i + 1}] ${addr}`);
    });
    const idx = await ask('\nPilih nomor wallet: ');
    const i = parseInt(idx) - 1;
    if (isNaN(i) || i < 0 || i >= keys.length) {
      console.log('[-] Index tidak valid'); process.exit(1);
    }
    selected = [keys[i]];

  } else if (mode === '2') {
    selected = keys;

  } else if (mode === '3') {
    const from = await ask(`\nMulai dari index (1-${keys.length}): `);
    const i = parseInt(from) - 1;
    if (isNaN(i) || i < 0 || i >= keys.length) {
      console.log('[-] Index tidak valid'); process.exit(1);
    }
    selected = keys.slice(i);
    console.log(`[*] Proses ${selected.length} wallet (index ${i + 1} sampai ${keys.length})`);

  } else {
    console.log('[-] Pilihan tidak valid'); process.exit(1);
  }

  for (const key of selected) {
    await processWallet(key);
  }
}

main().catch(console.error);
