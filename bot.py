import requests
import time
import os
from datetime import datetime, timezone

TELEGRAM_TOKEN = os.environ.get("TELEGRAM_TOKEN")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID")

def send_telegram(msg):
    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT_ID:
        print("Telegram non configuré")
        return
    try:
        url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
        requests.post(url, json={"chat_id": TELEGRAM_CHAT_ID, "text": msg, "parse_mode": "Markdown"}, timeout=10)
    except Exception as e:
        print(f"Telegram erreur: {e}")

def get_session():
    now = datetime.now(timezone.utc)
    t = now.hour * 60 + now.minute
    if 7*60 <= t <= 10*60: return "London 🇬🇧"
    if 12*60+30 <= t <= 15*60+30: return "New York 🇺🇸"
    return None

def is_weekend():
    return datetime.now(timezone.utc).weekday() >= 5

def fetch_btc_candles():
    url = "https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=5"
    r = requests.get(url, timeout=15, headers={"User-Agent": "Mozilla/5.0"})
    data = r.json()
    if data.get("error"):
        raise Exception(f"Kraken error: {data['error']}")
    candles_raw = list(data["result"].values())[0]
    return [{"open": float(c[1]), "high": float(c[2]), "low": float(c[3]), "close": float(c[4])} for c in candles_raw[-250:]]

def calc_atr(candles, period=14):
    atr = sum(max(candles[i]["high"]-candles[i]["low"], abs(candles[i]["high"]-candles[i-1]["close"]), abs(candles[i]["low"]-candles[i-1]["close"])) for i in range(1, period+1)) / period
    for i in range(period+1, len(candles)):
        tr = max(candles[i]["high"]-candles[i]["low"], abs(candles[i]["high"]-candles[i-1]["close"]), abs(candles[i]["low"]-candles[i-1]["close"]))
        atr = (atr*(period-1)+tr)/period
    return atr

def calc_ema(values, period):
    k = 2/(period+1)
    ema = sum(values[:period])/period
    for v in values[period:]: ema = v*k + ema*(1-k)
    return ema

def get_swings(candles, lookback=5):
    highs, lows = [], []
    for i in range(lookback, len(candles)-lookback):
        sl = candles[i-lookback:i+lookback+1]
        if candles[i]["high"] == max(c["high"] for c in sl): highs.append({"i":i,"price":candles[i]["high"]})
        if candles[i]["low"]  == min(c["low"]  for c in sl): lows.append({"i":i,"price":candles[i]["low"]})
    return highs, lows

def detect_choch(candles, sh, sl):
    last = candles[-1]
    if len(sh)>=2 and sh[-2]["price"]>sh[-1]["price"] and last["close"]>sh[-1]["price"]:
        return {"type":"BULLISH_CHOCH","level":sh[-1]["price"]}
    if len(sl)>=2 and sl[-2]["price"]<sl[-1]["price"] and last["close"]<sl[-1]["price"]:
        return {"type":"BEARISH_CHOCH","level":sl[-1]["price"]}
    return None

def detect_sweep(candles, sh, sl):
    last, prev = candles[-1], candles[-2]
    for s in sl[-4:]:
        if (prev["low"]<s["price"] and prev["close"]>s["price"] and last["close"]>s["price"]) or (last["low"]<s["price"] and last["close"]>s["price"]):
            return {"type":"BULLISH_SWEEP","level":s["price"]}
    for s in sh[-4:]:
        if (prev["high"]>s["price"] and prev["close"]<s["price"] and last["close"]<s["price"]) or (last["high"]>s["price"] and last["close"]<s["price"]):
            return {"type":"BEARISH_SWEEP","level":s["price"]}
    return None

def detect_bos(candles, sh, sl):
    last = candles[-1]
    for s in sh[-3:]:
        if last["close"]>s["price"]: return {"type":"BULLISH_BOS","level":s["price"]}
    for s in sl[-3:]:
        if last["close"]<s["price"]: return {"type":"BEARISH_BOS","level":s["price"]}
    return None

