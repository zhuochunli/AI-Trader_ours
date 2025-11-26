// Portfolio Analysis Page
// Detailed view of individual agent portfolios

const dataLoader = new DataLoader();
let allAgentsData = {};
let currentAgent = null;
let allocationChart = null;
let isLoading = false; // Flag to prevent multiple simultaneous loads

// Update subtitle based on current market
function updateMarketSubtitle() {
    const marketConfig = dataLoader.getMarketConfig();
    const subtitleElement = document.getElementById('marketSubtitle');
    
    if (marketConfig && subtitleElement) {
        // Custom subtitles for portfolio page
        const subtitles = {
            'us': 'Daily Trading Portfolio - Detailed analysis of holdings and performance',
            'us_5min': 'Intraday Trading Portfolio - Detailed position analysis',
            'cn': 'A-share market portfolio breakdown and holdings analysis'
        };
        
        const market = dataLoader.getMarket();
        subtitleElement.textContent = subtitles[market] || subtitles['us_5min'];
    }
}

// Load data and refresh UI
async function loadDataAndRefresh() {
    // Prevent multiple simultaneous loads
    if (isLoading) {
        console.log('Already loading, skipping...');
        return;
    }
    
    isLoading = true;
    showLoading();
    disableMarketButtons();

    try {
        // Ensure config is loaded first
        await dataLoader.initialize();
        
        // Update subtitle for the current market
        updateMarketSubtitle();
        
        // Load all agents data
        console.log('Loading all agents data...');
        allAgentsData = await dataLoader.loadAllAgentsData();
        console.log('Data loaded:', allAgentsData);

        // Populate agent selector
        populateAgentSelector();

        // Determine which agent to show (persist selection across refresh)
        const agentNames = Object.keys(allAgentsData);
        const defaultAgent = agentNames[0];
        const persistedAgent = (() => {
            try {
                return localStorage.getItem('portfolio-active-agent');
            } catch {
                return null;
            }
        })();
        let agentToLoad = defaultAgent;
        if (persistedAgent && agentNames.includes(persistedAgent)) {
            agentToLoad = persistedAgent;
        }

        if (agentToLoad) {
            currentAgent = agentToLoad;
            await loadAgentPortfolio(agentToLoad);
        }

    } catch (error) {
        console.error('Error loading data:', error);
        
        // Show error message in the UI instead of alert
        if (Object.keys(allAgentsData || {}).length === 0) {
            const container = document.querySelector('.container');
            if (container) {
                const errorMsg = document.createElement('div');
                errorMsg.style.cssText = 'margin: 20px; padding: 20px; background: #fff3cd; border-radius: 8px; color: #856404; text-align: center;';
                errorMsg.innerHTML = `
                    <strong>ℹ️ No agents found</strong><br>
                    ${dataLoader.getMarket() === 'us_5min' ? 
                        'Make sure your 5-minute trading agent is running. It may take a few moments for data to appear.' :
                        'No trading data available for this market. Please check your configuration.'
                    }
                `;
                container.insertBefore(errorMsg, container.firstElementChild.nextSibling);
                
                // Auto-remove message after 5 seconds
                setTimeout(() => errorMsg.remove(), 5000);
            }
        }
    } finally {
        hideLoading();
        enableMarketButtons();
        isLoading = false;
    }
}

// Button management functions
function disableMarketButtons() {
    const buttons = document.querySelectorAll('.market-btn');
    buttons.forEach(btn => {
        btn.disabled = true;
        btn.style.opacity = '0.6';
        btn.style.cursor = 'not-allowed';
    });
}

function enableMarketButtons() {
    const buttons = document.querySelectorAll('.market-btn');
    buttons.forEach(btn => {
        btn.disabled = false;
        btn.style.opacity = '';
        btn.style.cursor = 'pointer';
    });
}

