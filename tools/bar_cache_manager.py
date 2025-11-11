"""
5-Minute Bar Data Cache Manager
Caches up to 5 days of historical 5-minute bar data per stock
Accumulates today's data throughout the trading day
"""

import json
import os
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Any
import requests
from dotenv import load_dotenv

load_dotenv()

class BarCacheManager:
    """Manages caching of 5-minute bar data to minimize API calls"""
    
    def __init__(self, cache_dir: str = "data/price_cache_5min"):
        """
        Initialize the cache manager
        
        Args:
            cache_dir: Directory to store cached bar data
        """
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        
        # Alpaca API configuration
        self.api_key = os.getenv("ALPACA_API_KEY")
        self.api_secret = os.getenv("ALPACA_API_SECRET")
        self.base_url = "https://data.alpaca.markets/v2"
        self._alpaca_calendar = self._load_alpaca_calendar()
    
    def _get_symbol_dir(self, symbol: str) -> Path:
        """Get the directory for a symbol"""
        return self.cache_dir / symbol
    
    def _get_day_cache_file(self, symbol: str, date: str) -> Path:
        """Get the cache file path for a specific symbol and date"""
        symbol_dir = self._get_symbol_dir(symbol)
        symbol_dir.mkdir(parents=True, exist_ok=True)
        return symbol_dir / f"{date}.json"
    
    def _load_alpaca_calendar(self) -> Optional[List[Dict[str, Any]]]:
        """Load trading calendar from Alpaca to handle market holidays."""
        try:
            if not self.api_key or not self.api_secret:
                return None
            url = f"{self.base_url}/calendar"
            params = {
                "start": (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%d"),
                "end": (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d"),
            }
            response = requests.get(
                url,
                headers={
                    "APCA-API-KEY-ID": self.api_key,
                    "APCA-API-SECRET-KEY": self.api_secret,
                },
                params=params,
                timeout=10,
            )
            if response.status_code != 200:
                return None
            data = response.json()
            if isinstance(data, list):
                return data
        except Exception:
            pass
        return None
    
    def _get_previous_trading_day(self, reference: Optional[datetime] = None) -> datetime:
        """
        Get the previous trading day using Alpaca calendar if available, otherwise skipping weekends only.
        """
        if reference is None:
            reference = datetime.now()
        
        if self._alpaca_calendar:
            # calendar entries are ordered by date ascending
            ref_date_str = reference.strftime("%Y-%m-%d")
            prev_date = None
            for entry in self._alpaca_calendar:
                if entry.get("date") and entry["date"] < ref_date_str and entry.get("open") and entry.get("close"):
                    prev_date = entry["date"]
            if prev_date:
                return datetime.strptime(prev_date, "%Y-%m-%d")
        
        prev_day = reference - timedelta(days=1)
        while prev_day.weekday() >= 5:  # 5=Saturday, 6=Sunday
            prev_day -= timedelta(days=1)
        return prev_day
    
    def _load_day_cache(self, symbol: str, date: str) -> Optional[List[Dict[str, Any]]]:
        """Load cached data for a specific symbol and date"""
        cache_file = self._get_day_cache_file(symbol, date)
        if cache_file.exists():
            try:
                with open(cache_file, 'r') as f:
                    data = json.load(f)
                    return data.get("bars", [])
            except Exception as e:
                print(f"Error loading cache for {symbol} on {date}: {e}")
                return None
        return None
    
    def _save_day_cache(self, symbol: str, date: str, bars: List[Dict[str, Any]]) -> None:
        """Save cached data for a specific symbol and date"""
        cache_file = self._get_day_cache_file(symbol, date)
        try:
            cache_data = {
                "symbol": symbol,
                "date": date,
                "bars": bars,
                "bar_count": len(bars),
                "last_updated": datetime.now().isoformat()
            }
            with open(cache_file, 'w') as f:
                json.dump(cache_data, f, indent=2)
        except Exception as e:
            print(f"Error saving cache for {symbol} on {date}: {e}")
    
    def _fetch_from_alpaca(
        self, 
        symbol: str, 
        start_date: str, 
        end_date: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        Fetch 5-minute bars from Alpaca API
        
        Args:
            symbol: Stock symbol
            start_date: Start date in 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM:SS' format
            end_date: End date in 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM:SS' format (optional)
        
        Returns:
            List of bar data dictionaries
        """
        if not self.api_key or not self.api_secret:
            print(f"Warning: Alpaca API credentials not configured")
            return []
        
        try:
            import pytz
            
            # ET timezone for market hours
            et_tz = pytz.timezone('US/Eastern')
            
            # Parse dates - handle both "YYYY-MM-DD" and "YYYY-MM-DD HH:MM:SS" formats
            # ASSUME input times are already in ET (market time)
            if len(start_date) > 10:  # Has time component
                start_dt = datetime.strptime(start_date, "%Y-%m-%d %H:%M:%S")
                # Localize to ET
                start_dt = et_tz.localize(start_dt)
            else:
                start_dt = datetime.strptime(start_date, "%Y-%m-%d")
                start_dt = et_tz.localize(start_dt.replace(hour=9, minute=30))  # Default to market open
            
            if end_date:
                if len(end_date) > 10:
                    end_dt = datetime.strptime(end_date, "%Y-%m-%d %H:%M:%S")
                    end_dt = et_tz.localize(end_dt)
                else:
                    end_dt = datetime.strptime(end_date, "%Y-%m-%d")
                    end_dt = et_tz.localize(end_dt.replace(hour=16, minute=0))  # Default to market close
            else:
                # Convert current time to ET
                end_dt = datetime.now(et_tz)
            
            # Convert ET to UTC for Alpaca API (requires UTC with 'Z' suffix)
            import pytz
            utc_tz = pytz.UTC
            start_dt_utc = start_dt.astimezone(utc_tz)
            end_dt_utc = end_dt.astimezone(utc_tz)
            
            # Format as ISO 8601 with 'Z' suffix (e.g., "2024-01-03T00:00:00Z")
            start_str = start_dt_utc.strftime("%Y-%m-%dT%H:%M:%SZ")
            end_str = end_dt_utc.strftime("%Y-%m-%dT%H:%M:%SZ")
            
            # Build API request
            url = f"{self.base_url}/stocks/{symbol}/bars"
            params = {
                "timeframe": "5Min",
                "start": start_str,
                "end": end_str,
                "limit": 10000,
                "adjustment": "split",
                "feed": "iex"
            }
            
            headers = {
                "APCA-API-KEY-ID": self.api_key,
                "APCA-API-SECRET-KEY": self.api_secret,
            }
            
            response = requests.get(url, headers=headers, params=params)
            
            if response.status_code != 200:
                print(f"Alpaca API error for {symbol}: {response.status_code} - {response.text}")
                return []
            
            data = response.json()
            bars = data.get("bars", [])
            
            # Debug: Check if bars is None or empty
            if bars is None or len(bars) == 0:
                print(f"⚠️  No bars returned for {symbol}")
                print(f"   Request: {start_str} to {end_str}")
                print(f"   Response keys: {list(data.keys())}")
                if bars is None:
                    print(f"   bars = None (likely no data for this time range)")
                else:
                    print(f"   bars = [] (empty array)")
                return []
            
            # Format bars
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
            
            print(f"✅ Fetched {len(formatted_bars)} bars for {symbol} from {start_date} to {end_date or 'now'}")
            return formatted_bars
            
        except Exception as e:
            print(f"Error fetching bars from Alpaca for {symbol}: {e}")
            return []
    
    def get_day_bars(
        self, 
        symbol: str, 
        target_date: str,
        force_refresh: bool = False
    ) -> List[Dict[str, Any]]:
        """
        Get 5-minute bars for a specific day, using cache if available
        
        Args:
            symbol: Stock symbol
            target_date: Date in 'YYYY-MM-DD' format
            force_refresh: Force fetch from API even if cached
        
        Returns:
            List of bar data for the target day
        """
        # Check cache first
        if not force_refresh:
            cached_bars = self._load_day_cache(symbol, target_date)
            if cached_bars is not None:
                print(f"📦 Using cached data for {symbol} on {target_date}")
                return cached_bars
        
        # Fetch from API
        print(f"🌐 Fetching {symbol} data for {target_date} from Alpaca API")
        bars = self._fetch_from_alpaca(symbol, target_date, target_date)
        
        # Save to cache
        if bars:
            self._save_day_cache(symbol, target_date, bars)
        
        return bars
    
    def get_today_bars(self, symbol: str) -> List[Dict[str, Any]]:
        """
        Get today's 5-minute bars from market open until now
        Accumulates data throughout the day
        
        Args:
            symbol: Stock symbol
        
        Returns:
            List of bar data for today
        """
        today = datetime.now().strftime("%Y-%m-%d")
        
        # Load existing today's data from cache
        existing_bars = self._load_day_cache(symbol, today)
        if existing_bars is None:
            existing_bars = []
        
        # Determine last timestamp we have
        if existing_bars:
            last_timestamp = existing_bars[-1]["timestamp"]
            # Parse UTC timestamp and convert to ET
            last_dt_utc = datetime.fromisoformat(last_timestamp.replace('Z', '+00:00'))
            import pytz
            et_tz = pytz.timezone('US/Eastern')
            last_dt_et = last_dt_utc.astimezone(et_tz)
            # Fetch only new bars after last cached timestamp
            next_dt_et = last_dt_et + timedelta(minutes=5)
            
            # Check if next bar time is in the future - if so, no new bars to fetch
            now_et = datetime.now(et_tz)
            if next_dt_et > now_et:
                print(f"📦 No new bars yet (next expected at {next_dt_et.strftime('%H:%M')} ET, now is {now_et.strftime('%H:%M')} ET)")
                return existing_bars
            
            start_time = next_dt_et.strftime("%Y-%m-%d %H:%M:%S")
            print(f"📦 Appending new bars for {symbol} from {start_time} ET")
        else:
            # Fetch from market open today
            start_time = f"{today} 09:30:00"
            print(f"🌐 Fetching today's bars for {symbol} from market open")
        
        # Fetch new bars
        new_bars = self._fetch_from_alpaca(symbol, start_time, None)
        
        # Combine existing and new bars
        all_today_bars = existing_bars + new_bars
        
        # Save updated today's data to cache
        if all_today_bars:
            self._save_day_cache(symbol, today, all_today_bars)
        
        return all_today_bars
    
    def get_yesterday_bars(self, symbol: str) -> List[Dict[str, Any]]:
        """
        Get yesterday's complete 5-minute bars
        
        Args:
            symbol: Stock symbol
        
        Returns:
            List of bar data for yesterday
        """
        yesterday = self._get_previous_trading_day().strftime("%Y-%m-%d")
        return self.get_day_bars(symbol, yesterday)
    
    def get_recent_days_bars(
        self, 
        symbol: str, 
        days: int = 2
    ) -> Dict[str, List[Dict[str, Any]]]:
        """
        Get bars for the last N days
        
        Args:
            symbol: Stock symbol
            days: Number of days to retrieve (default 2 - yesterday and today)
        
        Returns:
            Dictionary mapping date to list of bars
        """
        result = {}
        current_date = datetime.now()
        for i in range(days):
            date_str = current_date.strftime("%Y-%m-%d")
            bars = self.get_day_bars(symbol, date_str)
            if bars:
                result[date_str] = bars
            current_date = self._get_previous_trading_day(current_date)
        
        return result
    
    def preload_cache(self, symbols: List[str], days: int = 2) -> None:
        """
        Preload cache with recent data for multiple symbols
        
        Args:
            symbols: List of stock symbols
            days: Number of days to cache (default 2 - yesterday and today)
        """
        print(f"🔄 Preloading cache for {len(symbols)} symbols ({days} days)...")
        for symbol in symbols:
            print(f"\n📊 Processing {symbol}...")
            self.get_recent_days_bars(symbol, days)
        print(f"\n✅ Cache preload complete!")
    
    def get_cache_stats(self, symbol: str) -> Dict[str, Any]:
        """Get statistics about cached data for a symbol"""
        symbol_dir = self._get_symbol_dir(symbol)
        
        if not symbol_dir.exists():
            return {
                "symbol": symbol,
                "days_cached": 0,
                "date_range": "No data",
                "total_bars": 0,
                "last_updated": "Never"
            }
        
        # Get all date files
        date_files = sorted(symbol_dir.glob("*.json"))
        days_cached = []
        total_bars = 0
        latest_update = None
        
        for date_file in date_files:
            date = date_file.stem  # e.g., "2025-11-10"
            days_cached.append(date)
            
            # Load and count bars
            bars = self._load_day_cache(symbol, date)
            if bars:
                total_bars += len(bars)
            
            # Track latest update
            try:
                with open(date_file, 'r') as f:
                    data = json.load(f)
                    last_updated = data.get("last_updated")
                    if last_updated:
                        if latest_update is None or last_updated > latest_update:
                            latest_update = last_updated
            except:
                pass
        
        return {
            "symbol": symbol,
            "days_cached": len(days_cached),
            "date_range": f"{min(days_cached)} to {max(days_cached)}" if days_cached else "No data",
            "total_bars": total_bars,
            "cached_dates": days_cached,
            "last_updated": latest_update or "Never"
        }


# Example usage and testing
if __name__ == "__main__":
    # Initialize cache manager
    cache_mgr = BarCacheManager()
    
    # Test with a stock
    symbol = "AAPL"
    
    print(f"\n{'='*60}")
    print(f"Testing Bar Cache Manager with {symbol}")
    print(f"{'='*60}\n")
    
    # Get today's bars (will accumulate throughout the day)
    today_bars = cache_mgr.get_today_bars(symbol)
    print(f"\n📈 Today's bars count: {len(today_bars)}")
    
    # Get yesterday's bars (will use cache if available)
    yesterday_bars = cache_mgr.get_yesterday_bars(symbol)
    print(f"\n📈 Yesterday's bars count: {len(yesterday_bars)}")
    
    # Get cache statistics
    stats = cache_mgr.get_cache_stats(symbol)
    print(f"\n📊 Cache Statistics:")
    for key, value in stats.items():
        print(f"  {key}: {value}")
    
    print(f"\n{'='*60}\n")

