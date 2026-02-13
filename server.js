const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

// Configuration
const CONFIG = {
    PORT: process.env.PORT || 3000,
    CHECK_INTERVAL: 3600000, // 1 hour in milliseconds
    WEBHOOK_URL: process.env.WEBHOOK_URL || '',
    
    SOURCES: {
        EUDR: [
            {
                name: "EU Commission - EUDR Main Page",
                url: "https://environment.ec.europa.eu/topics/forests/deforestation/regulation-deforestation-free-products_en"
            },
            {
                name: "EU Green Forum - EUDR Implementation",
                url: "https://green-forum.ec.europa.eu/nature-and-biodiversity/deforestation-regulation-implementation_en"
            },
            {
                name: "EUR-Lex - EUDR Legal Text",
                url: "https://eur-lex.europa.eu/eli/reg/2023/1115/oj/eng"
            },
            {
                name: "EU - EUDR FAQ",
                url: "https://environment.ec.europa.eu/topics/forests/deforestation/regulation-deforestation-free-products_en"
            },
            {
                name: "EUDR Guidance Documents",
                url: "https://environment.ec.europa.eu/topics/forests/deforestation_en"
            }
        ],
        FSC: [
            {
                name: "FSC International - News Centre",
                url: "https://fsc.org/en/newscentre"
            },
            {
                name: "FSC - Standards & Updates",
                url: "https://fsc.org/en/newscentre/standards"
            },
            {
                name: "FSC Connect - Document Centre",
                url: "https://connect.fsc.org/document-centre"
            },
            {
                name: "FSC - General News",
                url: "https://fsc.org/en/newscentre/general-news"
            },
            {
                name: "FSC International - Main Site",
                url: "https://fsc.org/en"
            }
        ]
    }
};

// State storage
let state = {
    history: {},
    totalChecks: 0,
    changesDetected: 0,
    lastCheck: null,
    changes: [],
    logs: [],
    startTime: new Date().toISOString(),
    nextCheck: null
};

function loadState() {
    try {
        if (fs.existsSync('state.json')) {
            const loaded = JSON.parse(fs.readFileSync('state.json', 'utf8'));
            state = { ...state, ...loaded, startTime: state.startTime };
            addLog('success', `Restored ${state.totalChecks} checks, ${state.changesDetected} changes detected`);
        }
    } catch (error) {
        addLog('info', 'Starting fresh monitoring session');
    }
}

function saveState() {
    try {
        fs.writeFileSync('state.json', JSON.stringify(state, null, 2));
    } catch (error) {
        // Silent fail on free tier
    }
}

function fetchPage(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        
        client.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 30000
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const hash = crypto.createHash('sha256').update(data).digest('hex');
                resolve(hash);
            });
        }).on('error', reject).on('timeout', () => {
            reject(new Error('Request timeout'));
        });
    });
}

