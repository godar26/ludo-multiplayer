'use strict';

/**
 * Serveur du jeu de Ludo multijoueur en ligne.
 * ------------------------------------------------------------------
 * Le serveur est la SOURCE UNIQUE DE VERITE : il possede l'etat complet
 * de chaque partie (position des pions, dé, joueur actif...) et valide
 * chaque action envoyee par les clients avant de la repercuter à tout
 * le monde. Aucun calcul de regle n'est fait cote client.
 */

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Constantes du plateau
// ---------------------------------------------------------------------------

// Ordre des couleurs = ordre d'attribution ET ordre physique dans le sens
// horaire sur le plateau (rouge en haut a gauche, vert en haut a droite,
// bleu en bas a droite, jaune en bas a gauche).
const COLORS = ['red', 'green', 'blue', 'yellow'];

// Decalage (en nombre de cases) entre la case de depart de chaque couleur
// sur la piste commune de 52 cases.
const START_OFFSET = { red: 0, green: 13, blue: 26, yellow: 39 };

// Cases "etoile" ou aucune capture n'est possible (depart de chaque couleur
// + 4 cases etoile intermediaires), indices sur la piste commune (0-51).
const SAFE_CELLS = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

const TRACK_LENGTH = 51;               // un pion parcourt les etapes 0 a 50 sur la piste commune
const HOME_STRETCH = 6;                // puis 6 cases de couloir prive (51 a 56)
const FINAL_STEP = TRACK_LENGTH + HOME_STRETCH - 1; // 56 = case centrale (arrivee)

const rooms = Object.create(null);

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans 0/O/1/I pour lisibilite
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms[code]);
  return code;
}

function publicPlayer(p) {
  return { id: p.id, name: p.name, color: p.color, connected: p.connected, pawns: p.pawns };
}

function publicState(room) {
  return {
    code: room.code,
    status: room.status,
    players: room.players.map(publicPlayer),
    turnIndex: room.turnIndex,
    dice: room.dice,
    canRoll: room.canRoll,
    movablePawns: room.movablePawns,
    hostId: room.hostId,
    winner: room.winner || null,
    winnerName: room.winnerName || null,
  };
}

function addLog(room, message, type = 'info') {
  const entry = { message, type, ts: Date.now() };
  room.log.push(entry);
  if (room.log.length > 150) room.log.shift();
  io.to(room.code).emit('log_entry', entry);
}

function broadcastState(room) {
  io.to(room.code).emit('state_update', publicState(room));
}

function connectedPlayers(room) {
  return room.players.filter((p) => p.connected);
}

function nextTurnIndex(room, fromIndex) {
  const n = room.players.length;
  let idx = fromIndex;
  for (let i = 0; i < n; i++) {
    idx = (idx + 1) % n;
    if (room.players[idx].connected) return idx;
  }
  return fromIndex;
}

// Convertit une "avancee" (step) sur la piste privee d'un joueur en case
// GLOBALE (0-51) de la piste commune. Retourne null si le pion est en base
// (step -1) ou dans son couloir prive (step >= TRACK_LENGTH).
function globalCell(color, step) {
  if (step < 0 || step >= TRACK_LENGTH) return null;
  return (START_OFFSET[color] + step) % 52;
}

function computeMovablePawns(room, player) {
  const movable = [];
  player.pawns.forEach((step, idx) => {
    if (step === -1) {
      if (room.dice === 6) movable.push(idx); // sortie de base uniquement sur un 6
    } else if (step < FINAL_STEP) {
      if (step + room.dice <= FINAL_STEP) movable.push(idx); // il faut le compte exact pour arriver
    }
  });
  return movable;
}

function checkWinner(player) {
  return player.pawns.every((s) => s === FINAL_STEP);
}

function passTurn(room) {
  room.turnIndex = nextTurnIndex(room, room.turnIndex);
  room.dice = null;
  room.canRoll = true;
  room.movablePawns = [];
}