// Update active button state
function updateActiveButton(activeMarket) {
    const usMarketBtn = document.getElementById('usMarketBtn');
    const cnMarketBtn = document.getElementById('cnMarketBtn');
    const us5minMarketBtn = document.getElementById('us5minMarketBtn');
    
    if (usMarketBtn) usMarketBtn.classList.remove('active');
    if (cnMarketBtn) cnMarketBtn.classList.remove('active');
    if (us5minMarketBtn) us5minMarketBtn.classList.remove('active');
    
    if (activeMarket === 'us' && usMarketBtn) {
        usMarketBtn.classList.add('active');
    } else if (activeMarket === 'cn' && cnMarketBtn) {
        cnMarketBtn.classList.add('active');
    } else if (activeMarket === 'us_5min' && us5minMarketBtn) {
        us5minMarketBtn.classList.add('active');
    }
}

// Expose loadAllData for live refresh
window.loadAllData = async function() {
    await loadDataAndRefresh();
};

// Initialize the page
async function init() {
    // Set up event listeners first
    setupEventListeners();
    
    // Set initial button state based on current market
    updateActiveButton(dataLoader.getMarket());

    // Load initial data
    // Load initial data
    await loadDataAndRefresh();
}

// Populate agent selector dropdown
function populateAgentSelector() {
    const select = document.getElementById('agentSelect');
    select.innerHTML = '';

    Object.keys(allAgentsData).forEach(agentName => {
        const option = document.createElement('option');
        option.value = agentName;
        // Use text only for dropdown options (HTML select doesn't support images well)
        option.textContent = dataLoader.getAgentDisplayName(agentName);
        select.appendChild(option);
    });

    // Set the select to the current agent if available
    if (currentAgent && select.value !== currentAgent) {
        select.value = currentAgent;
    }
}

// Load and display portfolio for selected agent
async function loadAgentPortfolio(agentName) {
    showLoading();

    try {
        currentAgent = agentName;
        try {
            localStorage.setItem('portfolio-active-agent', agentName);
        } catch {
            // Ignore storage errors (e.g., Safari private mode)
        }
        const data = allAgentsData[agentName];

        // Update performance metrics
        await updateMetrics(data);

        // Update holdings table
        await updateHoldingsTable(agentName);

        // Update allocation chart
        await updateAllocationChart(agentName);

        // Update trade history
        updateTradeHistory(agentName);

    } catch (error) {
        console.error('Error loading portfolio:', error);
    } finally {
        hideLoading();
    }
}

// Update performance metrics
async function updateMetrics(data) {
    let totalAsset = data.currentValue;
    const latestPosition = data.positions && data.positions.length > 0 ? data.positions[data.positions.length - 1] : null;
    const cashPosition = latestPosition && latestPosition.positions ? latestPosition.positions.CASH || 0 : 0;
    const totalTrades = data.positions ? data.positions.filter(p => p.this_action).length : 0;

    // For intraday trading, recalculate total asset value with current prices
    const market = dataLoader.getMarket();
    if (market === 'us_5min' && latestPosition) {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        const priceDate = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
        
        let stockValue = 0;
        for (const [symbol, shares] of Object.entries(latestPosition.positions)) {
            if (symbol !== 'CASH' && shares !== 0) {
                const price = await dataLoader.getClosingPrice(symbol, priceDate);
                if (price) {
                    // Handle both long positions (shares > 0) and short positions (shares < 0)
                    stockValue += shares * price;
                }
            }
        }
        totalAsset = cashPosition + stockValue;
    }

    // Synchronize in-memory data with recalculated totals
    data.currentValue = totalAsset;
    if (data.assetHistory && data.assetHistory.length > 0) {
        data.assetHistory[data.assetHistory.length - 1].value = totalAsset;
    }

    const totalReturn = data.initialValue ? ((totalAsset - data.initialValue) / data.initialValue * 100) : 0;

    document.getElementById('totalAsset').textContent = dataLoader.formatCurrency(totalAsset);
    document.getElementById('totalReturn').textContent = dataLoader.formatPercent(totalReturn);
    document.getElementById('totalReturn').className = `metric-value ${totalReturn >= 0 ? 'positive' : 'negative'}`;
    document.getElementById('cashPosition').textContent = dataLoader.formatCurrency(cashPosition);
    document.getElementById('totalTrades').textContent = totalTrades;
}

