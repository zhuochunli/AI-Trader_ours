"""
Intraday 5-minute trading agent prompt
Handles real-time intraday trading decisions based on 5-minute price bars
"""

import os
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional

from dotenv import load_dotenv

load_dotenv()

# Add project root directory to Python path
project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, project_root)

from tools.general_tools import get_config_value
from tools.price_tools import (
    all_nasdaq_100_symbols,
    get_today_init_position,
    format_5min_bars
)

STOP_SIGNAL = "<FINISH_SIGNAL>"

intraday_agent_system_prompt = """
You are analyzing 5-minute stock price data for a simulated trading exercise.

Task:
- You are an AI day trader focusing on NASDAQ stocks.
- Step 1: Analyze current 5-min and 15-min trends.
- Step 2: Analyze the following data (Open, High, Low, Close, Volume) and describe current market structure (trend, consolidation, breakout). Identify potential breakout or mean-reversion setups using price action, volume pattern.
- Step 3: Suggest one trade with entry/stop/take-profit.
- Step 4: Explain your rationale briefly.

For each trade, always define:
- Direction (long or short)
- Entry price
- Stop loss price
- Take profit price
- Rationale (1-2 sentences)

Guidelines:
- This is a simulated portfolio analysis exercise
- Stick with the stop loss and take profit prices after each entry.
- If volatility is extreme or liquidity is low, suggest staying flat.
- Consider transaction costs in your analysis
- If data is incomplete, output {STOP_SIGNAL} to continue later
- Close all positions before the end of each trading day.

Here is the information provided:

You are trading {symbol}

Today's date: {date}
Current time: {current_time}

Yesterday's closing positions (numbers after stock code represent how many shares you hold, numbers after CASH represent your available cash):
{yesterday_positions}

Yesterday's closing price of {symbol}:
${yesterday_close_price}

Current positions (numbers after stock code represent how many shares you hold, numbers after CASH represent your available cash):
{positions}

Current price of {symbol}:
${current_price}

Yesterday's 5-minute bars (full trading day). Identify patterns in price action, volume:
{yesterday_bars}

Today's 5-minute bars (from market open until now). Identify patterns in price action, volume:
{today_bars}

When you think your task is complete, output
{STOP_SIGNAL}
"""


def get_intraday_agent_system_prompt(
    today_datetime: str,
    signature: str,
    symbol: str,
    market: str = "us"
) -> str:
    """
    Generate system prompt for intraday 5-minute trading agent.
    
    Args:
        today_datetime: Current datetime string in format "YYYY-MM-DD HH:MM:SS"
        signature: Agent signature/name
        symbol: Stock symbol to trade
        market: Market type ("us" or "cn")
    
    Returns:
        Formatted system prompt string
    """
    # Parse datetime - handle both old format and ISO 8601 with timezone
    try:
        # Try ISO 8601 format first (e.g., "2025-11-07T12:37:13-05:00")
        current_dt = datetime.fromisoformat(today_datetime)
    except:
        try:
            # Fallback to old format (e.g., "2025-11-07 12:37:13")
            current_dt = datetime.strptime(today_datetime, "%Y-%m-%d %H:%M:%S")
        except:
            # Last resort: assume now
            current_dt = datetime.now()
    
    today_date = current_dt.strftime("%Y-%m-%d")
    current_time = current_dt.strftime("%H:%M:%S")
    
    # Get current positions
    current_positions = get_today_init_position(today_datetime, signature)
    
    # Get yesterday's closing positions (from previous trading day end)
    try:
        yesterday_dt = current_dt - timedelta(days=1)
        # Skip weekends
        while yesterday_dt.weekday() >= 5:
            yesterday_dt -= timedelta(days=1)
        # Get end of previous trading day (4:00 PM = 16:00:00)
        yesterday_close_dt = yesterday_dt.replace(hour=16, minute=0, second=0)
        yesterday_close_str = yesterday_close_dt.strftime("%Y-%m-%d %H:%M:%S")
        yesterday_positions = get_today_init_position(yesterday_close_str, signature)
    except:
        yesterday_positions = {"CASH": 10000.0}  # Default initial cash
    
    # Note: The actual bar data will be fetched by the agent using MCP tools
    # We provide placeholders here that the agent will fill in by calling get_5min_bars
    yesterday_bars_text = "Call get_5min_bars tool to fetch yesterday's full day 5-minute bars"
    today_bars_text = "Call get_5min_bars tool to fetch today's 5-minute bars from market open until current time"
    
    # Placeholder prices - agent will fetch actual prices using tools
    yesterday_close_price = "Unknown (fetch using get_5min_bars tool)"
    current_price = "Unknown (fetch using get_latest_bar tool)"
    
    return intraday_agent_system_prompt.format(
        symbol=symbol,
        date=today_date,
        current_time=current_time,
        yesterday_positions=yesterday_positions,
        yesterday_close_price=yesterday_close_price,
        positions=current_positions,
        current_price=current_price,
        today_bars=today_bars_text,
        yesterday_bars=yesterday_bars_text,
        STOP_SIGNAL=STOP_SIGNAL
    )


