const PLAYER_SIZE = 64;

// Fixed arena dimensions - must match frontend
const ARENA_WIDTH = 1200;
const ARENA_HEIGHT = 600;
const MAX_SPAWN_ATTEMPTS = 100;

// Broadcast throttling
const BROADCAST_RATE = 50; // Broadcast every 50ms (20 times/sec)
let lastBroadcastTime = 0;
let broadcastPending = false;
let broadcastTimeout: ReturnType<typeof setTimeout> | null = null;

const players = new Map<any, any>();

// Timer state (server is source of truth)
let gameTimer = 20;
let gameRunning = false;
let gamePaused = false;
let timerInterval: ReturnType<typeof setInterval> | null = null;

function startTimer() {
    if (timerInterval) return; // Already running

    gameRunning = true;
    gamePaused = false;

    timerInterval = setInterval(() => {
        if (gamePaused) return; // Don't tick if paused

        gameTimer--;
        broadcastTimer();

        if (gameTimer <= 0) {
            stopTimer();
            gameTimer = 20;
            broadcastTimer();
        }
    }, 1000);

    broadcastTimer();
}

function stopTimer() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
    gameRunning = false;
    gamePaused = false;
    gameTimer = 20;
    broadcastTimer();
}

function pauseTimer() {
    gamePaused = true;
    broadcastTimer();
}

function resumeTimer() {
    gamePaused = false;
    broadcastTimer();
}

function broadcastTimer() {
    const timerState = {
        type: "timer:update",
        payload: {
            timer: gameTimer,
            running: gameRunning,
            paused: gamePaused,
        },
    };

    for (const ws of players.keys()) {
        ws.send(JSON.stringify(timerState));
    }
}

const PORT = process.env.PORT || 5000;