def calc_fib(sh, sl):
    if not sh or not sl: return None
    h, l = sh[-1]["price"], sl[-1]["price"]
    r = h - l
    return {"swing_high":h,"swing_low":l,
            "f236":round(h-r*0.236,2),"f382":round(h-r*0.382,2),"f500":round(h-r*0.5,2),
            "f618":round(h-r*0.618,2),"f706":round(h-r*0.706,2),"f786":round(h-r*0.786,2),
            "f618up":round(l+r*0.618,2),"f706up":round(l+r*0.706,2),"f786up":round(l+r*0.786,2)}

def in_golden(price, fib, direction, atr):
    if not fib: return False
    if direction=="BUY": return fib["f786"]-atr*0.3 <= price <= fib["f618"]+atr*0.3
    return fib["f618up"]-atr*0.3 <= price <= fib["f786up"]+atr*0.3

def detect_zones(candles, atr):
    zones = []
    for i in range(3, len(candles)-1):
        body = abs(candles[i]["close"]-candles[i]["open"])
        if body > atr*1.5:
            if candles[i]["close"]>candles[i]["open"]: zones.append({"type":"DEMAND","top":candles[i]["open"],"bottom":candles[i]["low"]})
            else: zones.append({"type":"SUPPLY","top":candles[i]["high"],"bottom":candles[i]["open"]})
    return zones[-6:]

def analyze(candles):
    closes = [c["close"] for c in candles]
    price  = closes[-1]
    atr    = calc_atr(candles)
    ema50  = calc_ema(closes, 50)
    ema200 = calc_ema(closes, 200)
    sh, sl = get_swings(candles, 5)
    choch  = detect_choch(candles, sh, sl)
    sweep  = detect_sweep(candles, sh, sl)
    bos    = detect_bos(candles, sh, sl)
    zones  = detect_zones(candles, atr)
    fib    = calc_fib(sh, sl)
    htf    = ema50 > ema200

    nd = next((z for z in zones if z["type"]=="DEMAND" and z["bottom"]<=price<=z["top"]+atr), None)
    ns = next((z for z in zones if z["type"]=="SUPPLY" and z["bottom"]-atr<=price<=z["top"]), None)
    gb = in_golden(price, fib, "BUY", atr)
    gs = in_golden(price, fib, "SELL", atr)

    bc, br = 0, []
    if choch and choch["type"]=="BULLISH_CHOCH": bc+=1; br.append(f"✅ CHoCH haussier à ${choch['level']:,.2f}")
    if sweep and sweep["type"]=="BULLISH_SWEEP":  bc+=1; br.append(f"✅ Liquidity Sweep haussier à ${sweep['level']:,.2f}")
    if bos   and bos["type"]=="BULLISH_BOS":      bc+=1; br.append(f"✅ BOS haussier à ${bos['level']:,.2f}")
    if gb and fib: bc+=1; br.append(f"✅ Golden Zone Fibo (${fib['f786']:,.2f} - ${fib['f618']:,.2f})")
    if nd: bc+=1; br.append(f"✅ Demand Zone (${nd['bottom']:,.2f} - ${nd['top']:,.2f})")
    if htf: bc+=1; br.append("✅ Trend HTF haussier")

    sc, sr = 0, []
    if choch and choch["type"]=="BEARISH_CHOCH": sc+=1; sr.append(f"✅ CHoCH baissier à ${choch['level']:,.2f}")
    if sweep and sweep["type"]=="BEARISH_SWEEP":  sc+=1; sr.append(f"✅ Liquidity Sweep baissier à ${sweep['level']:,.2f}")
    if bos   and bos["type"]=="BEARISH_BOS":      sc+=1; sr.append(f"✅ BOS baissier à ${bos['level']:,.2f}")
    if gs and fib: sc+=1; sr.append(f"✅ Golden Zone Fibo (${fib['f618up']:,.2f} - ${fib['f786up']:,.2f})")
    if ns: sc+=1; sr.append(f"✅ Supply Zone (${ns['bottom']:,.2f} - ${ns['top']:,.2f})")
    if not htf: sc+=1; sr.append("✅ Trend HTF baissier")

    bv = sweep and sweep["type"]=="BULLISH_SWEEP" and bos and bos["type"]=="BULLISH_BOS" and bc>=3
    sv = sweep and sweep["type"]=="BEARISH_SWEEP" and bos and bos["type"]=="BEARISH_BOS" and sc>=3

    if not bv and not sv: return None

    if bv:
        sig="BUY"; conf=bc; reasons=br
        sl_p=round(sweep["level"]-atr*0.3,2); tp1=round(price+atr*2,2); tp2=round(fib["swing_high"] if fib else price+atr*4,2)
    else:
        sig="SELL"; conf=sc; reasons=sr
        sl_p=round(sweep["level"]+atr*0.3,2); tp1=round(price-atr*2,2); tp2=round(fib["swing_low"] if fib else price-atr*4,2)

    sl_pips=round(abs(price-sl_p),2); tp1p=round(abs(tp1-price),2); tp2p=round(abs(tp2-price),2)
    rr1=round(tp1p/sl_pips,1) if sl_pips>0 else 0; rr2=round(tp2p/sl_pips,1) if sl_pips>0 else 0
    return {"signal":sig,"price":price,"sl":sl_p,"tp1":tp1,"tp2":tp2,"sl_pips":sl_pips,"tp1_pips":tp1p,"tp2_pips":tp2p,"rr1":rr1,"rr2":rr2,"conf":conf,"reasons":reasons,"fib":fib,"atr":atr,"ema50":ema50,"ema200":ema200}

