import os
import sys
from typing import Any, Dict, List, Optional

from fastmcp import FastMCP

from typing import Dict, List, Optional, Any
import fcntl
from pathlib import Path
# Add project root directory to Python path
project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, project_root)
import json

from tools.general_tools import get_config_value, write_config_value
from tools.price_tools import (get_latest_position, get_open_prices,
                               get_yesterday_date,
                               get_yesterday_open_and_close_price,
                               get_yesterday_profit)

mcp = FastMCP("TradeTools")

def _position_lock(signature: str):
    """Context manager for file-based lock to serialize position updates per signature."""
    class _Lock:
        def __init__(self, name: str):
            base_dir = Path(project_root) / "data" / "agent_data" / name
            base_dir.mkdir(parents=True, exist_ok=True)
            self.lock_path = base_dir / ".position.lock"
            # Ensure lock file exists
            self._fh = open(self.lock_path, "a+")
        def __enter__(self):
            fcntl.flock(self._fh.fileno(), fcntl.LOCK_EX)
            return self
        def __exit__(self, exc_type, exc, tb):
            try:
                fcntl.flock(self._fh.fileno(), fcntl.LOCK_UN)
            finally:
                self._fh.close()
    return _Lock(signature)



@mcp.tool()
def buy(symbol: str, amount: int) -> Dict[str, Any]:
    """
    Buy stock function

    This function simulates stock buying operations, including the following steps:
    1. Get current position and operation ID
    2. Get stock opening price for the day
    3. Validate buy conditions (sufficient cash, lot size for CN market)
    4. Update position (increase stock quantity, decrease cash)
    5. Record transaction to position.jsonl file

    Args:
        symbol: Stock symbol, such as "AAPL", "MSFT", etc.
        amount: Buy quantity, must be a positive integer, indicating how many shares to buy
                For Chinese A-shares (symbols ending with .SH or .SZ), must be multiples of 100

    Returns:
        Dict[str, Any]:
          - Success: Returns new position dictionary (containing stock quantity and cash balance)
          - Failure: Returns {"error": error message, ...} dictionary

    Raises:
        ValueError: Raised when SIGNATURE environment variable is not set

    Example:
        >>> result = buy("AAPL", 10)
        >>> print(result)  # {"AAPL": 110, "MSFT": 5, "CASH": 5000.0, ...}
        >>> result = buy("600519.SH", 100)  # Chinese A-shares must be multiples of 100
        >>> print(result)  # {"600519.SH": 100, "CASH": 85000.0, ...}
    """
    # Step 1: Get environment variables and basic information
    # Get signature (model name) from environment variable, used to determine data storage path
    signature = get_config_value("SIGNATURE")
    if signature is None:
        raise ValueError("SIGNATURE environment variable is not set")

    # Get current trading date from environment variable
    today_date = get_config_value("TODAY_DATE")

    # Validate amount is positive
    if amount <= 0:
        return {
            "error": f"Buy amount must be positive! You tried to buy {amount} shares.",
            "symbol": symbol,
            "amount": amount,
            "date": today_date,
        }

    # Auto-detect market type based on symbol format
    market = "cn" if symbol.endswith((".SH", ".SZ")) else "us"

    # 🇨🇳 Chinese A-shares trading rule: Must trade in lots of 100 shares (一手 = 100股)
    if market == "cn" and amount % 100 != 0:
        return {
            "error": f"Chinese A-shares must be traded in multiples of 100 shares (1 lot = 100 shares). You tried to buy {amount} shares.",
            "symbol": symbol,
            "amount": amount,
            "date": today_date,
            "suggestion": f"Please use {(amount // 100) * 100} or {((amount // 100) + 1) * 100} shares instead.",
        }

    # Step 2: Get current latest position and operation ID
    # get_latest_position returns two values: position dictionary and current maximum operation ID
    # This ID is used to ensure each operation has a unique identifier
    # Acquire lock for atomic read-modify-write on positions
    with _position_lock(signature):
        try:
            current_position, current_action_id = get_latest_position(today_date, signature)
        except Exception as e:
            print(e)
            print(today_date, signature)
            return {"error": f"Failed to load latest position: {e}", "symbol": symbol, "date": today_date}
    # Step 3: Get stock opening price for the day
    # For 5-minute intraday trading (has time component), use Alpaca API for latest price
    # For daily trading, use get_open_prices from local files
    try:
        if 'T' in today_date or (' ' in today_date and len(today_date) > 10):
            # Intraday 5-minute trading - use Alpaca API to get latest price
            import requests
            alpaca_api_key = os.getenv("ALPACA_API_KEY")
            alpaca_api_secret = os.getenv("ALPACA_API_SECRET")
            
            url = f"https://data.alpaca.markets/v2/stocks/{symbol}/bars/latest"
            headers = {
                "APCA-API-KEY-ID": alpaca_api_key,
                "APCA-API-SECRET-KEY": alpaca_api_secret,
            }
            params = {"feed": "iex"}
            
            response = requests.get(url, headers=headers, params=params)
            if response.status_code == 200:
                data = response.json()
                bar = data.get("bar", {})
                this_symbol_price = bar.get("c")  # Close price of latest bar
                if not this_symbol_price:
                    raise KeyError(f"No price data for {symbol}")
                print(f"💰 Fetched latest price for {symbol}: ${this_symbol_price}")
            else:
                raise KeyError(f"Failed to fetch price for {symbol}: {response.status_code}")
        else:
            # Daily trading - use local price files
            this_symbol_price = get_open_prices(today_date, [symbol], market=market)[f"{symbol}_price"]
    except KeyError:
        # Stock symbol does not exist or price data is missing, return error message
        return {
            "error": f"Symbol {symbol} not found! This action will not be allowed.",
            "symbol": symbol,
            "date": today_date,
        }

    # Step 4: Validate buy conditions
    current_shares = current_position.get(symbol, 0)
    
    # If we have a short position (negative shares), buying closes the short
    # If we have a long position (positive shares) or no position, buying increases the long
    cash_required = this_symbol_price * amount
    
    # Calculate cash after transaction
    try:
        cash_left = current_position["CASH"] - cash_required
    except Exception as e:
        print(current_position, "CASH", this_symbol_price, amount)

    # Check if cash balance is sufficient
    if cash_left < 0:
        return {
            "error": "Insufficient cash! This action will not be allowed.",
            "required_cash": cash_required,
            "cash_available": current_position.get("CASH", 0),
            "symbol": symbol,
            "date": today_date,
        }
    
    # Check for reasonable position size limits (prevent unrealistic trades)
    # Maximum long position is limited by available cash (natural limit)
    # This is already enforced by the cash check above, so no additional limit needed
    
    # Step 5: Execute buy operation, update position
    new_position = current_position.copy()

    # Update stock position quantity
    # If closing a short (negative shares), this increases the value (makes it less negative)
    # If buying a long (positive or zero shares), this increases the value
    new_position[symbol] = current_shares + amount
    
    # Handle cash update based on whether we're closing a short or opening/increasing a long
    if current_shares < 0:
        # Closing a short position: decrease cash by buy-back cost (industry standard)
        # We already received proceeds when we opened the short, now we pay to buy back
        new_position["CASH"] = current_position.get("CASH", 0) - this_symbol_price * amount
    else:
        # Opening or increasing long position: decrease cash
        new_position["CASH"] = cash_left

    # Step 6: Record transaction to position.jsonl file
    # Build file path: {project_root}/data/{log_path}/{signature}/position/position.jsonl
    # Use append mode ("a") to write new transaction record
    # Each operation ID increments by 1, ensuring uniqueness of operation sequence
    log_path = get_config_value("LOG_PATH", "./data/agent_data")
    if log_path.startswith("./data/"):
        log_path = log_path[7:]  # Remove "./data/" prefix
    position_file_path = os.path.join(project_root, "data", log_path, signature, "position", "position.jsonl")
    with open(position_file_path, "a") as f:
        # Write JSON format transaction record, containing date, operation ID, transaction details and updated position
        print(
            f"Writing to position.jsonl: {json.dumps({'date': today_date, 'id': current_action_id + 1, 'this_action':{'action':'buy','symbol':symbol,'amount':amount},'positions': new_position})}"
        )
        f.write(
            json.dumps(
                {
                    "date": today_date,
                    "id": current_action_id + 1,
                    "this_action": {"action": "buy", "symbol": symbol, "amount": amount},
                    "positions": new_position,
                }
            )
            + "\n"
        )
    # Step 7: Return updated position
    write_config_value("IF_TRADE", True)
    print("IF_TRADE", get_config_value("IF_TRADE"))
    return new_position


