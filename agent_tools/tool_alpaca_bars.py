"""
Alpaca API tool for fetching stock price bars (5-minute, hourly, daily)
This is a more cost-effective alternative to AlphaVantage API
"""

import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional
import requests

from dotenv import load_dotenv
from fastmcp import FastMCP

# Add parent directory to Python path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
load_dotenv()

mcp = FastMCP("AlpacaBars")

# Alpaca API configuration
ALPACA_API_KEY = os.getenv("ALPACA_API_KEY")
ALPACA_API_SECRET = os.getenv("ALPACA_API_SECRET")
ALPACA_BASE_URL = "https://data.alpaca.markets/v2"


def _get_alpaca_headers() -> Dict[str, str]:
    """Get Alpaca API headers for authentication"""
    return {
        "APCA-API-KEY-ID": ALPACA_API_KEY,
        "APCA-API-SECRET-KEY": ALPACA_API_SECRET,
    }


@mcp.tool()
def get_5min_bars(
    symbol: str, 
    start_date: str, 
    end_date: Optional[str] = None,
    limit: int = 1000
) -> Dict[str, Any]:
    """
    Fetch 5-minute price bars from Alpaca API for a specific stock symbol.
    
    Args:
        symbol: Stock symbol (e.g., 'AAPL', 'TSLA')
        start_date: Start datetime in 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM:SS' format
        end_date: End datetime (optional), defaults to now if not specified
        limit: Maximum number of bars to return (default 1000, max 10000)
    
    Returns:
        Dictionary containing:
        - symbol: Stock symbol
        - bars: List of 5-minute bars with timestamp, open, high, low, close, volume
        - count: Number of bars returned
    """
    if not ALPACA_API_KEY or not ALPACA_API_SECRET:
        return {
            "error": "Alpaca API credentials not configured. Please set ALPACA_API_KEY and ALPACA_API_SECRET in .env file",
            "symbol": symbol
        }
    
    try:
        # Parse dates
        if ' ' in start_date:
            start_dt = datetime.strptime(start_date, "%Y-%m-%d %H:%M:%S")
        else:
            start_dt = datetime.strptime(start_date, "%Y-%m-%d")
        
        if end_date:
            if ' ' in end_date:
                end_dt = datetime.strptime(end_date, "%Y-%m-%d %H:%M:%S")
            else:
                end_dt = datetime.strptime(end_date, "%Y-%m-%d")
        else:
            end_dt = datetime.now()
        
        # Format for Alpaca API (RFC3339)
        start_str = start_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
        end_str = end_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
        
        # Build API URL
        url = f"{ALPACA_BASE_URL}/stocks/{symbol}/bars"
        params = {
            "timeframe": "5Min",
            "start": start_str,
            "end": end_str,
            "limit": min(limit, 10000),
            "adjustment": "split",  # Adjust for stock splits
            "feed": "iex"  # Use IEX data feed
        }
        
        # Make API request
        response = requests.get(url, headers=_get_alpaca_headers(), params=params)
        
        if response.status_code != 200:
            return {
                "error": f"Alpaca API error: {response.status_code} - {response.text}",
                "symbol": symbol
            }
        
        data = response.json()
        bars = data.get("bars", [])
        
        # Format bars for easier consumption
        formatted_bars = []
        for bar in bars:
            formatted_bars.append({
                "timestamp": bar["t"],
                "open": bar["o"],
                "high": bar["h"],
                "low": bar["l"],
                "close": bar["c"],
                "volume": bar["v"]
            })
        
        return {
            "symbol": symbol,
            "timeframe": "5Min",
            "bars": formatted_bars,
            "count": len(formatted_bars),
            "start_date": start_date,
            "end_date": end_date or "now"
        }
        
    except ValueError as e:
        return {
            "error": f"Date format error: {str(e)}. Use 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM:SS' format",
            "symbol": symbol
        }
    except Exception as e:
        return {
            "error": f"Failed to fetch bars: {str(e)}",
            "symbol": symbol
        }


