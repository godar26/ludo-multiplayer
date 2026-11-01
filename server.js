'use strict';
/**
 * Serveur LudoTable pour Vercel.
 * Les salons sont persistés dans Upstash Redis et Socket.IO diffuse
 * les événements entre les instances Vercel via son adaptateur Redis.
 */
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const Redis = require('ioredis');
const { createAdapter } = require('@socket.io/redis-adapter');

if (!process.env.REDIS_URL) {
  throw new Error('REDIS_URL manquant : configurez l’URL TCP/TLS Upstash dans Vercel.');
}

const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  retryStrategy(times) { return Math.min(times * 250, 3000); },
});
const pubClient = redis;
const subClient = redis.duplicate();
for (const [name, client] of [['Redis', redis], ['Redis subscriber', subClient]]) {
  client.on('error', (error) => console.error(name + ' error:', error.message));
}

const server = http.createServer();
const io = new Server(server, {
  path: '/api/socket-io/socket.io',
  transports: ['websocket'],
  cors: { origin: true, methods: ['GET', 'POST'] },
});
io.adapter(createAdapter(pubClient, subClient));

const COLORS = ['red', 'green', 'blue', 'yellow'];
const START_OFFSET = { red: 0, green: 13, blue: 26, yellow: 39 };
const SAFE_CELLS = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
const TRACK_LENGTH = 51;
const FINAL_STEP = TRACK_LENGTH + 6 - 1;
const ROOM_TTL_SECONDS = 6 * 60 * 60;
const roomKey = (code) => 'ludotable:room:' + code;
const lockKey = (code) => 'ludotable:lock:' + code;

async function getRoom(code) {
  const value = await redis.get(roomKey(code));
  return value ? JSON.parse(value) : null;
}
async function saveRoom(room) {
  await redis.set(roomKey(room.code), JSON.stringify(room), 'EX', ROOM_TTL_SECONDS);
}
async function withRoomLock(code, callback) {
  const token = crypto.randomUUID();
  const key = lockKey(code);
  let acquired = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await redis.set(key, token, 'PX', 15000, 'NX') === 'OK') {
      acquired = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!acquired) throw new Error('Le salon est occupé. Réessayez dans un instant.');
  try {
    return await callback();
  } finally {
    await redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1, key, token
    );
  }
}
async function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = '';
    for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
    if (!(await redis.exists(roomKey(code)))) return code;
  }
  throw new Error('Impossible de générer un code de salon. Réessayez.');
}
function publicPlayer(player) {
  return { id: player.id, name: player.name, color: player.color, connected: player.connected, pawns: player.pawns };
}
function publicState(room) {
  return {
    code: room.code, status: room.status, players: room.players.map(publicPlayer),
    turnIndex: room.turnIndex, dice: room.dice, canRoll: room.canRoll,
    movablePawns: room.movablePawns, hostId: room.hostId,
    winner: room.winner || null, winnerName: room.winnerName || null,
  };
}
function addLog(room, message, type = 'info') {
  const entry = { message, type, ts: Date.now() };
  room.log.push(entry);
  if (room.log.length > 150) room.log.shift();
  io.to(room.code).emit('log_entry', entry);
}
function broadcastState(room) { io.to(room.code).emit('state_update', publicState(room)); }
function connectedPlayers(room) { return room.players.filter((player) => player.connected); }
function nextTurnIndex(room, fromIndex) {
  const count = room.players.length;
  let index = fromIndex;
  for (let i = 0; i < count; i++) {
    index = (index + 1) % count;
    if (room.players[index] && room.players[index].connected) return index;
  }
  return fromIndex;
}
function globalCell(color, step) {
  if (step < 0 || step >= TRACK_LENGTH) return null;
  return (START_OFFSET[color] + step) % 52;
}
function computeMovablePawns(room, player) {
  const movable = [];
  player.pawns.forEach((step, index) => {
    if (step === -1) {
      if (room.dice === 6) movable.push(index);
    } else if (step < FINAL_STEP && step + room.dice <= FINAL_STEP) movable.push(index);
  });
  return movable;
}
function checkWinner(player) { return player.pawns.every((step) => step === FINAL_STEP); }
function passTurn(room) {
  room.turnIndex = nextTurnIndex(room, room.turnIndex);
  room.dice = null;
  room.canRoll = true;
  room.movablePawns = [];
}
function colorLabel(color) {
  return { red: 'Rouge', green: 'Vert', blue: 'Bleu', yellow: 'Jaune' }[color] || color;
}
function endGameIfAbandoned(room) {
  const alive = connectedPlayers(room);
  if (room.status === 'playing' && alive.length < 2) {
    room.status = 'finished';
    const winner = alive[0] || null;
    room.winner = winner ? winner.color : null;
    room.winnerName = winner ? winner.name : null;
    addLog(room, winner
      ? 'Partie interrompue : ' + winner.name + ' remporte la partie (les autres joueurs ont quitté).'
      : 'Partie interrompue : tous les joueurs ont quitté le salon.', 'system');
    io.to(room.code).emit('game_over', { winner: room.winner, winnerName: room.winnerName, reason: 'abandon' });
    broadcastState(room);
    return true;
  }
  return false;
}
function cleanName(value) { return String(value || '').trim().slice(0, 16) || 'Joueur'; }
function reportError(socket, error) {
  console.error('Socket event error:', error);
  socket.emit('error_message', error && error.message ? error.message : 'Une erreur serveur est survenue.');
}