// Update holdings table
async function updateHoldingsTable(agentName) {
    const holdings = dataLoader.getCurrentHoldings(agentName);
    const tableBody = document.getElementById('holdingsTableBody');
    tableBody.innerHTML = '';

    const data = allAgentsData[agentName];
    if (!data || !data.assetHistory || data.assetHistory.length === 0) {
        return;
    }

    if (!holdings || Object.keys(holdings).length === 0) {
        const noDataRow = document.createElement('tr');
        noDataRow.innerHTML = `
            <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 2rem;">
                No holdings data available
            </td>
        `;
        tableBody.appendChild(noDataRow);
        return;
    }

    // For intraday trading, use current time to get latest prices
    const market = dataLoader.getMarket();
    let priceDate;
    if (market === 'us_5min') {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        priceDate = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    } else {
        priceDate = data.assetHistory[data.assetHistory.length - 1].date;
    }

    // Get all stocks with non-zero holdings (including short positions with negative shares)
    const stocks = Object.entries(holdings)
        .filter(([symbol, shares]) => symbol !== 'CASH' && shares !== 0);

    // Sort by market value (descending)
    const holdingsData = await Promise.all(
        stocks.map(async ([symbol, shares]) => {
            const price = await dataLoader.getClosingPrice(symbol, priceDate);
            // Market value: positive for long positions, negative for short positions
            const marketValue = price ? shares * price : 0;
            const isShort = shares < 0;
            return { symbol, shares, price, marketValue, isShort };
        })
    );

    holdingsData.sort((a, b) => Math.abs(b.marketValue) - Math.abs(a.marketValue));

    // Calculate total value with current prices (short positions reduce total value)
    const totalStockValue = holdingsData.reduce((sum, h) => sum + h.marketValue, 0);
    const totalValue = totalStockValue + (holdings.CASH || 0);

    // Create table rows
    holdingsData.forEach(holding => {
        const weight = totalValue !== 0 ? (holding.marketValue / totalValue * 100).toFixed(2) : '0.00';
        const sharesDisplay = holding.isShort 
            ? `${Math.abs(holding.shares)} (short)`
            : holding.shares.toString();
        const row = document.createElement('tr');
        row.innerHTML = `
            <td class="symbol">${holding.symbol}</td>
            <td>${sharesDisplay}</td>
            <td>${dataLoader.formatCurrency(holding.price || 0)}</td>
            <td>${dataLoader.formatCurrency(holding.marketValue)}</td>
            <td>${weight}%</td>
        `;
        tableBody.appendChild(row);
    });

    // Add cash row
    if (holdings.CASH !== undefined) {
        const cashAmount = holdings.CASH || 0;
        const cashWeight = totalValue > 0 ? (cashAmount / totalValue * 100).toFixed(2) : 0;
        const cashRow = document.createElement('tr');
        cashRow.innerHTML = `
            <td class="symbol">CASH</td>
            <td>-</td>
            <td>-</td>
            <td>${dataLoader.formatCurrency(cashAmount)}</td>
            <td>${cashWeight}%</td>
        `;
        tableBody.appendChild(cashRow);
    }

    // If no holdings data, show a message
    if (holdingsData.length === 0 && (!holdings.CASH || holdings.CASH === 0)) {
        const noDataRow = document.createElement('tr');
        noDataRow.innerHTML = `
            <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 2rem;">
                No holdings data available
            </td>
        `;
        tableBody.appendChild(noDataRow);
    }
}