@mcp.tool()
def get_latest_bar(symbol: str, timeframe: str = "5Min") -> Dict[str, Any]:
    """
    Get the latest price bar for a symbol from Alpaca API.
    
    Args:
        symbol: Stock symbol (e.g., 'AAPL', 'TSLA')
        timeframe: Bar timeframe - "1Min", "5Min", "15Min", "1Hour", "1Day" (default "5Min")
    
    Returns:
        Dictionary containing the latest bar data:
        - symbol: Stock symbol
        - timestamp: Bar timestamp
        - open, high, low, close: OHLC prices
        - volume: Trading volume
    """
    if not ALPACA_API_KEY or not ALPACA_API_SECRET:
        return {
            "error": "Alpaca API credentials not configured",
            "symbol": symbol
        }
    
    try:
        url = f"{ALPACA_BASE_URL}/stocks/bars/latest"
        params = {
            "symbols": symbol,
            "feed": "iex"
        }
        
        response = requests.get(url, headers=_get_alpaca_headers(), params=params)
        
        if response.status_code != 200:
            return {
                "error": f"Alpaca API error: {response.status_code} - {response.text}",
                "symbol": symbol
            }
        
        data = response.json()
        bars = data.get("bars", {})
        
        if symbol not in bars:
            return {
                "error": f"No data found for symbol {symbol}",
                "symbol": symbol
            }
        
        bar = bars[symbol]
        return {
            "symbol": symbol,
            "timestamp": bar["t"],
            "open": bar["o"],
            "high": bar["h"],
            "low": bar["l"],
            "close": bar["c"],
            "volume": bar["v"],
            "timeframe": timeframe
        }
        
    except Exception as e:
        return {
            "error": f"Failed to fetch latest bar: {str(e)}",
            "symbol": symbol
        }


@mcp.tool()
def get_multiple_5min_bars(
    symbols: List[str],
    start_date: str,
    end_date: Optional[str] = None
) -> Dict[str, Any]:
    """
    Fetch 5-minute bars for multiple symbols in one call (more efficient).
    
    Args:
        symbols: List of stock symbols (e.g., ['AAPL', 'TSLA', 'GOOGL'])
        start_date: Start datetime in 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM:SS' format
        end_date: End datetime (optional), defaults to now
    
    Returns:
        Dictionary mapping each symbol to its bars data
    """
    if not ALPACA_API_KEY or not ALPACA_API_SECRET:
        return {
            "error": "Alpaca API credentials not configured"
        }
    
    try:
        # Parse dates
        if ' ' in start_date:
            start_dt = datetime.strptime(start_date, "%Y-%m-%d %H:%M:%S")
        else:
            start_dt = datetime.strptime(start_date, "%Y-%m-%d")
        
        if end_date:
            if ' ' in end_date:
                end_dt = datetime.strptime(end_date, "%Y-%m-%d %H:%M:%S")
            else:
                end_dt = datetime.strptime(end_date, "%Y-%m-%d")
        else:
            end_dt = datetime.now()
        
        # Format for Alpaca API
        start_str = start_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
        end_str = end_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
        
        # Build API URL (use multi-symbol endpoint)
        url = f"{ALPACA_BASE_URL}/stocks/bars"
        params = {
            "symbols": ",".join(symbols),
            "timeframe": "5Min",
            "start": start_str,
            "end": end_str,
            "limit": 1000,
            "adjustment": "split",
            "feed": "iex"
        }
        
        response = requests.get(url, headers=_get_alpaca_headers(), params=params)
        
        if response.status_code != 200:
            return {
                "error": f"Alpaca API error: {response.status_code} - {response.text}"
            }
        
        data = response.json()
        bars_by_symbol = data.get("bars", {})
        
        # Format results
        results = {}
        for symbol in symbols:
            if symbol in bars_by_symbol:
                bars = bars_by_symbol[symbol]
                formatted_bars = []
                for bar in bars:
                    formatted_bars.append({
                        "timestamp": bar["t"],
                        "open": bar["o"],
                        "high": bar["h"],
                        "low": bar["l"],
                        "close": bar["c"],
                        "volume": bar["v"]
                    })
                results[symbol] = {
                    "bars": formatted_bars,
                    "count": len(formatted_bars)
                }
            else:
                results[symbol] = {
                    "error": f"No data found for {symbol}",
                    "bars": [],
                    "count": 0
                }
        
        return {
            "symbols": symbols,
            "timeframe": "5Min",
            "data": results,
            "start_date": start_date,
            "end_date": end_date or "now"
        }
        
    except Exception as e:
        return {
            "error": f"Failed to fetch bars: {str(e)}"
        }


if __name__ == "__main__":
    port = int(os.getenv("ALPACA_BARS_HTTP_PORT", "8010"))
    mcp.run(transport="streamable-http", port=port)

