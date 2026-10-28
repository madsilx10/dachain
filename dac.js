// dac_login.js — npm i ethers
// wallet.txt: 1 privkey per baris
const { Wallet } = require("ethers");
const fs = require("fs");
const readline = require("readline");

const BASE = "https://interstellar.dachain.io";
const CHAIN_ID = 21892;
const STATEMENT = ""; // isi sesuai message SIWE asli (kosongin kalau gak ada)
const UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ask = (q) => new Promise((res) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, (a) => { rl.close(); res(a.trim()); });
});

class Jar {
  constructor() { this.c = {}; }
  absorb(res) {
    for (const sc of res.headers.getSetCookie?.() || []) {
      const [kv] = sc.split(";");
      const i = kv.indexOf("=");
      this.c[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    }
  }
  str() { return Object.entries(this.c).map(([k, v]) => `${k}=${v}`).join("; "); }
}

async function req(jar, method, path, body, extra = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: BASE,
      Referer: BASE + "/",
      "User-Agent": UA,
      "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
      Cookie: jar.str(),
      ...(jar.c.csrftoken ? { "X-Csrftoken": jar.c.csrftoken } : {}),
      ...extra,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  jar.absorb(res);
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

// Captcha Cap (cap.dachain.tech/74e539aa4f): challenge -> solve hashwx + instrumentation -> redeem.
// Belum di-reverse, jadi sementara token ditempel manual (ambil dari response /redeem di DevTools).
async function getCaptcha(address) {
  return await ask(`[${address}] tempel captcha token (redeem): `);
}

async function login(pk) {
  const wallet = new Wallet(pk.startsWith("0x") ? pk : "0x" + pk);
  const address = wallet.address;
  const jar = new Jar();

  // csrftoken awal (di-set oleh /auth/me/)
  await req(jar, "GET", "/api/v1/auth/me/");

  const n = await req(jar, "POST", "/api/v1/auth/siwe/nonce/", { signer: address });
  const nonce = n.json?.data?.nonce;
  if (!nonce) throw new Error("nonce gagal: " + JSON.stringify(n));

  const captcha = await getCaptcha(address);

  const message =
    `interstellar.dachain.io wants you to sign in with your Ethereum account:\n${address}\n\n` +
    (STATEMENT ? `${STATEMENT}\n\n` : "") +
    `URI: ${BASE}\nVersion: 1\nChain ID: ${CHAIN_ID}\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
  const signature = await wallet.signMessage(message);

  const r = await req(jar, "POST", "/api/v1/auth/siwe/", { message, signature }, { "X-Captcha-Token": captcha });
  if (!r.json?.success) throw new Error("siwe gagal: " + JSON.stringify(r.json));

  // cek status admit (launch/gate) + profil
  const g = await req(jar, "GET", "/api/v1/launch/gate/");
  const me = await req(jar, "GET", "/api/v1/auth/me/");

  return {
    address,
    cookies: jar.c,
    user: r.json.data.user,
    gate: g.json?.data
      ? { admitted: g.json.data.admitted, own_code: g.json.data.own_code, queue: g.json.data.queue }
      : g.json,
    me: me.json?.data ?? me.json,
  };
}

(async () => {
  const keys = fs.readFileSync("wallet.txt", "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
  const out = fs.existsSync("sessions.json") ? JSON.parse(fs.readFileSync("sessions.json")) : {};

  for (const [i, pk] of keys.entries()) {
    try {
      const s = await login(pk);
      out[s.address] = { cookies: s.cookies, user: s.user, gate: s.gate, me: s.me, at: new Date().toISOString() };
      console.log(`[${i + 1}/${keys.length}] ✅ ${s.address} | user ${s.user.id} (${s.user.status}) | admitted=${s.gate?.admitted} | code=${s.gate?.own_code}`);
    } catch (e) {
      console.log(`[${i + 1}/${keys.length}] ❌ ${e.message}`);
    }
    fs.writeFileSync("sessions.json", JSON.stringify(out, null, 2));
    await sleep(2000 + Math.random() * 2000);
  }
})();
