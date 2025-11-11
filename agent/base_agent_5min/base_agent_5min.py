"""
BaseAgent_5Min class - Trading agent for 5-minute intraday trading
Extends BaseAgent with 5-minute interval specific functionality
"""

import os
import json
import asyncio
import time as time_module
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Any
from pathlib import Path

from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_openai import ChatOpenAI
from langchain.agents import create_agent
from dotenv import load_dotenv

# Import project tools
import sys
project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, project_root)

from tools.general_tools import extract_conversation, extract_tool_messages, get_config_value, write_config_value
from tools.price_tools import add_no_trade_record
from tools.bar_cache_manager import BarCacheManager
from prompts.agent_prompt_5min import get_intraday_agent_system_prompt, STOP_SIGNAL

# Load environment variables
load_dotenv()

from agent.base_agent.base_agent import BaseAgent


class BaseAgent_5Min(BaseAgent):
    """
    Trading agent for 5-minute intraday trading operations
    
    Inherits all functionality from BaseAgent and overrides specific methods
    to support 5-minute interval trading logic:
    - Runs every 5 minutes during market hours
    - Uses Alpaca API for real-time 5-minute bars
    - Makes rapid intraday trading decisions
    """
    
    def __init__(
        self,
        signature: str,
        basemodel: str,
        stock_symbols: List[str],
        max_steps: int = 50,
        market: str = "us",
        trading_symbol: Optional[str] = None,
        live_mode: bool = False,
        **kwargs
    ):
        """
        Initialize 5-minute intraday trading agent
        
        Args:
            signature: Agent identifier
            basemodel: Base model name
            stock_symbols: List of stock symbols (for multi-stock support)
            max_steps: Maximum reasoning steps per session
            market: Market type ("us" or "cn")
            trading_symbol: Specific symbol to trade (for focused intraday trading)
            live_mode: If True, run in live mode (continuous trading from now)
            **kwargs: Additional arguments passed to BaseAgent
        """
        # Pass all parameters as keyword arguments to avoid conflicts
        super().__init__(
            signature=signature,
            basemodel=basemodel,
            stock_symbols=stock_symbols,
            max_steps=max_steps,
            market=market,
            **kwargs
        )
        
        # For intraday trading, support multiple symbols
        self.trading_symbols = stock_symbols if not trading_symbol else [trading_symbol]
        self.trading_symbol = self.trading_symbols[0]  # For backward compatibility
        self.live_mode = live_mode
        
        # Initialize bar cache manager
        cache_dir = os.path.join(project_root, "data", "price_cache_5min")
        self.cache_manager = BarCacheManager(cache_dir=cache_dir)
        
        # Preload cache for trading symbols if in live mode
        if live_mode:
            print(f"🔄 Preloading cache (yesterday + today) for {len(self.trading_symbols)} symbols...")
            self.cache_manager.preload_cache(self.trading_symbols, days=2)
        
        print(f"✅ Initialized {self.signature} for 5-minute intraday trading")
        print(f"📊 Trading symbols: {', '.join(self.trading_symbols)}")
        print(f"🔴 Live mode: {'ON' if live_mode else 'OFF'}")
    
    async def run_trading_session(self, today_datetime: str) -> None:
        """
        Run single 5-minute trading session with enhanced error handling
        
        Args:
            today_datetime: Trading datetime in format "YYYY-MM-DD HH:MM:SS"
        """
        print(f"📈 Starting 5-min intraday trading session: {today_datetime}")
        
        # Set up logging
        log_file = self._setup_logging(today_datetime)
        write_config_value("LOG_FILE", log_file)
        
        # Fetch cached bar data
        print(f"📊 Fetching bar data from cache...")
        today_bars = self.cache_manager.get_today_bars(self.trading_symbol)
        yesterday_bars = self.cache_manager.get_yesterday_bars(self.trading_symbol)
        
        print(f"✅ Today's bars: {len(today_bars)}, Yesterday's bars: {len(yesterday_bars)}")
        
        # Import the prompt function with bars
        from prompts.agent_prompt_5min import get_intraday_agent_system_prompt_with_bars
        
        # Update system prompt with intraday-specific prompt including cached bar data
        from langchain.agents import create_agent
        self.agent = create_agent(
            self.model,
            tools=self.tools,
            system_prompt=get_intraday_agent_system_prompt_with_bars(
                today_datetime, 
                self.signature,
                self.trading_symbol,
                today_bars,
                yesterday_bars,
                self.market
            ),
        )
        
        # Initial user query
        user_query = [{
            "role": "user", 
            "content": f"Please analyze the 5-minute bars and update positions for {self.trading_symbol} at {today_datetime}."
        }]
        message = user_query.copy()
        
        # Log initial message
        self._log_message(log_file, user_query)
        
        # Trading loop
        current_step = 0
        while current_step < self.max_steps:
            current_step += 1
            print(f"🔄 Step {current_step}/{self.max_steps}")
            
            try:
                # Call agent
                response = await self._ainvoke_with_retry(message)
                
                # Extract agent response
                agent_response = extract_conversation(response, "final")
                
                # Check stop signal
                if STOP_SIGNAL in agent_response:
                    print("✅ Received stop signal, trading session ended")
                    print(agent_response)
                    self._log_message(log_file, [{"role": "assistant", "content": agent_response}])
                    break
                
                # Extract tool messages with None check
                tool_msgs = extract_tool_messages(response)
                tool_response = '\n'.join([msg.content for msg in tool_msgs if msg.content is not None])
                
                # Prepare new messages
                new_messages = [
                    {"role": "assistant", "content": agent_response},
                    {"role": "user", "content": f'Tool results: {tool_response}'}
                ]
                
                # Add new messages
                message.extend(new_messages)
                
                # Log messages
                self._log_message(log_file, new_messages[0])
                self._log_message(log_file, new_messages[1])
                
            except Exception as e:
                print(f"❌ Trading session error: {str(e)}")
                print(f"Error details: {e}")
                raise
        
        # Handle trading results
        await self._handle_trading_result(today_datetime)
    
    def get_trading_times(self, start_datetime: str, end_datetime: str) -> List[str]:
        """
        Get list of 5-minute trading times between start and end datetime.
        
        For intraday trading, we generate 5-minute intervals during market hours:
        - US Market: 9:30 AM - 4:00 PM ET (6.5 hours = 78 five-minute intervals)
        - Markets are closed on weekends
        
        Args:
            start_datetime: Start datetime (YYYY-MM-DD HH:MM:SS)
            end_datetime: End datetime (YYYY-MM-DD HH:MM:SS)
            
        Returns:
            List of trading times in 5-minute intervals
        """
        print(f"📅 Generating 5-minute trading times: {start_datetime} to {end_datetime}")
        
        try:
            start_dt = datetime.strptime(start_datetime, "%Y-%m-%d %H:%M:%S")
            end_dt = datetime.strptime(end_datetime, "%Y-%m-%d %H:%M:%S")
        except ValueError:
            print("❌ Invalid datetime format. Use YYYY-MM-DD HH:MM:SS")
            return []
        
        # Market hours for US market (can be extended for other markets)
        market_open_hour = 9
        market_open_minute = 30
        market_close_hour = 16
        market_close_minute = 0
        
        trading_times = []
        current_dt = start_dt
        
        # Check if we should resume from last processed time
        if os.path.exists(self.position_file):
            try:
                with open(self.position_file, "r") as f:
                    last_line = None
                    for line in f:
                        last_line = line
                    if last_line:
                        doc = json.loads(last_line)
                        last_date = doc.get('date')
                        if last_date and ' ' in last_date:
                            last_dt = datetime.strptime(last_date, "%Y-%m-%d %H:%M:%S")
                            # Resume from next 5-minute interval
                            current_dt = max(current_dt, last_dt + timedelta(minutes=5))
            except Exception as e:
                print(f"⚠️ Could not read last position: {e}")
        
        while current_dt <= end_dt:
            # Skip weekends
            if current_dt.weekday() < 5:  # Monday=0, Friday=4
                # Check if within market hours
                current_time = current_dt.time()
                market_open = datetime.strptime(f"{market_open_hour}:{market_open_minute}", "%H:%M").time()
                market_close = datetime.strptime(f"{market_close_hour}:{market_close_minute}", "%H:%M").time()
                
                if market_open <= current_time < market_close:
                    # Ensure it's on a 5-minute boundary
                    if current_dt.minute % 5 == 0:
                        trading_times.append(current_dt.strftime("%Y-%m-%d %H:%M:%S"))
            
            # Move to next 5-minute interval
            current_dt += timedelta(minutes=5)
        
        print(f"📊 Generated {len(trading_times)} 5-minute trading intervals")
        return trading_times
    
    async def run_date_range(self, start_datetime: str, end_datetime: str) -> None:
        """
        Run all 5-minute trading intervals in datetime range
        
        Args:
            start_datetime: Start datetime (YYYY-MM-DD HH:MM:SS)
            end_datetime: End datetime (YYYY-MM-DD HH:MM:SS)
        """
        print(f"📅 Running 5-minute intraday trading: {start_datetime} to {end_datetime}")
        
        # Get trading times
        trading_times = self.get_trading_times(start_datetime, end_datetime)
        
        if not trading_times:
            print(f"ℹ️ No trading times to process")
            return
        
        print(f"📊 Trading intervals to process: {len(trading_times)}")
        print(f"First interval: {trading_times[0]}")
        print(f"Last interval: {trading_times[-1]}")
        
        # Process each 5-minute interval
        for idx, trade_time in enumerate(trading_times, 1):
            print(f"\n🔄 Processing {self.signature} - Interval {idx}/{len(trading_times)}: {trade_time}")
            
            # Set configuration
            write_config_value("TODAY_DATE", trade_time)
            write_config_value("SIGNATURE", self.signature)
            
            try:
                await self.run_with_retry(trade_time)
            except Exception as e:
                print(f"❌ Error processing {self.signature} - Time: {trade_time}")
                print(e)
                # Continue to next interval even if one fails
                continue
        
        print(f"✅ {self.signature} 5-minute intraday trading completed")
    
    def reset_positions(self) -> None:
        """
        Reset all positions to initial state (clear history and set initial cash)
        Also saves agent metadata for frontend auto-detection
        """
        print(f"🔄 Resetting positions for {self.signature}...")
        
        # Clear position file if it exists
        if os.path.exists(self.position_file):
            os.remove(self.position_file)
            print(f"✅ Cleared position history: {self.position_file}")
        
        # Clear log directory to remove old trades
        log_dir = os.path.join(self.data_path, "logs")
        if os.path.exists(log_dir):
            import shutil
            shutil.rmtree(log_dir)
            print(f"✅ Cleared log history: {log_dir}")
        
        # Create fresh directories
        os.makedirs(os.path.dirname(self.position_file), exist_ok=True)
        os.makedirs(log_dir, exist_ok=True)
        
        # Initialize with starting cash only
        initial_position = {
            "date": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "positions": {"CASH": self.initial_cash},
            "action_id": 0,
            "action_type": "INIT",
            "action_details": f"Initial cash: ${self.initial_cash}"
        }
        
        with open(self.position_file, "w") as f:
            f.write(json.dumps(initial_position) + "\n")
        
        # Save agent metadata for frontend auto-detection
        import pytz
        et_tz = pytz.timezone('US/Eastern')
        start_time_et = datetime.now(et_tz)
        start_time_iso = start_time_et.strftime("%Y-%m-%dT%H:%M:%S%z")
        start_time_iso = start_time_iso[:-2] + ":" + start_time_iso[-2:]

        metadata = {
            "signature": self.signature,
            "basemodel": self.basemodel,
            "stock_symbols": self.trading_symbols,
            "initial_cash": self.initial_cash,
            "market": self.market,
            "live_mode": True,
            "start_time": start_time_iso,
            "display_name": self._get_display_name(),
            "color": self._get_color_from_model(),
            "icon": self._get_icon_from_model()
        }
        
        metadata_file = os.path.join(self.data_path, "agent_config.json")
        with open(metadata_file, "w") as f:
            json.dump(metadata, f, indent=2)
        
        self._update_live_agents_manifest(metadata)
        
        print(f"✅ Initialized with ${self.initial_cash} cash, all positions at 0")
        print(f"📊 Trading stocks: {', '.join(self.trading_symbols)}")
    
    def _get_display_name(self) -> str:
        """Get display name for frontend based on model"""
        model_lower = self.basemodel.lower()
        if "gpt" in model_lower:
            return f"GPT-{self.basemodel.split('-')[1] if len(self.basemodel.split('-')) > 1 else '4'}"
        elif "claude" in model_lower:
            return "Claude 3.7 Sonnet"
        elif "gemini" in model_lower:
            return "Gemini 2.5 Flash"
        elif "deepseek" in model_lower:
            return "DeepSeek Chat"
        elif "qwen" in model_lower:
            return "Qwen3 Max"
        else:
            return self.basemodel
    
    def _get_color_from_model(self) -> str:
        """Get color for frontend based on model"""
        model_lower = self.basemodel.lower()
        if "gpt" in model_lower or "openai" in model_lower:
            return "#ffbe0b"
        elif "claude" in model_lower or "anthropic" in model_lower:
            return "#8338ec"
        elif "gemini" in model_lower or "google" in model_lower:
            return "#00d4ff"
        elif "deepseek" in model_lower:
            return "#ff006e"
        elif "qwen" in model_lower:
            return "#00ffcc"
        else:
            return "#3a86ff"
    
    def _get_icon_from_model(self) -> str:
        """Get icon path for frontend based on model"""
        model_lower = self.basemodel.lower()
        if "gpt" in model_lower or "openai" in model_lower:
            return "./figs/openai.svg"
        elif "claude" in model_lower or "anthropic" in model_lower:
            return "./figs/claude-color.svg"
        elif "gemini" in model_lower or "google" in model_lower:
            return "./figs/google.svg"
        elif "deepseek" in model_lower:
            return "./figs/deepseek.svg"
        elif "qwen" in model_lower:
            return "./figs/qwen.svg"
        else:
            return "./figs/stock.svg"
    
    def _update_live_agents_manifest(self, metadata: Dict[str, Any]) -> None:
        """Update live agents manifest for frontend auto-detection."""
        try:
            base_path = self.base_log_path if os.path.isabs(self.base_log_path) else os.path.join(Path(__file__).resolve().parents[2], self.base_log_path)
            manifest_path = os.path.join(base_path, "live_agents.json")
            os.makedirs(os.path.dirname(manifest_path), exist_ok=True)
            
            existing: List[Dict[str, Any]] = []
            if os.path.exists(manifest_path):
                with open(manifest_path, "r", encoding="utf-8") as f:
                    loaded = json.load(f)
                    if isinstance(loaded, list):
                        existing = loaded
            
            entry = {
                "folder": self.signature,
                "display_name": metadata.get("display_name", self.signature),
                "icon": metadata.get("icon", "./figs/stock.svg"),
                "color": metadata.get("color"),
                "basemodel": metadata.get("basemodel"),
                "stock_symbols": metadata.get("stock_symbols", []),
                "live_mode": metadata.get("live_mode", True),
                "start_time": metadata.get("start_time"),
                "enabled": True
            }
            
            updated = False
            for idx, item in enumerate(existing):
                if isinstance(item, dict) and item.get("folder") == self.signature:
                    existing[idx] = {**item, **entry}
                    updated = True
                    break
            
            if not updated:
                existing.append(entry)
            
            with open(manifest_path, "w", encoding="utf-8") as f:
                json.dump(existing, f, ensure_ascii=False, indent=2)
        except Exception as exc:
            print(f"⚠️  Warning: failed to update live agents manifest for {self.signature}: {exc}")
    
    def is_market_open(self) -> bool:
        """
        Check if market is currently open
        US Market: 9:30 AM - 4:00 PM ET, Monday-Friday
        """
        from datetime import timezone
        import pytz
        
        # Get current time in ET
        try:
            et_tz = pytz.timezone('US/Eastern')
            now_et = datetime.now(et_tz)
        except:
            # Fallback: assume system time + 3 hours (PST to EST)
            now = datetime.now()
            now_et = now + timedelta(hours=3)
        
        # Check if weekend
        if now_et.weekday() >= 5:  # Saturday=5, Sunday=6
            return False
        
        # Check market hours in ET
        current_time = now_et.time()
        market_open = datetime.strptime("09:30", "%H:%M").time()
        market_close = datetime.strptime("16:00", "%H:%M").time()
        
        is_open = market_open <= current_time < market_close
        print(f"⏰ Current ET time: {now_et.strftime('%H:%M:%S')} | Market {'OPEN' if is_open else 'CLOSED'}")
        
        return is_open
    
    async def run_live(self) -> None:
        """
        Run live 5-minute trading continuously from now until stopped
        - Resets positions on start
        - Trades immediately if market is open
        - Waits 5 minutes between trades
        - Continues until interrupted (Ctrl+C)
        """
        print(f"🔴 Starting LIVE 5-minute trading mode for {self.signature}")
        print(f"📊 Symbols: {', '.join(self.trading_symbols)}")
        print(f"💰 Initial cash: ${self.initial_cash:,.2f}")
        print(f"⏰ Will trade every 5 minutes during market hours")
        print(f"🛑 Press Ctrl+C to stop\n")
        
        # Reset positions to fresh state
        self.reset_positions()
        
        interval_count = 0
        
        last_closed_log = None
        try:
            while True:
                # ALWAYS use ET (Eastern Time) for stock operations
                import pytz
                et_tz = pytz.timezone('US/Eastern')
                current_time_et = datetime.now(et_tz)
                # Format as ISO 8601 with timezone for proper frontend parsing
                current_time_str = current_time_et.strftime("%Y-%m-%dT%H:%M:%S%z")
                # Insert colon in timezone (e.g., -0500 -> -05:00)
                current_time_str = current_time_str[:-2] + ':' + current_time_str[-2:]
                
                # Check if market is open
                if not self.is_market_open():
                    # Display in readable format for console
                    readable_time = current_time_et.strftime("%Y-%m-%d %H:%M:%S")
                    if last_closed_log is None or (current_time_et - last_closed_log).total_seconds() >= 3600:
                        print(f"⏸️  Market closed at {readable_time} ET. Waiting...")
                        last_closed_log = current_time_et
                    # Check again in 5 minutes
                    await asyncio.sleep(300)
                    continue
                else:
                    last_closed_log = None
                
                interval_count += 1
                # Display in readable format for console
                readable_time = current_time_et.strftime("%Y-%m-%d %H:%M:%S")
                print(f"\n{'='*60}")
                print(f"🔄 Interval #{interval_count} - {readable_time} ET")
                print(f"{'='*60}")
                
                # Set configuration
                # TODAY_DATE is in ET (Eastern Time) - standard for US stock market
                # Frontend will convert to user's local timezone for display
                write_config_value("TODAY_DATE", current_time_str)
                write_config_value("SIGNATURE", self.signature)
                
                try:
                    # Run trading session for current time
                    await self.run_with_retry(current_time_str)
                    print(f"✅ Interval #{interval_count} completed")
                except Exception as e:
                    print(f"❌ Error in interval #{interval_count}: {str(e)}")
                    print(f"Continuing to next interval...")
                
                # Wait 5 minutes (300 seconds)
                print(f"⏳ Waiting 5 minutes until next interval...")
                await asyncio.sleep(300)
                
        except KeyboardInterrupt:
            print(f"\n\n🛑 Received stop signal")
            print(f"📊 Total intervals completed: {interval_count}")
            print(f"✅ Live trading stopped gracefully")
            
            # Show final position summary
            summary = self.get_position_summary()
            currency_symbol = "¥" if self.market == "cn" else "$"
            print(f"\n📊 Final Position Summary:")
            print(f"   - Latest time: {summary.get('latest_date')}")
            print(f"   - Total trades: {summary.get('total_records', 0) - 1}")  # -1 for INIT
            print(f"   - Cash balance: {currency_symbol}{summary.get('positions', {}).get('CASH', 0):,.2f}")
            positions = summary.get('positions', {})
            for symbol, shares in positions.items():
                if symbol != 'CASH' and shares > 0:
                    print(f"   - {symbol}: {shares} shares")
    
    def __str__(self) -> str:
        symbols_str = ', '.join(self.trading_symbols)
        return f"BaseAgent_5Min(signature='{self.signature}', symbols=[{symbols_str}], basemodel='{self.basemodel}')"
    
    def __repr__(self) -> str:
        return self.__str__()

