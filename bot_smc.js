const https = require("https");

const TOKEN = process.env.TELEGRAM_TOKEN;
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
  return post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    chat_id: CHAT_ID, text: msg, parse_mode: "Markdown"
  });
}

// ─────────────────────────────────────────────
//  KILL ZONES — heure UTC
//  London : 07:00-10:00 UTC
//  New York : 12:30-15:30 UTC
// ─────────────────────────────────────────────

function inKillZone() {
  const now = new Date();
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();
  const t = h * 60 + m;
  const london_open  = 7  * 60;
  const london_close = 10 * 60;
  const ny_open      = 12 * 60 + 30;
  const ny_close     = 15 * 60 + 30;
  return (t >= london_open && t <= london_close) || (t >= ny_open && t <= ny_close);
}

function killZoneName() {
  const now = new Date();
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();
  const t = h * 60 + m;
  if (t >= 7*60 && t <= 10*60) return "London 🇬🇧";
  if (t >= 12*60+30 && t <= 15*60+30) return "New York 🇺🇸";
  return "Hors session";
}

function isWeekend() {
  const d = new Date().getUTCDay();
  return d === 0 || d === 6;
}

// ─────────────────────────────────────────────
//  INDICATEURS
// ─────────────────────────────────────────────

function calcATR(candles, p = 14) {
  let atr = 0;
  for (let i = 1; i <= p; i++) {
    atr += Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i-1].close),
      Math.abs(candles[i].low  - candles[i-1].close)
    );
  }
  atr /= p;
  for (let i = p+1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i-1].close),
      Math.abs(candles[i].low  - candles[i-1].close)
    );
    atr = (atr * (p-1) + tr) / p;
  }
  return atr;
}

function calcEMA(vals, p) {
  const k = 2 / (p+1);
  let ema = vals.slice(0,p).reduce((a,b)=>a+b,0)/p;
  for (let i = p; i < vals.length; i++) ema = vals[i]*k + ema*(1-k);
  return ema;
}

function calcRSI(closes, p = 14) {
  let ag = 0, al = 0;
  for (let i = 1; i <= p; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) ag += d; else al -= d;
  }
  ag /= p; al /= p;
  for (let i = p+1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    ag = (ag*(p-1) + Math.max(d,0)) / p;
    al = (al*(p-1) + Math.max(-d,0)) / p;
  }
  return al === 0 ? 100 : Math.round(100 - 100/(1+ag/al));
}

// ─────────────────────────────────────────────
//  DÉTECTION SWING HIGH / LOW (lookback bougies)
// ─────────────────────────────────────────────

function getSwings(candles, lookback = 5) {
  const swingHighs = [];
  const swingLows  = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const slice = candles.slice(i - lookback, i + lookback + 1);
    const maxH = Math.max(...slice.map(c => c.high));
    const minL = Math.min(...slice.map(c => c.low));
    if (candles[i].high === maxH) swingHighs.push({ i, price: candles[i].high });
    if (candles[i].low  === minL) swingLows.push({ i, price: candles[i].low  });
  }
  return { swingHighs, swingLows };
}

// ─────────────────────────────────────────────
//  DÉTECTION LIQUIDITY SWEEP
//  Un sweep = le prix perce un swing puis revient
// ─────────────────────────────────────────────

function detectSweep(candles, swings) {
  const last  = candles[candles.length - 1];
  const prev  = candles[candles.length - 2];
  const prev2 = candles[candles.length - 3];

  // Prend les 3 derniers swing highs/lows significatifs
  const recentHighs = swings.swingHighs.slice(-3).map(s => s.price);
  const recentLows  = swings.swingLows.slice(-3).map(s => s.price);

  // BULLISH SWEEP : wick sous un swing low puis close au-dessus
  for (const low of recentLows) {
    if (prev.low < low && prev.close > low && last.close > low) {
      return { type: "BULLISH_SWEEP", sweptLevel: low };
    }
  }

  // BEARISH SWEEP : wick au-dessus d'un swing high puis close en-dessous
  for (const high of recentHighs) {
    if (prev.high > high && prev.close < high && last.close < high) {
      return { type: "BEARISH_SWEEP", sweptLevel: high };
    }
  }

  return null;
}

// ─────────────────────────────────────────────
//  DÉTECTION FAIR VALUE GAP (FVG)
//  3 bougies consécutives : gap entre high[i-2] et low[i]
// ─────────────────────────────────────────────

