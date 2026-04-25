const express = require("express");
const fetch = require("node-fetch");

const app = express();
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

async function fetchBTCCandles(interval = "5m", limit = 150) {
  const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  const data = await res.json();
  return data.map(k => ({
    time:  k[0],
    open:  parseFloat(k[1]),
    high:  parseFloat(k[2]),
    low:   parseFloat(k[3]),
    close: parseFloat(k[4]),
    vol:   parseFloat(k[5]),
  }));
}

// ─────────────────────────────────────────────
//  API ENDPOINT
// ─────────────────────────────────────────────

app.get("/analyze", async (req, res) => {
  try {
    if (lastSignal) {
      return res.json({ ok: true, signal: lastSignal, updatedAt: lastSignal.updatedAt });
    }
    const candles = await fetchBTCCandles("5m", 150);
    const signal  = generateSignal(candles);
    signal.updatedAt = new Date().toISOString();
    lastSignal = signal;
    res.json({ ok: true, signal, updatedAt: signal.updatedAt });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─────────────────────────────────────────────
//  FRONTEND HTML (servi directement)
// ─────────────────────────────────────────────

app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>BTC Analyzer</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;600&family=Bebas+Neue&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#080c14;color:#e0e8f0;font-family:'IBM Plex Mono',monospace;min-height:100vh;overflow-x:hidden}
.grid{position:fixed;top:0;left:0;right:0;bottom:0;background-image:linear-gradient(rgba(0,212,170,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(0,212,170,.03) 1px,transparent 1px);background-size:40px 40px;pointer-events:none;z-index:0}
.scan{position:fixed;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,rgba(0,212,170,.6),transparent);animation:sc 4s linear infinite;pointer-events:none;z-index:1}
@keyframes sc{0%{top:0}100%{top:100vh}}
.ticker-wrap{overflow:hidden;white-space:nowrap;background:rgba(0,212,170,.06);border-top:1px solid rgba(0,212,170,.15);border-bottom:1px solid rgba(0,212,170,.15);padding:7px 0}
.ticker{display:inline-block;animation:tkr 20s linear infinite;font-size:11px;color:rgba(0,212,170,.7);letter-spacing:2px}
@keyframes tkr{0%{transform:translateX(100vw)}100%{transform:translateX(-100%)}}
.wrap{position:relative;z-index:2;padding:0 16px 40px}
.header{padding:22px 0 8px}
.tag{font-size:10px;letter-spacing:3px;color:#00d4aa;opacity:.7;text-transform:uppercase}
h1{font-family:'Bebas Neue',sans-serif;font-size:52px;letter-spacing:4px;line-height:1;background:linear-gradient(135deg,#fff 40%,#00d4aa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-top:2px}
.subtitle{font-size:11px;color:rgba(224,232,240,.35);margin-top:6px;letter-spacing:1px}

/* SIGNAL CARD */
.signal-card{border-radius:6px;padding:24px 20px;margin:20px 0 12px;position:relative;overflow:hidden;transition:all .3s}
.signal-card.buy {background:linear-gradient(135deg,rgba(0,212,170,.12),rgba(0,212,170,.04));border:1px solid rgba(0,212,170,.4)}
.signal-card.sell{background:linear-gradient(135deg,rgba(255,71,87,.12),rgba(255,71,87,.04));border:1px solid rgba(255,71,87,.4)}
.signal-card.wait{background:linear-gradient(135deg,rgba(255,165,2,.1),rgba(255,165,2,.03));border:1px solid rgba(255,165,2,.35)}
.signal-glow{position:absolute;top:-40px;right:-40px;width:120px;height:120px;border-radius:50%;filter:blur(50px);opacity:.3}
.buy  .signal-glow{background:#00d4aa}
.sell .signal-glow{background:#ff4757}
.wait .signal-glow{background:#ffa502}
.action-label{font-size:11px;letter-spacing:3px;color:rgba(224,232,240,.45);margin-bottom:8px}
.action-text{font-family:'Bebas Neue',sans-serif;font-size:72px;letter-spacing:6px;line-height:1}
.buy  .action-text{color:#00d4aa}
.sell .action-text{color:#ff4757}
.wait .action-text{color:#ffa502}
.action-sub{font-size:11px;margin-top:6px;letter-spacing:1px;opacity:.6}
.confidence-row{display:flex;justify-content:space-between;align-items:center;margin-top:16px}
.conf-label{font-size:10px;letter-spacing:2px;color:rgba(224,232,240,.4)}
.conf-value{font-family:'Bebas Neue',sans-serif;font-size:28px;color:#fff}
.conf-bar{height:3px;background:rgba(255,255,255,.08);border-radius:2px;margin-top:6px;overflow:hidden}
.conf-fill{height:100%;border-radius:2px;transition:width 1s ease}
.buy  .conf-fill{background:#00d4aa}
.sell .conf-fill{background:#ff4757}
.wait .conf-fill{background:#ffa502}

/* PRICE */
.price-row{display:flex;align-items:baseline;gap:8px;margin-bottom:20px}
.price-val{font-family:'Bebas Neue',sans-serif;font-size:36px;color:#fff;letter-spacing:2px}
.price-sym{font-size:12px;color:rgba(224,232,240,.4);letter-spacing:2px}

/* GRID CARDS */
.grid-cards{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
.mc{background:rgba(13,20,32,.85);border:1px solid rgba(255,255,255,.06);border-radius:4px;padding:14px;position:relative;overflow:hidden}
.mc::before{content:'';position:absolute;top:0;left:0;width:2px;height:100%}
.mc.g::before{background:#00d4aa}.mc.r::before{background:#ff4757}.mc.y::before{background:#ffa502}.mc.b::before{background:#0099cc}
.mc-label{font-size:10px;color:rgba(224,232,240,.35);letter-spacing:2px;margin-bottom:6px;text-transform:uppercase}
.mc-val{font-family:'Bebas Neue',sans-serif;font-size:26px;letter-spacing:2px}
.mc.g .mc-val{color:#00d4aa}.mc.r .mc-val{color:#ff4757}.mc.y .mc-val{color:#ffa502}.mc.b .mc-val{color:#0099cc}
.mc-sub{font-size:10px;color:rgba(224,232,240,.3);margin-top:3px}

/* REASONS */
.reasons-card{background:rgba(13,20,32,.85);border:1px solid rgba(255,255,255,.06);border-radius:4px;padding:16px;margin-bottom:8px}
.reasons-title{font-size:10px;letter-spacing:2px;color:rgba(224,232,240,.4);margin-bottom:12px;text-transform:uppercase}
.reason{display:flex;align-items:flex-start;gap:8px;margin-bottom:8px;font-size:12px;line-height:1.5;color:rgba(224,232,240,.75)}
.reason:last-child{margin-bottom:0}
.reason-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0;margin-top:5px}
.reason-dot.bull{background:#00d4aa}.reason-dot.bear{background:#ff4757}

/* LEVELS */
.levels-card{background:rgba(13,20,32,.85);border:1px solid rgba(255,255,255,.06);border-radius:4px;padding:16px;margin-bottom:8px}
.levels-title{font-size:10px;letter-spacing:2px;color:rgba(224,232,240,.4);margin-bottom:12px;text-transform:uppercase}
.levels-row{display:flex;gap:24px}
.level-item .lv-label{font-size:10px;letter-spacing:1px;margin-bottom:2px}
.level-item .lv-val{font-family:'Bebas Neue',sans-serif;font-size:22px}
.lv-support .lv-label{color:#00d4aa}.lv-support .lv-val{color:#00d4aa}
.lv-resist  .lv-label{color:#ff4757}.lv-resist  .lv-val{color:#ff4757}

/* REFRESH */
.refresh-btn{width:100%;padding:14px;background:transparent;border:1px solid rgba(0,212,170,.25);color:rgba(0,212,170,.7);font-family:'IBM Plex Mono',monospace;font-size:12px;letter-spacing:2px;cursor:pointer;border-radius:4px;text-transform:uppercase;transition:all .2s;margin-top:8px}
.refresh-btn:hover{border-color:rgba(0,212,170,.7);color:#00d4aa;background:rgba(0,212,170,.05)}
.refresh-btn:disabled{opacity:.4;cursor:not-allowed}
.auto-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.auto-label{font-size:11px;color:rgba(224,232,240,.4);letter-spacing:1px}
.toggle{position:relative;width:44px;height:24px;cursor:pointer}
.toggle input{opacity:0;width:0;height:0}
.slider{position:absolute;top:0;left:0;right:0;bottom:0;background:#1a2a3a;border-radius:24px;transition:.3s}
.slider::before{content:'';position:absolute;width:18px;height:18px;left:3px;bottom:3px;background:#fff;border-radius:50%;transition:.3s}
input:checked+.slider{background:#00d4aa}
input:checked+.slider::before{transform:translateX(20px)}
.updated{font-size:10px;color:rgba(224,232,240,.25);text-align:center;margin-top:12px;letter-spacing:1px}
.loading{text-align:center;padding:60px 0;font-size:13px;color:rgba(0,212,170,.6);letter-spacing:2px}
.pulse{animation:p 1s ease-in-out infinite}
@keyframes p{0%,100%{opacity:.3}50%{opacity:1}}
.error{background:rgba(255,71,87,.08);border:1px solid rgba(255,71,87,.3);border-radius:4px;padding:14px;color:#ff6b7a;font-size:12px;margin-top:16px}
.appear{animation:fup .4s ease}
@keyframes fup{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
footer{text-align:center;padding:20px;font-size:10px;color:rgba(224,232,240,.15);letter-spacing:2px;border-top:1px solid rgba(255,255,255,.04)}
</style>
</head>
<body>
<div class="grid"></div>
<div class="scan"></div>
<div class="ticker-wrap"><span class="ticker">BTC/USDT &nbsp;▸&nbsp; ANALYSE M5 &nbsp;▸&nbsp; EMA · RSI · MACD · BOLLINGER · ADX &nbsp;▸&nbsp; BTC/USDT &nbsp;▸&nbsp; ANALYSE M5 &nbsp;▸&nbsp; EMA · RSI · MACD · BOLLINGER · ADX &nbsp;▸&nbsp;</span></div>

<div class="wrap">
  <div class="header">
    <div class="tag">BTC Analyzer — Live M5</div>
    <h1>BTC<br>SIGNAL</h1>
    <p class="subtitle">Analyse temps réel · 5 indicateurs · Signal clair</p>
  </div>

  <div class="auto-row">
    <span class="auto-label">🔄 Auto-refresh (30s)</span>
    <label class="toggle"><input type="checkbox" id="autoToggle" checked onchange="toggleAuto()"><span class="slider"></span></label>
  </div>

  <button id="notifBtn" onclick="requestNotifPermission()" class="refresh-btn" style="margin-bottom:8px;border-color:rgba(255,165,2,.4);color:#ffa502">🔕 Activer les notifications</button>
  <div id="content"><div class="loading"><span class="pulse">⬤ CHARGEMENT...</span></div></div>

  <button class="refresh-btn" id="refreshBtn" onclick="load()">↻ ACTUALISER MAINTENANT</button>
  <div class="updated" id="updatedAt"></div>
</div>

<footer>BTC ANALYZER · NOT FINANCIAL ADVICE · DATA: BINANCE</footer>

<script>
let autoInterval = null;

function toggleAuto() {
  const on = document.getElementById('autoToggle').checked;
  if (on) { autoInterval = setInterval(load, 30000); }
  else    { clearInterval(autoInterval); }
}

function fmt(n) {
  return Number(n).toLocaleString('fr-FR', {minimumFractionDigits:1, maximumFractionDigits:1});
}

async function load() {
  const btn = document.getElementById('refreshBtn');
  btn.disabled = true;
  btn.textContent = '⬤ ANALYSE EN COURS...';

  try {
    const res  = await fetch('/analyze');
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    render(data.signal, data.updatedAt);
  } catch(e) {
    document.getElementById('content').innerHTML =
      '<div class="error">⚠ Erreur: ' + e.message + '</div>';
  } finally {
    btn.disabled = false;
    btn.textContent = '↻ ACTUALISER MAINTENANT';
  }
}

function render(s, updatedAt) {
  const actionFR = s.action === 'ACHÈTE' ? 'ACHÈTE' : s.action === 'VENDS' ? 'VENDS' : 'ATTENDS';
  const subText  = s.action === 'ACHÈTE' ? '→ Signal haussier détecté' :
                   s.action === 'VENDS'  ? '→ Signal baissier détecté' :
                                           '→ Pas de signal clair, reste en dehors';

  const reasonsHTML = s.reasons.map(r =>
    '<div class="reason"><div class="reason-dot ' + (r.bull ? 'bull' : 'bear') + '"></div><span>' + r.text + '</span></div>'
  ).join('');

  document.getElementById('content').innerHTML = \`
  <div class="appear">
    <div class="price-row">
      <span class="price-val">\${fmt(s.price)}</span>
      <span class="price-sym">USDT</span>
    </div>

    <div class="signal-card \${s.color}">
      <div class="signal-glow"></div>
      <div class="action-label">DÉCISION IA</div>
      <div class="action-text">\${actionFR}</div>
      <div class="action-sub">\${subText}</div>
      <div class="confidence-row">
        <div>
          <div class="conf-label">CONFIANCE</div>
          <div class="conf-value">\${s.confidence}%</div>
        </div>
        <div style="text-align:right">
          <div class="conf-label">SCORE</div>
          <div class="conf-value">\${s.score > 0 ? '+' : ''}\${s.score}</div>
        </div>
      </div>
      <div class="conf-bar"><div class="conf-fill" style="width:\${s.confidence}%"></div></div>
    </div>

    <div class="grid-cards">
      <div class="mc \${parseFloat(s.rsi) < 30 ? 'g' : parseFloat(s.rsi) > 70 ? 'r' : 'b'}">
        <div class="mc-label">RSI 14</div>
        <div class="mc-val">\${s.rsi}</div>
        <div class="mc-sub">\${parseFloat(s.rsi) < 30 ? 'Oversold' : parseFloat(s.rsi) > 70 ? 'Overbought' : 'Neutre'}</div>
      </div>
      <div class="mc \${parseFloat(s.adx) > 25 ? 'g' : 'y'}">
        <div class="mc-label">ADX</div>
        <div class="mc-val">\${s.adx}</div>
        <div class="mc-sub">Trend \${s.trendStrength}</div>
      </div>
      <div class="mc \${parseFloat(s.ema20) > parseFloat(s.ema50) ? 'g' : 'r'}">
        <div class="mc-label">EMA 20</div>
        <div class="mc-val">\${fmt(s.ema20)}</div>
        <div class="mc-sub">\${parseFloat(s.ema20) > parseFloat(s.ema50) ? '▲ Au-dessus EMA50' : '▼ En-dessous EMA50'}</div>
      </div>
      <div class="mc \${parseFloat(s.macdHist) > 0 ? 'g' : 'r'}">
        <div class="mc-label">MACD Hist.</div>
        <div class="mc-val">\${s.macdHist}</div>
        <div class="mc-sub">\${parseFloat(s.macdHist) > 0 ? 'Haussier' : 'Baissier'}</div>
      </div>
    </div>

    <div class="levels-card">
      <div class="levels-title">Niveaux clés (20 bougies)</div>
      <div class="levels-row">
        <div class="level-item lv-support">
          <div class="lv-label">▲ SUPPORT</div>
          <div class="lv-val">\${fmt(s.support)}</div>
        </div>
        <div class="level-item lv-resist">
          <div class="lv-label">▼ RÉSISTANCE</div>
          <div class="lv-val">\${fmt(s.resistance)}</div>
        </div>
        <div class="level-item" style="margin-left:auto;text-align:right">
          <div class="lv-label" style="color:rgba(224,232,240,.35)">BB Upper</div>
          <div class="lv-val" style="color:rgba(224,232,240,.5);font-family:'Bebas Neue';font-size:22px">\${fmt(s.bbUpper)}</div>
        </div>
      </div>
    </div>

    <div class="reasons-card">
      <div class="reasons-title">⬡ Pourquoi ce signal</div>
      \${reasonsHTML}
    </div>
  </div>\`;

  const d = new Date(updatedAt);
  document.getElementById('updatedAt').textContent =
    'Mis à jour à ' + d.toLocaleTimeString('fr-FR');
}

// ── PUSH NOTIFICATIONS ──────────────────────
let notifPermission = Notification.permission;
let prevSignalAction = null;

async function requestNotifPermission() {
  if (!('Notification' in window)) {
    alert("Ton navigateur ne supporte pas les notifications.");
    return;
  }
  const perm = await Notification.requestPermission();
  notifPermission = perm;
  updateNotifBtn();
}

function updateNotifBtn() {
  const btn = document.getElementById('notifBtn');
  if (!btn) return;
  if (notifPermission === 'granted') {
    btn.textContent = '🔔 Notifications activées';
    btn.style.borderColor = 'rgba(0,212,170,.6)';
    btn.style.color = '#00d4aa';
  } else {
    btn.textContent = '🔕 Activer les notifications';
    btn.style.borderColor = 'rgba(255,165,2,.4)';
    btn.style.color = '#ffa502';
  }
}

function sendNotif(action, confidence) {
  if (notifPermission !== 'granted') return;
  const icons = { 'ACHÈTE': '🟢', 'VENDS': '🔴', 'ATTENDS': '🟡' };
  new Notification('BTC Signal — ' + icons[action] + ' ' + action, {
    body: 'Confiance: ' + confidence + '% · Nouveau signal détecté sur BTC/USDT M5',
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    tag: 'btc-signal',
    renotify: true,
  });
}

// ── SSE — écoute le serveur en temps réel ──
function startSSE() {
  const es = new EventSource('/stream');
  es.onmessage = (e) => {
    const signal = JSON.parse(e.data);
    render(signal, signal.updatedAt);

    // Notif si signal change
    if (prevSignalAction && signal.action !== prevSignalAction && signal.action !== 'ATTENDS') {
      sendNotif(signal.action, signal.confidence);
    }
    prevSignalAction = signal.action;
  };
  es.onerror = () => {
    // Fallback polling si SSE fail
    setTimeout(() => es.close(), 1000);
    load();
    autoInterval = setInterval(load, 30000);
  };
}

// Start
load();
startSSE();
</script>
</body>
</html>`);
});


// ─────────────────────────────────────────────
//  PUSH NOTIFICATIONS (Web Push via VAPID-free)
//  On utilise l'API Notification native du browser
//  Le serveur envoie le dernier signal via SSE
// ─────────────────────────────────────────────

// Cache du dernier signal pour SSE
let lastSignal = null;
let sseClients = [];

// SSE endpoint — le browser écoute en continu
app.get("/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Envoie le signal actuel immédiatement si dispo
  if (lastSignal) {
    res.write("data: " + JSON.stringify(lastSignal) + "\n\n");
  }

  sseClients.push(res);

  req.on("close", () => {
    sseClients = sseClients.filter(c => c !== res);
  });
});

// Broadcast aux clients SSE connectés
function broadcast(signal) {
  const data = "data: " + JSON.stringify(signal) + "\n\n";
  sseClients.forEach(c => c.write(data));
}

// Analyse automatique server-side toutes les 30s
let prevAction = null;
async function serverLoop() {
  try {
    const candles = await fetchBTCCandles("5m", 150);
    const signal  = generateSignal(candles);
    signal.updatedAt = new Date().toISOString();
    lastSignal = signal;

    // Broadcast à tous les clients connectés
    broadcast(signal);

    // Log si changement de signal
    if (signal.action !== prevAction) {
      console.log("Signal changé:", prevAction, "→", signal.action);
      prevAction = signal.action;
    }
  } catch(e) {
    console.error("Loop error:", e.message);
  }
}

// Lance la boucle serveur dès le démarrage
serverLoop();
setInterval(serverLoop, 30000);

app.listen(PORT, () => console.log(`BTC Analyzer running on port ${PORT}`));
