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
    logs: []
};

// Load state from file
function loadState() {
    try {
        if (fs.existsSync('state.json')) {
            state = JSON.parse(fs.readFileSync('state.json', 'utf8'));
            addLog('info', 'State loaded from disk');
        }
    } catch (error) {
        addLog('error', `Failed to load state: ${error.message}`);
    }
}

// Save state to file
function saveState() {
    try {
        fs.writeFileSync('state.json', JSON.stringify(state, null, 2));
    } catch (error) {
        addLog('error', `Failed to save state: ${error.message}`);
    }
}

// Fetch URL and return content hash
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
                // Create hash of content
                const hash = crypto.createHash('sha256').update(data).digest('hex');
                resolve(hash);
            });
        }).on('error', reject).on('timeout', () => {
            reject(new Error('Request timeout'));
        });
    });
}

// Check all sources
async function checkAllSources() {
    addLog('info', 'Starting check of all sources...');
    
    state.totalChecks++;
    state.lastCheck = new Date().toISOString();
    
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
                // Compare with previous hash
                if (state.history[source.url].hash !== currentHash) {
                    // Change detected!
                    const change = {
                        category: source.category,
                        name: source.name,
                        url: source.url,
                        timestamp: new Date().toISOString(),
                        previousCheck: state.history[source.url].lastChecked
                    };
                    
                    changes.push(change);
                    state.changes.unshift(change);
                    state.changesDetected++;
                    
                    addLog('warning', `🚨 CHANGE DETECTED: ${source.name}`);
                }
            }
            
            // Update history
            state.history[source.url] = {
                hash: currentHash,
                lastChecked: new Date().toISOString(),
                name: source.name,
                category: source.category
            };
            
            // Small delay between requests
            await new Promise(resolve => setTimeout(resolve, 2000));
            
        } catch (error) {
            addLog('error', `Error checking ${source.name}: ${error.message}`);
        }
    }
    
    if (changes.length > 0) {
        addLog('warning', `Check completed - found ${changes.length} change(s)!`);
        await sendNotifications(changes);
    } else {
        addLog('success', 'Check completed - no changes found');
    }
    
    saveState();
    return changes;
}

// Send webhook notification
async function sendNotifications(changes) {
    if (!CONFIG.WEBHOOK_URL) {
        addLog('info', 'No webhook URL configured - skipping notifications');
        return;
    }
    
    const message = formatWebhookMessage(changes);
    
    return new Promise((resolve, reject) => {
        const url = new URL(CONFIG.WEBHOOK_URL);
        const options = {
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        };
        
        const req = https.request(options, (res) => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
                addLog('success', 'Webhook notification sent successfully');
                resolve();
            } else {
                addLog('error', `Webhook failed with status: ${res.statusCode}`);
                reject(new Error(`HTTP ${res.statusCode}`));
            }
        });
        
        req.on('error', (error) => {
            addLog('error', `Webhook error: ${error.message}`);
            reject(error);
        });
        
        req.write(JSON.stringify({ text: message }));
        req.end();
    });
}

// Format webhook message
function formatWebhookMessage(changes) {
    let message = `🚨 *EUDR/FSC Monitor Alert*\n\n`;
    message += `Detected ${changes.length} change(s) at ${new Date().toLocaleString()}\n\n`;
    
    for (const change of changes) {
        message += `*${change.category}*: ${change.name}\n`;
        message += `🔗 ${change.url}\n\n`;
    }
    
    return message;
}

// Add log entry
function addLog(type, message) {
    const timestamp = new Date().toISOString();
    const log = { type, message, timestamp };
    
    state.logs.unshift(log);
    
    // Keep only last 100 logs
    if (state.logs.length > 100) {
        state.logs = state.logs.slice(0, 100);
    }
    
    console.log(`[${timestamp}] [${type.toUpperCase()}] ${message}`);
}

