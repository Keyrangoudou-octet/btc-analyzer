const https = require("https");

const TOKEN   = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ─────────────────────────────────────────────
//  UTILS
// ─────────────────────────────────────────────

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, res => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on("error", reject);
  });
}

function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
    }, res => { res.on("data", () => {}); res.on("end", resolve); });
    req.on("error", reject);
    req.write(data); req.end();
  });
}

function sendTelegram(msg) {
  if (!TOKEN || !CHAT_ID) return Promise.resolve();
  return post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    chat_id: CHAT_ID, text: msg, parse_mode: "Markdown"
  });
}

// ─────────────────────────────────────────────
//  SESSIONS UTC
//  London  : 07:00-10:00
//  New York: 12:30-15:30
// ─────────────────────────────────────────────

function getSession() {
  const now = new Date();
  const t = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (t >= 7*60 && t <= 10*60)        return "London 🇬🇧";
  if (t >= 12*60+30 && t <= 15*60+30) return "New York 🇺🇸";
  return null;
}

function isWeekend() {
  const d = new Date().getUTCDay();
  return d === 0 || d === 6;
}

// ─────────────────────────────────────────────
//  FETCH KRAKEN BTC/USD M5
// ─────────────────────────────────────────────

async function fetchCandles() {
  const data = await get("https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=5");
  if (data.error && data.error.length) throw new Error("Kraken: " + data.error.join(", "));
  const raw = Object.values(data.result)[0].slice(-250);
  return raw.map(c => ({
    open:  parseFloat(c[1]),
    high:  parseFloat(c[2]),
    low:   parseFloat(c[3]),
    close: parseFloat(c[4]),
  }));
}

// ─────────────────────────────────────────────
//  INDICATEURS
// ─────────────────────────────────────────────

function calcATR(candles, p=14) {
  let atr = 0;
  for (let i=1; i<=p; i++) {
    atr += Math.max(candles[i].high-candles[i].low, Math.abs(candles[i].high-candles[i-1].close), Math.abs(candles[i].low-candles[i-1].close));
  }
  atr /= p;
  for (let i=p+1; i<candles.length; i++) {
    const tr = Math.max(candles[i].high-candles[i].low, Math.abs(candles[i].high-candles[i-1].close), Math.abs(candles[i].low-candles[i-1].close));
    atr = (atr*(p-1)+tr)/p;
  }
  return atr;
}

function calcEMA(vals, p) {
  const k = 2/(p+1);
  let ema = vals.slice(0,p).reduce((a,b)=>a+b,0)/p;
  for (let i=p; i<vals.length; i++) ema = vals[i]*k + ema*(1-k);
  return ema;
}

// ─────────────────────────────────────────────
//  SWING HIGH / LOW
// ─────────────────────────────────────────────

function getSwings(candles, lb=5) {
  const sh=[], sl=[];
  for (let i=lb; i<candles.length-lb; i++) {
    const s = candles.slice(i-lb, i+lb+1);
    if (candles[i].high === Math.max(...s.map(c=>c.high))) sh.push({i, price: candles[i].high});
    if (candles[i].low  === Math.min(...s.map(c=>c.low)))  sl.push({i, price: candles[i].low});
  }
  return {sh, sl};
}

// ─────────────────────────────────────────────
//  CHoCH
// ─────────────────────────────────────────────

function detectCHoCH(candles, sh, sl) {
  const last = candles[candles.length-1];
  if (sh.length>=2 && sh[sh.length-2].price > sh[sh.length-1].price && last.close > sh[sh.length-1].price)
    return {type:"BULLISH_CHOCH", level: sh[sh.length-1].price};
  if (sl.length>=2 && sl[sl.length-2].price < sl[sl.length-1].price && last.close < sl[sl.length-1].price)
    return {type:"BEARISH_CHOCH", level: sl[sl.length-1].price};
  return null;
}

// ─────────────────────────────────────────────
//  LIQUIDITY SWEEP
// ─────────────────────────────────────────────

function detectSweep(candles, sh, sl) {
  const last = candles[candles.length-1];
  const prev = candles[candles.length-2];
  for (const s of sl.slice(-4)) {
    if ((prev.low<s.price && prev.close>s.price && last.close>s.price) || (last.low<s.price && last.close>s.price))
      return {type:"BULLISH_SWEEP", level: s.price};
  }
  for (const s of sh.slice(-4)) {
    if ((prev.high>s.price && prev.close<s.price && last.close<s.price) || (last.high>s.price && last.close<s.price))
      return {type:"BEARISH_SWEEP", level: s.price};
  }
  return null;
}

// ─────────────────────────────────────────────
//  BREAK OF STRUCTURE
// ─────────────────────────────────────────────

