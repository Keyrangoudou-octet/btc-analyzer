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
    const req = https.request({ hostname: u.hostname, path: u.pathname, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": data.length } }, res => {
      res.on("data", () => {});
      res.on("end", resolve);
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function sendTelegram(msg) {
  return post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, { chat_id: CHAT_ID, text: msg, parse_mode: "HTML" });
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
    const d = closes[i] - closes[i-1];
    if (d > 0) ag += d; else al -= d;
  }
  ag /= p; al /= p;
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    ag = (ag * (p-1) + Math.max(d, 0)) / p;
    al = (al * (p-1) + Math.max(-d, 0)) / p;
  }
  return al === 0 ? 100 : Math.round(100 - 100 / (1 + ag / al));
}

let prevAction = null;

async function run() {
  try {
    const data = await get("https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=5");
    const candles = Object.values(data.result)[0].slice(-100);
    const closes = candles.map(c => parseFloat(c[4]));
    const highs  = candles.map(c => parseFloat(c[2]));
    const lows   = candles.map(c => parseFloat(c[3]));

    const price = closes[closes.length - 1];
    const ema20 = calcEMA(closes, 20);
    const ema50 = calcEMA(closes, 50);
    const rsi   = calcRSI(closes);
    const support    = Math.min(...lows.slice(-20));
    const resistance = Math.max(...highs.slice(-20));

    let score = 0;
    if (ema20 > ema50) score += 2; else score -= 2;
    if (rsi < 35) score += 1;
    else if (rsi > 65) score -= 1;
    else if (rsi > 50) score += 1;
    else score -= 1;

    const action = score >= 2 ? "ACHÈTE 🟢" : score <= -2 ? "VENDS 🔴" : "ATTENDS 🟡";

    console.log(`${new Date().toISOString()} | ${action} | $${price.toFixed(0)} | RSI: ${rsi} | Score: ${score}`);

    if (prevAction !== null && action !== prevAction) {
      await sendTelegram(
        `🔔 <b>SIGNAL BTC CHANGÉ</b>\n\n<b>${action}</b>\n\n💰 Prix: <b>$${price.toLocaleString()}</b>\n📊 RSI: ${rsi}\n📈 EMA20: ${ema20.toFixed(0)} | EMA50: ${ema50.toFixed(0)}\n🎯 Support: $${support.toFixed(0)}\n🎯 Résistance: $${resistance.toFixed(0)}\n\n<i>Not financial advice</i>`
      );
      console.log(`✅ Telegram envoyé: ${prevAction} → ${action}`);
    }
    prevAction = action;
  } catch(e) {
    console.error("Erreur:", e.message);
  }
}

console.log("BTC Signal Bot démarré ✅");
sendTelegram("🤖 <b>BTC Signal Bot démarré</b>\nSurveillance BTC/USD M5 active.");
run();
setInterval(run, 60000);