def _get_today_buy_amount(symbol: str, today_date: str, signature: str) -> int:
    """
    Helper function to get the total amount bought today for T+1 restriction check

    Args:
        symbol: Stock symbol
        today_date: Trading date
        signature: Model signature

    Returns:
        Total shares bought today
    """
    log_path = get_config_value("LOG_PATH", "./data/agent_data")
    if log_path.startswith("./data/"):
        log_path = log_path[7:]  # Remove "./data/" prefix
    position_file_path = os.path.join(project_root, "data", log_path, signature, "position", "position.jsonl")

    if not os.path.exists(position_file_path):
        return 0

    total_bought_today = 0
    with open(position_file_path, "r") as f:
        for line in f:
            if not line.strip():
                continue
            try:
                record = json.loads(line)
                if record.get("date") == today_date:
                    this_action = record.get("this_action", {})
                    if this_action.get("action") == "buy" and this_action.get("symbol") == symbol:
                        total_bought_today += this_action.get("amount", 0)
            except Exception:
                continue

    return total_bought_today


@mcp.tool()
def sell(symbol: str, amount: int) -> Dict[str, Any]:
    """
    Sell stock function

    This function simulates stock selling operations, including the following steps:
    1. Get current position and operation ID
    2. Get stock opening price for the day
    3. Validate sell conditions (position exists, sufficient quantity, lot size, T+1 for CN market)
    4. Update position (decrease stock quantity, increase cash)
    5. Record transaction to position.jsonl file

    Args:
        symbol: Stock symbol, such as "AAPL", "MSFT", etc.
        amount: Sell quantity, must be a positive integer, indicating how many shares to sell
                For Chinese A-shares (symbols ending with .SH or .SZ), must be multiples of 100
                and cannot sell shares bought on the same day (T+1 rule)

    Returns:
        Dict[str, Any]:
          - Success: Returns new position dictionary (containing stock quantity and cash balance)
          - Failure: Returns {"error": error message, ...} dictionary

    Raises:
        ValueError: Raised when SIGNATURE environment variable is not set

    Example:
        >>> result = sell("AAPL", 10)
        >>> print(result)  # {"AAPL": 90, "MSFT": 5, "CASH": 15000.0, ...}
        >>> result = sell("600519.SH", 100)  # Chinese A-shares must be multiples of 100
        >>> print(result)  # {"600519.SH": 0, "CASH": 115000.0, ...}
    """
    # Step 1: Get environment variables and basic information
    # Get signature (model name) from environment variable, used to determine data storage path
    signature = get_config_value("SIGNATURE")
    if signature is None:
        raise ValueError("SIGNATURE environment variable is not set")

    # Get current trading date from environment variable
    today_date = get_config_value("TODAY_DATE")

    # Validate amount is positive
    if amount <= 0:
        return {
            "error": f"Sell amount must be positive! You tried to sell {amount} shares.",
            "symbol": symbol,
            "amount": amount,
            "date": today_date,
        }

    # Auto-detect market type based on symbol format
    market = "cn" if symbol.endswith((".SH", ".SZ")) else "us"

    # 🇨🇳 Chinese A-shares trading rule: Must trade in lots of 100 shares (一手 = 100股)
    if market == "cn" and amount % 100 != 0:
        return {
            "error": f"Chinese A-shares must be traded in multiples of 100 shares (1 lot = 100 shares). You tried to sell {amount} shares.",
            "symbol": symbol,
            "amount": amount,
            "date": today_date,
            "suggestion": f"Please use {(amount // 100) * 100} or {((amount // 100) + 1) * 100} shares instead.",
        }

    # Step 2: Get current latest position and operation ID
    # get_latest_position returns two values: position dictionary and current maximum operation ID
    # This ID is used to ensure each operation has a unique identifier
    current_position, current_action_id = get_latest_position(today_date, signature)

    # Step 3: Get stock opening price for the day
    # For 5-minute intraday trading (has time component), use Alpaca API for latest price
    # For daily trading, use get_open_prices from local files
    try:
        if 'T' in today_date or (' ' in today_date and len(today_date) > 10):
            # Intraday 5-minute trading - use Alpaca API to get latest price
            import requests
            alpaca_api_key = os.getenv("ALPACA_API_KEY")
            alpaca_api_secret = os.getenv("ALPACA_API_SECRET")
            
            url = f"https://data.alpaca.markets/v2/stocks/{symbol}/bars/latest"
            headers = {
                "APCA-API-KEY-ID": alpaca_api_key,
                "APCA-API-SECRET-KEY": alpaca_api_secret,
            }
            params = {"feed": "iex"}
            
            response = requests.get(url, headers=headers, params=params)
            if response.status_code == 200:
                data = response.json()
                bar = data.get("bar", {})
                this_symbol_price = bar.get("c")  # Close price of latest bar
                if not this_symbol_price:
                    raise KeyError(f"No price data for {symbol}")
                print(f"💰 Fetched latest price for {symbol}: ${this_symbol_price}")
            else:
                raise KeyError(f"Failed to fetch price for {symbol}: {response.status_code}")
        else:
            # Daily trading - use local price files
            this_symbol_price = get_open_prices(today_date, [symbol], market=market)[f"{symbol}_price"]
    except KeyError:
        # Stock symbol does not exist or price data is missing, return error message
        return {
            "error": f"Symbol {symbol} not found! This action will not be allowed.",
            "symbol": symbol,
            "date": today_date,
        }

    # Step 4: Validate sell conditions
    # Get current position for this symbol (default to 0 if not present)
    current_shares = current_position.get(symbol, 0)
    
    # If we have a short position (negative shares), selling closes the short
    # If we have a long position (positive shares), selling reduces the long
    if current_shares < 0:
        # Closing a short position - check if we have enough short shares to close
        if abs(current_shares) < amount:
            return {
                "error": f"Insufficient short position to close! You have {abs(current_shares)} shares short, but trying to close {amount}.",
                "have": current_shares,
                "want_to_close": amount,
                "symbol": symbol,
                "date": today_date,
            }
        # Also check if we have enough cash to buy back the shares
        cash_required = this_symbol_price * amount
        if current_position.get("CASH", 0) < cash_required:
            return {
                "error": f"Insufficient cash to close short position! Need ${cash_required:.2f} but only have ${current_position.get('CASH', 0):.2f}.",
                "required_cash": cash_required,
                "cash_available": current_position.get("CASH", 0),
                "symbol": symbol,
                "date": today_date,
            }
    elif current_shares == 0:
        # No position - cannot sell (use short() function to open a short position)
        return {
            "error": f"No position for {symbol}! To open a short position, use the short() function instead.",
            "symbol": symbol,
            "date": today_date,
        }
    elif current_shares < amount:
        # Long position but insufficient shares
        return {
            "error": "Insufficient shares! This action will not be allowed.",
            "have": current_shares,
            "want_to_sell": amount,
            "symbol": symbol,
            "date": today_date,
        }

    # 🇨🇳 Chinese A-shares T+1 trading rule: Cannot sell shares bought on the same day
    if market == "cn":
        bought_today = _get_today_buy_amount(symbol, today_date, signature)
        if bought_today > 0:
            # Calculate sellable quantity (total position - bought today)
            sellable_amount = current_position[symbol] - bought_today
            if amount > sellable_amount:
                return {
                    "error": f"T+1 restriction violated! You bought {bought_today} shares of {symbol} today and cannot sell them until tomorrow.",
                    "symbol": symbol,
                    "total_position": current_position[symbol],
                    "bought_today": bought_today,
                    "sellable_today": max(0, sellable_amount),
                    "want_to_sell": amount,
                    "date": today_date,
                }

    # Step 5: Execute sell operation, update position
    # Create a copy of current position to avoid directly modifying original data
    new_position = current_position.copy()

    # Update stock position quantity and cash balance
    if current_shares < 0:
        # Closing a short position via sell(): decrease cash by buy-back cost (industry standard)
        # This should rarely happen (usually close via buy()), but handle it
        new_position[symbol] = current_shares + amount
        # Decrease cash: you pay to buy back the shares you borrowed
        new_position["CASH"] = current_position.get("CASH", 0) - this_symbol_price * amount
    else:
        # Selling a long position: reducing positive shares
        new_position[symbol] = current_shares - amount
        # Increase cash: you receive money from selling
        new_position["CASH"] = new_position.get("CASH", 0) + this_symbol_price * amount

    # Step 6: Record transaction to position.jsonl file
    # Build file path: {project_root}/data/{log_path}/{signature}/position/position.jsonl
    # Use append mode ("a") to write new transaction record
    # Each operation ID increments by 1, ensuring uniqueness of operation sequence
    log_path = get_config_value("LOG_PATH", "./data/agent_data")
    if log_path.startswith("./data/"):
        log_path = log_path[7:]  # Remove "./data/" prefix
    position_file_path = os.path.join(project_root, "data", log_path, signature, "position", "position.jsonl")
    with open(position_file_path, "a") as f:
        # Write JSON format transaction record, containing date, operation ID and updated position
        print(
            f"Writing to position.jsonl: {json.dumps({'date': today_date, 'id': current_action_id + 1, 'this_action':{'action':'sell','symbol':symbol,'amount':amount},'positions': new_position})}"
        )
        f.write(
            json.dumps(
                {
                    "date": today_date,
                    "id": current_action_id + 1,
                    "this_action": {"action": "sell", "symbol": symbol, "amount": amount},
                    "positions": new_position,
                }
            )
            + "\n"
        )

    # Step 7: Return updated position
    write_config_value("IF_TRADE", True)
    return new_position


