// Asset Evolution Chart
// Main page visualization

const dataLoader = new DataLoader();
window.dataLoader = dataLoader; // Export to global for transaction-loader
let chartInstance = null;
let allAgentsData = {};
let isLogScale = false;
let isLoading = false; // Flag to prevent multiple simultaneous loads
let marketStatusTimer = null;
let tradePopoverEl = null;
let activeTradeMarker = null;
let tradePopoverDocumentListenerAttached = false;
let showTradeMarkers = false;
let tradeToggleButton = null;
let lastMarketOpenStatus = null;

// Color palette for different agents
const agentColors = [
    '#00d4ff', // Cyan Blue
    '#00ffcc', // Cyan
    '#ff006e', // Hot Pink
    '#ffbe0b', // Yellow
    '#8338ec', // Purple
    '#3a86ff', // Blue
    '#fb5607', // Orange
    '#06ffa5'  // Mint
];

const TRADE_MARKER_BASE_SIZE = 12;
const TRADE_MARKER_HOVER_SCALE = 1.2;
const LIVE_REFRESH_INTERVAL_OPEN_MS = 60000; // 1 minute
const LIVE_REFRESH_INTERVAL_CLOSED_MS = 3600000; // 1 hour

function drawTradeArrow(ctx, x, y, size, direction, fillColor, borderColor, lineWidth) {
    const headHeight = size * 0.68;
    const tailHeight = size * 0.35;
    const tailExtra = size * 0.5;
    const halfWidth = size * 0.42;
    const tailHalfWidth = size * 0.16;

    ctx.beginPath();
    if (direction === 'buy') {
        ctx.moveTo(x, y - headHeight);
        ctx.lineTo(x + halfWidth, y + tailHeight);
        ctx.lineTo(x + tailHalfWidth, y + tailHeight);
        ctx.lineTo(x + tailHalfWidth, y + tailHeight + tailExtra);
        ctx.lineTo(x - tailHalfWidth, y + tailHeight + tailExtra);
        ctx.lineTo(x - tailHalfWidth, y + tailHeight);
        ctx.lineTo(x - halfWidth, y + tailHeight);
    } else {
        ctx.moveTo(x, y + headHeight);
        ctx.lineTo(x + halfWidth, y - tailHeight);
        ctx.lineTo(x + tailHalfWidth, y - tailHeight);
        ctx.lineTo(x + tailHalfWidth, y - tailHeight - tailExtra);
        ctx.lineTo(x - tailHalfWidth, y - tailHeight - tailExtra);
        ctx.lineTo(x - tailHalfWidth, y - tailHeight);
        ctx.lineTo(x - halfWidth, y - tailHeight);
    }
    ctx.closePath();

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.fillStyle = fillColor;
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = lineWidth;
    ctx.fill();
    ctx.stroke();
}

// Cache for loaded SVG images
const iconImageCache = {};

// Function to load SVG as image
function loadIconImage(iconPath) {
    return new Promise((resolve, reject) => {
        if (iconImageCache[iconPath]) {
            resolve(iconImageCache[iconPath]);
            return;
        }
        
        const img = new Image();
        img.onload = () => {
            iconImageCache[iconPath] = img;
            resolve(img);
        };
        img.onerror = reject;
        img.src = iconPath;
    });
}

function ensureTradePopover() {
    if (!tradePopoverEl) {
        tradePopoverEl = document.createElement('div');
        tradePopoverEl.id = 'tradePopover';
        tradePopoverEl.className = 'trade-popover hidden';
        document.body.appendChild(tradePopoverEl);
        tradePopoverEl.addEventListener('click', (event) => event.stopPropagation());
    }

    if (!tradePopoverDocumentListenerAttached) {
        document.addEventListener('click', () => hideTradePopover());
        tradePopoverDocumentListenerAttached = true;
    }

    return tradePopoverEl;
}

function hideChartTooltip(chart) {
    try {
        if (chart && chart.tooltip && typeof chart.tooltip.setActiveElements === 'function') {
            chart.tooltip.setActiveElements([], { x: 0, y: 0 });
        }
        const tooltipEl = document.getElementById('chartjs-tooltip');
        if (tooltipEl) {
            tooltipEl.style.opacity = 0;
        }
    } catch (error) {
        console.warn('Failed to hide chart tooltip:', error);
    }
}

function hideTradePopover() {
    if (tradePopoverEl) {
        tradePopoverEl.classList.add('hidden');
        tradePopoverEl.classList.remove('active');
    }
    activeTradeMarker = null;
}

function updateTradeToggleButton() {
    if (!tradeToggleButton) return;
    tradeToggleButton.textContent = showTradeMarkers ? 'Hide Trades' : 'Show Trades';
}

function rebuildChart() {
    if (chartInstance) {
        chartInstance.destroy();
        chartInstance = null;
    }
    createChart();
}

function adjustLiveRefreshForMarket(isOpen, statusChanged) {
    if (!window.LiveLoader || typeof window.LiveLoader.updateRefreshInterval !== 'function') {
        return;
    }

    const targetInterval = isOpen ? LIVE_REFRESH_INTERVAL_OPEN_MS : LIVE_REFRESH_INTERVAL_CLOSED_MS;
    const immediate = statusChanged && isOpen;

    window.LiveLoader.updateRefreshInterval(targetInterval, immediate);
}

function formatTradeTimestamp(timestamp) {
    if (!timestamp) {
        return 'Unknown time';
    }

    if (window.transactionLoader && typeof window.transactionLoader.formatDateTime === 'function') {
        return window.transactionLoader.formatDateTime(timestamp);
    }

    const normalized = timestamp.includes('T') ? timestamp : timestamp.replace(' ', 'T');
    const date = new Date(normalized);
    if (Number.isNaN(date.valueOf())) {
        return timestamp;
    }

    return date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZoneName: 'short'
    });
}

function formatShares(value) {
    if (value === null || value === undefined) {
        return '—';
    }
    // Handle short positions (negative shares)
    if (value < 0) {
        const absValue = Math.abs(value);
        const formatted = new Intl.NumberFormat('en-US', {
            maximumFractionDigits: 4
        }).format(absValue);
        return `-${formatted} (short)`;
    }
    return new Intl.NumberFormat('en-US', {
        maximumFractionDigits: 4
    }).format(value);
}

function formatCurrencySoft(value) {
    if (value === null || value === undefined) {
        return '—';
    }
    try {
        return dataLoader.formatCurrency(value);
    } catch (e) {
        return `$${value.toFixed(2)}`;
    }
}

function getValueChangeDisplay(value) {
    if (value === null || value === undefined) {
        return '—';
    }
    const formatted = formatCurrencySoft(Math.abs(value));
    return `${value >= 0 ? '+' : '-'}${formatted}`;
}

