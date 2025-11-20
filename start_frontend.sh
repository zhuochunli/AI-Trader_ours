#!/bin/bash

echo "🌐 Starting AI-Trader Frontend Dashboard"
echo "========================================"
echo ""

# Check if port 8080 is in use
if lsof -Pi :8080 -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "⚠️  Port 8080 is already in use"
    echo "Trying port 8081..."
    PORT=8081
else
    PORT=8080
fi

# Check if Python is available
if command -v python3 &> /dev/null; then
    PYTHON_CMD=python3
elif command -v python &> /dev/null; then
    PYTHON_CMD=python
else
    echo "❌ Python not found. Please install Python to run the web server."
    exit 1
fi

echo "📂 Serving files from: docs/"
echo "🔗 Frontend URL: http://localhost:$PORT"
echo ""
echo "📊 Available pages:"
echo "   • Main Dashboard: http://localhost:$PORT/index.html"
echo "   • Portfolio View: http://localhost:$PORT/portfolio.html"
echo ""
echo "💡 Press Ctrl+C to stop the server"
echo ""

# Ensure docs/data points to runtime data directory
if [ -d "docs/data" ] && [ ! -L "docs/data" ]; then
    echo "♻️  Converting docs/data directory into symlink -> ../data"
    rm -rf docs/data
fi

if [ ! -e "docs/data" ]; then
    ln -s ../data docs/data
fi

# Start the HTTP server
cd docs && $PYTHON_CMD -m http.server $PORT