function detectBOS(candles, sh, sl) {
  const last = candles[candles.length-1];
  for (const s of sh.slice(-3)) { if (last.close>s.price) return {type:"BULLISH_BOS", level: s.price}; }
  for (const s of sl.slice(-3)) { if (last.close<s.price) return {type:"BEARISH_BOS", level: s.price}; }
  return null;
}

// ─────────────────────────────────────────────
//  FIBONACCI
// ─────────────────────────────────────────────

function calcFib(sh, sl) {
  if (!sh.length || !sl.length) return null;
  const h = sh[sh.length-1].price, l = sl[sl.length-1].price, r = h-l;
  return {
    swing_high: h, swing_low: l,
    f236: +(h-r*0.236).toFixed(2), f382: +(h-r*0.382).toFixed(2),
    f500: +(h-r*0.5).toFixed(2),   f618: +(h-r*0.618).toFixed(2),
    f706: +(h-r*0.706).toFixed(2), f786: +(h-r*0.786).toFixed(2),
    f618up: +(l+r*0.618).toFixed(2), f706up: +(l+r*0.706).toFixed(2), f786up: +(l+r*0.786).toFixed(2),
  };
}

function inGolden(price, fib, dir, atr) {
  if (!fib) return false;
  if (dir==="BUY")  return price >= fib.f786-atr*0.3 && price <= fib.f618+atr*0.3;
  return price >= fib.f618up-atr*0.3 && price <= fib.f786up+atr*0.3;
}

// ─────────────────────────────────────────────
//  SUPPLY & DEMAND
// ─────────────────────────────────────────────

function detectZones(candles, atr) {
  const zones = [];
  for (let i=3; i<candles.length-1; i++) {
    const body = Math.abs(candles[i].close - candles[i].open);
    if (body > atr*1.5) {
      if (candles[i].close > candles[i].open) zones.push({type:"DEMAND", top: candles[i].open, bottom: candles[i].low});
      else zones.push({type:"SUPPLY", top: candles[i].high, bottom: candles[i].open});
    }
  }
  return zones.slice(-6);
}

// ─────────────────────────────────────────────
//  ANALYSE SMC PRINCIPALE
// ─────────────────────────────────────────────

function analyze(candles) {
  const closes = candles.map(c=>c.close);
  const price  = closes[closes.length-1];
  const atr    = calcATR(candles);
  const ema50  = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);
  const {sh, sl} = getSwings(candles, 5);
  const choch  = detectCHoCH(candles, sh, sl);
  const sweep  = detectSweep(candles, sh, sl);
  const bos    = detectBOS(candles, sh, sl);
  const zones  = detectZones(candles, atr);
  const fib    = calcFib(sh, sl);
  const htf    = ema50 > ema200;

  const nd = zones.find(z => z.type==="DEMAND" && z.bottom<=price && price<=z.top+atr);
  const ns = zones.find(z => z.type==="SUPPLY" && z.bottom-atr<=price && price<=z.top);
  const gb = inGolden(price, fib, "BUY", atr);
  const gs = inGolden(price, fib, "SELL", atr);

  let bc=0, br=[];
  if (choch?.type==="BULLISH_CHOCH") { bc++; br.push(`✅ CHoCH haussier à $${choch.level.toLocaleString()}`); }
  if (sweep?.type==="BULLISH_SWEEP") { bc++; br.push(`✅ Liquidity Sweep haussier à $${sweep.level.toLocaleString()}`); }
  if (bos?.type==="BULLISH_BOS")     { bc++; br.push(`✅ BOS haussier à $${bos.level.toLocaleString()}`); }
  if (gb && fib) { bc++; br.push(`✅ Golden Zone Fibo ($${fib.f786.toLocaleString()} - $${fib.f618.toLocaleString()})`); }
  if (nd)  { bc++; br.push(`✅ Demand Zone ($${nd.bottom.toLocaleString()} - $${nd.top.toLocaleString()})`); }
  if (htf) { bc++; br.push("✅ Trend HTF haussier (EMA50 > EMA200)"); }

  let sc=0, sr=[];
  if (choch?.type==="BEARISH_CHOCH") { sc++; sr.push(`✅ CHoCH baissier à $${choch.level.toLocaleString()}`); }
  if (sweep?.type==="BEARISH_SWEEP") { sc++; sr.push(`✅ Liquidity Sweep baissier à $${sweep.level.toLocaleString()}`); }
  if (bos?.type==="BEARISH_BOS")     { sc++; sr.push(`✅ BOS baissier à $${bos.level.toLocaleString()}`); }
  if (gs && fib) { sc++; sr.push(`✅ Golden Zone Fibo ($${fib.f618up.toLocaleString()} - $${fib.f786up.toLocaleString()})`); }
  if (ns)   { sc++; sr.push(`✅ Supply Zone ($${ns.bottom.toLocaleString()} - $${ns.top.toLocaleString()})`); }
  if (!htf) { sc++; sr.push("✅ Trend HTF baissier (EMA50 < EMA200)"); }

  const bv = sweep?.type==="BULLISH_SWEEP" && bos?.type==="BULLISH_BOS" && bc>=3;
  const sv = sweep?.type==="BEARISH_SWEEP" && bos?.type==="BEARISH_BOS" && sc>=3;

  if (!bv && !sv) return null;

  let sig, conf, reasons, slPrice, tp1, tp2;
  if (bv) {
    sig="BUY"; conf=bc; reasons=br;
    slPrice = +(sweep.level - atr*0.3).toFixed(2);
    tp1 = +(price + atr*2).toFixed(2);
    tp2 = +(fib ? fib.swing_high : price + atr*4).toFixed(2);
  } else {
    sig="SELL"; conf=sc; reasons=sr;
    slPrice = +(sweep.level + atr*0.3).toFixed(2);
    tp1 = +(price - atr*2).toFixed(2);
    tp2 = +(fib ? fib.swing_low : price - atr*4).toFixed(2);
  }

  const slPips  = +Math.abs(price-slPrice).toFixed(2);
  const tp1Pips = +Math.abs(tp1-price).toFixed(2);
  const tp2Pips = +Math.abs(tp2-price).toFixed(2);
  const rr1 = slPips>0 ? +(tp1Pips/slPips).toFixed(1) : 0;
  const rr2 = slPips>0 ? +(tp2Pips/slPips).toFixed(1) : 0;

  return {sig, price, slPrice, tp1, tp2, slPips, tp1Pips, tp2Pips, rr1, rr2, conf, reasons, fib, atr, ema50, ema200};
}