const server = Bun.serve({
    port: PORT,
    hostname: "0.0.0.0", // Bind to all interfaces for Railway

    fetch(req, server) {
        if (server.upgrade(req)) {
            return;
        }
        return new Response("WebSocket server running", { status: 200 });
    },

    websocket: {
        open(ws) {
            console.log("Client connected");
        },

        message(ws, message) {
            const data = JSON.parse(message.toString());

            if (data.type === "join") {
                const player = data.payload.player;
                
                // Position player based on infection status
                const placedPlayers = Array.from(players.values());
                
                if (player.isInfected) {
                    // Place infected players in the center
                    const CENTER_ZONE = {
                        x: ARENA_WIDTH / 2 - 100,
                        y: ARENA_HEIGHT / 2 - 75,
                        width: 200,
                        height: 150,
                    };
                    
                    let placed = false;
                    let attempts = 0;
                    
                    while (!placed && attempts < MAX_SPAWN_ATTEMPTS) {
                        const x = CENTER_ZONE.x + Math.random() * CENTER_ZONE.width;
                        const y = CENTER_ZONE.y + Math.random() * CENTER_ZONE.height;
                        
                        const tempPlayer = { ...player, x, y };
                        const overlaps = placedPlayers.some((p) => isOverlapping(tempPlayer, p));
                        
                        if (!overlaps) {
                            player.x = x;
                            player.y = y;
                            placed = true;
                        }
                        attempts++;
                    }
                    
                    if (!placed) {
                        // Fallback to center if no safe spot found
                        player.x = ARENA_WIDTH / 2 - PLAYER_SIZE / 2;
                        player.y = ARENA_HEIGHT / 2 - PLAYER_SIZE / 2;
                    }
                } else {
                    // Place regular players at edges/corners
                    const EDGE_MARGIN = 80;
                    
                    let placed = false;
                    let attempts = 0;
                    
                    while (!placed && attempts < MAX_SPAWN_ATTEMPTS) {
                        // Randomly choose an edge: 0=top, 1=bottom, 2=left, 3=right
                        const edge = Math.floor(Math.random() * 4);
                        let x: number, y: number;
                        
                        switch (edge) {
                            case 0: // Top edge
                                x = EDGE_MARGIN + Math.random() * (ARENA_WIDTH - 2 * EDGE_MARGIN - PLAYER_SIZE);
                                y = Math.random() * EDGE_MARGIN;
                                break;
                            case 1: // Bottom edge
                                x = EDGE_MARGIN + Math.random() * (ARENA_WIDTH - 2 * EDGE_MARGIN - PLAYER_SIZE);
                                y = ARENA_HEIGHT - EDGE_MARGIN - PLAYER_SIZE + Math.random() * EDGE_MARGIN;
                                break;
                            case 2: // Left edge
                                x = Math.random() * EDGE_MARGIN;
                                y = EDGE_MARGIN + Math.random() * (ARENA_HEIGHT - 2 * EDGE_MARGIN - PLAYER_SIZE);
                                break;
                            case 3: // Right edge
                            default:
                                x = ARENA_WIDTH - EDGE_MARGIN - PLAYER_SIZE + Math.random() * EDGE_MARGIN;
                                y = EDGE_MARGIN + Math.random() * (ARENA_HEIGHT - 2 * EDGE_MARGIN - PLAYER_SIZE);
                                break;
                        }
                        
                        const tempPlayer = { ...player, x, y };
                        const overlaps = placedPlayers.some((p) => isOverlapping(tempPlayer, p));
                        
                        if (!overlaps) {
                            player.x = x;
                            player.y = y;
                            placed = true;
                        }
                        attempts++;
                    }
                    
                    if (!placed) {
                        // Fallback to a corner if no safe spot found
                        player.x = EDGE_MARGIN;
                        player.y = EDGE_MARGIN;
                    }
                }
                
                players.set(ws, player);
                broadcastPlayersImmediate(); // Immediate for join events
                // Send current timer state to new player
                ws.send(
                    JSON.stringify({
                        type: "timer:update",
                        payload: {
                            timer: gameTimer,
                            running: gameRunning,
                            paused: gamePaused,
                        },
                    }),
                );
            }

            if (data.type === "game:start") {
                startTimer();
            }

            if (data.type === "game:stop") {
                stopTimer();
            }

            if (data.type === "player:gender") {
                const { playerId, gender } = data.payload;

                // Only allow gender change if game hasn't started
                if (gameRunning) return;

                // Update player's gender
                for (const player of players.values()) {
                    if (player.id === playerId) {
                        player.gender = gender;
                    }
                }

                broadcastPlayersImmediate(); // Immediate for gender change
            }

            if (data.type === "move") {
                const { dx, dy, isInfected } = data.payload;

                const player = players.get(ws);
                if (!player) return;

                // Apply movement
                player.x += dx;
                player.y += dy;

                // Clamp position to arena boundaries
                player.x = Math.max(
                    0,
                    Math.min(player.x, ARENA_WIDTH - PLAYER_SIZE),
                );
                player.y = Math.max(
                    0,
                    Math.min(player.y, ARENA_HEIGHT - PLAYER_SIZE),
                );

                // Sync infection state if client sends it
                if (typeof isInfected === "boolean") {
                    player.isInfected = isInfected;
                }

                // Reset collision state
                player.collidingWith = null;

                // Check collision with other players
                for (const [otherWs, otherPlayer] of players.entries()) {
                    if (otherWs === ws) continue;

                    if (isColliding(player, otherPlayer)) {
                        console.log(
                            `Collision: ${player.name} (Infected: ${player.isInfected}) ↔ ${otherPlayer.name} (Infected: ${otherPlayer.isInfected})`,
                        );

                        player.collidingWith = otherPlayer.id;
                        otherPlayer.collidingWith = player.id;

                        // Pause timer on collision
                        pauseTimer();
                    }
                }

                players.set(ws, player);
                broadcastPlayers();
            }

            if (data.type === "player:infect") {
                const { playerId } = data.payload;

                // Infect the target player
                for (const player of players.values()) {
                    if (player.id === playerId) {
                        player.isInfected = true;
                    }
                }

                resetAllPositions();
                broadcastPlayers("players:reset");

                // Resume timer after answering
                resumeTimer();
            }

            if (data.type === "answer:correct") {
                // Player answered correctly - just reset positions without infecting
                resetAllPositions();
                broadcastPlayers("players:reset");

                // Resume timer after answering
                resumeTimer();
            }

            if (data.type === "answer:feedback") {
                // Broadcast the answer feedback to all players
                const { playerId, playerName, isCorrect } = data.payload;

                for (const ws of players.keys()) {
                    ws.send(
                        JSON.stringify({
                            type: "answer:feedback",
                            payload: { playerId, playerName, isCorrect },
                        }),
                    );
                }
            }
        },

        close(ws) {
            players.delete(ws);
            broadcastPlayersImmediate(); // Immediate for disconnect events
            console.log("Client disconnected");
        },
    },
});

// Immediate broadcast (for important events like reset, join, disconnect)
function broadcastPlayersImmediate(type = "players:update") {
    const allPlayers = Array.from(players.values());

    for (const ws of players.keys()) {
        ws.send(JSON.stringify({ type, payload: allPlayers }));
    }
    lastBroadcastTime = Date.now();
}

// Throttled broadcast for movement updates
function broadcastPlayers(type = "players:update") {
    // For non-update types (reset, etc.), broadcast immediately
    if (type !== "players:update") {
        broadcastPlayersImmediate(type);
        return;
    }

    const now = Date.now();
    const timeSinceLastBroadcast = now - lastBroadcastTime;

    if (timeSinceLastBroadcast >= BROADCAST_RATE) {
        // Enough time has passed, broadcast immediately
        broadcastPlayersImmediate(type);
        broadcastPending = false;
        if (broadcastTimeout) {
            clearTimeout(broadcastTimeout);
            broadcastTimeout = null;
        }
    } else if (!broadcastPending) {
        // Schedule a broadcast for later
        broadcastPending = true;
        broadcastTimeout = setTimeout(() => {
            broadcastPlayersImmediate(type);
            broadcastPending = false;
            broadcastTimeout = null;
        }, BROADCAST_RATE - timeSinceLastBroadcast);
    }
    // If broadcast is already pending, do nothing (it will include latest state)
}