async function checkAllSources() {
    addLog('info', 'Starting automated check of all sources...');
    
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
                category: source.category
            };
            
            await new Promise(resolve => setTimeout(resolve, 2000));
            
        } catch (error) {
            addLog('error', `Error checking ${source.name}: ${error.message}`);
        }
    }
    
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
    if (!CONFIG.WEBHOOK_URL) {
        return;
    }
    
    const message = formatWebhookMessage(changes);
    
    return new Promise((resolve, reject) => {
        const url = new URL(CONFIG.WEBHOOK_URL);
        const options = {
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        };
        
        const req = https.request(options, (res) => {
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

function formatWebhookMessage(changes) {
    let message = `🚨 **EUDR/FSC CHANGE ALERT** 🚨\n\n`;
    message += `${changes.length} change(s) detected at ${new Date().toLocaleString('en-US', { timeZone: 'America/Panama' })}\n\n`;
    
    for (const change of changes) {
        message += `**${change.category}**: ${change.name}\n`;
        message += `🔗 ${change.url}\n\n`;
    }
    
    message += `View dashboard: https://eudr-monitor-24-7.onrender.com`;
    return message;
}

function addLog(type, message) {
    const timestamp = new Date().toISOString();
    const log = { type, message, timestamp };
    
    state.logs.unshift(log);
    if (state.logs.length > 100) {
        state.logs = state.logs.slice(0, 100);
    }
    
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
            monitoredSources: 10,
            recentChanges: state.changes.slice(0, 10),
            recentLogs: state.logs.slice(0, 25),
            hasNewChanges: state.changes.some(c => c.new)
        }));
    } else if (url.pathname === '/api/check-now') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Manual check initiated' }));
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
    return `
<!DOCTYPE html>
<html>
<head>
    <title>EUDR/FSC Monitor</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🌲</text></svg>">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        
        .container { max-width: 1200px; margin: 0 auto; }
        
        .header {
            background: white;
            padding: 30px;
            border-radius: 15px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
            margin-bottom: 30px;
            text-align: center;
        }
        
        .header h1 {
            color: #2d3748;
            font-size: 2.2em;
            margin-bottom: 10px;
        }
        
        .header p {
            color: #718096;
            font-size: 1.1em;
        }
        
        .status-live {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            background: #48bb78;
            color: white;
            padding: 8px 20px;
            border-radius: 25px;
            font-weight: 600;
            margin-top: 15px;
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
            50% { transform: scale(1.2); }
        }
        
        .alert-banner {
            background: linear-gradient(135deg, #fc8181 0%, #f56565 100%);
            color: white;
            padding: 20px 30px;
            border-radius: 15px;
            margin-bottom: 20px;
            box-shadow: 0 10px 30px rgba(245, 101, 101, 0.3);
            display: none;
            animation: slideDown 0.5s ease-out;
        }
        
        @keyframes slideDown {
            from { transform: translateY(-20px); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
        }
        
        .alert-banner.show { display: block; }
        
        .alert-banner h2 {
            font-size: 1.5em;
            margin-bottom: 10px;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        .alert-count {
            background: white;
            color: #f56565;
            padding: 5px 15px;
            border-radius: 20px;
            font-size: 0.9em;
            font-weight: bold;
        }
        
        .btn-mark-read {
            background: white;
            color: #f56565;
            border: none;
            padding: 10px 20px;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 600;
            margin-top: 10px;
        }
        
        .btn-mark-read:hover {
            background: #f7fafc;
        }
        
        .card {
            background: white;
            padding: 25px;
            border-radius: 15px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.1);
            margin-bottom: 20px;
        }
        
        .card h2 {
            color: #2d3748;
            margin-bottom: 20px;
            font-size: 1.4em;
        }
        
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 20px;
        }
        
        .stat {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
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
        
        .changes-section {
            margin-top: 20px;
        }
        
        .change-item {
            background: #fff5f5;
            border-left: 5px solid #fc8181;
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
        
        .change-new-badge {
            position: absolute;
            top: 15px;
            right: 15px;
            background: #f56565;
            color: white;
            padding: 5px 12px;
            border-radius: 15px;
            font-size: 0.8em;
            font-weight: bold;
        }
        
        .change-item h3 {
            color: #c53030;
            margin-bottom: 8px;
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
        
        .change-item a:hover {
            text-decoration: underline;
        }
        
        .no-changes {
            text-align: center;
            padding: 40px;
            color: #48bb78;
            font-size: 1.1em;
        }
        
        .no-changes-icon {
            font-size: 3em;
            margin-bottom: 10px;
        }
        
        .btn-group {
            display: flex;
            gap: 15px;
            flex-wrap: wrap;
        }
        
        .btn {
            background: #667eea;
            color: white;
            border: none;
            padding: 14px 28px;
            border-radius: 10px;
            cursor: pointer;
            font-size: 1em;
            font-weight: 600;
            transition: all 0.3s;
            flex: 1;
            min-width: 150px;
        }
        
        .btn:hover {
            background: #5a67d8;
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(102, 126, 234, 0.4);
        }
        
        .btn.secondary {
            background: #48bb78;
        }
        
        .btn.secondary:hover {
            background: #38a169;
        }
        
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
            color: #667eea;
            margin-top: 5px;
            font-weight: 600;
        }
        
        @media (max-width: 768px) {
            .header h1 { font-size: 1.6em; }
            .stats { grid-template-columns: 1fr; }
            .btn-group { flex-direction: column; }
            .btn { min-width: 100%; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🌲 EUDR & FSC Monitor</h1>
            <p>24/7 Automated Compliance Monitoring</p>
            <div class="status-live">
                <span class="pulse-dot"></span>
                LIVE & MONITORING
            </div>
        </div>
        
        <div class="alert-banner" id="alertBanner">
            <h2>
                🚨 Changes Detected!
                <span class="alert-count" id="alertCount">0</span>
            </h2>
            <p>New updates found on monitored sources. Review changes below.</p>
            <button class="btn-mark-read" onclick="markAsRead()">Mark All as Read</button>
        </div>
        
        <div class="info-box">
            <strong>ℹ️ How it works:</strong>
            This system automatically checks all EUDR and FSC sources every hour. When changes are detected, they appear here immediately and notifications are sent via Discord (if configured).
        </div>
        
        <div class="card">
            <h2>📊 Monitoring Status</h2>
            <div class="stats">
                <div class="stat">
                    <div class="stat-number" id="totalChecks">0</div>
                    <div class="stat-label">Total Checks</div>
                    <div class="stat-time" id="checksInfo"></div>
                </div>
                <div class="stat">
                    <div class="stat-number" id="changesDetected">0</div>
                    <div class="stat-label">Changes Detected</div>
                    <div class="stat-time">All Time</div>
                </div>
                <div class="stat">
                    <div class="stat-number">10</div>
                    <div class="stat-label">Sources Monitored</div>
                    <div class="stat-time">5 EUDR + 5 FSC</div>
                </div>
                <div class="stat">
                    <div class="stat-number" id="lastCheck">Never</div>
                    <div class="stat-label">Last Check</div>
                    <div class="countdown" id="nextCheck"></div>
                </div>
            </div>
        </div>
        
        <div class="card">
            <h2>🎛️ Controls</h2>
            <div class="btn-group">
                <button class="btn" onclick="checkNow()">🔍 Check Now</button>
                <button class="btn secondary" onclick="refresh()">🔄 Refresh Dashboard</button>
            </div>
        </div>
        
        <div class="card">
            <h2>🚨 Detected Changes</h2>
            <div id="changesList"></div>
        </div>
    </div>
    
    <script>
        let updateInterval;
        let countdownInterval;
        
        async function refresh() {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                
                // Update stats
                document.getElementById('totalChecks').textContent = data.totalChecks;
                document.getElementById('changesDetected').textContent = data.changesDetected;
                
                // Update last check time
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
                    
                    document.getElementById('checksInfo').textContent = 'Since ' + new Date(data.lastCheck).toLocaleDateString();
                } else {
                    document.getElementById('lastCheck').textContent = 'Never';
                }
                
                // Update next check countdown
                if (data.nextCheck) {
                    updateCountdown(data.nextCheck);
                }
                
                // Show/hide alert banner
                if (data.hasNewChanges && data.recentChanges.length > 0) {
                    const newCount = data.recentChanges.filter(c => c.new).length;
                    if (newCount > 0) {
                        document.getElementById('alertBanner').classList.add('show');
                        document.getElementById('alertCount').textContent = newCount;
                    }
                } else {
                    document.getElementById('alertBanner').classList.remove('show');
                }
                
                // Render changes
                const changesList = document.getElementById('changesList');
                if (data.recentChanges && data.recentChanges.length > 0) {
                    changesList.innerHTML = data.recentChanges.map(change => \`
                        <div class="change-item \${change.new ? 'new' : ''}">
                            \${change.new ? '<span class="change-new-badge">NEW</span>' : ''}
                            <h3>🔴 \${change.category}: \${change.name}</h3>
                            <p><strong>Detected:</strong> \${new Date(change.timestamp).toLocaleString()}</p>
                            <p><strong>Link:</strong> <a href="\${change.url}" target="_blank">\${change.url}</a></p>
                        </div>
                    \`).join('');
                } else {
                    changesList.innerHTML = \`
                        <div class="no-changes">
                            <div class="no-changes-icon">✅</div>
                            <p><strong>No changes detected yet</strong></p>
                            <p style="font-size: 0.9em; margin-top: 5px;">System is monitoring. You'll see updates here when changes occur.</p>
                        </div>
                    \`;
                }
                
            } catch (error) {
                console.error('Refresh error:', error);
            }
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
        
        async function checkNow() {
            const btn = event.target;
            btn.disabled = true;
            btn.textContent = '⏳ Checking...';
            
            await fetch('/api/check-now');
            
            setTimeout(() => {
                refresh();
                btn.disabled = false;
                btn.textContent = '🔍 Check Now';
                alert('Check completed! Dashboard refreshed.');
            }, 3000);
        }
        
        async function markAsRead() {
            await fetch('/api/mark-read');
            refresh();
        }
        
        // Auto-refresh every 30 seconds
        updateInterval = setInterval(refresh, 30000);
        
        // Initial load
        refresh();
    </script>
</body>
</html>
    `;
}

// Initialize
loadState();
addLog('info', '🚀 EUDR/FSC Monitor starting...');

server.listen(CONFIG.PORT, () => {
    addLog('success', `✅ Server running on port ${CONFIG.PORT}`);
    addLog('info', `Monitoring 10 sources (5 EUDR + 5 FSC)`);
    addLog('info', `Check interval: Every 60 minutes`);
    
    if (CONFIG.WEBHOOK_URL) {
        addLog('success', '✅ Discord webhook configured');
    } else {
        addLog('warning', '⚠️  Discord webhook not set');
    }
});

// Run initial check
setTimeout(() => {
    addLog('info', 'Running initial check...');
    checkAllSources().catch(err => addLog('error', err.message));
}, 10000);

// Schedule periodic checks
setInterval(() => {
    checkAllSources().catch(err => addLog('error', err.message));
}, CONFIG.CHECK_INTERVAL);

// Graceful shutdown
process.on('SIGTERM', () => {
    addLog('info', 'Shutting down...');
    saveState();
    server.close(() => process.exit(0));
});
