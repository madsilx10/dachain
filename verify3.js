const crypto = require('crypto');
const fs = require('fs');

const a = new Uint32Array([1116352408,1899447441,3049323471,3921009573,961987163,1508970993,2453635748,2870763221,3624381080,310598401,607225278,1426881987,1925078388,2162078206,2614888103,3248222580,3835390401,4022224774,264347078,604807628,770255983,1249150122,1555081692,1996064986,2554220882,2821834349,2952996808,3210313671,3336571891,3584528711,113926993,338241895,666307205,773529912,1294757372,1396182291,1695183700,1986661051,2177026350,2456956037,2730485921,2820302411,3259730800,3345764771,3516065817,3600352804,4094571909,275423344,430227734,506948616,659060556,883997877,958139571,1322822218,1537002063,1747873779,1955562222,2024104815,2227730452,2361852424,2428436474,2756734187,3204031479,3329325298]);
const l = (e, t) => {
  const n=e.length,s=1+(n+8>>6),r=new Uint8Array(s<<6);
  r.set(e),r[n]=128;
  const o=8*n,lv=new DataView(r.buffer);
  lv.setUint32(r.length-4,o>>>0,false);
  lv.setUint32(r.length-8,Math.floor(o/4294967296),false);
  let i=1779033703,c=3144134277,f=1013904242,w=2773480762,g=1359893119,d=2600822924,h=528734635,u=1541459225;
  const m=new Uint32Array(64);
  for(let e=0;e<s;e++){
    const t=e<<6;
    for(let e=0;e<16;e++) m[e]=lv.getUint32(t+(e<<2),false);
    for(let e=16;e<64;e++){
      const t=m[e-15],n=m[e-2],s=(t>>>7|t<<25)^(t>>>18|t<<14)^t>>>3,r=(n>>>17|n<<15)^(n>>>19|n<<13)^n>>>10;
      m[e]=m[e-16]+s+m[e-7]+r>>>0;
    }
    let n=i,s=c,r=f,o=w,b=g,p=d,_=h,y=u;
    for(let e=0;e<64;e++){
      const t=y+((b>>>6|b<<26)^(b>>>11|b<<21)^(b>>>25|b<<7))+(b&p^~b&_)+a[e]+m[e]>>>0,lv=n&s^n&r^s&r;
      y=_,_=p,p=b,b=o+t>>>0,o=r,r=s,s=n,n=t+(((n>>>2|n<<30)^(n>>>13|n<<19)^(n>>>22|n<<10))+lv>>>0)>>>0;
    }
    i=i+n>>>0,c=c+s>>>0,f=f+r>>>0,w=w+o>>>0,g=g+b>>>0,d=d+p>>>0,h=h+_>>>0,u=u+y>>>0;
  }
  const b=new DataView(t.buffer,t.byteOffset,32);
  b.setUint32(0,i,false),b.setUint32(4,c,false),b.setUint32(8,f,false),b.setUint32(12,w,false),
  b.setUint32(16,g,false),b.setUint32(20,d,false),b.setUint32(24,h,false),b.setUint32(28,u,false);
};

async function verify(wasmBuf, c, d, n, expectedNonce) {
  const { instance: w } = await WebAssembly.instantiate(wasmBuf, {});
  w.exports._initialize && w.exports._initialize();
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
  const out = new Uint8Array(32);

  const outerIdx = Math.floor(expectedNonce / n);
  let tmp = outerIdx;
  for (let e = 0; e < 8; e++) { seed40[32+e] = tmp & 0xff; tmp = Math.floor(tmp/256); }
  l(seed40, out);
  mem.set(out, seedPtr);
  w.exports.hashwx_make(ctx, seedPtr);

  const modPtr = w.exports.hashwx_module(ctx);
  const modSize = w.exports.hashwx_module_size(ctx);
  const modBytes = new Uint8Array(w.exports.memory.buffer, modPtr, modSize).slice();
  const subExec = new WebAssembly.Instance(new WebAssembly.Module(modBytes), { env: { memory: w.exports.memory } }).exports.exec;

  w.exports.hashwx_exec_begin(ctx, BigInt(expectedNonce));
  subExec(regPtr, memPtr);
  const result = BigInt.asUintN(64, w.exports.hashwx_exec_final(ctx));
  return result <= target;
}

(async () => {
  const wasm1 = fs.readFileSync('hashwx.wasm');
  const wasm2 = fs.readFileSync('hashwx2.wasm');

  const challenges = [
    { c: '8be43d390fbf42420235de8fa6f66c6ef11f62e4834ba9ee5ab7d62825ba919c', d: 362500, n: 65536 },
    { c: '3ea6422e047b001e0fa23e21902122c86ffd2bf4db9fe26b485f85a0faf5e18e', d: 362500, n: 65536 },
    { c: '78287bc745cba9a6af9ffdfeccf28269ba12794082503d460cec65acb53164dc', d: 362500, n: 65536 },
    { c: '057482770f33f6185c18585f235a0ec87be4962fe6ac025f26381acc74c7296c', d: 362500, n: 65536 },
  ];
  const nonces = [494114, 281321, 407971, 354805];

  for (let i = 0; i < challenges.length; i++) {
    const { c, d, n } = challenges[i];
    const v1 = await verify(wasm1, c, d, n, nonces[i]);
    const v2 = await verify(wasm2, c, d, n, nonces[i]);
    console.log(`CH${i} nonce=${nonces[i]}: wasm1=${v1} wasm2=${v2}`);
  }
})();