function showTradePopover({ dataset, dataPoint, element, chart }) {
    const popover = ensureTradePopover();
    const meta = dataPoint.meta || {};
    const action = meta.action || 'trade';
    const isSell = action === 'sell';
    const isShort = action === 'short';
    const symbol = meta.symbol || 'Unknown';
    const amountFormatted = formatShares(meta.amount);
    const displayName = meta.displayName || dataset.label || dataLoader.getAgentDisplayName(meta.agentName || dataset.agentName);
    const timestamp = meta.timestamp || meta.assetDate;
    const timeDisplay = formatTradeTimestamp(timestamp);

    const priceDisplay = meta.price !== null && meta.price !== undefined
        ? formatCurrencySoft(meta.price)
        : 'Unknown';

    const portfolioValueDisplay = meta.valueAfter !== null && meta.valueAfter !== undefined
        ? formatCurrencySoft(meta.valueAfter)
        : '—';

    const valueChangeDisplay = meta.valueChange !== null && meta.valueChange !== undefined
        ? getValueChangeDisplay(meta.valueChange)
        : '—';

    const remainingCashDisplay = meta.cashAfter !== null && meta.cashAfter !== undefined
        ? formatCurrencySoft(meta.cashAfter)
        : '—';

    const sharesAfterDisplay = formatShares(meta.sharesAfter);

    const changeClass = meta.valueChange > 0 ? 'positive' : (meta.valueChange < 0 ? 'negative' : 'neutral');
    
    const actionLabel = isShort ? 'Short' : (isSell ? 'Sell' : 'Buy');
    const actionClass = isShort || isSell ? 'sell' : 'buy';

    const html = `
        <div class="trade-popover-header">
            <span class="trade-badge ${actionClass}">${actionLabel}</span>
            <div class="trade-symbol">${symbol}</div>
            <div class="trade-amount">×${amountFormatted}</div>
        </div>
        <div class="trade-agent">${displayName}</div>
        <div class="trade-time">${timeDisplay}</div>
        <div class="trade-popover-divider"></div>
        <dl class="trade-popover-stats">
            <div class="trade-popover-row">
                <dt>Trade Price</dt>
                <dd>${priceDisplay}</dd>
            </div>
            <div class="trade-popover-row">
                <dt>Total Value</dt>
                <dd>${portfolioValueDisplay}</dd>
            </div>
            <div class="trade-popover-row">
                <dt>Value Change</dt>
                <dd class="${changeClass}">${valueChangeDisplay}</dd>
            </div>
            <div class="trade-popover-row">
                <dt>Shares After</dt>
                <dd>${sharesAfterDisplay}</dd>
            </div>
            <div class="trade-popover-row">
                <dt>Remaining Cash</dt>
                <dd>${remainingCashDisplay}</dd>
            </div>
        </dl>
    `;

    popover.innerHTML = html;
    popover.classList.add('hidden');
    popover.classList.remove('active');

    const canvasRect = chart.canvas.getBoundingClientRect();
    const scrollX = window.pageXOffset;
    const scrollY = window.pageYOffset;

    const baseLeft = canvasRect.left + scrollX + element.x + 24;
    const baseTop = canvasRect.top + scrollY + element.y;

    // Make visible to measure
    popover.classList.remove('hidden');
    popover.style.left = '0px';
    popover.style.top = '0px';
    const popRect = popover.getBoundingClientRect();

    let left = baseLeft;
    let top = baseTop - popRect.height / 2;

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    if (left + popRect.width > viewportWidth - 20) {
        left = baseLeft - popRect.width - 40;
    }

    if (left < 20) {
        left = 20;
    }

    if (top + popRect.height > viewportHeight - 20) {
        top = viewportHeight - popRect.height - 20;
    }

    if (top < 20) {
        top = 20;
    }

    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;

    // Trigger animation
    popover.classList.add('active');
    popover.classList.remove('hidden');

    activeTradeMarker = {
        id: meta.id,
        datasetLabel: dataset.label
    };
}

// Update market subtitle based on current market
function updateMarketSubtitle() {
    console.log('[updateMarketSubtitle] Starting...');
    console.log('[updateMarketSubtitle] Current market:', dataLoader.getMarket());

    const marketConfig = dataLoader.getMarketConfig();
    console.log('[updateMarketSubtitle] Market config:', marketConfig);

    const subtitleElement = document.getElementById('marketSubtitle');
    console.log('[updateMarketSubtitle] Subtitle element:', subtitleElement);

    if (marketConfig && marketConfig.subtitle && subtitleElement) {
        subtitleElement.textContent = marketConfig.subtitle;
        console.log('Updated subtitle to:', marketConfig.subtitle);
    } else {
        console.warn('[updateMarketSubtitle] Missing required data:', {
            hasMarketConfig: !!marketConfig,
            hasSubtitle: marketConfig?.subtitle,
            hasElement: !!subtitleElement
        });
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
    hideTradePopover();

    try {
        // Ensure config is loaded first
        await dataLoader.initialize();

        // Update subtitle for the current market
        updateMarketSubtitle();

        // Load all agents data
        console.log('Loading all agents data...');
        allAgentsData = await dataLoader.loadAllAgentsData();
        console.log('Data loaded:', allAgentsData);

        // Preload all agent icons
        const agentNames = Object.keys(allAgentsData);
        const iconPromises = agentNames.map(agentName => {
            const iconPath = dataLoader.getAgentIcon(agentName);
            return loadIconImage(iconPath).catch(err => {
                console.warn(`Failed to load icon for ${agentName}:`, err);
            });
        });
        await Promise.all(iconPromises);

        const buyHoldSeries = dataLoader.getBuyHoldSeries();
        if (buyHoldSeries.length > 0) {
            const baselineIconPath = dataLoader.getAgentIcon('buy-and-hold');
            try {
                await loadIconImage(baselineIconPath);
            } catch (err) {
                console.warn('Failed to load Buy-and-Hold icon:', err);
            }
        }
        console.log('Icons preloaded');

        // Destroy existing chart if it exists
        if (chartInstance) {
            hideTradePopover();
            console.log('Destroying existing chart...');
            chartInstance.destroy();
            chartInstance = null;
        }

        // Update stats
        updateStats();

        // Create chart
        createChart();

        // Create legend
        createLegend();

        // Create leaderboard and action flow
        await createLeaderboard();
        await createActionFlow();
        refreshMarketStatusBadge();
        updateTradeToggleButton();

    } catch (error) {
        console.error('Error loading data:', error);
        
        // Show error message in the UI instead of alert
        const statsGrid = document.querySelector('.stats-grid');
        if (statsGrid && Object.keys(allAgentsData || {}).length === 0) {
            const errorMsg = document.createElement('div');
            errorMsg.style.cssText = 'grid-column: 1 / -1; padding: 20px; background: #fff3cd; border-radius: 8px; color: #856404; text-align: center;';
            errorMsg.innerHTML = `
                <strong>ℹ️ No agents found</strong><br>
                ${dataLoader.getMarket() === 'us_5min' ? 
                    'Make sure your 5-minute trading agent is running. It may take a few moments for data to appear.' :
                    'No trading data available for this market. Please check your configuration.'
                }
            `;
            statsGrid.insertBefore(errorMsg, statsGrid.firstChild);
            
            // Auto-remove message after 5 seconds
            setTimeout(() => errorMsg.remove(), 5000);
        }
    } finally {
        hideLoading();
        enableMarketButtons();
        refreshMarketStatusBadge();
        updateTradeToggleButton();
        isLoading = false;
    }
}

// Expose loadAllData for live refresh
window.loadAllData = async function() {
    await loadDataAndRefresh();
};

function getUSMarketStatus() {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        hour12: false
    });
    const parts = formatter.formatToParts(now);
    const findValue = type => parts.find(p => p.type === type)?.value;
    const hour = Number(findValue('hour') ?? 0);
    const minute = Number(findValue('minute') ?? 0);
    const weekdayLabel = findValue('weekday') ?? 'Sun';
    const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const weekday = weekdayMap[weekdayLabel] ?? 0;
    const minutesSinceMidnight = hour * 60 + minute;
    const openMinutes = 9 * 60 + 30;
    const closeMinutes = 16 * 60;
    const isWeekday = weekday >= 1 && weekday <= 5;
    const isOpen = isWeekday && minutesSinceMidnight >= openMinutes && minutesSinceMidnight < closeMinutes;

    const statusText = isOpen ? 'Market Open' : 'Market Closed';
    let detailText;

    if (isOpen) {
        detailText = 'Closes at 04:00 PM ET';
    } else if (isWeekday && minutesSinceMidnight < openMinutes) {
        detailText = 'Opens today at 09:30 ET';
    } else {
        let daysToAdd;
        if (isWeekday && minutesSinceMidnight >= closeMinutes) {
            daysToAdd = weekday === 5 ? 3 : 1;
        } else if (weekday === 6) { // Saturday
            daysToAdd = 2;
        } else { // Sunday
            daysToAdd = 1;
        }
        const nextDate = new Date(now);
        nextDate.setDate(nextDate.getDate() + daysToAdd);
        const nextFormatter = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York',
            weekday: 'short',
            month: 'short',
            day: 'numeric'
        });
        detailText = `Opens ${nextFormatter.format(nextDate)} at 09:30 ET`;
    }

    return { isOpen, statusText, detailText };
}

