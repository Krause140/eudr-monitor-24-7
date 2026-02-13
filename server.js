const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

// Configuration
const CONFIG = {
    PORT: process.env.PORT || 3000,
    CHECK_INTERVAL: 3600000, // 1 hour
    WEBHOOK_URL: process.env.WEBHOOK_URL || '',
    
    SOURCES: {
        EUDR: [
            {
                name: "EU Commission - EUDR Main Page",
                url: "https://environment.ec.europa.eu/topics/forests/deforestation/regulation-deforestation-free-products_en",
                priority: "high"
            },
            {
                name: "EUDR 2026 Delay & Amendments",
                url: "https://trade.ec.europa.eu/access-to-markets/en/news/delay-until-december-2026-and-other-developments-implementation-eudr-regulation",
                priority: "critical"
            },
            {
                name: "EU Council - EUDR Revision",
                url: "https://www.consilium.europa.eu/en/press/press-releases/2025/12/18/deforestation-council-signs-off-targeted-revision-to-simplify-and-postpone-the-regulation/",
                priority: "critical"
            },
            {
                name: "EU Green Forum - Implementation",
                url: "https://green-forum.ec.europa.eu/nature-and-biodiversity/deforestation-regulation-implementation_en",
                priority: "high"
            },
            {
                name: "EUR-Lex - EUDR Legal Text",
                url: "https://eur-lex.europa.eu/eli/reg/2023/1115/oj/eng",
                priority: "medium"
            },
            {
                name: "EUDR Guidance Documents",
                url: "https://environment.ec.europa.eu/topics/forests/deforestation_en",
                priority: "medium"
            }
        ],
        FSC: [
            {
                name: "FSC International - News Centre",
                url: "https://fsc.org/en/newscentre",
                priority: "high"
            },
            {
                name: "FSC - Standards & Updates",
                url: "https://fsc.org/en/newscentre/standards",
                priority: "high"
            },
            {
                name: "FSC Connect - Document Centre",
                url: "https://connect.fsc.org/document-centre",
                priority: "medium"
            },
            {
                name: "FSC - General News",
                url: "https://fsc.org/en/newscentre/general-news",
                priority: "medium"
            }
        ]
    }
};

let state = {
    history: {},
    totalChecks: 0,
    changesDetected: 0,
    lastCheck: null,
    changes: [],
    logs: [],
    startTime: new Date().toISOString(),
    nextCheck: null,
    checkHistory: []
};

function loadState() {
    try {
        if (fs.existsSync('state.json')) {
            const loaded = JSON.parse(fs.readFileSync('state.json', 'utf8'));
            state = { ...state, ...loaded, startTime: state.startTime };
            addLog('success', `Restored monitoring data - ${state.totalChecks} checks performed`);
        }
    } catch (error) {
        addLog('info', 'Starting fresh monitoring session');
    }
}

function saveState() {
    try {
        fs.writeFileSync('state.json', JSON.stringify(state, null, 2));
    } catch (error) {}
}

function fetchPage(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        
        client.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 30000
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(crypto.createHash('sha256').update(data).digest('hex')));
        }).on('error', reject).on('timeout', () => reject(new Error('Timeout')));
    });
}

