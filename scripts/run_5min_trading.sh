#!/bin/bash

# Run 5-minute intraday trading with AI-Trader
# This script starts the 5-minute trading agent

echo "🚀 Starting 5-Minute Intraday Trading"
echo "======================================"

# Unset any cached environment variables first
unset OPENAI_API_KEY
unset OPENAI_BASE_URL

# Check if export_env.sh exists and source it
if [ -f export_env.sh ]; then
    source export_env.sh
    echo "✅ Loaded environment from export_env.sh"
elif [ -f .env ]; then
    # If export_env.sh doesn't exist, try .env
    echo "⚠️  export_env.sh not found, trying .env..."
    export $(grep -v '^#' .env | xargs) 2>/dev/null
    echo "✅ Loaded environment from .env"
else
    echo "❌ Error: Neither export_env.sh nor .env file found!"
    echo "Please create a .env file with your API keys"
    echo "You can copy from .env.example:"
    echo "  cp .env.example .env"
    exit 1
fi

# Check if Alpaca credentials are set
if ! grep -q "ALPACA_API_KEY=" .env || ! grep -q "ALPACA_API_SECRET=" .env; then
    echo "⚠️  Warning: Alpaca API credentials not found in .env"
    echo "Please add ALPACA_API_KEY and ALPACA_API_SECRET to .env file"
fi

# Default config file
CONFIG_FILE="${1:-configs/default_5min_config.json}"

if [ ! -f "$CONFIG_FILE" ]; then
    echo "❌ Error: Configuration file not found: $CONFIG_FILE"
    exit 1
fi

echo "📄 Using configuration: $CONFIG_FILE"
echo ""

# Run the trading agent
python main.py "$CONFIG_FILE"

echo ""
echo "✅ Trading session completed"