function updateMarketStatusIndicator() {
    const badge = document.getElementById('marketStatusBadge');
    if (!badge || dataLoader.getMarket() !== 'us_5min') {
        return;
    }
    const textEl = badge.querySelector('.market-status-text');
    if (!textEl) {
        return;
    }
    const status = getUSMarketStatus();
    badge.classList.remove('open', 'closed');
    badge.classList.add(status.isOpen ? 'open' : 'closed');
    textEl.textContent = status.detailText ? `${status.statusText} | ${status.detailText}` : status.statusText;

    const previousStatus = lastMarketOpenStatus;
    const statusChanged = previousStatus !== null && previousStatus !== status.isOpen;
    lastMarketOpenStatus = status.isOpen;

    adjustLiveRefreshForMarket(status.isOpen, statusChanged);
}

function refreshMarketStatusBadge() {
    const badge = document.getElementById('marketStatusBadge');
    if (!badge) {
        return;
    }
    if (dataLoader.getMarket() === 'us_5min') {
        badge.style.display = 'inline-flex';
        updateMarketStatusIndicator();
        if (marketStatusTimer === null) {
            marketStatusTimer = setInterval(updateMarketStatusIndicator, 60000);
        }
    } else {
        badge.style.display = 'none';
        if (marketStatusTimer !== null) {
            clearInterval(marketStatusTimer);
            marketStatusTimer = null;
        }
    }
}

// Initialize the page
async function init() {
    // Set up event listeners first
    setupEventListeners();
    
    // Set initial button state to match current market
    updateActiveButton(dataLoader.getMarket());

    // Load initial data
    await loadDataAndRefresh();
}

// Update statistics cards
function updateStats() {
    const agentNames = Object.keys(allAgentsData);
    const agentCount = agentNames.length;

    // Calculate date range
    // For live trading: From = earliest data point, To = current time (now)
    // For historical trading: From = earliest, To = latest data point
    let minDate = null;
    let maxDate = null;

    agentNames.forEach(name => {
        const history = allAgentsData[name].assetHistory;
        history.forEach(entry => {
            const entryDate = entry.date;
            if (!minDate || entryDate < minDate) minDate = entryDate;
            if (!maxDate || entryDate > maxDate) maxDate = entryDate;
        });

        const serviceStart = allAgentsData[name].startTime;
        if (serviceStart) {
            if (!minDate || serviceStart < minDate) {
                minDate = serviceStart;
            }
        }
    });

    // For intraday trading, use current time as the end time
    const market = dataLoader.getMarket();
    if (market === 'us_5min') {
        // Use current LOCAL time for live intraday trading
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        const nowStr = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
        maxDate = nowStr;
        console.log('🕐 Using current local time as end:', nowStr);
    }

    console.log('📅 Trading period:', minDate, 'to', maxDate);

    // Find best performer
    let bestAgent = null;
    let bestReturn = -Infinity;

    agentNames.forEach(name => {
        const returnValue = allAgentsData[name].return;
        if (returnValue > bestReturn) {
            bestReturn = returnValue;
            bestAgent = name;
        }
    });

    // Update DOM
    document.getElementById('agent-count').textContent = agentCount;

    // Format date/time for display
    const formatDateTime = (dateStr, label) => {
        if (!dateStr) return 'N/A';
        const date = new Date(dateStr);
        const market = dataLoader.getMarket();
        
        // For intraday trading, include time
        if (market === 'us_5min') {
            const timeStr = date.toLocaleString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: true
            });
            const dateStrFormatted = date.toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric'
            });
            return `${label}: ${dateStrFormatted} ${timeStr}`;
        }
        
        // For daily trading, just show date
        const dateStrFormatted = date.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
        });
        return `${label}: ${dateStrFormatted}`;
    };

    // Update trading period with separate lines
    const periodStartEl = document.getElementById('period-start');
    const periodEndEl = document.getElementById('period-end');
    
    if (periodStartEl && periodEndEl) {
        periodStartEl.textContent = minDate ? formatDateTime(minDate, 'From') : 'N/A';
        periodEndEl.textContent = maxDate ? formatDateTime(maxDate, 'To') : 'N/A';
    } else {
        // Fallback for old HTML structure
        const periodEl = document.getElementById('trading-period');
        if (periodEl) {
            periodEl.textContent = minDate && maxDate ?
                `${formatDateTime(minDate, 'From')}\n${formatDateTime(maxDate, 'To')}` : 'N/A';
        }
    }
    
    document.getElementById('best-performer').textContent = bestAgent ?
        dataLoader.getAgentDisplayName(bestAgent) : 'N/A';
    document.getElementById('avg-return').textContent = bestAgent ?
        dataLoader.formatPercent(bestReturn) : 'N/A';
}

