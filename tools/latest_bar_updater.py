#!/usr/bin/env python3
"""Poll Alpaca latest bars and update local cache for frontend refresh."""

from __future__ import annotations

import json
import os
import signal
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List

import pytz
import requests
from dotenv import load_dotenv

# Ensure project root is on sys.path so we can import helper utilities
PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

# Late import after manipulating sys.path
from tools.general_tools import read_json_file  # noqa: E402

load_dotenv()

ALPACA_API_KEY = os.getenv("ALPACA_API_KEY")
ALPACA_API_SECRET = os.getenv("ALPACA_API_SECRET")
ALPACA_BASE_URL = "https://data.alpaca.markets/v2"
DEFAULT_CONFIG_PATH = PROJECT_ROOT / "configs" / "default_5min_config.json"
CACHE_DIRS = [
    PROJECT_ROOT / "data" / "price_cache_5min" / "latest",
    PROJECT_ROOT / "docs" / "data" / "price_cache_5min" / "latest",
]
POLL_INTERVAL_SECONDS = int(os.getenv("ALPACA_LATEST_POLL_INTERVAL", "60"))
ET_TZ = pytz.timezone("US/Eastern")


def load_symbols(config_path: Path) -> List[str]:
    config = read_json_file(str(config_path))
    symbols = config.get("stock_symbols") or []
    if not isinstance(symbols, list) or not symbols:
        raise ValueError("No stock_symbols configured for 5-min trading")
    return symbols


def fetch_latest_bars(symbols: List[str]) -> Dict[str, Dict]:
    url = f"{ALPACA_BASE_URL}/stocks/bars/latest"
    params = {
        "symbols": ",".join(symbols),
        "feed": "iex",
    }
    headers = {
        "APCA-API-KEY-ID": ALPACA_API_KEY or "",
        "APCA-API-SECRET-KEY": ALPACA_API_SECRET or "",
    }
    response = requests.get(url, headers=headers, params=params, timeout=10)
    if response.status_code != 200:
        raise RuntimeError(
            f"Alpaca latest bars API error: {response.status_code} - {response.text}"
        )
    data = response.json() or {}
    return data.get("bars", {})


def ensure_cache_dirs() -> None:
    for cache_dir in CACHE_DIRS:
        cache_dir.mkdir(parents=True, exist_ok=True)


def store_latest_bars(bars: Dict[str, Dict]) -> None:
    ensure_cache_dirs()
    fetched_at = datetime.now(timezone.utc)
    fetched_at_et = fetched_at.astimezone(ET_TZ)
    meta = {
        "fetched_at_utc": fetched_at.isoformat(),
        "fetched_at_et": fetched_at_et.isoformat(),
    }
    for symbol, bar in bars.items():
        if not bar:
            continue
        payload = {
            "symbol": symbol,
            "bar": bar,
            "meta": meta,
        }
        for cache_dir in CACHE_DIRS:
            target_file = cache_dir / f"{symbol.upper()}.json"
            with target_file.open("w", encoding="utf-8") as fh:
                json.dump(payload, fh, ensure_ascii=False, indent=2)


def poll(symbols: List[str]) -> None:
    print(
        f"📈 Starting Alpaca latest-bar poller for {len(symbols)} symbols: {', '.join(symbols)}"
    )
    print(f"   ➜ Poll interval: {POLL_INTERVAL_SECONDS} seconds")

    while True:
        try:
            bars = fetch_latest_bars(symbols)
            if not bars:
                print("⚠️  No latest bars received from Alpaca")
            else:
                store_latest_bars(bars)
                print(
                    "✅ Updated latest bars for "
                    f"{len(bars)} symbols at "
                    f"{datetime.now(ET_TZ).strftime('%Y-%m-%d %H:%M:%S %Z')}"
                )
        except KeyboardInterrupt:
            raise
        except Exception as exc:  # noqa: BLE001
            print(f"❌ Failed to update latest bars: {exc}")

        time.sleep(POLL_INTERVAL_SECONDS)


def main(config_path: Path = DEFAULT_CONFIG_PATH) -> None:
    if not ALPACA_API_KEY or not ALPACA_API_SECRET:
        raise RuntimeError("ALPACA_API_KEY and ALPACA_API_SECRET must be set")

    symbols = load_symbols(config_path)
    stop_requested = False

    def handle_signal(signum, frame):  # noqa: ARG001
        nonlocal stop_requested
        stop_requested = True
        print("\n🛑 Latest-bar poller received stop signal. Exiting...")

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    try:
        while not stop_requested:
            try:
                poll(symbols)
            except KeyboardInterrupt:
                stop_requested = True
    finally:
        print("✅ Latest-bar poller stopped")


if __name__ == "__main__":
    cfg_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_CONFIG_PATH
    main(cfg_path)