io.on('connection', (socket) => {
  const run = (callback) => async (payload = {}) => {
    try { await callback(payload || {}); }
    catch (error) { reportError(socket, error); }
  };

  socket.on('create_room', run(async ({ name } = {}) => {
    const code = await generateRoomCode();
    const room = {
      code, hostId: socket.id, status: 'lobby', players: [], turnIndex: 0,
      dice: null, canRoll: true, movablePawns: [], log: [], winner: null, winnerName: null,
    };
    await withRoomLock(code, async () => {
      await saveRoom(room);
      await joinRoom(socket, room, cleanName(name));
    });
    socket.emit('room_created', { code });
  }));

  socket.on('join_room', run(async ({ code, name } = {}) => {
    const roomCode = String(code || '').trim().toUpperCase();
    await withRoomLock(roomCode, async () => {
      const room = await getRoom(roomCode);
      if (!room) throw new Error("Ce salon n'existe pas.");
      if (room.status !== 'lobby') throw new Error('Cette partie a déjà démarré.');
      if (room.players.length >= 4) throw new Error('Ce salon est complet (4 joueurs max).');
      await joinRoom(socket, room, cleanName(name));
    });
  }));

  async function joinRoom(sock, room, name) {
    const color = COLORS[room.players.length];
    room.players.push({ id: sock.id, name, color, connected: true, pawns: [-1, -1, -1, -1] });
    sock.data.roomCode = room.code;
    await sock.join(room.code);
    addLog(room, name + ' a rejoint le salon (couleur ' + colorLabel(color) + ').', 'system');
    await saveRoom(room);
    broadcastState(room);
  }

  socket.on('start_game', run(async ({ code } = {}) => {
    const roomCode = String(code || '').trim().toUpperCase();
    await withRoomLock(roomCode, async () => {
      const room = await getRoom(roomCode);
      if (!room) return;
      if (room.hostId !== socket.id) throw new Error("Seul l'hôte peut démarrer la partie.");
      if (room.players.length < 2) throw new Error('Il faut au moins 2 joueurs pour commencer.');
      room.status = 'playing';
      room.turnIndex = 0;
      addLog(room, 'La partie commence ! Bonne chance à tous.', 'system');
      await saveRoom(room);
      io.to(room.code).emit('game_started');
      broadcastState(room);
    });
  }));

  socket.on('roll_dice', run(async ({ code } = {}) => {
    const roomCode = String(code || '').trim().toUpperCase();
    await withRoomLock(roomCode, async () => {
      const room = await getRoom(roomCode);
      if (!room || room.status !== 'playing') return;
      const player = room.players[room.turnIndex];
      if (!player || player.id !== socket.id) throw new Error("Ce n'est pas votre tour.");
      if (!room.canRoll) throw new Error("Vous devez d'abord déplacer un pion.");
      room.dice = 1 + Math.floor(Math.random() * 6);
      addLog(room, player.name + ' lance le dé et obtient un ' + room.dice + '.', room.dice === 6 ? 'six' : 'roll');
      room.movablePawns = computeMovablePawns(room, player);
      room.canRoll = false;
      if (room.movablePawns.length === 0) {
        addLog(room, player.name + " n'a aucun mouvement possible.", 'info');
        passTurn(room);
      }
      await saveRoom(room);
      broadcastState(room);
    });
  }));

  socket.on('move_pawn', run(async ({ code, pawnIndex } = {}) => {
    const roomCode = String(code || '').trim().toUpperCase();
    await withRoomLock(roomCode, async () => {
      const room = await getRoom(roomCode);
      if (!room || room.status !== 'playing') return;
      const player = room.players[room.turnIndex];
      if (!player || player.id !== socket.id) throw new Error("Ce n'est pas votre tour.");
      if (room.canRoll) throw new Error("Lancez d'abord le dé.");
      if (!Number.isInteger(pawnIndex) || !room.movablePawns.includes(pawnIndex)) {
        throw new Error('Ce pion ne peut pas être déplacé.');
      }
      const currentStep = player.pawns[pawnIndex];
      const newStep = currentStep === -1 ? 0 : currentStep + room.dice;
      player.pawns[pawnIndex] = newStep;
      let bonus = room.dice === 6;
      if (currentStep === -1) addLog(room, player.name + ' fait sortir un pion de sa base.', 'move');
      else if (newStep === FINAL_STEP) addLog(room, player.name + ' amène un pion à la maison !', 'home');
      else addLog(room, player.name + ' avance un pion de ' + room.dice + ' case(s).', 'move');

      const cell = globalCell(player.color, newStep);
      if (cell !== null && !SAFE_CELLS.has(cell)) {
        for (const opponent of room.players) {
          if (opponent.color === player.color) continue;
          opponent.pawns.forEach((opponentStep, opponentIndex) => {
            if (opponentStep === -1 || opponentStep >= TRACK_LENGTH) return;
            if (globalCell(opponent.color, opponentStep) === cell) {
              opponent.pawns[opponentIndex] = -1;
              bonus = true;
              addLog(room, player.name + ' capture un pion de ' + opponent.name + ', qui retourne à sa base !', 'capture');
            }
          });
        }
      }
      if (checkWinner(player)) {
        room.status = 'finished';
        room.winner = player.color;
        room.winnerName = player.name;
        addLog(room, player.name + ' (' + colorLabel(player.color) + ') remporte la partie !', 'win');
        await saveRoom(room);
        io.to(room.code).emit('game_over', { winner: player.color, winnerName: player.name, reason: 'victory' });
        broadcastState(room);
        return;
      }
      if (bonus) {
        room.dice = null;
        room.canRoll = true;
        room.movablePawns = [];
        addLog(room, player.name + ' rejoue !', 'info');
      } else passTurn(room);
      await saveRoom(room);
      broadcastState(room);
    });
  }));

  socket.on('send_chat', run(async ({ code, message } = {}) => {
    const roomCode = String(code || '').trim().toUpperCase();
    await withRoomLock(roomCode, async () => {
      const room = await getRoom(roomCode);
      if (!room) return;
      const player = room.players.find((entry) => entry.id === socket.id);
      if (!player) return;
      const chatText = String(message || '').trim().slice(0, 200);
      if (!chatText) return;
      addLog(room, player.name + ' : ' + chatText, 'chat');
      await saveRoom(room);
    });
  }));

  socket.on('leave_room', () => handleLeave(socket));
  socket.on('disconnect', () => handleLeave(socket));
});

async function handleLeave(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  try {
    await withRoomLock(code, async () => {
      const room = await getRoom(code);
      if (!room) return;
      const player = room.players.find((entry) => entry.id === socket.id);
      if (!player || !player.connected) return;
      player.connected = false;
      addLog(room, player.name + " s'est déconnecté.", 'system');
      if (room.status === 'lobby') {
        room.players = room.players.filter((entry) => entry.id !== socket.id);
        if (room.players.length === 0) {
          await redis.del(roomKey(code));
          return;
        }
        if (room.hostId === socket.id) room.hostId = room.players[0].id;
        await saveRoom(room);
        broadcastState(room);
        return;
      }
      if (endGameIfAbandoned(room)) {
        await saveRoom(room);
        return;
      }
      if (room.status === 'playing' && room.players[room.turnIndex] && room.players[room.turnIndex].id === socket.id) {
        addLog(room, 'Le tour de ' + player.name + ' est passé automatiquement.', 'system');
        passTurn(room);
      }
      await saveRoom(room);
      broadcastState(room);
    });
  } catch (error) {
    console.error('Leave room error:', error);
  }
}

module.exports = server;
