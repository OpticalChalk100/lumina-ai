const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// --- Load local environment variables if .env exists ---
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    try {
        const envConfig = fs.readFileSync(envPath, 'utf8');
        envConfig.split(/\r?\n/).forEach(line => {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
                const parts = trimmed.split('=');
                if (parts.length >= 2) {
                    const key = parts[0].trim();
                    const val = parts.slice(1).join('=').trim().replace(/^["']|["']$/g, '');
                    process.env[key] = val;
                }
            }
        });
        console.log('[ENV] Loaded environment variables from .env file');
    } catch (err) {
        console.error('[ENV] Error parsing .env file:', err);
    }
}

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' })); // Allow large payloads for descriptors
app.use(express.static(path.join(__dirname)));

// File Paths
const FACES_FILE = path.join(__dirname, 'registered_faces.json');
const LOGS_FILE = path.join(__dirname, 'attendance_logs.json');
const CSV_FILE = path.join(__dirname, 'attendance.csv');

// --- Helper Functions ---
function readJSON(filePath) {
    if (!fs.existsSync(filePath)) return [];
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(content || '[]');
    } catch (err) {
        console.error(`Error reading ${filePath}:`, err);
        return [];
    }
}

function writeJSON(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 4), 'utf8');
    } catch (err) {
        console.error(`Error writing to ${filePath}:`, err);
    }
}

// --- REST Endpoints ---

// A. Get server config status (tells client if secure API proxy is available)
app.get('/api/config', (req, res) => {
    res.json({ hasToken: !!process.env.HF_TOKEN });
});