// Update allocation chart (pie chart)
async function updateAllocationChart(agentName) {
    const holdings = dataLoader.getCurrentHoldings(agentName);
    if (!holdings) return;

    const data = allAgentsData[agentName];
    
    const values = [];
    // For intraday trading, use current time to get latest prices
    const market = dataLoader.getMarket();
    let priceDate;
    if (market === 'us_5min') {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        priceDate = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    } else {
        priceDate = data.assetHistory[data.assetHistory.length - 1].date;
    }

    // Calculate market values
    const allocations = [];
    let totalValue = 0;

    for (const [symbol, shares] of Object.entries(holdings)) {
        if (symbol === 'CASH') {
            if (shares !== undefined) {
                const cashValue = shares || 0;
                allocations.push({ label: 'CASH', value: cashValue });
                totalValue += cashValue;
            }
        } else if (shares !== 0) {
            // Include both long (positive) and short (negative) positions
            const price = await dataLoader.getClosingPrice(symbol, priceDate);
            if (price) {
                const value = shares * price; // Negative for short positions
                const label = shares < 0 ? `${symbol} (short)` : symbol;
                allocations.push({ label, value });
                totalValue += value;
            }
        }
    }

    if (allocations.length === 0) {
        allocations.push({ label: 'CASH', value: holdings.CASH || 0 });
        totalValue = holdings.CASH || 0;
    }

    // Sort by value and take top 10, combine rest as "Others"
    allocations.sort((a, b) => b.value - a.value);

    const topAllocations = allocations.slice(0, 10);
    const othersValue = allocations.slice(10).reduce((sum, a) => sum + a.value, 0);

    if (othersValue > 0) {
        topAllocations.push({ label: 'Others', value: othersValue });
    }

    // Destroy existing chart
    if (allocationChart) {
        allocationChart.destroy();
    }

    // Create new chart
    const ctx = document.getElementById('allocationChart').getContext('2d');
    
    // Define consistent color mapping for common assets
    const assetColorMap = {
        'CASH': '#00d4ff',      // Blue for cash
        'QQQ': '#00ffcc',       // Cyan for QQQ
        'Others': '#ff006e'     // Pink for others
    };
    
    // Extended color palette for other assets
    const defaultColors = [
        '#ffbe0b', '#8338ec', '#3a86ff', '#fb5607', '#06ffa5',
        '#ff006e', '#ffbe0b', '#8338ec', '#3a86ff', '#fb5607'
    ];
    
    // Assign colors based on asset type, fallback to default palette
    let colorIndex = 0;
    const backgroundColor = topAllocations.map(a => {
        if (assetColorMap[a.label]) {
            return assetColorMap[a.label];
        }
        // For unknown assets, use default palette
        const color = defaultColors[colorIndex % defaultColors.length];
        colorIndex++;
        return color;
    });

    allocationChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: topAllocations.map(a => a.label),
            datasets: [{
                data: topAllocations.map(a => a.value),
                backgroundColor: backgroundColor,
                borderWidth: 2,
                borderColor: '#1a2238'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        color: '#a0aec0',
                        padding: 15,
                        font: {
                            size: 12
                        }
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(26, 34, 56, 0.95)',
                    titleColor: '#00d4ff',
                    bodyColor: '#fff',
                    borderColor: '#2d3748',
                    borderWidth: 1,
                    padding: 12,
                    callbacks: {
                        label: function(context) {
                            const label = context.label || '';
                            const value = dataLoader.formatCurrency(context.parsed);
                            const total = context.dataset.data.reduce((sum, v) => sum + v, 0);
                            const percentage = ((context.parsed / total) * 100).toFixed(1);
                            return `${label}: ${value} (${percentage}%)`;
                        }
                    }
                }
            }
        }
    });
}

