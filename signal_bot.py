# XauBot — Asian Range Bot v1
# Stratégie : range asiatique (00h-07h30 UTC) → sweep London → ordre limit
# Analyse 1x/jour à 07h30 UTC | Rappel annulation à 17h00 UTC

import asyncio, logging, os, requests, pandas as pd
from datetime import datetime, timezone
from telegram import Bot
from telegram.request import HTTPXRequest

TELEGRAM_TOKEN   = os.environ["TELEGRAM_TOKEN"]
TELEGRAM_CHAT_ID = os.environ["TELEGRAM_CHAT_ID"]
TWELVE_API_KEY   = os.environ["TWELVE_API_KEY"]

ASIAN_START_HOUR  = 0
ASIAN_END_HOUR    = 7
ANALYSIS_HOUR     = 7
ANALYSIS_MINUTE   = 30
REMINDER_HOUR     = 17
REMINDER_MINUTE   = 0

ENTRY_BUFFER = 2.0
SL_BUFFER    = 8.0

SYMBOL = "XAU/USD"
LABEL  = "XAUUSD"

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")
log = logging.getLogger(__name__)

def get_candles(interval="15min", outputsize=60):
    try:
        r = requests.get("https://api.twelvedata.com/time_series", params={
            "symbol": SYMBOL, "interval": interval,
            "outputsize": outputsize, "apikey": TWELVE_API_KEY, "format": "JSON"
        }, timeout=10)
        data = r.json()
        if "values" not in data:
            log.error("Twelve Data: " + str(data.get("message", ""))); return None
        df = pd.DataFrame(data["values"]).rename(columns={"datetime": "time"})
        for col in ["open", "high", "low", "close"]: df[col] = pd.to_numeric(df[col])
        df["time"] = pd.to_datetime(df["time"])
        return df.iloc[::-1].reset_index(drop=True)
    except Exception as e:
        log.error("get_candles: " + str(e)); return None

def ema(series, period): return series.ewm(span=period, adjust=False).mean()

def atr_series(df, period=14):
    hi, lo, cl = df["high"], df["low"], df["close"]
    return pd.concat([hi-lo, (hi-cl.shift()).abs(), (lo-cl.shift()).abs()], axis=1).max(axis=1).rolling(period).mean()

def detect_fvg(df, lookback=20):
    n = len(df)
    for i in range(n-2, max(2, n-lookback), -1):
        h0 = float(df["high"].iloc[i-2]); l0 = float(df["low"].iloc[i-2])
        hi = float(df["high"].iloc[i]);   li = float(df["low"].iloc[i])
        if li > h0: return ("BULL", round(h0,2), round(li,2))
        if hi < l0: return ("BEAR", round(hi,2), round(l0,2))
    return None

def detect_ob(df, lookback=20, atr_mult=1.5):
    n = len(df); atr_v = float(atr_series(df).iloc[-1])
    for i in range(n-4, max(0, n-lookback), -1):
        o=float(df["open"].iloc[i]); c=float(df["close"].iloc[i])
        h=float(df["high"].iloc[i]); l=float(df["low"].iloc[i])
        fu_h = max(float(df["high"].iloc[j]) for j in range(i+1, min(i+4,n)))
        fu_l = min(float(df["low"].iloc[j])  for j in range(i+1, min(i+4,n)))
        if c < o and (fu_h-h) > atr_mult*atr_v: return ("BULL", round(l,2), round(h,2))
        if c > o and (l-fu_l) > atr_mult*atr_v: return ("BEAR", round(l,2), round(h,2))
    return None

def get_asian_range(df):
    now_utc = datetime.now(timezone.utc)
    asian = df[
        (df["time"].dt.date == now_utc.date()) &
        (df["time"].dt.hour >= ASIAN_START_HOUR) &
        (df["time"].dt.hour < ASIAN_END_HOUR)
    ]
    if len(asian) < 3:
        log.warning("Pas assez de bougies asiatiques"); return None, None
    return round(float(asian["high"].max()), 2), round(float(asian["low"].min()), 2)

def get_htf_trend():
    df = get_candles(interval="30min", outputsize=60)
    if df is None or len(df) < 55: return None
    df["ef"] = ema(df["close"], 15); df["es"] = ema(df["close"], 50)
    return "BULL" if float(df["ef"].iloc[-1]) > float(df["es"].iloc[-1]) else "BEAR"

