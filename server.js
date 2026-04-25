const express = require("express");
const fetch = require("node-fetch");

const app = express();

// ─────────────────────────────────────────────
//  TELEGRAM NOTIFICATIONS
// ─────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegram(message) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "HTML"
      })
    });
  } catch(e) {
    console.error("Telegram error:", e.message);
  }
}
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
//  INDICATEURS TECHNIQUES (calcul pur JS)
// ─────────────────────────────────────────────

function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const result = new Array(period - 1).fill(null);
  result.push(ema);
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

function calcRSI(closes, period = 14) {
  const result = new Array(period).fill(null);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return result;
}

function calcMACD(closes) {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdLine = ema12.map((v, i) => (v !== null && ema26[i] !== null) ? v - ema26[i] : null);
  const validMacd = macdLine.filter(v => v !== null);
  const signalRaw = calcEMA(validMacd, 9);
  const signal = new Array(macdLine.length - validMacd.length).fill(null).concat(
    new Array(validMacd.length - signalRaw.length).fill(null).concat(signalRaw)
  );
  const histogram = macdLine.map((v, i) => (v !== null && signal[i] !== null) ? v - signal[i] : null);
  return { macdLine, signal, histogram };
}

function calcBB(closes, period = 20, mult = 2) {
  const result = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { result.push(null); continue; }
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
    result.push({ upper: mean + mult * std, mid: mean, lower: mean - mult * std });
  }
  return result;
}

function calcADX(highs, lows, closes, period = 14) {
  const result = new Array(period * 2).fill(null);
  let trSum = 0, dmPSum = 0, dmMSum = 0;

  for (let i = 1; i <= period; i++) {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
    const dmP = highs[i] - highs[i-1] > lows[i-1] - lows[i] ? Math.max(highs[i] - highs[i-1], 0) : 0;
    const dmM = lows[i-1] - lows[i] > highs[i] - highs[i-1] ? Math.max(lows[i-1] - lows[i], 0) : 0;
    trSum += tr; dmPSum += dmP; dmMSum += dmM;
  }

  let diP = 100 * dmPSum / trSum;
  let diM = 100 * dmMSum / trSum;
  let dx = Math.abs(diP - diM) / (diP + diM) * 100;
  let adx = dx;

  for (let i = period + 1; i < closes.length; i++) {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
    const dmP = highs[i] - highs[i-1] > lows[i-1] - lows[i] ? Math.max(highs[i] - highs[i-1], 0) : 0;
    const dmM = lows[i-1] - lows[i] > highs[i] - highs[i-1] ? Math.max(lows[i-1] - lows[i], 0) : 0;
    trSum = trSum - trSum / period + tr;
    dmPSum = dmPSum - dmPSum / period + dmP;
    dmMSum = dmMSum - dmMSum / period + dmM;
    diP = 100 * dmPSum / trSum;
    diM = 100 * dmMSum / trSum;
    dx = Math.abs(diP - diM) / (diP + diM + 0.0001) * 100;
    adx = (adx * (period - 1) + dx) / period;
    if (i >= period * 2) result.push({ adx, diP, diM });
  }
  return result;
}

// ─────────────────────────────────────────────
//  LOGIQUE DE SIGNAL
// ─────────────────────────────────────────────

