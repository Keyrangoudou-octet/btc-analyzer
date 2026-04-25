const https = require("https");

const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, res => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => resolve(JSON.parse(data)));
    }).on("error", reject);
  });
}

function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
    }, res => {
      res.on("data", () => {});
      res.on("end", resolve);
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function sendTelegram(msg) {
  return post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    chat_id: CHAT_ID,
    text: msg,
    parse_mode: "Markdown"
  });
}

function calcEMA(vals, p) {
  const k = 2 / (p + 1);
  let ema = vals.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < vals.length; i++) ema = vals[i] * k + ema * (1 - k);
  return ema;
}

function calcRSI(closes, p = 14) {
  let ag = 0, al = 0;
  for (let i = 1; i <= p; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) ag += d; else al -= d;
  }
  ag /= p; al /= p;
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (p - 1) + Math.max(d, 0)) / p;
    al = (al * (p - 1) + Math.max(-d, 0)) / p;
  }
  return al === 0 ? 100 : Math.round(100 - 100 / (1 + ag / al));
}

function calcATR(candles, p = 14) {
  let atr = 0;
  for (let i = 1; i <= p; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i-1].close),
      Math.abs(candles[i].low  - candles[i-1].close)
    );
    atr += tr;
  }
  atr /= p;
  for (let i = p + 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i-1].close),
      Math.abs(candles[i].low  - candles[i-1].close)
    );
    atr = (atr * (p - 1) + tr) / p;
  }
  return atr;
}

let prevAction = null;

async function run() {
  try {
    const data = await get("https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=5");
    const raw = Object.values(data.result)[0].slice(-100);
    const candles = raw.map(c => ({
      close: parseFloat(c[4]),
      high:  parseFloat(c[2]),
      low:   parseFloat(c[3]),
    }));

    const closes = candles.map(c => c.close);
    const highs  = candles.map(c => c.high);
    const lows   = candles.map(c => c.low);

    const price      = closes[closes.length - 1];
    const ema20      = calcEMA(closes, 20);
    const ema50      = calcEMA(closes, 50);
    const rsi        = calcRSI(closes);
    const atr        = calcATR(candles);
    const support    = Math.min(...lows.slice(-20));
    const resistance = Math.max(...highs.slice(-20));

    let score = 0;
    if (ema20 > ema50) score += 2; else score -= 2;
    if (rsi < 35)      score += 1;
    else if (rsi > 65) score -= 1;
    else if (rsi > 50) score += 1;
    else               score -= 1;

    const action = score >= 2 ? "ACHÈTE 🟢" : score <= -2 ? "VENDS 🔴" : "ATTENDS 🟡";

    // TP / SL basés sur ATR — ratio risque/récompense 1:2
    let sl, tp1, tp2;
    if (action.includes("ACHÈTE")) {
      sl  = Math.round(price - atr * 1.5);
      tp1 = Math.round(price + atr * 2);
      tp2 = Math.round(price + atr * 3.5);
    } else if (action.includes("VENDS")) {
      sl  = Math.round(price + atr * 1.5);
      tp1 = Math.round(price - atr * 2);
      tp2 = Math.round(price - atr * 3.5);
    }

    console.log(`${new Date().toISOString()} | ${action} | $${price.toFixed(0)} | RSI: ${rsi} | ATR: ${atr.toFixed(0)}`);

    if (prevAction !== null && action !== prevAction) {
      let msg =
        `🔔 *SIGNAL BTC CHANGÉ*\n\n` +
        `*${action}*\n\n` +
        `💰 Entrée: *$${Math.round(price).toLocaleString()}*\n`;

      if (sl && tp1) {
        msg +=
          `🛑 Stop Loss: *$${sl.toLocaleString()}*\n` +
          `🎯 TP1: *$${tp1.toLocaleString()}*\n` +
          `🎯 TP2: *$${tp2.toLocaleString()}*\n\n`;
      }

      msg +=
        `📊 RSI: ${rsi}\n` +
        `📈 EMA20: ${Math.round(ema20).toLocaleString()} | EMA50: ${Math.round(ema50).toLocaleString()}\n` +
        `📉 ATR: ${Math.round(atr)}\n` +
        `🔵 Support: $${Math.round(support).toLocaleString()}\n` +
        `🔴 Résistance: $${Math.round(resistance).toLocaleString()}\n\n` +
        `_Not financial advice_`;

      await sendTelegram(msg);
      console.log(`Telegram envoyé: ${prevAction} → ${action}`);
    }

    prevAction = action;

  } catch (e) {
    console.error("Erreur:", e.message);
  }
}

console.log("BTC Signal Bot démarré");
sendTelegram("🤖 *BTC Signal Bot démarré*\nSurveillance BTC/USD M5 active.");
run();
setInterval(run, 60000);