function resetAllPositions() {
    const placedPlayers: any[] = [];

    // Define spawn zones
    const CENTER_ZONE = {
        x: ARENA_WIDTH / 2 - 100,
        y: ARENA_HEIGHT / 2 - 75,
        width: 200,
        height: 150,
    };

    const EDGE_MARGIN = 80; // How far from edge to spawn regular players

    // Separate infected and regular players
    const allPlayers = Array.from(players.values());
    const infectedPlayers = allPlayers.filter((p) => p.isInfected);
    const regularPlayers = allPlayers.filter((p) => !p.isInfected);

    // Place infected players at center
    for (const player of infectedPlayers) {
        let attempts = 0;
        let placed = false;

        while (!placed && attempts < MAX_SPAWN_ATTEMPTS) {
            const x = CENTER_ZONE.x + Math.random() * CENTER_ZONE.width;
            const y = CENTER_ZONE.y + Math.random() * CENTER_ZONE.height;

            const tempPlayer = { ...player, x, y };

            const overlaps = placedPlayers.some((p) =>
                isOverlapping(tempPlayer, p),
            );

            if (!overlaps) {
                player.x = x;
                player.y = y;
                player.collidingWith = null;

                placedPlayers.push(player);
                placed = true;
            }

            attempts++;
        }

        if (!placed) {
            console.warn(
                `Failed to place infected player safely: ${player.name}`,
            );
        }
    }

    // Place regular players at edges (randomly choose which edge)
    for (const player of regularPlayers) {
        let attempts = 0;
        let placed = false;

        while (!placed && attempts < MAX_SPAWN_ATTEMPTS) {
            // Randomly choose an edge: 0=top, 1=bottom, 2=left, 3=right
            const edge = Math.floor(Math.random() * 4);
            let x: number, y: number;

            switch (edge) {
                case 0: // Top edge
                    x =
                        EDGE_MARGIN +
                        Math.random() *
                            (ARENA_WIDTH - 2 * EDGE_MARGIN - PLAYER_SIZE);
                    y = Math.random() * EDGE_MARGIN;
                    break;
                case 1: // Bottom edge
                    x =
                        EDGE_MARGIN +
                        Math.random() *
                            (ARENA_WIDTH - 2 * EDGE_MARGIN - PLAYER_SIZE);
                    y =
                        ARENA_HEIGHT -
                        EDGE_MARGIN -
                        PLAYER_SIZE +
                        Math.random() * EDGE_MARGIN;
                    break;
                case 2: // Left edge
                    x = Math.random() * EDGE_MARGIN;
                    y =
                        EDGE_MARGIN +
                        Math.random() *
                            (ARENA_HEIGHT - 2 * EDGE_MARGIN - PLAYER_SIZE);
                    break;
                case 3: // Right edge
                default:
                    x =
                        ARENA_WIDTH -
                        EDGE_MARGIN -
                        PLAYER_SIZE +
                        Math.random() * EDGE_MARGIN;
                    y =
                        EDGE_MARGIN +
                        Math.random() *
                            (ARENA_HEIGHT - 2 * EDGE_MARGIN - PLAYER_SIZE);
                    break;
            }

            const tempPlayer = { ...player, x, y };

            const overlaps = placedPlayers.some((p) =>
                isOverlapping(tempPlayer, p),
            );

            if (!overlaps) {
                player.x = x;
                player.y = y;
                player.collidingWith = null;

                placedPlayers.push(player);
                placed = true;
            }

            attempts++;
        }

        if (!placed) {
            console.warn(
                `Failed to place regular player safely: ${player.name}`,
            );
        }
    }
}

interface Player {
    id: string;
    x: number;
    y: number;
    isInfected: boolean;
    name?: string;
    gender?: string;
    collidingWith?: string | null;
}

function isColliding(a: Player, b: Player): boolean {
    const A_WIDTH = 24; // shorter width
    const A_HEIGHT = 40; // regular height

    const B_WIDTH = 24;
    const B_HEIGHT = 40;

    return (
        a.x < b.x + B_WIDTH &&
        a.x + A_WIDTH > b.x &&
        a.y < b.y + B_HEIGHT &&
        a.y + A_HEIGHT > b.y &&
        a.isInfected !== b.isInfected
    );
}

function isOverlapping(a: Player, b: Player): boolean {
    return (
        a.x < b.x + PLAYER_SIZE &&
        a.x + PLAYER_SIZE > b.x &&
        a.y < b.y + PLAYER_SIZE &&
        a.y + PLAYER_SIZE > b.y
    );
}

console.log(`Server running on port ${server.port}`);