// Create the main chart
function createChart() {
    const ctx = document.getElementById('assetChart').getContext('2d');

    // Collect all unique timestamps (include baseline) and sort them chronologically
    const allDates = new Set();
    const buyHoldSeries = dataLoader.getBuyHoldSeries();

    Object.keys(allAgentsData).forEach(agentName => {
        const agent = allAgentsData[agentName];
        agent.assetHistory.forEach(h => allDates.add(h.date));
        (agent.tradeMarkers || []).forEach(marker => {
            if (marker.assetDate) {
                allDates.add(marker.assetDate);
            } else if (marker.timestamp) {
                allDates.add(marker.timestamp);
            }
        });
    });

    buyHoldSeries.forEach(entry => allDates.add(entry.date));
    let sortedDates = Array.from(allDates).sort();

    const parseDate = (dateStr) => {
        if (!dateStr) return null;
        if (dateStr.includes('T')) {
            return new Date(dateStr);
        }
        return new Date(dateStr.replace(' ', 'T'));
    };

    // For intraday 5-min trading, extend x-axis to current time
    // Start from FIRST actual data point (not INIT or earlier)
    const market = dataLoader.getMarket();
    if (market === 'us_5min' && sortedDates.length > 0) {
        const now = new Date();
        const nowIso = now.toISOString();
        const lastDateStr = sortedDates[sortedDates.length - 1];
        const lastDateObj = parseDate(lastDateStr);

        if (!lastDateObj || now.getTime() > lastDateObj.getTime() + 30 * 1000) {
            sortedDates.push(nowIso);
            console.log(`⏰ Extended x-axis to current time: ${nowIso} (was: ${lastDateStr})`);
        } else {
            console.log(`⏰ X-axis already includes current or future data point: ${lastDateStr}`);
        }
        
        console.log(`📊 Intraday Chart: ${sortedDates.length} data points from ${sortedDates[0]} to ${sortedDates[sortedDates.length - 1]}`);
    }

    // Chart data summary
    console.log(`📊 Chart: ${sortedDates.length} time points from ${sortedDates[0]} to ${sortedDates[sortedDates.length - 1]}`);

    const datasets = [];

    Object.keys(allAgentsData).forEach((agentName, index) => {
        const data = allAgentsData[agentName];
        let color, borderWidth, borderDash;

        // Special styling for benchmarks (check if name contains 'QQQ' or 'SSE')
        const isBenchmark = agentName.includes('QQQ') || agentName.includes('SSE');
        if (isBenchmark) {
            color = dataLoader.getAgentBrandColor(agentName) || '#ff6b00';
            borderWidth = 2;
            borderDash = [5, 5]; // Dashed line for benchmark
        } else {
            color = dataLoader.getAgentBrandColor(agentName) || agentColors[index % agentColors.length];
            borderWidth = 3;
            borderDash = [];
        }

        console.log(`[DATASET ${index}] ${agentName} => COLOR: ${color}, isBenchmark: ${isBenchmark}`);

        // Create data points for all dates
        // For intraday trading: forward-fill to show continuous line from start to now
        const market = dataLoader.getMarket();
        let lastKnownValue = null;
        
        const chartData = sortedDates.map(date => {
            const historyEntry = data.assetHistory.find(h => h.date === date);
            
            if (historyEntry) {
                // We have actual data - use it and remember it
                lastKnownValue = historyEntry.value;
                return {
                    x: date,
                    y: historyEntry.value
                };
            } else if (market === 'us_5min' && lastKnownValue !== null) {
                // For intraday: forward-fill the last known value to keep line continuous
                return {
                    x: date,
                    y: lastKnownValue
                };
            } else {
                // No data yet - show null (gap)
                return {
                    x: date,
                    y: null
                };
            }
        });

        console.log(`Dataset ${index} (${agentName}):`, {
            label: dataLoader.getAgentDisplayName(agentName),
            dataPoints: chartData.filter(d => d.y !== null).length,
            color: color,
            isBenchmark: isBenchmark,
            sampleData: chartData.slice(0, 3)
        });

        const datasetObj = {
            label: dataLoader.getAgentDisplayName(agentName),
            data: chartData,
            borderColor: color,
            backgroundColor: isBenchmark ? 'transparent' : createGradient(ctx, color),
            borderWidth: borderWidth,
            borderDash: borderDash,
            tension: 0.42, // Smooth curves for financial charts
            pointRadius: 0,
            pointHoverRadius: 7,
            pointHoverBackgroundColor: color,
            pointHoverBorderColor: '#fff',
            pointHoverBorderWidth: 3,
            fill: !isBenchmark, // No fill for benchmarks
            spanGaps: true, // Connect points to show continuous line (we forward-fill for intraday)
            agentName: agentName,
            agentIcon: dataLoader.getAgentIcon(agentName),
            cubicInterpolationMode: 'monotone' // Smooth, monotonic interpolation
        };

        console.log(`[DATASET OBJECT ${index}] borderColor: ${datasetObj.borderColor}, pointHoverBackgroundColor: ${datasetObj.pointHoverBackgroundColor}`);

        datasets.push(datasetObj);

        const assetValueLookup = new Map((data.assetHistory || []).map(entry => [entry.date, entry.value]));
        let lastKnownValueForMarkers = null;
        const buyPoints = [];
        const sellPoints = [];

        (data.tradeMarkers || []).forEach(marker => {
            const markerDate = marker.assetDate || marker.timestamp || marker.date;
            if (!markerDate) {
                return;
            }

            let value = assetValueLookup.get(markerDate);
            if (value === undefined && markerDate.includes(' ')) {
                value = assetValueLookup.get(markerDate.replace(' ', 'T'));
            }
            if (value === undefined && marker.timestamp && marker.timestamp !== markerDate) {
                value = assetValueLookup.get(marker.timestamp);
            }
            if ((value === undefined || value === null) && lastKnownValueForMarkers !== null) {
                value = lastKnownValueForMarkers;
            }
            if (value === undefined || value === null) {
                return;
            }

            lastKnownValueForMarkers = value;

            const meta = {
                ...marker,
                assetValue: value,
                displayName: dataLoader.getAgentDisplayName(agentName),
                agentName
            };

            const point = {
                x: markerDate,
                y: value,
                meta
            };

            if (marker.action === 'buy') {
                buyPoints.push(point);
            } else if (marker.action === 'sell' || marker.action === 'short') {
                // Short actions are displayed as sell arrows (downward) since shorting is selling shares you don't own
                sellPoints.push(point);
            }
        });

        if (showTradeMarkers && buyPoints.length > 0) {
            datasets.push({
                label: `${dataLoader.getAgentDisplayName(agentName)} Buys`,
                data: buyPoints,
                type: 'scatter',
                showLine: false,
                borderColor: color,
                backgroundColor: color,
                pointBackgroundColor: color,
                pointBorderColor: '#ffffff',
                pointBorderWidth: 1.5,
                pointRadius: 0,
                pointHoverRadius: 0,
                agentName,
                isTradeMarker: true,
                tradeType: 'buy',
                order: 200 + index,
                spanGaps: false,
                pointHitRadius: 12,
                clip: false,
                markerSize: TRADE_MARKER_BASE_SIZE
            });
        }

        if (showTradeMarkers && sellPoints.length > 0) {
            datasets.push({
                label: `${dataLoader.getAgentDisplayName(agentName)} Sells/Shorts`,
                data: sellPoints,
                type: 'scatter',
                showLine: false,
                borderColor: color,
                backgroundColor: color,
                pointBackgroundColor: color,
                pointBorderColor: '#0f172a',
                pointBorderWidth: 1.5,
                pointRadius: 0,
                pointHoverRadius: 0,
                agentName,
                isTradeMarker: true,
                tradeType: 'sell',
                order: 201 + index,
                spanGaps: false,
                pointHitRadius: 12,
                clip: false,
                markerSize: TRADE_MARKER_BASE_SIZE
            });
        }
    });

    if (buyHoldSeries.length > 0) {
        const buyHoldColor = dataLoader.getAgentBrandColor('QQQ Invesco') || '#ff6b00';
        let lastKnownValue = null;
        const buyHoldData = sortedDates.map(date => {
            const entry = buyHoldSeries.find(h => h.date === date);
            if (entry) {
                lastKnownValue = entry.value;
                return { x: date, y: entry.value };
            }
            if (market === 'us_5min' && lastKnownValue !== null) {
                return { x: date, y: lastKnownValue };
            }
            return { x: date, y: null };
        });

        if (buyHoldData.some(point => point.y !== null)) {
            datasets.push({
                label: 'Buy-and-Hold',
                data: buyHoldData,
                borderColor: buyHoldColor,
                backgroundColor: 'transparent',
                borderWidth: 2,
                borderDash: [5, 5],
                tension: 0.2,
                pointRadius: 0,
                pointHoverRadius: 7,
                pointHoverBackgroundColor: buyHoldColor,
                pointHoverBorderColor: '#fff',
                pointHoverBorderWidth: 2,
                fill: false,
                spanGaps: true,
                cubicInterpolationMode: 'monotone',
                isBaseline: true,
                agentName: 'buy-and-hold',
                agentIcon: dataLoader.getAgentIcon('buy-and-hold')
            });
        }
    }

    // Create gradient for area fills
    function createGradient(ctx, color) {
        // Parse color and create gradient
        const gradient = ctx.createLinearGradient(0, 0, 0, 400);
        gradient.addColorStop(0, color + '30'); // 30% opacity at top
        gradient.addColorStop(0.5, color + '15'); // 15% opacity at middle
        gradient.addColorStop(1, color + '05'); // 5% opacity at bottom
        return gradient;
    }

    // Custom plugin to draw icons on chart lines with pulsing animation
    const iconPlugin = {
        id: 'iconLabels',
        afterDatasetsDraw: (chart) => {
            const ctx = chart.ctx;
            const now = Date.now();

            chart.data.datasets.forEach((dataset, datasetIndex) => {
                const meta = chart.getDatasetMeta(datasetIndex);
                if (!meta.hidden && dataset.data.length > 0) {
                    if (dataset.isTradeMarker) {
                        return;
                    }
                    const lastPoint = meta.data[meta.data.length - 1];
                    if (!lastPoint) {
                        return;
                    }

                    const x = lastPoint.x;
                    const y = lastPoint.y;

                    ctx.save();

                    const pulseSpeed = 1500; // milliseconds per cycle
                    const phase = ((now + datasetIndex * 300) % pulseSpeed) / pulseSpeed; // Offset each line
                    const pulse = Math.sin(phase * Math.PI * 2) * 0.5 + 0.5; // 0 to 1

                    if (!dataset.isBaseline) {
                        // Draw animated ripple rings (outer glow effect)
                        for (let i = 0; i < 3; i++) {
                            const ripplePhase = ((now + datasetIndex * 300 + i * 500) % 2000) / 2000;
                            const rippleSize = 6 + ripplePhase * 20;
                            const rippleOpacity = (1 - ripplePhase) * 0.4;

                            ctx.strokeStyle = dataset.borderColor;
                            ctx.globalAlpha = rippleOpacity;
                            ctx.lineWidth = 2;
                            ctx.beginPath();
                            ctx.arc(x, y, rippleSize, 0, Math.PI * 2);
                            ctx.stroke();
                        }

                        ctx.globalAlpha = 1;

                        // Draw main pulsing point
                        const pointSize = 5 + pulse * 3;

                        // Outer glow
                        ctx.shadowColor = dataset.borderColor;
                        ctx.shadowBlur = 10 + pulse * 15;
                        ctx.fillStyle = dataset.borderColor;
                        ctx.beginPath();
                        ctx.arc(x, y, pointSize, 0, Math.PI * 2);
                        ctx.fill();

                        // Inner bright core
                        ctx.shadowBlur = 5;
                        ctx.fillStyle = '#ffffff';
                        ctx.beginPath();
                        ctx.arc(x, y, pointSize * 0.5, 0, Math.PI * 2);
                        ctx.fill();
                    } else {
                        // Static marker for baseline
                        ctx.globalAlpha = 0.75;
                        ctx.fillStyle = dataset.borderColor;
                        ctx.shadowColor = dataset.borderColor;
                        ctx.shadowBlur = 6;
                        ctx.beginPath();
                        ctx.arc(x, y, 5, 0, Math.PI * 2);
                        ctx.fill();

                        ctx.globalAlpha = 1;
                        ctx.shadowBlur = 0;
                        ctx.fillStyle = '#ffffff';
                        ctx.beginPath();
                        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
                        ctx.fill();
                    }

                    // Reset shadow for icon drawing
                    ctx.shadowBlur = 0;

                    // Draw icon image with glow background (positioned to the right)
                    const iconSize = 30;
                    const iconX = x + 22;

                    // Icon background circle with glow
                    ctx.shadowColor = dataset.borderColor;
                    ctx.shadowBlur = dataset.isBaseline ? 10 : 15;
                    ctx.fillStyle = dataset.borderColor;
                    ctx.beginPath();
                    ctx.arc(iconX, y, iconSize / 2, 0, Math.PI * 2);
                    ctx.fill();

                    // Reset shadow for icon
                    ctx.shadowBlur = 0;

                    // Draw icon image if loaded
                    if (dataset.agentIcon && iconImageCache[dataset.agentIcon]) {
                        const img = iconImageCache[dataset.agentIcon];
                        const imgSize = iconSize * 0.6; // Icon slightly smaller than circle
                        ctx.drawImage(img, iconX - imgSize/2, y - imgSize/2, imgSize, imgSize);
                    } else {
                        // Text fallback
                        ctx.fillStyle = '#ffffff';
                        ctx.font = 'bold 12px "Inter", sans-serif';
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        const fallbackText = dataset.isBaseline ? 'BH' : 'AI';
                        ctx.fillText(fallbackText, iconX, y);
                    }

                    ctx.restore();
                }
            });

            // Request animation frame to continuously update the pulse effect
            requestAnimationFrame(() => {
                if (chart && !chart.destroyed) {
                    chart.update('none'); // Update without animation to maintain smooth pulse
                }
            });
        }
    };

    const tradeMarkerPlugin = {
        id: 'tradeMarkerArrows',
        afterDatasetsDraw: (chart) => {
            const ctx = chart.ctx;

            if (!showTradeMarkers) {
                return;
            }

            chart.data.datasets.forEach((dataset, datasetIndex) => {
                if (!dataset.isTradeMarker) {
                    return;
                }

                const meta = chart.getDatasetMeta(datasetIndex);
                if (!meta || meta.hidden) {
                    return;
                }

                const baseSize = dataset.markerSize || TRADE_MARKER_BASE_SIZE;
                const borderWidth = dataset.pointBorderWidth ?? 1.5;
                const fillColor = dataset.pointBackgroundColor || dataset.backgroundColor || dataset.borderColor || '#ffffff';
                const strokeColor = dataset.pointBorderColor || dataset.borderColor || '#0f172a';
                const direction = dataset.tradeType === 'sell' ? 'sell' : 'buy';

                meta.data.forEach((element) => {
                    if (!element || element.skip || typeof element.x !== 'number' || typeof element.y !== 'number') {
                        return;
                    }

                    const isActive = element.active;
                    const drawSize = isActive ? baseSize * TRADE_MARKER_HOVER_SCALE : baseSize;

                    ctx.save();
                    drawTradeArrow(ctx, element.x, element.y, drawSize, direction, fillColor, strokeColor, borderWidth);
                    ctx.restore();
                });
            });
        }
    };

    console.log('Creating chart with', datasets.length, 'datasets');
    console.log('Datasets summary:', datasets.map(d => ({
        label: d.label,
        borderColor: d.borderColor,
        backgroundColor: typeof d.backgroundColor === 'string' ? d.backgroundColor : 'GRADIENT',
        dataPoints: d.data.filter(p => p.y !== null).length,
        borderWidth: d.borderWidth,
        fill: d.fill
    })));

    // DEBUG: Log the actual Chart.js config
    console.log('[CHART.JS CONFIG] About to create chart with datasets:', JSON.stringify(
        datasets.map(d => ({ label: d.label, borderColor: d.borderColor }))
    ));

    chartInstance = new Chart(ctx, {
        type: 'line',
        data: { datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            resizeDelay: 200,
            onClick: (event, elements, chart) => {
        const nativeEvent = event?.native || event;
        const clickElements = chart.getElementsAtEventForMode(
            nativeEvent,
            'nearest',
            { intersect: true },
            false
        );

        if (!clickElements || clickElements.length === 0) {
                    hideTradePopover();
                    return;
                }

        const tradeElement = clickElements.find(el => {
            const ds = chart.data.datasets[el.datasetIndex];
            return ds && ds.isTradeMarker;
        });

        if (!tradeElement) {
            hideTradePopover();
        return;
    }

        const dataset = chart.data.datasets[tradeElement.datasetIndex];
        const dataPoint = dataset?.data?.[tradeElement.index];

        if (!dataset || !dataPoint || !dataPoint.meta) {
            hideTradePopover();
            return;
        }

        if (activeTradeMarker && activeTradeMarker.id === dataPoint.meta.id) {
                    hideTradePopover();
                    return;
                }

                if (event && event.native) {
                    event.native.stopPropagation();
                }

        hideChartTooltip(chart);

                showTradePopover({
                    dataset,
                    dataPoint,
            element: tradeElement.element,
                    chart
                });
            },
            layout: {
                padding: {
                    right: 50,
                    top: 10,
                    bottom: 10
                }
            },
            interaction: {
                mode: 'index',
                intersect: false
            },
            elements: {
                line: {
                    borderJoinStyle: 'round',
                    borderCapStyle: 'round'
                }
            },
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    enabled: false,
                    external: function(context) {
                        // Custom HTML tooltip
                        const tooltipModel = context.tooltip;
                        let tooltipEl = document.getElementById('chartjs-tooltip');

                        // Create element on first render
                        if (!tooltipEl) {
                            tooltipEl = document.createElement('div');
                            tooltipEl.id = 'chartjs-tooltip';
                            tooltipEl.innerHTML = '<div class="tooltip-container"></div>';
                            document.body.appendChild(tooltipEl);
                        }

                        // Hide if no tooltip
                        if (tooltipModel.opacity === 0) {
                            tooltipEl.style.opacity = 0;
                            return;
                        }

                        // Set Text
                        if (tooltipModel.body) {
                            const dataPoints = tooltipModel.dataPoints || [];

                            // Sort data points by value at this time point (descending)
                            const sortedPoints = [...dataPoints].sort((a, b) => {
                                const valueA = a.parsed.y || 0;
                                const valueB = b.parsed.y || 0;
                                return valueB - valueA;
                            });

                            // Format title (date/time)
                            const titleLines = tooltipModel.title || [];
                            let titleHtml = '';
                            if (titleLines.length > 0) {
                                const dateStr = titleLines[0];
                                const market = dataLoader.getMarket();
                                
                                if (dateStr && dateStr.includes(':')) {
                                    const date = new Date(dateStr);
                                    
                                    // For intraday 5-min, show time more prominently
                                    if (market === 'us_5min') {
                                        titleHtml = date.toLocaleString('en-US', {
                                            month: 'short',
                                            day: 'numeric',
                                            hour: '2-digit',
                                            minute: '2-digit',
                                            hour12: true
                                        });
                                    } else {
                                        titleHtml = date.toLocaleString('en-US', {
                                            month: 'short',
                                            day: 'numeric',
                                            year: 'numeric',
                                            hour: '2-digit',
                                            minute: '2-digit'
                                        });
                                    }
                                } else {
                                    titleHtml = dateStr;
                                }
                            }

                            // Build body HTML with logos and ranked data
                            let innerHtml = `<div class="tooltip-title">${titleHtml}</div>`;
                            innerHtml += '<div class="tooltip-body">';

                            let leaderboardRank = 1;
                            sortedPoints.forEach((dataPoint) => {
                                const dataset = dataPoint.dataset;
                                if (dataset.isTradeMarker) {
                                    return;
                                }
                                const agentName = dataset.agentName;
                                const displayName = dataset.label;
                                const value = dataPoint.parsed.y;
                                const icon = dataLoader.getAgentIcon(agentName);
                                const color = dataset.borderColor;

                                const rankBadge = `<span class="rank-badge">#${leaderboardRank++}</span>`;

                                innerHtml += `
                                    <div class="tooltip-row">
                                        ${rankBadge}
                                        <img src="${icon}" class="tooltip-icon" alt="${displayName}">
                                        <span class="tooltip-label" style="color: ${color}">${displayName}</span>
                                        <span class="tooltip-value">${dataLoader.formatCurrency(value)}</span>
                                    </div>
                                `;
                            });

                            innerHtml += '</div>';

                            const container = tooltipEl.querySelector('.tooltip-container');
                            container.innerHTML = innerHtml;
                        }

                        const position = context.chart.canvas.getBoundingClientRect();
                        const tooltipWidth = tooltipEl.offsetWidth || 300;
                        const tooltipHeight = tooltipEl.offsetHeight || 200;

                        // Smart positioning to prevent overflow
                        let left = position.left + window.pageXOffset + tooltipModel.caretX;
                        let top = position.top + window.pageYOffset + tooltipModel.caretY;

                        // Offset to prevent covering the hover point
                        const offset = 15;
                        left += offset;
                        top -= offset;

                        // Check if tooltip would go off right edge
                        const viewportWidth = window.innerWidth;
                        const viewportHeight = window.innerHeight;

                        if (left + tooltipWidth > viewportWidth - 20) {
                            // Position to the left of the cursor instead
                            left = position.left + window.pageXOffset + tooltipModel.caretX - tooltipWidth - offset;
                        }

                        // Check if tooltip would go off bottom edge
                        if (top + tooltipHeight > viewportHeight - 20) {
                            top = viewportHeight - tooltipHeight - 20;
                        }

                        // Check if tooltip would go off top edge
                        if (top < 20) {
                            top = 20;
                        }

                        // Check if tooltip would go off left edge
                        if (left < 20) {
                            left = 20;
                        }

                        // Display, position, and set styles
                        tooltipEl.style.opacity = 1;
                        tooltipEl.style.position = 'absolute';
                        tooltipEl.style.left = left + 'px';
                        tooltipEl.style.top = top + 'px';
                        tooltipEl.style.pointerEvents = 'none';
                        tooltipEl.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
                        tooltipEl.style.transform = 'translateZ(0)'; // GPU acceleration
                    }
                }
            },
            scales: {
                x: {
                    type: 'category',
                    labels: sortedDates,
                    grid: {
                        color: 'rgba(45, 55, 72, 0.3)',
                        drawBorder: false,
                        lineWidth: 1
                    },
                    ticks: {
                        color: '#a0aec0',
                        maxRotation: 45,
                        minRotation: 45,
                        autoSkip: true,
                        includeBounds: true,  // Always show first and last labels
                        maxTicksLimit: dataLoader.getMarket() === 'us_5min' ? 20 : 15,
                        font: {
                            size: 11
                        },
                        callback: function(value, index, ticks) {
                            const dateStr = this.getLabelForValue(value);
                            if (!dateStr) return '';

                            const market = dataLoader.getMarket();
                            const isFirstOrLast = index === 0 || index === ticks.length - 1;
                            
                            // Format for intraday 5-minute trading - ALWAYS show full date and time
                            if (market === 'us_5min' && dateStr.includes(':')) {
                                const date = new Date(dateStr);
                                const month = (date.getMonth() + 1).toString().padStart(2, '0');
                                const day = date.getDate().toString().padStart(2, '0');
                                const hour = date.getHours().toString().padStart(2, '0');
                                const minute = date.getMinutes().toString().padStart(2, '0');
                                
                                // For first/last ticks, add marker for visibility
                                const label = `${month}/${day} ${hour}:${minute}`;
                                return isFirstOrLast ? `${label}` : label;
                            }
                            
                            // Format for hourly or daily timestamps
                            if (dateStr.includes(':')) {
                                const date = new Date(dateStr);
                                const month = (date.getMonth() + 1).toString().padStart(2, '0');
                                const day = date.getDate().toString().padStart(2, '0');
                                const hour = date.getHours().toString().padStart(2, '0');
                                return `${month}/${day} ${hour}:00`;
                            }
                            
                            return dateStr;
                        }
                    }
                },
                y: {
                    type: isLogScale ? 'logarithmic' : 'linear',
                    grid: {
                        color: 'rgba(45, 55, 72, 0.3)',
                        drawBorder: false,
                        lineWidth: 1
                    },
                    ticks: {
                        color: '#a0aec0',
                        callback: function(value) {
                            return dataLoader.formatCurrency(value);
                        },
                        font: {
                            size: 11
                        }
                    }
                }
            }
        },
        plugins: [iconPlugin, tradeMarkerPlugin]
    });
}