async function checkAllSources() {
    addLog('info', '🔍 Starting automated check...');
    
    state.totalChecks++;
    state.lastCheck = new Date().toISOString();
    state.nextCheck = new Date(Date.now() + CONFIG.CHECK_INTERVAL).toISOString();
    
    const changes = [];
    const allSources = [
        ...CONFIG.SOURCES.EUDR.map(s => ({ ...s, category: 'EUDR' })),
        ...CONFIG.SOURCES.FSC.map(s => ({ ...s, category: 'FSC' }))
    ];
    
    for (const source of allSources) {
        try {
            addLog('info', `Checking: ${source.name}`);
            const currentHash = await fetchPage(source.url);
            
            if (state.history[source.url]) {
                if (state.history[source.url].hash !== currentHash) {
                    const change = {
                        category: source.category,
                        name: source.name,
                        url: source.url,
                        timestamp: new Date().toISOString(),
                        previousCheck: state.history[source.url].lastChecked,
                        priority: source.priority,
                        new: true
                    };
                    
                    changes.push(change);
                    state.changes.unshift(change);
                    state.changesDetected++;
                    addLog('warning', `🚨 CHANGE DETECTED: ${source.name}`);
                }
            }
            
            state.history[source.url] = {
                hash: currentHash,
                lastChecked: new Date().toISOString(),
                name: source.name,
                category: source.category,
                status: 'checked'
            };
            
            await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (error) {
            state.history[source.url] = {
                ...state.history[source.url],
                status: 'error',
                lastError: error.message
            };
            addLog('error', `Error: ${source.name} - ${error.message}`);
        }
    }
    
    state.checkHistory.unshift({
        timestamp: state.lastCheck,
        changesFound: changes.length,
        sourcesChecked: allSources.length
    });
    if (state.checkHistory.length > 50) state.checkHistory = state.checkHistory.slice(0, 50);
    
    if (changes.length > 0) {
        addLog('warning', `✅ Check completed - ${changes.length} CHANGE(S) FOUND!`);
        await sendNotifications(changes);
    } else {
        addLog('success', '✅ Check completed - All sources unchanged');
    }
    
    saveState();
    return changes;
}

async function sendNotifications(changes) {
    if (!CONFIG.WEBHOOK_URL) return;
    
    const criticalChanges = changes.filter(c => c.priority === 'critical');
    let message = criticalChanges.length > 0 ? 
        `🚨🚨 **CRITICAL EUDR/FSC UPDATE** 🚨🚨\n\n` :
        `🚨 **EUDR/FSC Change Alert**\n\n`;
    
    message += `${changes.length} change(s) detected at ${new Date().toLocaleString('en-US', { timeZone: 'America/Panama' })}\n\n`;
    
    for (const change of changes) {
        const emoji = change.priority === 'critical' ? '🔴' : change.priority === 'high' ? '🟠' : '🟡';
        message += `${emoji} **${change.category}**: ${change.name}\n`;
        message += `🔗 ${change.url}\n\n`;
    }
    
    message += `📊 View dashboard: https://eudr-monitor-24-7.onrender.com`;
    
    return new Promise((resolve, reject) => {
        const url = new URL(CONFIG.WEBHOOK_URL);
        const req = https.request({
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, (res) => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
                addLog('success', '✅ Discord notification sent');
                resolve();
            } else {
                reject(new Error(`HTTP ${res.statusCode}`));
            }
        });
        req.on('error', reject);
        req.write(JSON.stringify({ text: message }));
        req.end();
    });
}