def get_intraday_agent_system_prompt_with_bars(
    today_datetime: str,
    signature: str,
    symbol: str,
    today_bars: List[Dict],
    yesterday_bars: List[Dict],
    market: str = "us"
) -> str:
    """
    Generate system prompt for intraday agent with pre-fetched bar data.
    This version includes actual bar data in the prompt.
    
    Args:
        today_datetime: Current datetime string
        signature: Agent signature
        symbol: Stock symbol
        today_bars: List of today's 5-minute bars
        yesterday_bars: List of yesterday's 5-minute bars
        market: Market type
    
    Returns:
        Formatted system prompt with bar data
    """
    # Parse datetime - handle both old format and ISO 8601 with timezone
    try:
        # Try ISO 8601 format first (e.g., "2025-11-07T12:37:13-05:00")
        current_dt = datetime.fromisoformat(today_datetime)
    except:
        try:
            # Fallback to old format (e.g., "2025-11-07 12:37:13")
            current_dt = datetime.strptime(today_datetime, "%Y-%m-%d %H:%M:%S")
        except:
            # Last resort: assume now
            current_dt = datetime.now()
    
    today_date = current_dt.strftime("%Y-%m-%d")
    current_time = current_dt.strftime("%H:%M:%S")
    
    # Get positions
    current_positions = get_today_init_position(today_datetime, signature)
    
    try:
        yesterday_dt = current_dt - timedelta(days=1)
        while yesterday_dt.weekday() >= 5:
            yesterday_dt -= timedelta(days=1)
        yesterday_close_dt = yesterday_dt.replace(hour=16, minute=0, second=0)
        yesterday_close_str = yesterday_close_dt.strftime("%Y-%m-%d %H:%M:%S")
        yesterday_positions = get_today_init_position(yesterday_close_str, signature)
    except:
        yesterday_positions = {"CASH": 10000.0}
    
    # Format bar data
    def translate_bar_keys(bars: List[Dict]) -> List[Dict]:
        key_map = {
            "c": "close_price",
            "h": "high_price",
            "l": "low_price",
            "n": "number_of_trades",
            "o": "open_price",
            "t": "timestamp",
            "v": "volume",
            "vw": "volume_weighted_average_price",
        }
        translated = []
        for bar in bars:
            translated_bar = {}
            for key, value in bar.items():
                new_key = key_map.get(key, key)
                translated_bar[new_key] = value
            translated.append(translated_bar)
        return translated

    today_bars_translated = translate_bar_keys(today_bars) if today_bars else None
    yesterday_bars_translated = translate_bar_keys(yesterday_bars) if yesterday_bars else None

    today_bars_text = format_5min_bars(today_bars_translated, max_bars=50) if today_bars_translated else "No bars available yet (market just opened or data pending)"
    yesterday_bars_text = format_5min_bars(yesterday_bars_translated, max_bars=50) if yesterday_bars_translated else "No historical bars available"
    
    # Extract prices from bars
    yesterday_close_price = yesterday_bars_translated[-1].get("close_price", "Unknown") if yesterday_bars_translated else "Data not available"
    current_price = today_bars_translated[-1].get("close_price", "Unknown") if today_bars_translated else "Data not available"
    
    return intraday_agent_system_prompt.format(
        symbol=symbol,
        date=today_date,
        current_time=current_time,
        yesterday_positions=yesterday_positions,
        yesterday_close_price=yesterday_close_price,
        positions=current_positions,
        current_price=current_price,
        today_bars=today_bars_text,
        yesterday_bars=yesterday_bars_text,
        STOP_SIGNAL=STOP_SIGNAL
    )


if __name__ == "__main__":
    # Test prompt generation
    test_datetime = "2025-11-06 14:30:00"
    test_signature = "test-agent"
    test_symbol = "AAPL"
    
    prompt = get_intraday_agent_system_prompt(test_datetime, test_signature, test_symbol)
    print(prompt)