// Create legend
function createLegend() {
    const legendContainer = document.getElementById('agentLegend');
    legendContainer.innerHTML = '';

    Object.keys(allAgentsData).forEach((agentName, index) => {
        const data = allAgentsData[agentName];
        let color, borderStyle;

        // Special styling for benchmarks (check if name contains 'QQQ' or 'SSE')
        const isBenchmark = agentName.includes('QQQ') || agentName.includes('SSE');
        if (isBenchmark) {
            color = dataLoader.getAgentBrandColor(agentName) || '#ff6b00';
            borderStyle = 'dashed';
        } else {
            color = dataLoader.getAgentBrandColor(agentName) || agentColors[index % agentColors.length];
            borderStyle = 'solid';
        }

        console.log(`[LEGEND ${index}] ${agentName} => COLOR: ${color}, isBenchmark: ${isBenchmark}`);
        
        const returnValue = data.return;
        const returnClass = returnValue >= 0 ? 'positive' : 'negative';
        const iconPath = dataLoader.getAgentIcon(agentName);
        const brandColor = dataLoader.getAgentBrandColor(agentName);

        const legendItem = document.createElement('div');
        legendItem.className = 'legend-item';
        legendItem.innerHTML = `
            <div class="legend-icon" ${brandColor ? `style="background: ${brandColor}20;"` : ''}>
                <img src="${iconPath}" alt="${agentName}" class="legend-icon-img" />
            </div>
            <div class="legend-color" style="background: ${color}; border-style: ${borderStyle};"></div>
            <div class="legend-info">
                <div class="legend-name">${dataLoader.getAgentDisplayName(agentName)}</div>
                <div class="legend-return ${returnClass}">${dataLoader.formatPercent(returnValue)}</div>
            </div>
        `;

        legendContainer.appendChild(legendItem);
    });

    const buyHoldSeries = dataLoader.getBuyHoldSeries();
    if (buyHoldSeries.length > 0) {
        const buyHoldColor = dataLoader.getAgentBrandColor('QQQ Invesco') || '#ff6b00';
        const legendItem = document.createElement('div');
        legendItem.className = 'legend-item';
        legendItem.innerHTML = `
            <div class="legend-icon" style="background: ${buyHoldColor}1A;">
                <img src="${dataLoader.getAgentIcon('buy-and-hold')}" alt="Buy-and-Hold" class="legend-icon-img" />
            </div>
            <div class="legend-color" style="background: ${buyHoldColor}; border-style: dashed;"></div>
            <div class="legend-info">
                <div class="legend-name">Buy-and-Hold</div>
                <div class="legend-return neutral">Baseline</div>
            </div>
        `;
        legendContainer.appendChild(legendItem);
    }
}