function addLog(type, message) {
    const timestamp = new Date().toISOString();
    state.logs.unshift({ type, message, timestamp });
    if (state.logs.length > 100) state.logs = state.logs.slice(0, 100);
    console.log(`[${timestamp}] [${type.toUpperCase()}] ${message}`);
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(getDashboardHTML());
    } else if (url.pathname === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'running',
            totalChecks: state.totalChecks,
            changesDetected: state.changesDetected,
            lastCheck: state.lastCheck,
            nextCheck: state.nextCheck,
            sources: Object.entries(state.history).map(([url, data]) => ({
                url,
                name: data.name,
                category: data.category,
                status: data.status || 'unknown',
                lastChecked: data.lastChecked,
                lastError: data.lastError
            })),
            recentChanges: state.changes.slice(0, 20),
            recentLogs: state.logs.slice(0, 25),
            checkHistory: state.checkHistory.slice(0, 24),
            hasNewChanges: state.changes.some(c => c.new)
        }));
    } else if (url.pathname === '/api/check-now') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Check initiated' }));
        checkAllSources().catch(err => addLog('error', err.message));
    } else if (url.pathname === '/api/mark-read') {
        state.changes.forEach(c => c.new = false);
        saveState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

function getDashboardHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>EUDR & FSC Monitor</title>
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🌲</text></svg>">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        :root {
            --primary: #667eea;
            --secondary: #764ba2;
            --success: #48bb78;
            --warning: #ed8936;
            --danger: #fc8181;
            --dark: #2d3748;
            --light: #f7fafc;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
            min-height: 100vh;
            padding: 20px;
        }
        
        .container { max-width: 1400px; margin: 0 auto; }
        
        .header {
            background: white;
            padding: 30px;
            border-radius: 15px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
            margin-bottom: 30px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
            gap: 20px;
        }
        
        .header-content { text-align: left; }
        .header h1 { color: var(--dark); font-size: 2.2em; margin-bottom: 5px; }
        .header p { color: #718096; font-size: 1.1em; }
        
        .header-controls {
            display: flex;
            gap: 15px;
            align-items: center;
            flex-wrap: wrap;
        }
        
        .lang-switcher {
            display: flex;
            gap: 5px;
            background: var(--light);
            padding: 5px;
            border-radius: 8px;
        }
        
        .lang-btn {
            background: transparent;
            border: none;
            padding: 8px 12px;
            cursor: pointer;
            border-radius: 5px;
            font-size: 0.9em;
            transition: all 0.3s;
        }
        
        .lang-btn:hover, .lang-btn.active {
            background: var(--primary);
            color: white;
        }
        
        .status-live {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            background: var(--success);
            color: white;
            padding: 10px 20px;
            border-radius: 25px;
            font-weight: 600;
            animation: pulse 2s infinite;
        }
        
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.8; }
        }
        
        .pulse-dot {
            width: 10px;
            height: 10px;
            background: white;
            border-radius: 50%;
            animation: pulse-dot 2s infinite;
        }
        
        @keyframes pulse-dot {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.3); }
        }
        
        .alert-banner {
            background: linear-gradient(135deg, var(--danger) 0%, #f56565 100%);
            color: white;
            padding: 25px 30px;
            border-radius: 15px;
            margin-bottom: 20px;
            box-shadow: 0 10px 30px rgba(252, 129, 129, 0.4);
            display: none;
            animation: slideDown 0.5s ease-out;
        }
        
        @keyframes slideDown {
            from { transform: translateY(-20px); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
        }
        
        .alert-banner.show { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 15px; }
        
        .alert-content h2 {
            font-size: 1.5em;
            margin-bottom: 8px;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        .alert-count {
            background: white;
            color: var(--danger);
            padding: 5px 15px;
            border-radius: 20px;
            font-size: 0.9em;
            font-weight: bold;
        }
        
        .btn-mark-read {
            background: white;
            color: var(--danger);
            border: none;
            padding: 12px 24px;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 600;
            transition: all 0.3s;
        }
        
        .btn-mark-read:hover {
            transform: scale(1.05);
            box-shadow: 0 5px 15px rgba(0,0,0,0.2);
        }
        
        .card {
            background: white;
            padding: 25px;
            border-radius: 15px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.1);
            margin-bottom: 20px;
        }
        
        .card h2 {
            color: var(--dark);
            margin-bottom: 20px;
            font-size: 1.4em;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        .grid-2 {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
        }
        
        .grid-4 {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 20px;
        }
        
        .stat {
            background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
            color: white;
            padding: 25px;
            border-radius: 12px;
            text-align: center;
            box-shadow: 0 5px 15px rgba(102, 126, 234, 0.3);
        }
        
        .stat-number {
            font-size: 2.5em;
            font-weight: bold;
            margin-bottom: 5px;
        }
        
        .stat-label {
            font-size: 0.95em;
            opacity: 0.95;
        }
        
        .stat-time {
            font-size: 0.85em;
            opacity: 0.8;
            margin-top: 5px;
        }
        
        .source-status-item {
            background: var(--light);
            padding: 15px;
            border-radius: 10px;
            margin-bottom: 10px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-left: 4px solid transparent;
        }
        
        .source-status-item.eudr { border-left-color: #4299e1; }
        .source-status-item.fsc { border-left-color: var(--success); }
        
        .source-info h3 {
            font-size: 1em;
            color: var(--dark);
            margin-bottom: 5px;
        }
        
        .source-info p {
            font-size: 0.85em;
            color: #718096;
        }
        
        .status-indicator {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 0.9em;
            font-weight: 600;
        }
        
        .status-dot {
            width: 12px;
            height: 12px;
            border-radius: 50%;
        }
        
        .status-dot.checked { background: var(--success); animation: pulse-dot 2s infinite; }
        .status-dot.error { background: var(--danger); }
        .status-dot.checking { background: var(--warning); animation: spin 1s linear infinite; }
        
        @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }
        
        .change-item {
            background: #fff5f5;
            border-left: 5px solid var(--danger);
            padding: 20px;
            margin-bottom: 15px;
            border-radius: 8px;
            position: relative;
        }
        
        .change-item.new {
            animation: highlight 2s ease-in-out;
        }
        
        @keyframes highlight {
            0%, 100% { background: #fff5f5; }
            50% { background: #fed7d7; }
        }
        
        .change-item.critical {
            background: #ffe5e5;
            border-left-width: 6px;
        }
        
        .change-new-badge {
            position: absolute;
            top: 15px;
            right: 15px;
            background: var(--danger);
            color: white;
            padding: 5px 12px;
            border-radius: 15px;
            font-size: 0.75em;
            font-weight: bold;
            animation: bounce 2s infinite;
        }
        
        @keyframes bounce {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-5px); }
        }
        
        .priority-badge {
            display: inline-block;
            padding: 3px 10px;
            border-radius: 12px;
            font-size: 0.75em;
            font-weight: bold;
            margin-left: 10px;
        }
        
        .priority-critical {
            background: #ff4444;
            color: white;
        }
        
        .priority-high {
            background: #ff8800;
            color: white;
        }
        
        .priority-medium {
            background: #ffbb00;
            color: #333;
        }
        
        .change-item h3 {
            color: #c53030;
            margin-bottom: 10px;
            font-size: 1.1em;
        }
        
        .change-item p {
            color: #718096;
            font-size: 0.95em;
            margin-bottom: 5px;
        }
        
        .change-item a {
            color: #4299e1;
            text-decoration: none;
            font-weight: 600;
            word-break: break-all;
        }
        
        .change-item a:hover { text-decoration: underline; }
        
        .no-changes {
            text-align: center;
            padding: 40px;
            color: var(--success);
        }
        
        .no-changes-icon {
            font-size: 3em;
            margin-bottom: 10px;
        }
        
        .chart-container {
            height: 200px;
            margin-top: 20px;
        }
        
        .btn-group {
            display: flex;
            gap: 15px;
            flex-wrap: wrap;
        }
        
        .btn {
            background: var(--primary);
            color: white;
            border: none;
            padding: 14px 28px;
            border-radius: 10px;
            cursor: pointer;
            font-size: 1em;
            font-weight: 600;
            transition: all 0.3s;
            flex: 1;
            min-width: 180px;
        }
        
        .btn:hover {
            background: #5a67d8;
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(102, 126, 234, 0.4);
        }
        
        .btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
            transform: none;
        }
        
        .btn.secondary { background: var(--success); }
        .btn.secondary:hover { background: #38a169; }
        
        .info-box {
            background: #ebf8ff;
            border-left: 4px solid #4299e1;
            padding: 15px 20px;
            border-radius: 8px;
            margin-bottom: 20px;
            color: #2c5282;
        }
        
        .info-box strong {
            display: block;
            margin-bottom: 5px;
        }
        
        .countdown {
            font-size: 0.9em;
            color: var(--primary);
            margin-top: 5px;
            font-weight: 600;
        }
        
        .quick-links {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-top: 15px;
        }
        
        .quick-link {
            background: var(--light);
            padding: 15px;
            border-radius: 10px;
            text-decoration: none;
            color: var(--dark);
            transition: all 0.3s;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        .quick-link:hover {
            transform: translateY(-3px);
            box-shadow: 0 5px 15px rgba(0,0,0,0.1);
            background: var(--primary);
            color: white;
        }
        
        @media (max-width: 768px) {
            .header { flex-direction: column; text-align: center; }
            .header-content { text-align: center; }
            .btn-group { flex-direction: column; }
            .btn { min-width: 100%; }
            .grid-2, .grid-4 { grid-template-columns: 1fr; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="header-content">
                <h1>🌲 EUDR & FSC Monitor</h1>
                <p id="headerSubtitle">24/7 Automated Compliance Monitoring</p>
            </div>
            <div class="header-controls">
                <div class="lang-switcher">
                    <button class="lang-btn active" onclick="setLanguage('en')">🇬🇧 EN</button>
                    <button class="lang-btn" onclick="setLanguage('da')">🇩🇰 DA</button>
                    <button class="lang-btn" onclick="setLanguage('es')">🇪🇸 ES</button>
                </div>
                <div class="status-live">
                    <span class="pulse-dot"></span>
                    <span id="liveStatus">LIVE & MONITORING</span>
                </div>
            </div>
        </div>
        
        <div class="alert-banner" id="alertBanner">
            <div class="alert-content">
                <h2>
                    🚨 <span id="alertTitle">Changes Detected!</span>
                    <span class="alert-count" id="alertCount">0</span>
                </h2>
                <p id="alertDescription">New updates found on monitored sources. Review changes below.</p>
            </div>
            <button class="btn-mark-read" onclick="markAsRead()" id="markReadBtn">Mark All as Read</button>
        </div>
        
        <div class="info-box">
            <strong>⚠️ <span id="eudrUpdateTitle">IMPORTANT: EUDR Implementation Delayed to December 2026</span></strong>
            <p id="eudrUpdateText">The EU has postponed EUDR compliance to December 30, 2026 for large/medium operators (June 30, 2027 for small businesses). New simplifications and amendments are being monitored. Stay updated here.</p>
        </div>
        
        <div class="card">
            <h2>📊 <span id="monitoringStatusTitle">Monitoring Status</span></h2>
            <div class="grid-4">
                <div class="stat">
                    <div class="stat-number" id="totalChecks">0</div>
                    <div class="stat-label" id="totalChecksLabel">Total Checks</div>
                    <div class="stat-time" id="checksInfo"></div>
                </div>
                <div class="stat">
                    <div class="stat-number" id="changesDetected">0</div>
                    <div class="stat-label" id="changesLabel">Changes Detected</div>
                    <div class="stat-time" id="changesInfo">All Time</div>
                </div>
                <div class="stat">
                    <div class="stat-number">10</div>
                    <div class="stat-label" id="sourcesLabel">Sources Monitored</div>
                    <div class="stat-time">6 EUDR + 4 FSC</div>
                </div>
                <div class="stat">
                    <div class="stat-number" id="lastCheck">Never</div>
                    <div class="stat-label" id="lastCheckLabel">Last Check</div>
                    <div class="countdown" id="nextCheck"></div>
                </div>
            </div>
        </div>
        
        <div class="grid-2">
            <div class="card">
                <h2>📡 <span id="sourceStatusTitle">Source Status</span></h2>
                <div id="sourceStatusList"></div>
            </div>
            
            <div class="card">
                <h2>📈 <span id="changeHistoryTitle">Check History (24h)</span></h2>
                <div class="chart-container" id="chartContainer">
                    <canvas id="historyChart"></canvas>
                </div>
            </div>
        </div>
        
        <div class="card">
            <h2>🎛️ <span id="controlsTitle">Controls</span></h2>
            <div class="btn-group">
                <button class="btn" onclick="checkNow()" id="checkNowBtn">🔍 Check Now</button>
                <button class="btn secondary" onclick="refresh()" id="refreshBtn">🔄 Refresh Dashboard</button>
            </div>
        </div>
        
        <div class="card">
            <h2>🔗 <span id="quickLinksTitle">Quick Access</span></h2>
            <div class="quick-links">
                <a href="https://environment.ec.europa.eu/topics/forests/deforestation/regulation-deforestation-free-products_en" target="_blank" class="quick-link">
                    📄 View All EUDR Sources
                </a>
                <a href="https://fsc.org/en/newscentre" target="_blank" class="quick-link">
                    🌲 View All FSC Sources
                </a>
                <a href="https://trade.ec.europa.eu/access-to-markets/en/news/delay-until-december-2026-and-other-developments-implementation-eudr-regulation" target="_blank" class="quick-link">
                    🔴 EUDR 2026 Delay Info
                </a>
                <a href="#" onclick="exportReport(); return false;" class="quick-link">
                    💾 Download Report
                </a>
            </div>
        </div>
        
        <div class="card">
            <h2>🚨 <span id="detectedChangesTitle">Detected Changes</span></h2>
            <div id="changesList"></div>
        </div>
    </div>
    
    <script>
        let currentLang = 'en';
        let updateInterval, countdownInterval;
        
        const translations = {
            en: {
                headerSubtitle: '24/7 Automated Compliance Monitoring',
                liveStatus: 'LIVE & MONITORING',
                alertTitle: 'Changes Detected!',
                alertDescription: 'New updates found on monitored sources. Review changes below.',
                markReadBtn: 'Mark All as Read',
                eudrUpdateTitle: 'IMPORTANT: EUDR Implementation Delayed to December 2026',
                eudrUpdateText: 'The EU has postponed EUDR compliance to December 30, 2026 for large/medium operators (June 30, 2027 for small businesses). New simplifications and amendments are being monitored. Stay updated here.',
                monitoringStatusTitle: 'Monitoring Status',
                totalChecksLabel: 'Total Checks',
                changesLabel: 'Changes Detected',
                changesInfo: 'All Time',
                sourcesLabel: 'Sources Monitored',
                lastCheckLabel: 'Last Check',
                sourceStatusTitle: 'Source Status',
                changeHistoryTitle: 'Check History (24h)',
                controlsTitle: 'Controls',
                checkNowBtn: '🔍 Check Now',
                refreshBtn: '🔄 Refresh Dashboard',
                quickLinksTitle: 'Quick Access',
                detectedChangesTitle: 'Detected Changes',
                noChangesTitle: 'No changes detected yet',
                noChangesDesc: 'System is monitoring. Updates will appear here when changes occur.'
            },
            da: {
                headerSubtitle: '24/7 Automatisk Overvågning',
                liveStatus: 'LIVE & OVERVÅGER',
                alertTitle: 'Ændringer Fundet!',
                alertDescription: 'Nye opdateringer fundet på overvågede kilder. Se ændringer nedenfor.',
                markReadBtn: 'Markér Alle Som Læst',
                eudrUpdateTitle: 'VIGTIGT: EUDR Implementering Udsat til December 2026',
                eudrUpdateText: 'EU har udsat EUDR compliance til 30. december 2026 for store/mellemstore virksomheder (30. juni 2027 for små virksomheder). Nye forenklinger og ændringer overvåges. Bliv opdateret her.',
                monitoringStatusTitle: 'Overvågningsstatus',
                totalChecksLabel: 'Totale Checks',
                changesLabel: 'Ændringer Fundet',
                changesInfo: 'Alle Tid',
                sourcesLabel: 'Kilder Overvåget',
                lastCheckLabel: 'Sidst Tjekket',
                sourceStatusTitle: 'Kilde Status',
                changeHistoryTitle: 'Check Historik (24t)',
                controlsTitle: 'Kontroller',
                checkNowBtn: '🔍 Tjek Nu',
                refreshBtn: '🔄 Opdater Dashboard',
                quickLinksTitle: 'Hurtig Adgang',
                detectedChangesTitle: 'Fundne Ændringer',
                noChangesTitle: 'Ingen ændringer fundet endnu',
                noChangesDesc: 'Systemet overvåger. Opdateringer vises her når ændringer sker.'
            },
            es: {
                headerSubtitle: 'Monitoreo Automatizado 24/7',
                liveStatus: 'EN VIVO Y MONITOREANDO',
                alertTitle: '¡Cambios Detectados!',
                alertDescription: 'Nuevas actualizaciones encontradas en fuentes monitoreadas. Revise los cambios a continuación.',
                markReadBtn: 'Marcar Todos Como Leídos',
                eudrUpdateTitle: 'IMPORTANTE: Implementación EUDR Retrasada hasta Diciembre 2026',
                eudrUpdateText: 'La UE ha pospuesto el cumplimiento de EUDR hasta el 30 de diciembre de 2026 para operadores grandes/medianos (30 de junio de 2027 para pequeñas empresas). Se están monitoreando nuevas simplificaciones y enmiendas. Manténgase actualizado aquí.',
                monitoringStatusTitle: 'Estado del Monitoreo',
                totalChecksLabel: 'Verificaciones Totales',
                changesLabel: 'Cambios Detectados',
                changesInfo: 'Todo el Tiempo',
                sourcesLabel: 'Fuentes Monitoreadas',
                lastCheckLabel: 'Última Verificación',
                sourceStatusTitle: 'Estado de Fuentes',
                changeHistoryTitle: 'Historial de Verificaciones (24h)',
                controlsTitle: 'Controles',
                checkNowBtn: '🔍 Verificar Ahora',
                refreshBtn: '🔄 Actualizar Panel',
                quickLinksTitle: 'Acceso Rápido',
                detectedChangesTitle: 'Cambios Detectados',
                noChangesTitle: 'Aún no se detectaron cambios',
                noChangesDesc: 'El sistema está monitoreando. Las actualizaciones aparecerán aquí cuando ocurran cambios.'
            }
        };
        
        function setLanguage(lang) {
            currentLang = lang;
            document.querySelectorAll('.lang-btn').forEach(btn => btn.classList.remove('active'));
            event.target.classList.add('active');
            
            const t = translations[lang];
            Object.keys(t).forEach(key => {
                const el = document.getElementById(key);
                if (el) {
                    if (el.tagName === 'BUTTON' || el.tagName === 'INPUT') {
                        el.textContent = t[key];
                    } else {
                        el.textContent = t[key];
                    }
                }
            });
            
            refresh();
        }
        
        async function refresh() {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                
                document.getElementById('totalChecks').textContent = data.totalChecks;
                document.getElementById('changesDetected').textContent = data.changesDetected;
                
                if (data.lastCheck) {
                    const lastCheckDate = new Date(data.lastCheck);
                    const now = new Date();
                    const diffMinutes = Math.floor((now - lastCheckDate) / 60000);
                    
                    if (diffMinutes < 1) {
                        document.getElementById('lastCheck').textContent = 'Just now';
                    } else if (diffMinutes < 60) {
                        document.getElementById('lastCheck').textContent = diffMinutes + 'm ago';
                    } else {
                        document.getElementById('lastCheck').textContent = lastCheckDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                    }
                    
                    document.getElementById('checksInfo').textContent = 'Since ' + lastCheckDate.toLocaleDateString();
                }
                
                if (data.nextCheck) {
                    updateCountdown(data.nextCheck);
                }
                
                // Alert banner
                if (data.hasNewChanges && data.recentChanges.length > 0) {
                    const newCount = data.recentChanges.filter(c => c.new).length;
                    if (newCount > 0) {
                        document.getElementById('alertBanner').classList.add('show');
                        document.getElementById('alertCount').textContent = newCount;
                    }
                } else {
                    document.getElementById('alertBanner').classList.remove('show');
                }
                
                // Source status
                renderSourceStatus(data.sources);
                
                // Changes
                renderChanges(data.recentChanges);
                
                // Chart
                renderChart(data.checkHistory);
                
            } catch (error) {
                console.error('Refresh error:', error);
            }
        }
        
        function renderSourceStatus(sources) {
            const container = document.getElementById('sourceStatusList');
            if (!sources || sources.length === 0) {
                container.innerHTML = '<p style="color: #718096;">Loading...</p>';
                return;
            }
            
            container.innerHTML = sources.map(source => {
                const statusClass = source.status === 'checked' ? 'checked' : source.status === 'error' ? 'error' : 'checking';
                const statusText = source.status === 'checked' ? '✅ Checked' : source.status === 'error' ? '❌ Error' : '⏳ Checking';
                const timeAgo = source.lastChecked ? getTimeAgo(source.lastChecked) : 'Never';
                
                return \`
                    <div class="source-status-item \${source.category.toLowerCase()}">
                        <div class="source-info">
                            <h3>\${source.name}</h3>
                            <p>Last checked: \${timeAgo}</p>
                        </div>
                        <div class="status-indicator">
                            <span class="status-dot \${statusClass}"></span>
                            <span>\${statusText}</span>
                        </div>
                    </div>
                \`;
            }).join('');
        }
        
        function renderChanges(changes) {
            const container = document.getElementById('changesList');
            if (!changes || changes.length === 0) {
                const t = translations[currentLang];
                container.innerHTML = \`
                    <div class="no-changes">
                        <div class="no-changes-icon">✅</div>
                        <p><strong>\${t.noChangesTitle}</strong></p>
                        <p style="font-size: 0.9em; margin-top: 5px;">\${t.noChangesDesc}</p>
                    </div>
                \`;
                return;
            }
            
            container.innerHTML = changes.map(change => {
                const priorityBadge = change.priority ? \`<span class="priority-badge priority-\${change.priority}">\${change.priority.toUpperCase()}</span>\` : '';
                const criticalClass = change.priority === 'critical' ? 'critical' : '';
                
                return \`
                    <div class="change-item \${change.new ? 'new' : ''} \${criticalClass}">
                        \${change.new ? '<span class="change-new-badge">NEW</span>' : ''}
                        <h3>🔴 \${change.category}: \${change.name} \${priorityBadge}</h3>
                        <p><strong>Detected:</strong> \${new Date(change.timestamp).toLocaleString()}</p>
                        <p><strong>Link:</strong> <a href="\${change.url}" target="_blank">\${change.url}</a></p>
                    </div>
                \`;
            }).join('');
        }
        
        function renderChart(history) {
            if (!history || history.length === 0) return;
            
            const canvas = document.getElementById('historyChart');
            const ctx = canvas.getContext('2d');
            const width = canvas.parentElement.clientWidth;
            const height = 200;
            canvas.width = width;
            canvas.height = height;
            
            ctx.clearRect(0, 0, width, height);
            
            const data = history.slice(0, 24).reverse();
            const max = Math.max(...data.map(d => d.changesFound), 1);
            const barWidth = width / data.length;
            
            data.forEach((d, i) => {
                const barHeight = (d.changesFound / max) * (height - 40);
                const x = i * barWidth;
                const y = height - barHeight - 20;
                
                ctx.fillStyle = d.changesFound > 0 ? '#fc8181' : '#48bb78';
                ctx.fillRect(x + 5, y, barWidth - 10, barHeight);
                
                ctx.fillStyle = '#718096';
                ctx.font = '10px sans-serif';
                ctx.fillText(d.changesFound, x + barWidth/2 - 5, y - 5);
            });
        }
        
        function updateCountdown(nextCheckISO) {
            if (countdownInterval) clearInterval(countdownInterval);
            
            countdownInterval = setInterval(() => {
                const now = new Date();
                const nextCheck = new Date(nextCheckISO);
                const diff = nextCheck - now;
                
                if (diff <= 0) {
                    document.getElementById('nextCheck').textContent = 'Checking now...';
                    return;
                }
                
                const minutes = Math.floor(diff / 60000);
                const seconds = Math.floor((diff % 60000) / 1000);
                document.getElementById('nextCheck').textContent = \`Next check in \${minutes}m \${seconds}s\`;
            }, 1000);
        }
        
        function getTimeAgo(timestamp) {
            const now = new Date();
            const then = new Date(timestamp);
            const diffMinutes = Math.floor((now - then) / 60000);
            
            if (diffMinutes < 1) return 'Just now';
            if (diffMinutes < 60) return diffMinutes + 'm ago';
            const diffHours = Math.floor(diffMinutes / 60);
            if (diffHours < 24) return diffHours + 'h ago';
            return then.toLocaleDateString();
        }
        
        async function checkNow() {
            const btn = document.getElementById('checkNowBtn');
            btn.disabled = true;
            btn.textContent = '⏳ Checking...';
            
            await fetch('/api/check-now');
            
            setTimeout(() => {
                refresh();
                btn.disabled = false;
                setLanguage(currentLang);
                alert('Check completed! Dashboard refreshed.');
            }, 3000);
        }
        
        async function markAsRead() {
            await fetch('/api/mark-read');
            refresh();
        }
        
        function exportReport() {
            alert('Report export feature coming soon!');
        }
        
        updateInterval = setInterval(refresh, 30000);
        refresh();
    </script>
</body>
</html>`;
}

// Initialize
loadState();
addLog('info', '🚀 EUDR/FSC Monitor starting with enhanced features...');
addLog('info', '📡 Monitoring 6 EUDR sources (including 2026 delay updates)');
addLog('info', '🌲 Monitoring 4 FSC sources');

server.listen(CONFIG.PORT, () => {
    addLog('success', `✅ Server running on port ${CONFIG.PORT}`);
    if (CONFIG.WEBHOOK_URL) {
        addLog('success', '✅ Discord webhook configured');
    } else {
        addLog('warning', '⚠️  Discord webhook not configured');
    }
});

setTimeout(() => {
    addLog('info', 'Running initial check...');
    checkAllSources().catch(err => addLog('error', err.message));
}, 10000);

setInterval(() => {
    checkAllSources().catch(err => addLog('error', err.message));
}, CONFIG.CHECK_INTERVAL);

process.on('SIGTERM', () => {
    addLog('info', 'Shutting down...');
    saveState();
    server.close(() => process.exit(0));
});
