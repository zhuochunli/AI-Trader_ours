#!/bin/bash

# Start 5-Minute Live Trading
# This script starts MCP services and then launches the trading agent

echo "🚀 Starting 5-Minute Live Trading System"
echo "========================================"

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
    echo "Please create .env with your API keys"
    exit 1
fi

echo ""
echo "📡 Starting MCP Tool Services..."
echo ""

# Start MCP services in background
python agent_tools/start_mcp_services.py &
MCP_PID=$!

echo "✅ MCP services started (PID: $MCP_PID)"
echo ""

# Start latest-bar poller in background
if [ -n "$ALPACA_API_KEY" ] && [ -n "$ALPACA_API_SECRET" ]; then
    python tools/latest_bar_updater.py configs/default_5min_config.json &
    LATEST_PID=$!
    echo "✅ Latest-bar poller started (PID: $LATEST_PID)"
else
    echo "⚠️  Alpaca API keys not set, skipping latest-bar poller."
fi

# Wait a bit for services to initialize
echo "⏳ Waiting 3 seconds for services to initialize..."
sleep 3

echo ""
echo "🔴 Starting Live Trading Agent..."
echo "   - Press Ctrl+C to stop trading"
echo "   - This will also stop MCP services"
echo ""

# Start the trading agent
python main.py configs/default_5min_config.json

# When trading stops, kill MCP services
echo ""
echo "🛑 Stopping MCP services..."
kill $MCP_PID 2>/dev/null

# Stop latest-bar poller if running
if [ -n "$LATEST_PID" ]; then
    echo "🛑 Stopping latest-bar poller..."
    kill $LATEST_PID 2>/dev/null
fi

echo "✅ Trading system stopped"