function detectFVG(candles) {
  const fvgs = [];
  for (let i = 2; i < candles.length; i++) {
    const bullFVG = candles[i].low > candles[i-2].high; // gap haussier
    const bearFVG = candles[i].high < candles[i-2].low; // gap baissier
    if (bullFVG) fvgs.push({ type: "BULL", low: candles[i-2].high, high: candles[i].low, i });
    if (bearFVG) fvgs.push({ type: "BEAR", low: candles[i].high, high: candles[i-2].low, i });
  }
  return fvgs.slice(-5); // 5 derniers FVG
}

// ─────────────────────────────────────────────
//  BREAK OF STRUCTURE (BOS)
//  Confirme la direction après le sweep
// ─────────────────────────────────────────────

function detectBOS(candles, swings) {
  const last = candles[candles.length - 1];
  const recentHighs = swings.swingHighs.slice(-2).map(s => s.price);
  const recentLows  = swings.swingLows.slice(-2).map(s => s.price);

  // BOS haussier : close au-dessus d'un swing high précédent
  for (const high of recentHighs) {
    if (last.close > high) return { type: "BULLISH_BOS", level: high };
  }

  // BOS baissier : close en-dessous d'un swing low précédent
  for (const low of recentLows) {
    if (last.close < low) return { type: "BEARISH_BOS", level: low };
  }

  return null;
}

// ─────────────────────────────────────────────
//  LOGIQUE PRINCIPALE SMC
// ─────────────────────────────────────────────

function analyzesSMC(candles) {
  const closes = candles.map(c => c.close);
  const price  = closes[closes.length - 1];
  const atr    = calcATR(candles);
  const ema50  = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);
  const rsi    = calcRSI(closes);

  const swings = getSwings(candles, 5);
  const sweep  = detectSweep(candles, swings);
  const bos    = detectBOS(candles, swings);
  const fvgs   = detectFVG(candles);

  // Trend HTF : EMA50 vs EMA200
  const htfBull = ema50 > ema200;

  // Prix dans un FVG récent ?
  const inBullFVG = fvgs.some(f => f.type === "BULL" && price >= f.low && price <= f.high);
  const inBearFVG = fvgs.some(f => f.type === "BEAR" && price >= f.low && price <= f.high);

  let signal = null;
  let reasons = [];
  let confluences = 0;

  // ── SIGNAL ACHAT ──────────────────────────────
  // 1. Liquidity sweep baissier (sweep d'un low) → reversal haussier
  // 2. BOS haussier (confirmation)
  // 3. Trend HTF haussier (EMA50 > EMA200)
  // 4. RSI pas overbought
  if (sweep && sweep.type === "BULLISH_SWEEP") {
    confluences++;
    reasons.push(`✅ Liquidity sweep haussier à $${Math.round(sweep.sweptLevel).toLocaleString()}`);
  }
  if (bos && bos.type === "BULLISH_BOS") {
    confluences++;
    reasons.push(`✅ Break of Structure haussier`);
  }
  if (htfBull) {
    confluences++;
    reasons.push(`✅ Trend HTF haussier (EMA50 > EMA200)`);
  }
  if (rsi < 55 && rsi > 30) {
    confluences++;
    reasons.push(`✅ RSI favorable: ${rsi}`);
  }
  if (inBullFVG) {
    confluences++;
    reasons.push(`✅ Prix dans un Fair Value Gap haussier`);
  }

  if (sweep && sweep.type === "BULLISH_SWEEP" && bos && bos.type === "BULLISH_BOS" && confluences >= 3) {
    signal = "BUY";
  }

  // ── SIGNAL VENTE ──────────────────────────────
  if (!signal) {
    confluences = 0;
    reasons = [];

    if (sweep && sweep.type === "BEARISH_SWEEP") {
      confluences++;
      reasons.push(`✅ Liquidity sweep baissier à $${Math.round(sweep.sweptLevel).toLocaleString()}`);
    }
    if (bos && bos.type === "BEARISH_BOS") {
      confluences++;
      reasons.push(`✅ Break of Structure baissier`);
    }
    if (!htfBull) {
      confluences++;
      reasons.push(`✅ Trend HTF baissier (EMA50 < EMA200)`);
    }
    if (rsi > 45 && rsi < 70) {
      confluences++;
      reasons.push(`✅ RSI favorable: ${rsi}`);
    }
    if (inBearFVG) {
      confluences++;
      reasons.push(`✅ Prix dans un Fair Value Gap baissier`);
    }

    if (sweep && sweep.type === "BEARISH_SWEEP" && bos && bos.type === "BEARISH_BOS" && confluences >= 3) {
      signal = "SELL";
    }
  }

  if (!signal) return null;

  // TP / SL basés sur ATR + niveau sweepé
  let sl, tp1, tp2;
  if (signal === "BUY") {
    sl  = parseFloat((sweep ? sweep.sweptLevel - atr * 0.5 : price - atr * 1.5).toFixed(2));
    tp1 = parseFloat((price + atr * 2).toFixed(2));
    tp2 = parseFloat((price + atr * 4).toFixed(2));
  } else {
    sl  = parseFloat((sweep ? sweep.sweptLevel + atr * 0.5 : price + atr * 1.5).toFixed(2));
    tp1 = parseFloat((price - atr * 2).toFixed(2));
    tp2 = parseFloat((price - atr * 4).toFixed(2));
  }

  const rr = Math.abs(tp1 - price) / Math.abs(price - sl);

  return { signal, price, sl, tp1, tp2, rsi, atr, rr, reasons, confluences, ema50, ema200 };
}