// Toggle between linear and log scale
function toggleScale() {
    isLogScale = !isLogScale;

    const button = document.getElementById('toggle-log');
    button.textContent = isLogScale ? 'Log Scale' : 'Linear Scale';

    // Update chart
    if (chartInstance) {
        hideTradePopover();
        chartInstance.destroy();
    }
    createChart();
}

// Export chart data as CSV
function exportData() {
    let csv = 'Date,';

    const agentNames = Object.keys(allAgentsData);
    const buyHoldSeries = dataLoader.getBuyHoldSeries();
    let header = agentNames.map(name => dataLoader.getAgentDisplayName(name));
    if (buyHoldSeries.length > 0) {
        header.push('Buy-and-Hold');
    }
    csv += header.join(',') + '\n';

    // Collect all unique dates
    const allDates = new Set();
    agentNames.forEach(name => {
        allAgentsData[name].assetHistory.forEach(h => allDates.add(h.date));
    });
    if (buyHoldSeries.length > 0) {
        buyHoldSeries.forEach(h => allDates.add(h.date));
    }

    // Sort dates
    const sortedDates = Array.from(allDates).sort();

    // Data rows
    sortedDates.forEach(date => {
        const row = [date];
        agentNames.forEach(name => {
            const history = allAgentsData[name].assetHistory;
            const entry = history.find(h => h.date === date);
            row.push(entry ? entry.value.toFixed(2) : '');
        });
        if (buyHoldSeries.length > 0) {
            const entry = buyHoldSeries.find(h => h.date === date);
            row.push(entry ? entry.value.toFixed(2) : '');
        }
        csv += row.join(',') + '\n';
    });

    // Download CSV
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'aitrader_asset_evolution.csv';
    a.click();
    window.URL.revokeObjectURL(url);
}