// ─────────────────────────────────────────────
//  MAIN LOOP
// ─────────────────────────────────────────────

let lastSignal = 0;
const COOLDOWN = 45 * 60 * 1000;

async function run() {
  if (isWeekend()) { console.log("Weekend — pas de signal BTC."); return; }

  const session = getSession();
  if (!session) { console.log(`${new Date().toISOString()} | Hors session.`); return; }

  try {
    const candles = await fetchCandles();
    const result  = analyze(candles);
    const price   = candles[candles.length-1].close;

    if (!result) {
      console.log(`${new Date().toISOString()} | ${session} | $${price.toLocaleString()} | Pas de setup SMC.`);
      return;
    }

    const now = Date.now();
    if (now - lastSignal < COOLDOWN) { console.log("Cooldown actif."); return; }
    lastSignal = now;

    const emoji  = result.sig==="BUY" ? "🟢" : "🔴";
    const action = result.sig==="BUY" ? "ACHÈTE" : "VENDS";
    const f = result.fib;
    const fibTxt = f ?
      `\n*Niveaux Fibonacci:*\n0.382 → $${f.f382.toLocaleString()}\n0.500 → $${f.f500.toLocaleString()}\n0.618 → *$${f.f618.toLocaleString()}* ⭐\n0.706 → *$${f.f706.toLocaleString()}* ⭐\n0.786 → $${f.f786.toLocaleString()}\n` : "";

    const msg =
      `${emoji} *SIGNAL BTC — ${action}*\n📍 Session: ${session}\n\n` +
      `💰 Entrée: *$${result.price.toLocaleString()}*\n` +
      `🛑 SL: *${result.slPips.toLocaleString()} pips* ($${result.slPrice.toLocaleString()})\n` +
      `🎯 TP1: *${result.tp1Pips.toLocaleString()} pips* ($${result.tp1.toLocaleString()}) — R/R 1:${result.rr1}\n` +
      `🎯 TP2: *${result.tp2Pips.toLocaleString()} pips* ($${result.tp2.toLocaleString()}) — R/R 1:${result.rr2}\n\n` +
      `*Confluences (${result.conf}/6):*\n` +
      result.reasons.join("\n") +
      fibTxt + "\n" +
      `📉 ATR: $${Math.round(result.atr).toLocaleString()} | EMA50: $${Math.round(result.ema50).toLocaleString()}\n\n` +
      `_Not financial advice_`;

    await sendTelegram(msg);
    console.log(`✅ Signal BTC: ${action} | $${result.price.toLocaleString()}`);

  } catch(e) {
    console.error("Erreur:", e.message);
  }
}

console.log("BTC SMC Bot démarré ✅");
sendTelegram(
  "🟡 *BTC SMC Signal Bot démarré*\n\n" +
  "Stratégie: CHoCH + Liq Sweep + BOS + Golden Zone Fibo\n" +
  "Sessions: London + New York\n" +
  "Paire: BTC/USD M5"
);

run();
setInterval(run, 60 * 1000);