// ─────────────────────────────────────────────
//  FETCH KRAKEN M5
// ─────────────────────────────────────────────

async function fetchCandles() {
  const data = await get("https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=5");
  const raw = Object.values(data.result)[0].slice(-250);
  return raw.map(c => ({
    time:  c[0] * 1000,
    open:  parseFloat(c[1]),
    high:  parseFloat(c[2]),
    low:   parseFloat(c[3]),
    close: parseFloat(c[4]),
    vol:   parseFloat(c[6]),
  }));
}

// ─────────────────────────────────────────────
//  MAIN LOOP
// ─────────────────────────────────────────────

let lastSignalTime = 0;
const SIGNAL_COOLDOWN = 30 * 60 * 1000; // 30 min entre 2 signaux

async function run() {
  if (isWeekend()) {
    console.log("Weekend — pas de signal BTC.");
    return;
  }

  if (!inKillZone()) {
    console.log(`${new Date().toISOString()} | Hors Kill Zone — en attente.`);
    return;
  }

  try {
    const candles = await fetchCandles();
    const result  = analyzesSMC(candles);

    const price = candles[candles.length-1].close;
    const kz    = killZoneName();

    if (!result) {
      console.log(`${new Date().toISOString()} | ${kz} | $${Math.round(price).toLocaleString()} | Pas de setup SMC.`);
      return;
    }

    // Cooldown pour éviter les doublons
    const now = Date.now();
    if (now - lastSignalTime < SIGNAL_COOLDOWN) {
      console.log(`${new Date().toISOString()} | Signal trouvé mais cooldown actif.`);
      return;
    }
    lastSignalTime = now;

    const emoji  = result.signal === "BUY" ? "🟢" : "🔴";
    const action = result.signal === "BUY" ? "ACHÈTE" : "VENDS";

    // Pips BTC = $1 par pip
    const slPips  = Math.abs(Math.round(result.price - result.sl));
    const tp1Pips = Math.abs(Math.round(result.tp1  - result.price));
    const tp2Pips = Math.abs(Math.round(result.tp2  - result.price));

    const msg =
      `${emoji} *SIGNAL BTC — ${action}*\n` +
      `📍 Session: ${kz}\n\n` +
      `💰 Entrée: *$${result.price.toFixed(2)}*\n` +
      `🛑 SL: *${slPips} pips* ($${result.sl.toFixed(2)})\n` +
      `🎯 TP1: *${tp1Pips} pips* ($${result.tp1.toFixed(2)})\n` +
      `🎯 TP2: *${tp2Pips} pips* ($${result.tp2.toFixed(2)})\n` +
      `⚖️ R/R: *1:${result.rr.toFixed(1)}*\n\n` +
      `*Confluences (${result.confluences}/5):*\n` +
      result.reasons.join("\n") + "\n\n" +
      `📊 RSI: ${result.rsi} | ATR: ${Math.round(result.atr)} pips\n` +
      `📈 EMA50: $${result.ema50.toFixed(2)} | EMA200: $${result.ema200.toFixed(2)}\n\n` +
      `_Not financial advice_`;

    await sendTelegram(msg);
    console.log(`✅ Signal envoyé: ${action} | $${result.price.toFixed(2)}`);

  } catch(e) {
    console.error("Erreur:", e.message);
  }
}

// ─────────────────────────────────────────────
//  DÉMARRAGE
// ─────────────────────────────────────────────

console.log("BTC SMC Bot démarré ✅");
sendTelegram(
  "🤖 *BTC SMC Signal Bot*\n\n" +
  "Stratégie: Smart Money Concepts\n" +
  "Logique: Liquidity Sweep + BOS + FVG\n" +
  "Sessions: London 🇬🇧 + New York 🇺🇸\n" +
  "Paire: BTC/USD M5\n\n" +
  "_Signaux uniquement pendant les Kill Zones_"
);

run();
setInterval(run, 60 * 1000); // toutes les minutes
