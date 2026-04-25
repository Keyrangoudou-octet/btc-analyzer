import requests
import time
import os

TELEGRAM_TOKEN = os.environ.get("TELEGRAM_TOKEN")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID")

def send_telegram(msg):
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    requests.post(url, json={
        "chat_id": TELEGRAM_CHAT_ID,
        "text": msg,
        "parse_mode": "HTML"
    })

def get_btc_candles():
    # Kraken public API - no restrictions
    url = "https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=5"
    r = requests.get(url, timeout=10)
    data = r.json()
    candles = list(data["result"].values())[0]
    return [{
        "close": float(c[4]),
        "high":  float(c[2]),
        "low":   float(c[3]),
    } for c in candles[-100:]]

def calc_ema(values, period):
    k = 2 / (period + 1)
    ema = sum(values[:period]) / period
    for v in values[period:]:
        ema = v * k + ema * (1 - k)
    return ema

def calc_rsi(closes, period=14):
    gains, losses = [], []
    for i in range(1, len(closes)):
        diff = closes[i] - closes[i-1]
        gains.append(max(diff, 0))
        losses.append(max(-diff, 0))
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period
    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period-1) + gains[i]) / period
        avg_loss = (avg_loss * (period-1) + losses[i]) / period
    if avg_loss == 0:
        return 100
    rs = avg_gain / avg_loss
    return round(100 - 100 / (1 + rs), 1)

def analyze(candles):
    closes = [c["close"] for c in candles]
    highs  = [c["high"]  for c in candles]
    lows   = [c["low"]   for c in candles]

    price = closes[-1]
    ema20 = calc_ema(closes, 20)
    ema50 = calc_ema(closes, 50)
    rsi   = calc_rsi(closes)

    support    = min(lows[-20:])
    resistance = max(highs[-20:])

    score = 0
    if ema20 > ema50:  score += 2
    else:              score -= 2
    if rsi < 35:       score += 1
    elif rsi > 65:     score -= 1
    elif rsi > 50:     score += 1
    else:              score -= 1

    if score >= 2:     action = "ACHÈTE 🟢"
    elif score <= -2:  action = "VENDS 🔴"
    else:              action = "ATTENDS 🟡"

    return {
        "action": action,
        "price": price,
        "rsi": rsi,
        "ema20": round(ema20, 1),
        "ema50": round(ema50, 1),
        "support": round(support, 1),
        "resistance": round(resistance, 1),
        "score": score
    }

def main():
    print("BTC Signal Bot démarré ✅")
    send_telegram("🤖 <b>BTC Signal Bot démarré</b>\nJe surveille le BTC/USD M5 en temps réel.")

    prev_action = None

    while True:
        try:
            candles = get_btc_candles()
            s = analyze(candles)
            action = s["action"]

            print(f"Signal: {action} | Prix: ${s['price']:,.0f} | RSI: {s['rsi']} | Score: {s['score']}")

            # Envoie une alerte seulement si le signal change
            if prev_action is not None and action != prev_action:
                msg = (
                    f"<b>🔔 SIGNAL BTC CHANGÉ</b>\n\n"
                    f"<b>{action}</b>\n\n"
                    f"💰 Prix: <b>${s['price']:,.0f}</b>\n"
                    f"📊 RSI: {s['rsi']}\n"
                    f"📈 EMA20: {s['ema20']} | EMA50: {s['ema50']}\n"
                    f"🎯 Support: ${s['support']:,.0f}\n"
                    f"🎯 Résistance: ${s['resistance']:,.0f}\n\n"
                    f"<i>Not financial advice</i>"
                )
                send_telegram(msg)
                print(f"✅ Alerte Telegram envoyée: {prev_action} → {action}")

            prev_action = action

        except Exception as e:
            print(f"Erreur: {e}")

        time.sleep(60)  # Vérifie toutes les 60 secondes

if __name__ == "__main__":
    main()