// B. Secure Hugging Face API proxy endpoint
app.post('/api/chat', async (req, res) => {
    const { modelId, systemPrompt, messages, temperature, maxTokens } = req.body;
    const token = process.env.HF_TOKEN;

    if (!token) {
        return res.status(500).json({ error: 'Server does not have an API token configured. Please check your HF_TOKEN environment variable.' });
    }

    const ENDPOINT = 'https://router.huggingface.co/v1/chat/completions';

    const chatMessages = [
        { role: 'system', content: systemPrompt || 'You are Lumina, a brilliant AI chatbot.' },
        ...messages.map(m => ({
            role: m.role === 'ai' ? 'assistant' : m.role,
            content: m.content
        }))
    ];

    const payload = {
        model: modelId,
        messages: chatMessages,
        temperature: parseFloat(temperature) || 0.7,
        max_tokens: parseInt(maxTokens) || 1024,
        stream: false
    };

    let attempts = 0;
    const maxAttempts = 5;

    while (attempts < maxAttempts) {
        try {
            const response = await fetch(ENDPOINT, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            if (response.ok) {
                const result = await response.json();
                const content = result?.choices?.[0]?.message?.content;
                if (content) {
                    return res.json({ content: content.trim() });
                }
                return res.status(500).json({ error: 'Received an incomplete response from Hugging Face.' });
            }

            if (response.status === 401 || response.status === 403) {
                return res.status(401).json({ error: 'Unauthorized. The server Hugging Face Token is invalid or revoked.' });
            }

            if (response.status === 402) {
                return res.status(402).json({ error: 'Server Hugging Face billing credits exhausted.' });
            }

            if (response.status === 429) {
                attempts++;
                console.warn(`[PROXY] Rate limited. Retrying ${attempts}/${maxAttempts}...`);
                await new Promise(r => setTimeout(r, 2000 * attempts));
                continue;
            }

            if (response.status === 503) {
                attempts++;
                let estTime = 15;
                try {
                    const errData = await response.json();
                    estTime = errData.estimated_time || 15;
                } catch (_) {}
                console.warn(`[PROXY] Model loading. Retrying in ${estTime}s (${attempts}/${maxAttempts})...`);
                await new Promise(r => setTimeout(r, Math.min(3000 * attempts, estTime * 1000)));
                continue;
            }

            const rawText = await response.text();
            return res.status(response.status).json({ error: `Hugging Face Error (${response.status}): ${rawText || response.statusText}` });

        } catch (err) {
            console.error(`[PROXY] Request error:`, err);
            if (attempts >= maxAttempts - 1) {
                return res.status(500).json({ error: `Backend proxy fetch error: ${err.message}` });
            }
            attempts++;
            await new Promise(r => setTimeout(r, 2500));
        }
    }

    res.status(504).json({ error: 'Hugging Face API gateway timed out after multiple retries.' });
});

// 1. Get all registered faces
app.get('/api/registered-faces', (req, res) => {
    const faces = readJSON(FACES_FILE);
    res.json(faces);
});

// 2. Register a new face descriptor
app.post('/api/register-face', (req, res) => {
    const { name, descriptor } = req.body;
    if (!name || !descriptor) {
        return res.status(400).json({ error: 'Name and descriptor are required!' });
    }

    const faces = readJSON(FACES_FILE);
    // Remove if already exists with same name to prevent duplicates
    const filteredFaces = faces.filter(f => f.name.toLowerCase() !== name.toLowerCase());
    filteredFaces.push({ name, descriptor });
    
    writeJSON(FACES_FILE, filteredFaces);
    console.log(`Registered face for: ${name}`);
    res.json({ success: true, message: `Successfully registered ${name}'s face descriptor!` });
});

// 3. Get attendance logs
app.get('/api/attendance', (req, res) => {
    const logs = readJSON(LOGS_FILE);
    res.json(logs);
});

// 4. Mark attendance
app.post('/api/attendance', (req, res) => {
    const { name } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'Name is required!' });
    }

    const logs = readJSON(LOGS_FILE);
    const now = new Date();
    const timestampStr = now.toLocaleString();

    // Check if marked present within last 5 minutes to prevent spamming logs
    const lockoutPeriod = 5 * 60 * 1000; // 5 minutes in milliseconds
    const isRecent = logs.some(log => {
        if (log.name.toLowerCase() !== name.toLowerCase()) return false;
        
        // Parse dateISO reliably; fallback to old timestamp format if dateISO isn't present
        const logTime = log.dateISO ? new Date(log.dateISO).getTime() : new Date(log.timestamp).getTime();
        return !isNaN(logTime) && (now.getTime() - logTime) < lockoutPeriod;
    });

    if (isRecent) {
        return res.json({ success: false, message: 'Attendance already marked recently!' });
    }

    const newLog = { name, timestamp: timestampStr, dateISO: now.toISOString() };
    logs.unshift(newLog); // Put new logs at start
    writeJSON(LOGS_FILE, logs);

    // Append to CSV File
    try {
        if (!fs.existsSync(CSV_FILE)) {
            fs.writeFileSync(CSV_FILE, 'Timestamp,Name,Status\n', 'utf8');
        }
        fs.appendFileSync(CSV_FILE, `"${timestampStr}","${name}","Present"\n`, 'utf8');
    } catch (err) {
        console.error('Error writing to CSV:', err);
    }

    console.log(`[ATTENDANCE] Marked present: ${name} at ${timestampStr}`);
    res.json({ success: true, message: `Attendance recorded for ${name}!`, log: newLog });
});

// Serve Lumina Chat as main index
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve Attendance System
app.get('/attendance', (req, res) => {
    res.sendFile(path.join(__dirname, 'attendance.html'));
});

// Start Server
app.listen(PORT, () => {
    const os = require('os');
    let localIP = 'localhost';
    const interfaces = os.networkInterfaces();
    for (const devName in interfaces) {
        const iface = interfaces[devName];
        for (let i = 0; i < iface.length; i++) {
            const alias = iface[i];
            if ((alias.family === 'IPv4' || alias.family === 4) && !alias.internal) {
                localIP = alias.address;
                break;
            }
        }
        if (localIP !== 'localhost') break;
    }

    console.log(`=============================================================`);
    console.log(`  Lumina Server started successfully!`);
    console.log(`  - Local Access:         http://localhost:${PORT}`);
    console.log(`  - Network Access:       http://${localIP}:${PORT}`);
    console.log(`  - Face Recognition UI:  http://localhost:${PORT}/attendance.html`);
    console.log(`  - Face Recognition Net: http://${localIP}:${PORT}/attendance.html`);
    console.log(`=============================================================`);
});