async def morning_analysis(bot):
    df15 = get_candles(interval="15min", outputsize=80)
    if df15 is None or len(df15) < 20:
        await bot.send_message(chat_id=TELEGRAM_CHAT_ID, text="⚠️ Asian Range Bot — données M15 indisponibles"); return

    asian_high, asian_low = get_asian_range(df15)
    if asian_high is None:
        await bot.send_message(chat_id=TELEGRAM_CHAT_ID, text="⚠️ Asian Range Bot — range asiatique introuvable"); return

    range_size = round(asian_high - asian_low, 2)
    htf = get_htf_trend() or "NEUTRE"
    price = round(float(df15["close"].iloc[-1]), 2)
    atr_v = round(float(atr_series(df15).iloc[-1]), 2)
    fvg = detect_fvg(df15); ob = detect_ob(df15)

    buy_entry = round(asian_low - ENTRY_BUFFER, 2)
    buy_sl    = round(asian_low - SL_BUFFER, 2)
    buy_tp1   = round(buy_entry + atr_v*0.8, 2)
    buy_tp2   = round(buy_entry + atr_v*1.5, 2)
    buy_tp3   = round(asian_high, 2)
    buy_score = 30
    buy_fvg = fvg and fvg[0]=="BULL" and fvg[1]<=asian_low+10 and fvg[2]>=asian_low-10
    buy_ob  = ob  and ob[0] =="BULL" and ob[1] <=asian_low+10 and ob[2] >=asian_low-10
    if buy_fvg: buy_score += 35
    if buy_ob:  buy_score += 40
    if htf == "BULL": buy_score += 20
    buy_conf = "HIGH" if buy_score>=75 else ("MEDIUM" if buy_score>=50 else "LOW")

    sell_entry = round(asian_high + ENTRY_BUFFER, 2)
    sell_sl    = round(asian_high + SL_BUFFER, 2)
    sell_tp1   = round(sell_entry - atr_v*0.8, 2)
    sell_tp2   = round(sell_entry - atr_v*1.5, 2)
    sell_tp3   = round(asian_low, 2)
    sell_score = 30
    sell_fvg = fvg and fvg[0]=="BEAR" and fvg[1]<=asian_high+10 and fvg[2]>=asian_high-10
    sell_ob  = ob  and ob[0] =="BEAR" and ob[1] <=asian_high+10 and ob[2] >=asian_high-10
    if sell_fvg: sell_score += 35
    if sell_ob:  sell_score += 40
    if htf == "BEAR": sell_score += 20
    sell_conf = "HIGH" if sell_score>=75 else ("MEDIUM" if sell_score>=50 else "LOW")

    now = datetime.utcnow().strftime("%H:%M UTC")
    trend_icon = "🟢" if htf=="BULL" else ("🔴" if htf=="BEAR" else "⚪")
    bci = "🟢" if buy_conf=="HIGH" else ("🟡" if buy_conf=="MEDIUM" else "🔴")
    sci = "🟢" if sell_conf=="HIGH" else ("🟡" if sell_conf=="MEDIUM" else "🔴")

    msg  = "🌅 ASIAN RANGE — " + LABEL + " | " + now + "\n"
    msg += "━━━━━━━━━━━━━━━━━━\n"
    msg += "📊 Range : " + str(asian_low) + " — " + str(asian_high) + "  ($" + str(range_size) + ")\n"
    msg += "📈 HTF M30 : " + htf + " " + trend_icon + "\n"
    msg += "📍 Prix actuel : " + str(price) + "\n"
    msg += "━━━━━━━━━━━━━━━━━━\n"
    if fvg:
        fi = "✅" if (fvg[0]=="BULL" and htf=="BULL") or (fvg[0]=="BEAR" and htf=="BEAR") else "⚠️"
        msg += "📐 FVG M15 : " + fvg[0] + " " + fi + " [" + str(fvg[1]) + "-" + str(fvg[2]) + "]\n"
    if ob:
        oi = "✅" if (ob[0]=="BULL" and htf=="BULL") or (ob[0]=="BEAR" and htf=="BEAR") else "⚠️"
        msg += "📦 OB M15  : " + ob[0] + " " + oi + " [" + str(ob[1]) + "-" + str(ob[2]) + "]\n"
    msg += "━━━━━━━━━━━━━━━━━━\n"
    msg += "🟢 BUY LIMIT @ " + str(buy_entry) + "\n"
    msg += "   🛑 SL  : " + str(buy_sl) + "  (-$" + str(round(buy_entry-buy_sl,1)) + ")\n"
    msg += "   🎯 TP1 : " + str(buy_tp1) + "\n"
    msg += "   🎯 TP2 : " + str(buy_tp2) + "\n"
    msg += "   🎯 TP3 : " + str(buy_tp3) + "  (haut range)\n"
    msg += "   " + bci + " Confiance : " + buy_conf + " (" + str(buy_score) + "/125)\n"
    if buy_fvg: msg += "   ✅ FVG BULL aligné\n"
    if buy_ob:  msg += "   ✅ OB BULL aligné\n"
    msg += "━━━━━━━━━━━━━━━━━━\n"
    msg += "🔴 SELL LIMIT @ " + str(sell_entry) + "\n"
    msg += "   🛑 SL  : " + str(sell_sl) + "  (+$" + str(round(sell_sl-sell_entry,1)) + ")\n"
    msg += "   🎯 TP1 : " + str(sell_tp1) + "\n"
    msg += "   🎯 TP2 : " + str(sell_tp2) + "\n"
    msg += "   🎯 TP3 : " + str(sell_tp3) + "  (bas range)\n"
    msg += "   " + sci + " Confiance : " + sell_conf + " (" + str(sell_score) + "/125)\n"
    if sell_fvg: msg += "   ✅ FVG BEAR aligné\n"
    if sell_ob:  msg += "   ✅ OB BEAR aligné\n"
    msg += "━━━━━━━━━━━━━━━━━━\n"
    if htf == "BULL":
        msg += "💡 HTF BULL → Privilégie le BUY\n   London va probablement sweeper le bas de range\n"
    elif htf == "BEAR":
        msg += "💡 HTF BEAR → Privilégie le SELL\n   London va probablement sweeper le haut de range\n"
    else:
        msg += "💡 HTF NEUTRE → Place les deux, annule le perdant si l'un se remplit\n"
    msg += "━━━━━━━━━━━━━━━━━━\n"
    msg += "⚠️ Vérifie les news avant London (forexfactory.com)\n"
    msg += "⏳ Rappel annulation à 17h00 UTC si non rempli"
    await bot.send_message(chat_id=TELEGRAM_CHAT_ID, text=msg)