function generateSignal(candles) {
  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const n = closes.length - 1; // dernière bougie

  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  const rsi   = calcRSI(closes, 14);
  const macd  = calcMACD(closes);
  const bb    = calcBB(closes, 20);
  const adxData = calcADX(highs, lows, closes, 14);

  const price    = closes[n];
  const ema20v   = ema20[n];
  const ema50v   = ema50[n];
  const ema20p   = ema20[n-1];
  const ema50p   = ema50[n-1];
  const rsiV     = rsi[n];
  const macdV    = macd.macdLine[n];
  const macdSig  = macd.signal[n];
  const macdH    = macd.histogram[n];
  const macdHp   = macd.histogram[n-1];
  const bbV      = bb[n];
  const adxV     = adxData[adxData.length - 1];

  // Score system: +1 / -1 par condition
  let score = 0;
  const reasons = [];

  // EMA trend
  if (ema20v > ema50v) { score += 2; reasons.push({ bull: true, text: "EMA20 > EMA50 (tendance haussière)" }); }
  else                  { score -= 2; reasons.push({ bull: false, text: "EMA20 < EMA50 (tendance baissière)" }); }

  // EMA cross
  if (ema20v > ema50v && ema20p <= ema50p) { score += 2; reasons.push({ bull: true, text: "Croisement EMA haussier vient de se former" }); }
  if (ema20v < ema50v && ema20p >= ema50p) { score -= 2; reasons.push({ bull: false, text: "Croisement EMA baissier vient de se former" }); }

  // RSI
  if (rsiV < 30)      { score += 1; reasons.push({ bull: true,  text: `RSI ${rsiV.toFixed(1)} — Zone oversold (rebond possible)` }); }
  else if (rsiV > 70) { score -= 1; reasons.push({ bull: false, text: `RSI ${rsiV.toFixed(1)} — Zone overbought (risque de retournement)` }); }
  else if (rsiV > 50) { score += 1; reasons.push({ bull: true,  text: `RSI ${rsiV.toFixed(1)} — Au-dessus de 50 (momentum haussier)` }); }
  else                { score -= 1; reasons.push({ bull: false, text: `RSI ${rsiV.toFixed(1)} — En-dessous de 50 (momentum baissier)` }); }

  // MACD
  if (macdV > macdSig && macdH > 0 && macdH > macdHp) { score += 2; reasons.push({ bull: true,  text: "MACD au-dessus signal et histogramme croissant" }); }
  else if (macdV < macdSig && macdH < 0 && macdH < macdHp) { score -= 2; reasons.push({ bull: false, text: "MACD en-dessous signal et histogramme décroissant" }); }
  else if (macdV > macdSig) { score += 1; reasons.push({ bull: true,  text: "MACD au-dessus de la ligne signal" }); }
  else                       { score -= 1; reasons.push({ bull: false, text: "MACD en-dessous de la ligne signal" }); }

  // Bollinger Bands
  if (bbV) {
    if (price < bbV.lower) { score += 1; reasons.push({ bull: true,  text: "Prix sous la bande inférieure de Bollinger (survente)" }); }
    else if (price > bbV.upper) { score -= 1; reasons.push({ bull: false, text: "Prix au-dessus de la bande supérieure de Bollinger (surachat)" }); }
    else if (price > bbV.mid)   { score += 1; reasons.push({ bull: true,  text: "Prix au-dessus de la moyenne Bollinger" }); }
    else                         { score -= 1; reasons.push({ bull: false, text: "Prix en-dessous de la moyenne Bollinger" }); }
  }

  // ADX — force du trend
  let trendStrength = "Faible";
  if (adxV) {
    if (adxV.adx > 40)      trendStrength = "Fort";
    else if (adxV.adx > 25) trendStrength = "Modéré";
    reasons.push({ bull: adxV.diP > adxV.diM, text: `ADX ${adxV.adx.toFixed(1)} — Tendance ${trendStrength}` });
    if (adxV.adx < 20) { score = Math.round(score * 0.5); } // Réduit le signal en range
  }

  // Décision finale
  const maxScore = 10;
  const confidence = Math.min(Math.abs(score) / maxScore * 100, 100);

  let action, color;
  if (score >= 4)       { action = "ACHÈTE";  color = "buy"; }
  else if (score <= -4) { action = "VENDS";   color = "sell"; }
  else                  { action = "ATTENDS"; color = "wait"; }

  // Support / Résistance simples (plus haut/bas des 20 dernières bougies)
  const recent = candles.slice(-20);
  const support    = Math.min(...recent.map(c => c.low));
  const resistance = Math.max(...recent.map(c => c.high));

  return {
    action,
    color,
    score,
    confidence: Math.round(confidence),
    price,
    rsi: rsiV?.toFixed(1),
    ema20: ema20v?.toFixed(1),
    ema50: ema50v?.toFixed(1),
    adx: adxV?.adx.toFixed(1),
    macdHist: macdH?.toFixed(2),
    support: support.toFixed(1),
    resistance: resistance.toFixed(1),
    bbUpper: bbV?.upper.toFixed(1),
    bbLower: bbV?.lower.toFixed(1),
    trendStrength,
    reasons,
  };
}

// ─────────────────────────────────────────────
//  FETCH BINANCE
// ─────────────────────────────────────────────

async function fetchBTCCandles() {
  // Kraken OHLC API — no geo restrictions worldwide
  // interval=5 = 5 minutes, last 150 candles
  const url = "https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=5";
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }
  });
  if (!res.ok) throw new Error("Kraken HTTP " + res.status);
  const data = await res.json();
  if (data.error && data.error.length > 0) {
    throw new Error("Kraken error: " + data.error.join(", "));
  }
  // Kraken format: [time, open, high, low, close, vwap, volume, count]
  const candles = data.result?.XXBTZUSD || data.result?.XBTUSD || Object.values(data.result || {})[0];
  if (!Array.isArray(candles) || candles.length === 0) {
    throw new Error("Kraken bad response: " + JSON.stringify(data).slice(0, 100));
  }
  return candles.slice(-150).map(k => ({
    time:  k[0] * 1000,
    open:  parseFloat(k[1]),
    high:  parseFloat(k[2]),
    low:   parseFloat(k[3]),
    close: parseFloat(k[4]),
    vol:   parseFloat(k[6]),
  }));
}