// Update trade history timeline
function updateTradeHistory(agentName) {
    const trades = dataLoader.getTradeHistory(agentName);
    const timeline = document.getElementById('tradeTimeline');
    timeline.innerHTML = '';

    if (trades.length === 0) {
        timeline.innerHTML = '<p style="color: var(--text-muted);">No trade history available.</p>';
        return;
    }

    // Show all trades (scrollable container handles overflow)
    const recentTrades = trades;

    recentTrades.forEach(trade => {
        const tradeItem = document.createElement('div');
        tradeItem.className = 'trade-item';

        const isShort = trade.action === 'short';
        const icon = trade.action === 'buy' ? '📈' : '📉';
        const iconClass = trade.action === 'buy' ? 'buy' : 'sell';
        const actionText = isShort ? 'Shorted' : (trade.action === 'buy' ? 'Bought' : 'Sold');

        // Format the timestamp for hourly data
        let formattedDate = trade.date;
        if (trade.date.includes(':')) {
            const date = new Date(trade.date);
            formattedDate = date.toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });
        }

        const sharesAfter = trade.positions && trade.symbol ? trade.positions[trade.symbol] ?? 0 : 0;
        const isShortPosition = sharesAfter < 0;
        const sharesDisplay = isShortPosition 
            ? `${Math.abs(sharesAfter)} (short)`
            : `${sharesAfter} ${Math.abs(sharesAfter) === 1 ? 'share' : 'shares'}`;
        const priceInfo = Number.isFinite(trade.price) ? `$${trade.price.toFixed(2)} USD` : 'Price unavailable';
        const cashAfter = trade.positions && typeof trade.positions.CASH === 'number'
            ? trade.positions.CASH
            : null;
        const cashText = cashAfter !== null
            ? `$${cashAfter.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
            : 'N/A';

        tradeItem.innerHTML = `
            <div class="trade-icon ${iconClass}">${icon}</div>
            <div class="trade-details">
                <div class="trade-action">${actionText} ${trade.amount} ${trade.amount === 1 ? 'share' : 'shares'} of ${trade.symbol}</div>
                <div class="trade-meta">
                    <span>${formattedDate}</span>
                    <span> • </span>
                    <span class="trade-metric"><strong>Price:</strong> ${priceInfo}</span>
                    <span> • </span>
                    <span class="trade-metric"><strong>Position:</strong> ${sharesDisplay}</span>
                    <span> • </span>
                    <span class="trade-metric"><strong>Cash:</strong> ${cashText}</span>
                </div>
            </div>
        `;

        timeline.appendChild(tradeItem);
    });
}

// Set up event listeners
function setupEventListeners() {
    document.getElementById('agentSelect').addEventListener('change', (e) => {
        loadAgentPortfolio(e.target.value);
    });

    // Market switching with protection against multiple clicks
    const usMarketBtn = document.getElementById('usMarketBtn');
    const cnMarketBtn = document.getElementById('cnMarketBtn');
    const us5minMarketBtn = document.getElementById('us5minMarketBtn');

    if (usMarketBtn) {
        usMarketBtn.addEventListener('click', async () => {
            const targetMarket = 'us';
            const currentMarket = dataLoader.getMarket();
            
            if (currentMarket === targetMarket) {
                console.log(`Already on ${targetMarket}, ignoring click`);
                return;
            }
            
            console.log(`Switching from ${currentMarket} to ${targetMarket}`);
            dataLoader.setMarket(targetMarket);
            updateActiveButton(targetMarket);
            await loadDataAndRefresh();
        });
    }

    if (cnMarketBtn) {
        cnMarketBtn.addEventListener('click', async () => {
            const targetMarket = 'cn';
            const currentMarket = dataLoader.getMarket();
            
            if (currentMarket === targetMarket) {
                console.log(`Already on ${targetMarket}, ignoring click`);
                return;
            }
            
            console.log(`Switching from ${currentMarket} to ${targetMarket}`);
            dataLoader.setMarket(targetMarket);
            updateActiveButton(targetMarket);
            await loadDataAndRefresh();
        });
    }

    if (us5minMarketBtn) {
        us5minMarketBtn.addEventListener('click', async () => {
            const targetMarket = 'us_5min';
            const currentMarket = dataLoader.getMarket();
            
            if (currentMarket === targetMarket) {
                console.log(`Already on ${targetMarket}, ignoring click`);
                return;
            }
            
            console.log(`Switching from ${currentMarket} to ${targetMarket}`);
            dataLoader.setMarket(targetMarket);
            updateActiveButton(targetMarket);
            await loadDataAndRefresh();
        });
    }

    // Scroll to top button
    const scrollBtn = document.getElementById('scrollToTop');
    window.addEventListener('scroll', () => {
        if (window.pageYOffset > 300) {
            scrollBtn.classList.add('visible');
        } else {
            scrollBtn.classList.remove('visible');
        }
    });

    scrollBtn.addEventListener('click', () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    });
}

// Loading overlay controls
function showLoading() {
    document.getElementById('loadingOverlay').classList.remove('hidden');
}

function hideLoading() {
    document.getElementById('loadingOverlay').classList.add('hidden');
}

// Initialize on page load
window.addEventListener('DOMContentLoaded', init);