def main():
    print("BTC SMC Bot démarré ✅")
    send_telegram("🟡 *BTC SMC Signal Bot démarré*\n\nStratégie: CHoCH + Liq Sweep + BOS + Golden Zone Fibo\nSessions: London + New York\nPaire: BTC/USD M5")

    last_signal = 0
    cooldown = 45 * 60

    while True:
        try:
            if is_weekend():
                print("Weekend — pas de signal BTC.")
                time.sleep(60); continue

            session = get_session()
            if not session:
                print(f"{datetime.now(timezone.utc).isoformat()} | Hors session.")
                time.sleep(60); continue

            candles = fetch_btc_candles()
            result  = analyze(candles)
            price   = candles[-1]["close"]

            if not result:
                print(f"{datetime.now(timezone.utc).isoformat()} | {session} | ${price:,.2f} | Pas de setup SMC.")
                time.sleep(60); continue

            now = time.time()
            if now - last_signal < cooldown:
                print("Cooldown actif."); time.sleep(60); continue
            last_signal = now

            emoji  = "🟢" if result["signal"]=="BUY" else "🔴"
            action = "ACHÈTE" if result["signal"]=="BUY" else "VENDS"
            f = result["fib"]
            fib_txt = f"\n*Niveaux Fibonacci:*\n0.382 → ${f['f382']:,.2f}\n0.500 → ${f['f500']:,.2f}\n0.618 → *${f['f618']:,.2f}* ⭐\n0.706 → *${f['f706']:,.2f}* ⭐\n0.786 → ${f['f786']:,.2f}\n" if f else ""

            msg = (
                f"{emoji} *SIGNAL BTC — {action}*\n📍 Session: {session}\n\n"
                f"💰 Entrée: *${result['price']:,.2f}*\n"
                f"🛑 SL: *{result['sl_pips']:,.2f} pips* (${result['sl']:,.2f})\n"
                f"🎯 TP1: *{result['tp1_pips']:,.2f} pips* (${result['tp1']:,.2f}) — R/R 1:{result['rr1']}\n"
                f"🎯 TP2: *{result['tp2_pips']:,.2f} pips* (${result['tp2']:,.2f}) — R/R 1:{result['rr2']}\n\n"
                f"*Confluences ({result['conf']}/6):*\n"
                f"{chr(10).join(result['reasons'])}"
                f"{fib_txt}\n"
                f"📉 ATR: {result['atr']:,.2f} | EMA50: ${result['ema50']:,.2f}\n\n"
                f"_Not financial advice_"
            )
            send_telegram(msg)
            print(f"✅ Signal BTC: {action} | ${result['price']:,.2f}")

        except Exception as e:
            print(f"Erreur: {e}")

        time.sleep(60)

if __name__ == "__main__":
    main()
