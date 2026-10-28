#!/usr/bin/env python3
"""Betting rules that are checked in code (stdlib only, no network).  See RULES.md.

Rule 2, boost rule: prefer profit boosts on straights or 2-leg bets whose unboosted price is +100..+299.
Avoid boosting plain cash favourites and 3-leg SGPs, unless the promo itself requires 3 legs (bet365 boosts and
FanDuel NBA/NHL boosts do).  Anything outside the preferred set is "flagged" and needs +2% EV at the model price.
It is a flag/warning only: nothing is ever blocked by this module.
"""
import re

PREF_MIN, PREF_MAX = 100, 299     # preferred unboosted price range for a boost
FLAG_MIN_EV = 2.0                 # % EV at the model price that a flagged boost must still clear
THREE_LEG_PROMOS = {"bet365": None, "FanDuel": {"NBA", "NHL"}}   # book -> sports (None = every sport) whose boosts need 3 legs

def legs_of(market="", pick="", event=""):
    """Number of legs in a bet (1 = straight). Reads '3-leg' / '2 legs' from the market, else counts ' + ' in the pick."""
    m = re.search(r"(\d)\s*[- ]?\s*legs?\b", market or "", re.I)
    if m: return int(m.group(1))
    if re.search(r"\b(sgp|parlay|multi)\b", market or "", re.I) or " + " in (pick or ""):
        return max(2, (pick or "").count(" + ") + 1)
    return 1

def requires_three_legs(book, sport="", market=""):
    """True when the promo needs 3 legs (so a 3-leg boost is allowed). A '3+ legs' / 'min 3 legs' note in the market also counts."""
    if re.search(r"(min(imum)?\s*3|3\s*\+|3\s*or\s*more)\s*[- ]?legs?", market or "", re.I): return True
    if book in THREE_LEG_PROMOS:
        sports = THREE_LEG_PROMOS[book]
        return sports is None or (sport or "").upper() in sports
    return False

def boost_check(legs, price, ev_pct=None, book="", sport="", market=""):
    """(status, message) for a boosted bet.  price = the UNBOOSTED american price (int), ev_pct = EV % at the model price (or None).
    status: preferred | required_3leg | flagged_ok | flagged_low_ev | flagged_no_ev   (the last two are warnings, never blocks)."""
    pref = legs <= 2 and price is not None and PREF_MIN <= price <= PREF_MAX
    if pref: return "preferred", f"boost rule OK: {'straight' if legs == 1 else '2-leg'} at {price:+d} (preferred +{PREF_MIN} to +{PREF_MAX})"
    if legs >= 3 and requires_three_legs(book, sport, market):
        return "required_3leg", f"boost rule: {legs}-leg boost allowed, {book} promo requires 3 legs"
    if legs >= 3: why = f"{legs}-leg SGP/parlay boost the promo does not require"
    elif price is None: why = "price unknown"
    elif price < PREF_MIN: why = f"boost on a favourite ({price:+d})"
    else: why = f"price {price:+d} is outside +{PREF_MIN} to +{PREF_MAX}"
    if ev_pct is None: return "flagged_no_ev", f"BOOST RULE FLAG: {why}; needs +{FLAG_MIN_EV:g}% EV at the model price and none is logged"
    if ev_pct < FLAG_MIN_EV: return "flagged_low_ev", f"BOOST RULE WARNING: {why}; EV {ev_pct:+.1f}% is below the +{FLAG_MIN_EV:g}% needed"
    return "flagged_ok", f"boost rule flag: {why}, but EV {ev_pct:+.1f}% clears +{FLAG_MIN_EV:g}%"

def boost_check_bet(b):
    """boost_check for a bets.csv-style row; None when the bet is not boosted."""
    from common import boost_pct
    bp = boost_pct(b.get("market", ""), b.get("price", ""), b.get("boosted_price", ""))
    if not bp and not (b.get("boosted_price") or "").strip(): return None
    m = re.search(r"[+-]\d{3,}", str(b.get("price", "")).replace("\u2212", "-"))
    price = int(m[0]) if m and "unconfirmed" not in str(b.get("price", "")).lower() else None
    try: ev = float(b.get("ev_pct")) if str(b.get("ev_pct", "")).strip() else None
    except ValueError: ev = None
    sport = ""
    for s in ("NBA", "NHL", "NFL", "MLB", "NCAAF", "WNBA"):
        if re.search(rf"\b{s}\b", b.get("event", "") + " " + b.get("market", "")): sport = s; break
    return boost_check(legs_of(b.get("market", ""), b.get("pick", ""), b.get("event", "")), price, ev, b.get("book", ""), sport, b.get("market", ""))
