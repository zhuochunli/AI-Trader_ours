#!/bin/bash

echo "🚀 Starting Complete AI-Trader System"
echo "======================================"
echo ""

# Function to cleanup on exit
cleanup() {
    echo ""
    echo "🛑 Shutting down all services..."
    
    # Kill latest-bar poller
    if [ ! -z "$LATEST_PID" ]; then
        kill $LATEST_PID 2>/dev/null
        echo "   ✅ Latest-bar poller stopped (PID: $LATEST_PID)"
    fi

    # Kill trading agent (by PID first, then by name)
    if [ ! -z "$TRADING_PID" ]; then
        kill $TRADING_PID 2>/dev/null
        echo "   ✅ Trading agent stopped (PID: $TRADING_PID)"
    fi
    pkill -f "main.py" 2>/dev/null
    pkill -f "python.*main.py" 2>/dev/null
    
    # Kill MCP services (by PID first, then by port)
    if [ ! -z "$MCP_PID" ]; then
        kill $MCP_PID 2>/dev/null
    fi
    for port in 8001 8002 8003 8004 8005 8010; do
        lsof -ti:$port | xargs kill -9 2>/dev/null
    done
    echo "   ✅ MCP services stopped"
    
    # Kill frontend server (by PID and by port)
    if [ ! -z "$FRONTEND_PID" ]; then
        kill $FRONTEND_PID 2>/dev/null
        echo "   ✅ Frontend server stopped (PID: $FRONTEND_PID)"
    fi
    pkill -f "http.server.*808" 2>/dev/null
    
    echo ""
    echo "✅ All services stopped cleanly"
    exit 0
}

# Set up trap to catch Ctrl+C
trap cleanup INT TERM

if [ -f ".env" ]; then
    set -a
    source .env
    set +a
fi

# Ensure frontend data points to live runtime data and stale caches are cleared
echo "🧹 Preparing data directories..."
if [ -e "docs/data" ] && [ ! -L "docs/data" ]; then
    echo "   • Removing stale docs/data directory"
    rm -rf docs/data
fi

if [ ! -L "docs/data" ]; then
    ln -s ../data docs/data
    echo "   • Created docs/data → ../data symlink"
fi

RUNTIME_DATA_DIR="./data/agent_data_5min"
if [ -d "$RUNTIME_DATA_DIR" ]; then
    echo "   • Clearing previous log snapshots"
    find "$RUNTIME_DATA_DIR" -maxdepth 2 -type d \( -name "log" -o -name "logs" \) -exec rm -rf {} + 2>/dev/null

    echo "   • Removing cached baseline data"
    find "$RUNTIME_DATA_DIR" -type f -name "buy_and_hold.json" -delete 2>/dev/null
fi

# Ensure legacy data path points at live 5-min data
if [ -e "data/agent_data" ] || [ -L "data/agent_data" ]; then
    rm -rf data/agent_data
fi
ln -s agent_data_5min data/agent_data
echo "   • Linked data/agent_data → agent_data_5min"

echo "Step 1/3: Starting Frontend Dashboard..."
echo "----------------------------------------"
./start_frontend.sh > /dev/null 2>&1 &
FRONTEND_PID=$!
sleep 2

if ps -p $FRONTEND_PID > /dev/null; then
    echo "✅ Frontend started (PID: $FRONTEND_PID)"
    echo "   🔗 Dashboard: http://localhost:8080/index.html"
    echo "   🔗 Portfolio: http://localhost:8080/portfolio.html"
else
    echo "❌ Frontend failed to start"
    echo "   ℹ️  Port 8080 might be in use. Trying to clean up..."
    pkill -f "http.server.*808" 2>/dev/null
    echo "   Run './start_all.sh' again to retry"
    exit 1
fi

echo ""
echo "Step 2/3: Starting MCP Services..."
echo "----------------------------------------"
python agent_tools/start_mcp_services.py > /dev/null 2>&1 &
MCP_PID=$!
sleep 3

if ps -p $MCP_PID > /dev/null; then
    echo "✅ MCP services started (PID: $MCP_PID)"
else
    echo "❌ MCP services failed to start"
    cleanup
fi

echo ""
echo "Step 3/3: Starting 5-Min Trading Agent..."
echo "----------------------------------------"
# Start latest-bar poller if Alpaca keys available
if [ -n "$ALPACA_API_KEY" ] && [ -n "$ALPACA_API_SECRET" ]; then
    python tools/latest_bar_updater.py configs/default_5min_config.json > /dev/null 2>&1 &
    LATEST_PID=$!
    echo "✅ Latest-bar poller started (PID: $LATEST_PID)"
else
    echo "⚠️  Alpaca API keys not set; skipping latest-bar poller."
fi

# .env file is loaded automatically by Python's dotenv
python main.py configs/default_5min_config.json &
TRADING_PID=$!

echo "✅ Trading agent started (PID: $TRADING_PID)"

echo ""
echo "============================================"
echo "🎉 AI-Trader System is LIVE!"
echo "============================================"
echo ""
echo "📊 Services Running:"
echo "   • Frontend:  http://localhost:8080"
echo "   • MCP Tools: Ports 8001-8004, 8010"
echo "   • Trading:   5-minute live trading"
echo ""
echo "💡 To view your trading dashboard:"
echo "   1. Open: http://localhost:8080/index.html"
echo "   2. Watch real-time trading!"
echo ""
echo "⚠️  Press Ctrl+C to stop all services"
echo ""

# Wait for user interrupt
wait

