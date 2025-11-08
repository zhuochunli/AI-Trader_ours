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
- Analyze the provided 5-minute price bars
- Identify patterns in price action, volume, and momentum
- Use the available analysis tools to evaluate trading scenarios
- Determine optimal position adjustments based on technical analysis

Analysis approach:
1. Review yesterday's positions and closing prices
2. Examine today's 5-minute bars for trends and patterns
3. Compare current bars with yesterday's bars for context
4. Consider current portfolio positions and available capital
5. Evaluate potential buy, sell, or hold scenarios

Guidelines:
- This is a simulated portfolio analysis exercise
- Call the provided tools to perform analysis and position updates
- Focus on technical indicators: momentum, volume, support/resistance
- Consider transaction costs in your analysis
- If data is incomplete, output {STOP_SIGNAL} to continue later

Here is the information you need:

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

Today's 5-minute bars (from market open until now):
{today_bars}

Yesterday's 5-minute bars (full trading day):
{yesterday_bars}

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
    today_bars_text = format_5min_bars(today_bars, max_bars=50) if today_bars else "No bars available yet (market just opened or data pending)"
    yesterday_bars_text = format_5min_bars(yesterday_bars, max_bars=50) if yesterday_bars else "No historical bars available"
    
    # Extract prices from bars
    yesterday_close_price = yesterday_bars[-1].get("close", "Unknown") if yesterday_bars else "Data not available"
    current_price = today_bars[-1].get("close", "Unknown") if today_bars else "Data not available"
    
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