// HTTP Server for dashboard
const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    if (url.pathname === '/') {
        // Serve dashboard
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(getDashboardHTML());
    } else if (url.pathname === '/api/status') {
        // API endpoint for status
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'running',
            totalChecks: state.totalChecks,
            changesDetected: state.changesDetected,
            lastCheck: state.lastCheck,
            monitoredSources: Object.keys(state.history).length,
            recentChanges: state.changes.slice(0, 10),
            recentLogs: state.logs.slice(0, 20)
        }));
    } else if (url.pathname === '/api/check-now') {
        // Trigger immediate check
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Check initiated' }));
        checkAllSources().catch(err => addLog('error', err.message));
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

// Dashboard HTML
function getDashboardHTML() {
    return `
<!DOCTYPE html>
<html>
<head>
    <title>EUDR/FSC Monitor - Live Dashboard</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body {
            font-family: Arial, sans-serif;
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            background: #f5f5f5;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 30px;
            border-radius: 10px;
            margin-bottom: 20px;
        }
        .card {
            background: white;
            padding: 20px;
            border-radius: 10px;
            margin-bottom: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-bottom: 20px;
        }
        .stat {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 20px;
            border-radius: 10px;
            text-align: center;
        }
        .stat-number {
            font-size: 2em;
            font-weight: bold;
        }
        .stat-label {
            font-size: 0.9em;
            opacity: 0.9;
        }
        .log {
            background: #1a202c;
            color: #a0aec0;
            padding: 15px;
            border-radius: 5px;
            font-family: monospace;
            font-size: 0.9em;
            max-height: 400px;
            overflow-y: auto;
        }
        .log-entry {
            margin-bottom: 5px;
            padding: 5px;
            border-left: 3px solid #4a5568;
        }
        .log-entry.warning { border-left-color: #ed8936; }
        .log-entry.error { border-left-color: #f56565; }
        .log-entry.success { border-left-color: #48bb78; }
        .log-entry.info { border-left-color: #4299e1; }
        .btn {
            background: #667eea;
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 5px;
            cursor: pointer;
            font-size: 1em;
            font-weight: 600;
        }
        .btn:hover { background: #5a67d8; }
        .status-badge {
            display: inline-block;
            padding: 5px 15px;
            border-radius: 20px;
            font-size: 0.9em;
            background: #48bb78;
            color: white;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>🌲 EUDR & FSC Monitor - Live Dashboard</h1>
        <p>Automated 24/7 monitoring service <span class="status-badge">● RUNNING</span></p>
    </div>
    
    <div class="stats" id="stats">
        <div class="stat">
            <div class="stat-number" id="totalChecks">0</div>
            <div class="stat-label">Total Checks</div>
        </div>
        <div class="stat">
            <div class="stat-number" id="changes">0</div>
            <div class="stat-label">Changes Detected</div>
        </div>
        <div class="stat">
            <div class="stat-number" id="sources">0</div>
            <div class="stat-label">Sources Monitored</div>
        </div>
        <div class="stat">
            <div class="stat-number" id="lastCheck">Never</div>
            <div class="stat-label">Last Check</div>
        </div>
    </div>
    
    <div class="card">
        <h2>Controls</h2>
        <button class="btn" onclick="checkNow()">🔍 Check Now</button>
        <button class="btn" onclick="refresh()" style="background: #48bb78; margin-left: 10px;">🔄 Refresh</button>
    </div>
    
    <div class="card">
        <h2>📝 Activity Log</h2>
        <div class="log" id="log"></div>
    </div>
    
    <script>
        async function refresh() {
            const res = await fetch('/api/status');
            const data = await res.json();
            
            document.getElementById('totalChecks').textContent = data.totalChecks;
            document.getElementById('changes').textContent = data.changesDetected;
            document.getElementById('sources').textContent = data.monitoredSources;
            
            if (data.lastCheck) {
                const date = new Date(data.lastCheck);
                document.getElementById('lastCheck').textContent = date.toLocaleTimeString();
            }
            
            const logDiv = document.getElementById('log');
            logDiv.innerHTML = data.recentLogs.map(log => 
                \`<div class="log-entry \${log.type}">
                    <span style="color: #718096;">[\${new Date(log.timestamp).toLocaleTimeString()}]</span>
                    <span>\${log.message}</span>
                </div>\`
            ).join('');
        }
        
        async function checkNow() {
            await fetch('/api/check-now');
            alert('Check initiated! Refresh in a few minutes to see results.');
        }
        
        // Auto-refresh every 30 seconds
        setInterval(refresh, 30000);
        refresh();
    </script>
</body>
</html>
    `;
}

// Initialize
loadState();
addLog('info', '🚀 EUDR/FSC Monitor starting...');

// Start server
server.listen(CONFIG.PORT, () => {
    addLog('success', `✅ Server running on port ${CONFIG.PORT}`);
    addLog('info', `Dashboard: http://localhost:${CONFIG.PORT}`);
    addLog('info', `Check interval: ${CONFIG.CHECK_INTERVAL / 60000} minutes`);
    
    if (CONFIG.WEBHOOK_URL) {
        addLog('success', '✅ Webhook configured');
    } else {
        addLog('warning', '⚠️  No webhook URL set - notifications disabled');
    }
});

// Run initial check after 10 seconds
setTimeout(() => {
    checkAllSources().catch(err => addLog('error', err.message));
}, 10000);

// Schedule periodic checks
setInterval(() => {
    checkAllSources().catch(err => addLog('error', err.message));
}, CONFIG.CHECK_INTERVAL);

// Graceful shutdown
process.on('SIGTERM', () => {
    addLog('info', 'Shutting down gracefully...');
    saveState();
    server.close(() => {
        addLog('info', 'Server closed');
        process.exit(0);
    });
});