// Set up event listeners
function setupEventListeners() {
    tradeToggleButton = document.getElementById('toggle-trades');
    if (tradeToggleButton) {
        tradeToggleButton.addEventListener('click', () => {
            showTradeMarkers = !showTradeMarkers;
            updateTradeToggleButton();
            hideTradePopover();
            hideChartTooltip(chartInstance);
            rebuildChart();
        });
    }

    document.getElementById('toggle-log').addEventListener('click', toggleScale);
    document.getElementById('export-chart').addEventListener('click', exportData);

    // Market switching with protection against multiple clicks
    const usMarketBtn = document.getElementById('usMarketBtn');
    const cnMarketBtn = document.getElementById('cnMarketBtn');
    const us5minMarketBtn = document.getElementById('us5minMarketBtn');

    if (usMarketBtn) {
        usMarketBtn.addEventListener('click', async () => {
            const targetMarket = 'us';
            const currentMarket = dataLoader.getMarket();
            
            // Prevent clicks during loading or if already on this market
            if (isLoading || currentMarket === targetMarket) {
                console.log(`Already on ${targetMarket} or loading, ignoring click`);
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
            
            // Prevent clicks during loading or if already on this market
            if (isLoading || currentMarket === targetMarket) {
                console.log(`Already on ${targetMarket} or loading, ignoring click`);
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
            
            // Prevent clicks during loading or if already on this market
            if (isLoading || currentMarket === targetMarket) {
                console.log(`Already on ${targetMarket} or loading, ignoring click`);
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

    // Window resize handler for chart responsiveness
    let resizeTimeout;
    const handleResize = () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            if (chartInstance) {
                console.log('Resizing chart...'); // Debug log
                chartInstance.resize();
                chartInstance.update('none'); // Force update without animation
            }
        }, 100); // Faster response
    };

    window.addEventListener('resize', handleResize);

    // Also handle orientation change for mobile
    window.addEventListener('orientationchange', handleResize);

    updateTradeToggleButton();
}

// Create leaderboard
async function createLeaderboard() {
    const leaderboard = await window.transactionLoader.buildLeaderboard(allAgentsData);
    const container = document.getElementById('leaderboardList');
    container.innerHTML = '';

    leaderboard.forEach((item, index) => {
        const rankClass = index === 0 ? 'first' : index === 1 ? 'second' : index === 2 ? 'third' : '';
        const gainClass = item.gain >= 0 ? 'positive' : 'negative';

        const iconBg = item.color ? `${item.color}1A` : 'rgba(0, 212, 255, 0.1)';
        const baselineColor = item.color || '#ff6b00';
        const iconContent = item.icon
            ? `<img src="${item.icon}" alt="${item.displayName}">`
            : `<span class="leaderboard-baseline-badge" style="color: ${baselineColor}; border-color: ${baselineColor}80;">BH</span>`;

        const itemEl = document.createElement('div');
        itemEl.className = 'leaderboard-item';
        itemEl.style.animationDelay = `${index * 0.05}s`;
        itemEl.innerHTML = `
            <div class="leaderboard-rank ${rankClass}">#${item.rank}</div>
            <div class="leaderboard-icon" style="background: ${iconBg};">
                ${iconContent}
            </div>
            <div class="leaderboard-info">
                <div class="leaderboard-name">${item.displayName}</div>
                <div class="leaderboard-value">${window.transactionLoader.formatCurrency(item.currentValue)}</div>
            </div>
            <div class="leaderboard-gain">
                <div class="gain-amount ${gainClass}">${window.transactionLoader.formatCurrency(item.gain)}</div>
                <div class="gain-percent ${gainClass}">${window.transactionLoader.formatPercent(item.gainPercent)}</div>
            </div>
        `;

        container.appendChild(itemEl);
    });
}

// Create action flow with pagination
let actionFlowState = {
    allTransactions: [],
    loadedCount: 0,
    pageSize: 20,
    maxTransactions: 100,
    isLoading: false,
    container: null
};

async function createActionFlow() {
    // Load all transactions
    await window.transactionLoader.loadAllTransactions();
    actionFlowState.allTransactions = window.transactionLoader.getMostRecentTransactions(100);
    actionFlowState.container = document.getElementById('actionList');
    actionFlowState.container.innerHTML = '';
    actionFlowState.loadedCount = 0;

    // Load initial batch
    await loadMoreTransactions();

    // Set up scroll listener
    setupScrollListener();
}

async function loadMoreTransactions() {
    if (actionFlowState.isLoading) return;
    if (actionFlowState.loadedCount >= actionFlowState.allTransactions.length) return;
    if (actionFlowState.loadedCount >= actionFlowState.maxTransactions) return;

    actionFlowState.isLoading = true;

    // Show loading indicator
    showLoadingIndicator();

    // Calculate how many to load
    const startIndex = actionFlowState.loadedCount;
    const endIndex = Math.min(
        startIndex + actionFlowState.pageSize,
        actionFlowState.allTransactions.length,
        actionFlowState.maxTransactions
    );

    // Load this batch
    for (let i = startIndex; i < endIndex; i++) {
        const transaction = actionFlowState.allTransactions[i];
        const agentName = transaction.agentFolder;
        const currentMarket = dataLoader.getMarket();
        const displayName = window.configLoader.getDisplayName(agentName, currentMarket);
        const icon = window.configLoader.getIcon(agentName, currentMarket);
        const actionClass = transaction.action;

        // Load agent's thinking
        const thinking = await window.transactionLoader.loadAgentThinking(agentName, transaction.date, currentMarket);

        const cardEl = document.createElement('div');
        cardEl.className = 'action-card';
        cardEl.style.animationDelay = `${(i % actionFlowState.pageSize) * 0.03}s`;

        // Build card HTML - only include reasoning section if thinking is available
        let cardHTML = `
            <div class="action-header">
                <div class="action-agent-icon">
                    <img src="${icon}" alt="${displayName}">
                </div>
                <div class="action-meta">
                    <div class="action-agent-name">${displayName}</div>
                    <div class="action-details">
                        <span class="action-type ${actionClass}">${transaction.action}</span>
                        <span class="action-symbol">${transaction.symbol}</span>
                        <span>×${transaction.amount}</span>
                    </div>
                </div>
                <div class="action-timestamp">${window.transactionLoader.formatDateTime(transaction.date)}</div>
            </div>
        `;

        // Only add reasoning section if thinking is available
        if (thinking !== null) {
            cardHTML += `
            <div class="action-body">
                <div class="action-thinking-label">
                    <span class="thinking-icon">🧠</span>
                    Agent Reasoning
                </div>
                <div class="action-thinking">${formatThinking(thinking)}</div>
            </div>
            `;
        }

        cardEl.innerHTML = cardHTML;

        // Remove the status note and loading indicator before adding new cards
        const existingNote = actionFlowState.container.querySelector('.transactions-status-note');
        if (existingNote) {
            existingNote.remove();
        }
        const existingLoader = actionFlowState.container.querySelector('.transactions-loading');
        if (existingLoader) {
            existingLoader.remove();
        }

        actionFlowState.container.appendChild(cardEl);
    }

    actionFlowState.loadedCount = endIndex;
    actionFlowState.isLoading = false;

    // Hide loading indicator and add status note
    hideLoadingIndicator();
    updateStatusNote();
}

function showLoadingIndicator() {
    // Remove existing indicator
    const existingLoader = actionFlowState.container.querySelector('.transactions-loading');
    if (existingLoader) {
        existingLoader.remove();
    }

    const loaderEl = document.createElement('div');
    loaderEl.className = 'transactions-loading';
    loaderEl.style.cssText = 'text-align: center; padding: 1.5rem; color: var(--accent); font-size: 0.9rem; font-weight: 500;';
    loaderEl.innerHTML = '⏳ Loading more transactions...';
    actionFlowState.container.appendChild(loaderEl);
}

function hideLoadingIndicator() {
    const existingLoader = actionFlowState.container.querySelector('.transactions-loading');
    if (existingLoader) {
        existingLoader.remove();
    }
}

function updateStatusNote() {
    // Remove existing note
    const existingNote = actionFlowState.container.querySelector('.transactions-status-note');
    if (existingNote) {
        existingNote.remove();
    }

    // Add new note
    const noteEl = document.createElement('div');
    noteEl.className = 'transactions-status-note';
    noteEl.style.cssText = 'text-align: center; padding: 1.5rem; color: var(--text-muted); font-size: 0.9rem;';

    const totalAvailable = actionFlowState.allTransactions.length;
    const loaded = actionFlowState.loadedCount;

    if (loaded >= actionFlowState.maxTransactions || loaded >= totalAvailable) {
        // We've loaded everything we can
        if (totalAvailable > actionFlowState.maxTransactions) {
            noteEl.textContent = `Showing the most recent ${loaded} of ${totalAvailable} total transactions`;
        } else {
            noteEl.textContent = `Showing all ${loaded} recent transactions`;
        }
    } else {
        // More to load
        noteEl.textContent = `Loaded ${loaded} of ${Math.min(totalAvailable, actionFlowState.maxTransactions)} transactions. Scroll down to load more...`;
    }

    actionFlowState.container.appendChild(noteEl);
}

function setupScrollListener() {
    const container = actionFlowState.container;
    let ticking = false;

    const checkScroll = () => {
        const scrollTop = container.scrollTop;
        const scrollHeight = container.scrollHeight;
        const clientHeight = container.clientHeight;

        // Trigger load when user is within 300px of bottom
        if (scrollHeight - (scrollTop + clientHeight) < 300) {
            if (!actionFlowState.isLoading &&
                actionFlowState.loadedCount < actionFlowState.maxTransactions &&
                actionFlowState.loadedCount < actionFlowState.allTransactions.length) {
                loadMoreTransactions();
            }
        }

        ticking = false;
    };

    // Listen to the container's scroll, not window scroll
    container.addEventListener('scroll', () => {
        if (!ticking) {
            window.requestAnimationFrame(() => {
                checkScroll();
            });
            ticking = true;
        }
    });
}

// Format thinking text into paragraphs
function formatThinking(text) {
    // Split by double newlines or numbered lists
    const paragraphs = text.split(/\n\n+/).filter(p => p.trim());

    if (paragraphs.length === 0) {
        return `<p>${text}</p>`;
    }

    return paragraphs.map(p => `<p>${p.trim()}</p>`).join('');
}

// Loading overlay controls
function showLoading() {
    document.getElementById('loadingOverlay').classList.remove('hidden');
}

function hideLoading() {
    document.getElementById('loadingOverlay').classList.add('hidden');
}

// Market button controls
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

// Initialize on page load
window.addEventListener('DOMContentLoaded', init);