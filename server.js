const WebSocket = require('ws');
const PORT = process.env.PORT || 8081; // Use Render's PORT env var, or 8081 locally
const wss = new WebSocket.Server({ port: PORT });

// This object will store our active game sessions.
// Key: 6-digit code
// Value: {
//   tvWs: WebSocket,          // The WebSocket connection for the TV display
//   controllers: [{ws: WebSocket, id: string}, ...], // Array of controller WebSockets
//   status: {},               // The last known game status from the TV
//   settings: {               // The last known settings (interval, voice, pattern)
//     callIntervalSeconds: 3,
//     speechEnabled: true,
//     selectedVoiceURI: '',
//     customGamePatternIndices: []
//   },
//   queuedNumbers: []         // Numbers queued by controllers
// }
const sessions = {}; 

console.log('WebSocket server started on port 8081');

wss.on('connection', ws => {
    let currentSessionCode = null;
    let clientType = null; // 'tv' or 'controller'
    let controllerId = null; // Unique ID for this controller instance

    console.log('Client connected.');

    ws.on('message', message => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            console.error('Invalid JSON received:', message);
            return;
        }

        // Handle messages from the TV display
        if (data.type === 'registerTv') {
            // If this TV is already in a session, remove old entry.
            // (Shouldn't happen if TV always generates new code, but good for cleanup)
            for (const code in sessions) {
                if (sessions[code].tvWs === ws) {
                    delete sessions[code];
                    console.log(`Removed old TV session ${code}`);
                    break;
                }
            }

            const newCode = generateSixDigitCode();
            sessions[newCode] = {
                tvWs: ws,
                controllers: [],
                status: {
                    currentBall: null, calledBalls: [], availableBallsCount: 75,
                    isPlaying: false, message: '', countdown: 3, timestamp: Date.now()
                },
                settings: {
                    callIntervalSeconds: 3, speechEnabled: true,
                    selectedVoiceURI: '', customGamePatternIndices: []
                },
                queuedNumbers: []
            };
            currentSessionCode = newCode;
            clientType = 'tv';
            ws.send(JSON.stringify({ type: 'sessionCode', code: newCode }));
            console.log(`TV registered with code: ${newCode}`);

        } else if (data.type === 'tvStatusUpdate' && currentSessionCode && sessions[currentSessionCode] && clientType === 'tv') {
            // Update the session's status with what the TV reports
            sessions[currentSessionCode].status = data.status;
            // Optionally, forward status to connected controllers if they need to update their UI
            sessions[currentSessionCode].controllers.forEach(c => {
                if (c.ws.readyState === WebSocket.OPEN) {
                    c.ws.send(JSON.stringify({ type: 'tvStatus', status: data.status }));
                }
            });

        } else if (data.type === 'queuedNumbersUpdate' && currentSessionCode && sessions[currentSessionCode] && clientType === 'tv') {
            // TV reports its current queue
            sessions[currentSessionCode].queuedNumbers = data.queue;
            // Optionally, forward queue status to controllers if they need it
            sessions[currentSessionCode].controllers.forEach(c => {
                if (c.ws.readyState === WebSocket.OPEN) {
                    c.ws.send(JSON.stringify({ type: 'queuedNumbers', queue: data.queue }));
                }
            });

        } else if (data.type === 'tvInitialSettings' && currentSessionCode && sessions[currentSessionCode] && clientType === 'tv') {
             // TV sends its initial settings. Store them.
             sessions[currentSessionCode].settings = { ...sessions[currentSessionCode].settings, ...data.settings };
             // Broadcast these initial settings to any connected controllers
             sessions[currentSessionCode].controllers.forEach(c => {
                 if (c.ws.readyState === WebSocket.OPEN) {
                     c.ws.send(JSON.stringify({ type: 'initialSettings', settings: sessions[currentSessionCode].settings }));
                 }
             });

        // Handle messages from controllers
        } else if (data.type === 'joinSession') {
            const { code, controllerCustomId } = data;
            const session = sessions[code];
            if (session && session.tvWs && session.tvWs.readyState === WebSocket.OPEN) {
                // Check if already connected (prevents duplicate entries on refresh)
                const existingController = session.controllers.find(c => c.id === controllerCustomId);
                if (existingController) {
                    console.log(`Controller ${controllerCustomId} rejoining session ${code}`);
                    // Send current status and settings to rejoining controller
                    ws.send(JSON.stringify({ type: 'joined', code: code }));
                    ws.send(JSON.stringify({ type: 'tvStatus', status: session.status }));
                    ws.send(JSON.stringify({ type: 'initialSettings', settings: session.settings }));
                    ws.send(JSON.stringify({ type: 'queuedNumbers', queue: session.queuedNumbers }));
                } else if (session.controllers.length < 2) { // Max 2 controllers
                    session.controllers.push({ ws: ws, id: controllerCustomId });
                    currentSessionCode = code;
                    clientType = 'controller';
                    controllerId = controllerCustomId;
                    ws.send(JSON.stringify({ type: 'joined', code: code }));
                    // Send current TV status and settings to the new controller
                    ws.send(JSON.stringify({ type: 'tvStatus', status: session.status }));
                    ws.send(JSON.stringify({ type: 'initialSettings', settings: session.settings }));
                    ws.send(JSON.stringify({ type: 'queuedNumbers', queue: session.queuedNumbers }));
                    console.log(`Controller ${controllerCustomId} joined session ${code}`);
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: 'Session is full (max 2 controllers).' }));
                    console.log(`Join failed for ${controllerCustomId}: Session ${code} is full.`);
                }
            } else {
                ws.send(JSON.stringify({ type: 'error', message: 'Invalid code or TV not active.' }));
                console.log(`Join failed for ${controllerCustomId}: Invalid code ${code} or TV not active.`);
            }

        } else if (data.type === 'command' && currentSessionCode && sessions[currentSessionCode] && clientType === 'controller') {
            const session = sessions[currentSessionCode];
            if (session.tvWs.readyState === WebSocket.OPEN) {
                // Forward the command directly to the TV display
                session.tvWs.send(JSON.stringify({ type: 'command', command: data.command }));
                console.log(`Command '${data.command.type}' from ${controllerId} sent to TV in session ${currentSessionCode}`);
            } else {
                ws.send(JSON.stringify({ type: 'error', message: 'TV not connected.' }));
                console.warn(`Controller ${controllerId} tried to send command, but TV is not open in session ${currentSessionCode}`);
            }

        } else if (data.type === 'settingsUpdate' && currentSessionCode && sessions[currentSessionCode] && clientType === 'controller') {
            const session = sessions[currentSessionCode];
            // Update the session's settings with what the controller reports
            session.settings = { ...session.settings, ...data.settings };
            if (session.tvWs.readyState === WebSocket.OPEN) {
                // Forward the settings update to the TV display
                session.tvWs.send(JSON.stringify({ type: 'settingsUpdate', settings: data.settings }));
                console.log(`Settings update from ${controllerId} sent to TV in session ${currentSessionCode}`);
            } else {
                ws.send(JSON.stringify({ type: 'error', message: 'TV not connected.' }));
                console.warn(`Controller ${controllerId} tried to send settings, but TV is not open in session ${currentSessionCode}`);
            }

        } else if (data.type === 'queueNumbers' && currentSessionCode && sessions[currentSessionCode] && clientType === 'controller') {
            const session = sessions[currentSessionCode];
            // Update the session's queued numbers on the server
            // Ensure numbers are valid (1-75) and not already called on TV
            // (Note: TV will do final validation, this is a pre-check)
            const validNewNumbers = data.numbers.filter(num => 
                typeof num === 'number' && num >= 1 && num <= 75
            );
            session.queuedNumbers = [...session.queuedNumbers, ...validNewNumbers];
            
            if (session.tvWs.readyState === WebSocket.OPEN) {
                // Forward the updated queue to the TV display
                session.tvWs.send(JSON.stringify({ type: 'queueUpdate', queue: session.queuedNumbers }));
                console.log(`Queued numbers from ${controllerId} sent to TV in session ${currentSessionCode}`);
            } else {
                ws.send(JSON.stringify({ type: 'error', message: 'TV not connected.' }));
                console.warn(`Controller ${controllerId} tried to send queue, but TV is not open in session ${currentSessionCode}`);
            }
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected.');
        if (currentSessionCode && sessions[currentSessionCode]) {
            const session = sessions[currentSessionCode];
            if (clientType === 'tv') {
                console.log(`TV for session ${currentSessionCode} disconnected. Closing session.`);
                // Notify all connected controllers that the TV disconnected
                session.controllers.forEach(c => {
                    if (c.ws.readyState === WebSocket.OPEN) {
                        c.ws.send(JSON.stringify({ type: 'sessionEnded', message: 'TV disconnected.' }));
                        c.ws.close();
                    }
                });
                delete sessions[currentSessionCode]; // Clean up the session
            } else if (clientType === 'controller') {
                session.controllers = session.controllers.filter(c => c.ws !== ws);
                console.log(`Controller ${controllerId} disconnected from session ${currentSessionCode}. Remaining controllers: ${session.controllers.length}`);
                // Optionally notify TV that a controller disconnected
                if (session.tvWs && session.tvWs.readyState === WebSocket.OPEN) {
                    session.tvWs.send(JSON.stringify({ type: 'controllerDisconnected', controllerId: controllerId }));
                }
            }
        }
    });

    ws.on('error', error => {
        console.error('WebSocket Error:', error.message);
    });
});

function generateSixDigitCode() {
    let code;
    do {
        code = Math.floor(100000 + Math.random() * 900000).toString();
    } while (sessions[code]); // Ensure uniqueness
    return code;
}