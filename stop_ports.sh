#!/bin/bash

echo "🛑 Stopping All MCP Service Ports"
echo "=================================="
echo ""

# Define MCP service ports
PORTS=(8001 8002 8003 8004 8005 8010)
PORT_NAMES=("Search" "Trade" "LocalPrices" "Math" "News" "AlpacaBars")

stopped_count=0

for i in "${!PORTS[@]}"; do
    port=${PORTS[$i]}
    name=${PORT_NAMES[$i]}
    
    # Find process using this port
    pid=$(lsof -ti:$port 2>/dev/null)
    
    if [ -z "$pid" ]; then
        echo "✅ Port $port ($name) - Not in use"
    else
        echo "🔴 Port $port ($name) - Process found (PID: $pid)"
        kill -9 $pid 2>/dev/null
        if [ $? -eq 0 ]; then
            echo "   ✅ Killed process $pid"
            ((stopped_count++))
        else
            echo "   ❌ Failed to kill process $pid"
        fi
    fi
done

echo ""
echo "📊 Summary: Stopped $stopped_count process(es)"
echo ""

# Also check for any Python processes running MCP tools
echo "Checking for lingering MCP tool processes..."
mcp_processes=$(ps aux | grep -E "tool_(math|search|trade|alpaca|news|get_price)" | grep -v grep | awk '{print $2}')

if [ -z "$mcp_processes" ]; then
    echo "✅ No lingering MCP tool processes found"
else
    echo "🔴 Found lingering MCP processes:"
    ps aux | grep -E "tool_(math|search|trade|alpaca|news|get_price)" | grep -v grep
    echo ""
    echo "Killing them..."
    echo "$mcp_processes" | xargs kill -9 2>/dev/null
    echo "✅ Done"
fi

echo ""
echo "🎉 All ports cleared!"