async def evening_reminder(bot):
    now = datetime.utcnow().strftime("%d/%m/%Y")
    msg  = "⏰ RAPPEL — " + LABEL + " | 17h00 UTC\n"
    msg += "━━━━━━━━━━━━━━━━━━\n"
    msg += "Annule les ordres limit asiatiques non remplis.\n"
    msg += "La range du " + now + " n'est plus valide.\n"
    msg += "━━━━━━━━━━━━━━━━━━\n"
    msg += "✅ Si un trade est ouvert → gère ton SL (breakeven si +TP1 touché)"
    await bot.send_message(chat_id=TELEGRAM_CHAT_ID, text=msg)

async def main():
    bot = Bot(token=TELEGRAM_TOKEN, request=HTTPXRequest(read_timeout=30, connect_timeout=30, write_timeout=30))
    for attempt in range(5):
        try:
            await bot.send_message(chat_id=TELEGRAM_CHAT_ID,
                text="🌅 Asian Range Bot v1 démarré\nAnalyse 07h30 UTC | Rappel 17h00 UTC | Lun-Ven")
            break
        except Exception as e:
            log.error("Startup: " + str(e)); await asyncio.sleep(10)

    analysis_sent_today = None
    reminder_sent_today = None

    while True:
        try:
            now = datetime.now(timezone.utc)
            if now.weekday() < 5:
                today = now.date()
                if now.hour == ANALYSIS_HOUR and now.minute >= ANALYSIS_MINUTE:
                    if analysis_sent_today != today:
                        await morning_analysis(bot); analysis_sent_today = today
                if now.hour == REMINDER_HOUR and now.minute >= REMINDER_MINUTE:
                    if reminder_sent_today != today:
                        await evening_reminder(bot); reminder_sent_today = today
        except Exception as e:
            log.error("Erreur: " + str(e))
        await asyncio.sleep(60)

if __name__ == "__main__":
    asyncio.run(main())