@mcp.tool()
def short(symbol: str, amount: int) -> Dict[str, Any]:
    """
    Short stock function (sell shares you don't own)

    This function simulates short selling operations, including the following steps:
    1. Get current position and operation ID
    2. Get stock current price
    3. Validate short conditions (sufficient cash for margin, lot size for CN market)
    4. Update position (create negative share position, increase cash)
    5. Record transaction to position.jsonl file

    Args:
        symbol: Stock symbol, such as "AAPL", "MSFT", etc.
        amount: Short quantity, must be a positive integer, indicating how many shares to short
                For Chinese A-shares (symbols ending with .SH or .SZ), must be multiples of 100

    Returns:
        Dict[str, Any]:
          - Success: Returns new position dictionary (containing negative stock quantity and cash balance)
          - Failure: Returns {"error": error message, ...} dictionary

    Raises:
        ValueError: Raised when SIGNATURE environment variable is not set

    Example:
        >>> result = short("AAPL", 10)
        >>> print(result)  # {"AAPL": -10, "MSFT": 5, "CASH": 15000.0, ...}
        >>> result = short("600519.SH", 100)  # Chinese A-shares must be multiples of 100
        >>> print(result)  # {"600519.SH": -100, "CASH": 115000.0, ...}
    """
    # Step 1: Get environment variables and basic information
    signature = get_config_value("SIGNATURE")
    if signature is None:
        raise ValueError("SIGNATURE environment variable is not set")

    today_date = get_config_value("TODAY_DATE")

    # Validate amount is positive
    if amount <= 0:
        return {
            "error": f"Short amount must be positive! You tried to short {amount} shares.",
            "symbol": symbol,
            "amount": amount,
            "date": today_date,
        }

    # Auto-detect market type
    market = "cn" if symbol.endswith((".SH", ".SZ")) else "us"

    # 🇨🇳 Chinese A-shares trading rule: Must trade in lots of 100 shares
    if market == "cn" and amount % 100 != 0:
        return {
            "error": f"Chinese A-shares must be traded in multiples of 100 shares (1 lot = 100 shares). You tried to short {amount} shares.",
            "symbol": symbol,
            "amount": amount,
            "date": today_date,
            "suggestion": f"Please use {(amount // 100) * 100} or {((amount // 100) + 1) * 100} shares instead.",
        }

    # Step 2: Get current position
    with _position_lock(signature):
        try:
            current_position, current_action_id = get_latest_position(today_date, signature)
        except Exception as e:
            print(e)
            print(today_date, signature)
            return {"error": f"Failed to load latest position: {e}", "symbol": symbol, "date": today_date}

    # Step 3: Get stock price
    try:
        if 'T' in today_date or (' ' in today_date and len(today_date) > 10):
            # Intraday 5-minute trading - use Alpaca API
            import requests
            alpaca_api_key = os.getenv("ALPACA_API_KEY")
            alpaca_api_secret = os.getenv("ALPACA_API_SECRET")
            
            url = f"https://data.alpaca.markets/v2/stocks/{symbol}/bars/latest"
            headers = {
                "APCA-API-KEY-ID": alpaca_api_key,
                "APCA-API-SECRET-KEY": alpaca_api_secret,
            }
            params = {"feed": "iex"}
            
            response = requests.get(url, headers=headers, params=params)
            if response.status_code == 200:
                data = response.json()
                bar = data.get("bar", {})
                this_symbol_price = bar.get("c")
                if not this_symbol_price:
                    raise KeyError(f"No price data for {symbol}")
                print(f"💰 Fetched latest price for {symbol}: ${this_symbol_price}")
            else:
                raise KeyError(f"Failed to fetch price for {symbol}: {response.status_code}")
        else:
            # Daily trading - use local price files
            this_symbol_price = get_open_prices(today_date, [symbol], market=market)[f"{symbol}_price"]
    except KeyError:
        return {
            "error": f"Symbol {symbol} not found! This action will not be allowed.",
            "symbol": symbol,
            "date": today_date,
        }

    # Step 4: Check if we already have a long position (can't short if you're long)
    current_shares = current_position.get(symbol, 0)
    if current_shares > 0:
        return {
            "error": f"Cannot short {symbol} while holding a long position ({current_shares} shares). Close your long position first.",
            "symbol": symbol,
            "current_position": current_shares,
            "date": today_date,
        }

    # Step 5: Validate short position requirements
    # Short position limit should be the same as long position limit
    # Maximum short shares = maximum long shares you could buy with current cash
    current_cash = current_position.get("CASH", 0)
    max_long_shares = int(current_cash / this_symbol_price) if this_symbol_price > 0 else 0
    
    # Calculate total short shares after this trade
    new_short_shares = current_shares - amount  # Will be more negative
    total_short_shares = abs(new_short_shares)
    
    # Check if short position would exceed the same limit as long positions
    if total_short_shares > max_long_shares:
        return {
            "error": f"Short position would exceed maximum allowed! With ${current_cash:.2f} cash and ${this_symbol_price:.2f} price, maximum is {max_long_shares} shares (same as long limit), but this trade would create {total_short_shares} shares short.",
            "current_cash": current_cash,
            "stock_price": this_symbol_price,
            "max_allowed_shares": max_long_shares,
            "current_short_shares": abs(current_shares) if current_shares < 0 else 0,
            "new_short_shares": total_short_shares,
            "symbol": symbol,
            "date": today_date,
        }

    # Step 6: Execute short operation
    new_position = current_position.copy()

    # Create short position (negative shares)
    new_position[symbol] = current_shares - amount

    # Increase cash balance immediately (industry standard)
    # Proceeds from short sale are credited to cash but held as collateral/restricted
    # This matches real broker systems (Interactive Brokers, TD Ameritrade, etc.)
    new_position["CASH"] = new_position.get("CASH", 0) + this_symbol_price * amount

    # Step 6: Record transaction
    log_path = get_config_value("LOG_PATH", "./data/agent_data")
    if log_path.startswith("./data/"):
        log_path = log_path[7:]
    position_file_path = os.path.join(project_root, "data", log_path, signature, "position", "position.jsonl")
    with open(position_file_path, "a") as f:
        print(
            f"Writing to position.jsonl: {json.dumps({'date': today_date, 'id': current_action_id + 1, 'this_action':{'action':'short','symbol':symbol,'amount':amount},'positions': new_position})}"
        )
        f.write(
            json.dumps(
                {
                    "date": today_date,
                    "id": current_action_id + 1,
                    "this_action": {"action": "short", "symbol": symbol, "amount": amount},
                    "positions": new_position,
                }
            )
            + "\n"
        )

    # Step 7: Return updated position
    write_config_value("IF_TRADE", True)
    return new_position


if __name__ == "__main__":
    # new_result = buy("AAPL", 1)
    # print(new_result)
    # new_result = sell("AAPL", 1)
    # print(new_result)
    port = int(os.getenv("TRADE_HTTP_PORT", "8002"))
    mcp.run(transport="streamable-http", port=port)