function endGameIfAbandoned(room) {
  const alive = connectedPlayers(room);
  if (room.status === 'playing' && alive.length < 2) {
    room.status = 'finished';
    const winner = alive[0] || null;
    room.winner = winner ? winner.color : null;
    room.winnerName = winner ? winner.name : null;
    addLog(
      room,
      winner
        ? `Partie interrompue : ${winner.name} remporte la partie (les autres joueurs ont quitte).`
        : 'Partie interrompue : tous les joueurs ont quitte le salon.',
      'system'
    );
    io.to(room.code).emit('game_over', { winner: room.winner, winnerName: room.winnerName, reason: 'abandon' });
    broadcastState(room);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Socket.io
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  socket.on('create_room', ({ name } = {}) => {
    const cleanName = String(name || '').trim().slice(0, 16) || 'Joueur';
    const code = generateRoomCode();
    const room = {
      code,
      hostId: socket.id,
      status: 'lobby',
      players: [],
      turnIndex: 0,
      dice: null,
      canRoll: true,
      movablePawns: [],
      log: [],
      winner: null,
      winnerName: null,
    };
    rooms[code] = room;
    joinRoom(socket, room, cleanName);
    socket.emit('room_created', { code });
  });

  socket.on('join_room', ({ code, name } = {}) => {
    const room = rooms[String(code || '').trim().toUpperCase()];
    const cleanName = String(name || '').trim().slice(0, 16) || 'Joueur';
    if (!room) return socket.emit('error_message', "Ce salon n'existe pas.");
    if (room.status !== 'lobby') return socket.emit('error_message', 'Cette partie a deja demarre.');
    if (room.players.length >= 4) return socket.emit('error_message', 'Ce salon est complet (4 joueurs max).');
    joinRoom(socket, room, cleanName);
  });

  function joinRoom(sock, room, name) {
    const color = COLORS[room.players.length];
    const player = { id: sock.id, name, color, connected: true, pawns: [-1, -1, -1, -1] };
    room.players.push(player);
    sock.data.roomCode = room.code;
    sock.join(room.code);
    addLog(room, `${name} a rejoint le salon (couleur ${colorLabel(color)}).`, 'system');
    broadcastState(room);
  }

  socket.on('start_game', ({ code } = {}) => {
    const room = rooms[code];
    if (!room) return;
    if (room.hostId !== socket.id) return socket.emit('error_message', "Seul l'hote peut demarrer la partie.");
    if (room.players.length < 2) return socket.emit('error_message', 'Il faut au moins 2 joueurs pour commencer.');
    room.status = 'playing';
    room.turnIndex = 0;
    addLog(room, 'La partie commence ! Bonne chance a tous.', 'system');
    io.to(room.code).emit('game_started');
    broadcastState(room);
  });

  socket.on('roll_dice', ({ code } = {}) => {
    const room = rooms[code];
    if (!room || room.status !== 'playing') return;
    const player = room.players[room.turnIndex];
    if (!player || player.id !== socket.id) return socket.emit('error_message', "Ce n'est pas votre tour.");
    if (!room.canRoll) return socket.emit('error_message', "Vous devez d'abord deplacer un pion.");

    room.dice = 1 + Math.floor(Math.random() * 6);
    addLog(room, `${player.name} lance le de et obtient un ${room.dice}.`, room.dice === 6 ? 'six' : 'roll');

    const movable = computeMovablePawns(room, player);
    room.movablePawns = movable;
    room.canRoll = false;

    if (movable.length === 0) {
      addLog(room, `${player.name} n'a aucun mouvement possible.`, 'info');
      passTurn(room);
    }
    broadcastState(room);
  });

  socket.on('move_pawn', ({ code, pawnIndex } = {}) => {
    const room = rooms[code];
    if (!room || room.status !== 'playing') return;
    const player = room.players[room.turnIndex];
    if (!player || player.id !== socket.id) return socket.emit('error_message', "Ce n'est pas votre tour.");
    if (room.canRoll) return socket.emit('error_message', "Lancez d'abord le de.");
    if (!room.movablePawns.includes(pawnIndex)) return socket.emit('error_message', 'Ce pion ne peut pas etre deplace.');

    const currentStep = player.pawns[pawnIndex];
    const newStep = currentStep === -1 ? 0 : currentStep + room.dice;
    player.pawns[pawnIndex] = newStep;

    let bonus = room.dice === 6;

    if (currentStep === -1) {
      addLog(room, `${player.name} fait sortir un pion de sa base.`, 'move');
    } else if (newStep === FINAL_STEP) {
      addLog(room, `${player.name} amene un pion a la maison !`, 'home');
    } else {
      addLog(room, `${player.name} avance un pion de ${room.dice} case(s).`, 'move');
    }

    // Verification de capture (uniquement sur la piste commune, hors cases sures)
    const cell = globalCell(player.color, newStep);
    if (cell !== null && !SAFE_CELLS.has(cell)) {
      for (const opp of room.players) {
        if (opp.color === player.color) continue;
        opp.pawns.forEach((oStep, oIdx) => {
          if (oStep === -1 || oStep >= TRACK_LENGTH) return;
          if (globalCell(opp.color, oStep) === cell) {
            opp.pawns[oIdx] = -1;
            bonus = true;
            addLog(room, `${player.name} capture un pion de ${opp.name}, qui retourne a sa base !`, 'capture');
          }
        });
      }
    }

    if (checkWinner(player)) {
      room.status = 'finished';
      room.winner = player.color;
      room.winnerName = player.name;
      addLog(room, `${player.name} (${colorLabel(player.color)}) remporte la partie !`, 'win');
      io.to(room.code).emit('game_over', { winner: player.color, winnerName: player.name, reason: 'victory' });
      broadcastState(room);
      return;
    }

    if (bonus) {
      room.dice = null;
      room.canRoll = true;
      room.movablePawns = [];
      addLog(room, `${player.name} rejoue !`, 'info');
    } else {
      passTurn(room);
    }
    broadcastState(room);
  });

  socket.on('send_chat', ({ code, message } = {}) => {
    const room = rooms[code];
    if (!room) return;
    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;
    const text = String(message || '').trim().slice(0, 200);
    if (!text) return;
    addLog(room, `${player.name} : ${text}`, 'chat');
  });

  socket.on('leave_room', () => handleLeave(socket));
  socket.on('disconnect', () => handleLeave(socket));

  function handleLeave(sock) {
    const code = sock.data.roomCode;
    if (!code) return;
    const room = rooms[code];
    if (!room) return;
    const player = room.players.find((p) => p.id === sock.id);
    if (!player || !player.connected) return;
    player.connected = false;
    addLog(room, `${player.name} s'est deconnecte.`, 'system');

    if (room.status === 'lobby') {
      room.players = room.players.filter((p) => p.id !== sock.id);
      if (room.players.length === 0) {
        delete rooms[code];
        return;
      }
      if (room.hostId === sock.id) room.hostId = room.players[0].id;
      broadcastState(room);
      return;
    }

    if (endGameIfAbandoned(room)) return;

    if (room.status === 'playing' && room.players[room.turnIndex].id === sock.id) {
      addLog(room, `Le tour de ${player.name} est passe automatiquement.`, 'system');
      passTurn(room);
    }
    broadcastState(room);
  }
});

function colorLabel(color) {
  return { red: 'Rouge', green: 'Vert', blue: 'Bleu', yellow: 'Jaune' }[color] || color;
}

// Nettoyage periodique des salons vides ou abandonnes depuis longtemps
setInterval(() => {
  const now = Date.now();
  for (const code of Object.keys(rooms)) {
    const room = rooms[code];
    const anyoneConnected = room.players.some((p) => p.connected);
    const lastLog = room.log[room.log.length - 1];
    const idleTooLong = lastLog && now - lastLog.ts > 1000 * 60 * 60 * 6; // 6h
    if (!anyoneConnected && (room.players.length === 0 || idleTooLong)) delete rooms[code];
  }
}, 1000 * 60 * 30);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Serveur Ludo en ecoute sur le port ${PORT}`);
});
