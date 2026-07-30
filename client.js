'use strict';

/**
 * Client LudoTable.
 * Ce fichier ne contient AUCUNE regle de jeu : il ne fait qu'afficher
 * l'etat envoye par le serveur et transmettre les intentions du joueur
 * (lancer le de, deplacer un pion). Le serveur reste seul juge.
 */

const socket = io();

// ---------------------------------------------------------------------------
// Constantes de rendu du plateau (doivent correspondre visuellement au
// decoupage des regles cote serveur : 52 cases communes + 6 cases de
// couloir prive par couleur + 4 zones de base).
// ---------------------------------------------------------------------------

const COLORS = ['red', 'green', 'blue', 'yellow'];
const START_OFFSET = { red: 0, green: 13, blue: 26, yellow: 39 };
const SAFE_INDICES = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
const TRACK_LENGTH = 51;
const FINAL_STEP = 56;

// Coordonnees [row, col] (0-14) des 52 cases de la piste commune, indice 0-51.
const TRACK_COORDS = [
  [6,1],[6,2],[6,3],[6,4],[6,5],
  [5,6],[4,6],[3,6],[2,6],[1,6],[0,6],
  [0,7],
  [0,8],[1,8],[2,8],[3,8],[4,8],[5,8],
  [6,9],[6,10],[6,11],[6,12],[6,13],
  [6,14],
  [7,14],
  [8,14],
  [8,13],[8,12],[8,11],[8,10],[8,9],
  [9,8],[10,8],[11,8],[12,8],[13,8],[14,8],
  [14,7],
  [14,6],
  [13,6],[12,6],[11,6],[10,6],[9,6],
  [8,5],[8,4],[8,3],[8,2],[8,1],[8,0],
  [7,0],
  [6,0],
];

const HOME_COORDS = {
  red: [[7,1],[7,2],[7,3],[7,4],[7,5],[7,6]],
  green: [[1,7],[2,7],[3,7],[4,7],[5,7],[6,7]],
  blue: [[7,13],[7,12],[7,11],[7,10],[7,9],[7,8]],
  yellow: [[13,7],[12,7],[11,7],[10,7],[9,7],[8,7]],
};

const BASE_SLOTS = {
  red: [[1,1],[1,4],[4,1],[4,4]],
  green: [[1,10],[1,13],[4,10],[4,13]],
  blue: [[10,10],[10,13],[13,10],[13,13]],
  yellow: [[10,1],[10,4],[13,1],[13,4]],
};

const CENTER_COORD = [7, 7];

const COLOR_LABEL = { red: 'Rouge', green: 'Vert', blue: 'Bleu', yellow: 'Jaune' };
const COLOR_HEX = { red: '#e5533d', green: '#3fa34d', blue: '#2f7fd1', yellow: '#eec13a' };

function globalCellFor(color, step) {
  if (step < 0 || step >= TRACK_LENGTH) return null;
  return (START_OFFSET[color] + step) % 52;
}

function coordFor(color, step) {
  if (step === -1) return null; // gere separement (slots de base)
  if (step < TRACK_LENGTH) return TRACK_COORDS[globalCellFor(color, step)];
  if (step < FINAL_STEP) return HOME_COORDS[color][step - TRACK_LENGTH];
  return CENTER_COORD;
}

// ---------------------------------------------------------------------------
// Etat local
// ---------------------------------------------------------------------------

let myName = '';
let roomCode = null;
let latestState = null;
let boardBuilt = false;
let lastDiceShown = null;

// ---------------------------------------------------------------------------
// References DOM
// ---------------------------------------------------------------------------

const screens = {
  home: document.getElementById('screen-home'),
  lobby: document.getElementById('screen-lobby'),
  game: document.getElementById('screen-game'),
};

const el = {
  inputName: document.getElementById('input-name'),
  btnCreate: document.getElementById('btn-create'),
  btnShowJoin: document.getElementById('btn-show-join'),
  joinPanel: document.getElementById('join-panel'),
  inputCode: document.getElementById('input-code'),
  btnJoin: document.getElementById('btn-join'),
  homeError: document.getElementById('home-error'),

  roomCodeValue: document.getElementById('room-code-value'),
  btnCopyCode: document.getElementById('btn-copy-code'),
  lobbyPlayers: document.getElementById('lobby-players'),
  lobbyHint: document.getElementById('lobby-hint'),
  btnStartGame: document.getElementById('btn-start-game'),
  btnLeaveLobby: document.getElementById('btn-leave-lobby'),

  gameRoomCode: document.getElementById('game-room-code'),
  turnIndicator: document.getElementById('turn-indicator'),
  board: document.getElementById('board'),
  playersPanel: document.getElementById('players-panel'),
  dice: document.getElementById('dice'),
  diceFace: document.getElementById('dice-face'),
  btnRoll: document.getElementById('btn-roll'),
  diceHint: document.getElementById('dice-hint'),
  logList: document.getElementById('log-list'),
  chatForm: document.getElementById('chat-form'),
  chatInput: document.getElementById('chat-input'),

  modal: document.getElementById('modal-gameover'),
  modalIcon: document.getElementById('modal-icon'),
  modalTitle: document.getElementById('modal-title'),
  modalText: document.getElementById('modal-text'),
  btnModalHome: document.getElementById('btn-modal-home'),

  toast: document.getElementById('toast'),
};

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.remove('active'));
  screens[name].classList.add('active');
}

function showError(target, message) {
  target.textContent = message;
  target.classList.remove('hidden');
}

let toastTimer = null;
function showToast(message) {
  el.toast.textContent = message;
  el.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 3200);
}

// ---------------------------------------------------------------------------
// Ecran accueil
// ---------------------------------------------------------------------------

el.btnShowJoin.addEventListener('click', () => {
  el.joinPanel.classList.toggle('hidden');
});

el.btnCreate.addEventListener('click', () => {
  el.homeError.classList.add('hidden');
  myName = el.inputName.value.trim();
  if (!myName) return showError(el.homeError, 'Merci de saisir un pseudo.');
  socket.emit('create_room', { name: myName });
});

el.btnJoin.addEventListener('click', () => {
  el.homeError.classList.add('hidden');
  myName = el.inputName.value.trim();
  const code = el.inputCode.value.trim().toUpperCase();
  if (!myName) return showError(el.homeError, 'Merci de saisir un pseudo.');
  if (!code) return showError(el.homeError, 'Merci de saisir un code de salon.');
  socket.emit('join_room', { code, name: myName });
});

el.inputCode.addEventListener('input', () => {
  el.inputCode.value = el.inputCode.value.toUpperCase();
});

socket.on('room_created', ({ code }) => {
  roomCode = code;
});

socket.on('error_message', (message) => {
  if (screens.home.classList.contains('active')) {
    showError(el.homeError, message);
  } else {
    showToast(message);
  }
});

// ---------------------------------------------------------------------------
// Ecran salon (lobby)
// ---------------------------------------------------------------------------

el.btnCopyCode.addEventListener('click', () => {
  if (!roomCode) return;
  navigator.clipboard?.writeText(roomCode).then(() => showToast('Code copié !'));
});

el.btnStartGame.addEventListener('click', () => {
  socket.emit('start_game', { code: roomCode });
});

el.btnLeaveLobby.addEventListener('click', () => {
  window.location.reload();
});

function renderLobby(state) {
  roomCode = state.code;
  el.roomCodeValue.textContent = state.code;
  el.gameRoomCode.textContent = state.code;

  el.lobbyPlayers.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    const p = state.players[i];
    const slot = document.createElement('div');
    slot.className = 'lobby-slot' + (p ? '' : ' empty');
    if (p) {
      slot.innerHTML = `
        <span class="dot" style="background:${COLOR_HEX[p.color]}"></span>
        <span>${escapeHtml(p.name)}</span>
        ${p.id === state.hostId ? '<span class="host-tag">Hôte</span>' : ''}
      `;
    } else {
      slot.textContent = 'En attente…';
    }
    el.lobbyPlayers.appendChild(slot);
  }

  const isHost = state.hostId === socket.id;
  const enoughPlayers = state.players.length >= 2;
  el.btnStartGame.disabled = !(isHost && enoughPlayers);
  el.btnStartGame.classList.toggle('hidden', !isHost);

  if (!enoughPlayers) {
    el.lobbyHint.textContent = 'En attente d\'autres joueurs (minimum 2)…';
  } else if (isHost) {
    el.lobbyHint.textContent = `${state.players.length}/4 joueurs prêts. Vous pouvez lancer la partie.`;
  } else {
    el.lobbyHint.textContent = `${state.players.length}/4 joueurs prêts. En attente que l'hôte lance la partie…`;
  }
}

// ---------------------------------------------------------------------------
// Ecran de jeu — construction du plateau (une seule fois)
// ---------------------------------------------------------------------------

function buildBoard() {
  el.board.innerHTML = '';
  boardBuilt = true;

  // Zones de base
  COLORS.forEach((color) => {
    const zone = document.createElement('div');
    zone.className = `base-zone ${color}`;
    const inner = document.createElement('div');
    inner.className = 'base-inner';
    for (let i = 0; i < 4; i++) {
      const slot = document.createElement('div');
      slot.className = 'base-slot';
      inner.appendChild(slot);
    }
    zone.appendChild(inner);
    el.board.appendChild(zone);
  });

  // Cases de la piste commune
  TRACK_COORDS.forEach(([row, col], idx) => {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.style.gridRow = row + 1;
    cell.style.gridColumn = col + 1;
    if (SAFE_INDICES.has(idx)) cell.classList.add('safe');
    // Teinte discrete des cases de depart de chaque couleur
    for (const color of COLORS) {
      if (idx === START_OFFSET[color]) cell.classList.add(`path-${color}`);
    }
    el.board.appendChild(cell);
  });

  // Couloirs prives (home stretch)
  COLORS.forEach((color) => {
    HOME_COORDS[color].forEach(([row, col]) => {
      const cell = document.createElement('div');
      cell.className = `cell home-${color}`;
      cell.style.gridRow = row + 1;
      cell.style.gridColumn = col + 1;
      el.board.appendChild(cell);
    });
  });

  // Centre (arrivee)
  const center = document.createElement('div');
  center.className = 'center-home';
  center.innerHTML = `
    <svg viewBox="0 0 100 100" preserveAspectRatio="none">
      <polygon points="0,0 50,50 100,0" fill="${COLOR_HEX.green}" />
      <polygon points="100,0 50,50 100,100" fill="${COLOR_HEX.blue}" />
      <polygon points="100,100 50,50 0,100" fill="${COLOR_HEX.yellow}" />
      <polygon points="0,100 50,50 0,0" fill="${COLOR_HEX.red}" />
    </svg>
  `;
  el.board.appendChild(center);

  // Conteneur des pions (positionnement absolu par-dessus la grille)
  const pawnLayer = document.createElement('div');
  pawnLayer.id = 'pawn-layer';
  pawnLayer.style.position = 'absolute';
  pawnLayer.style.inset = '0';
  el.board.appendChild(pawnLayer);
}

// Calcule une position (en %) avec un leger decalage si plusieurs pions
// partagent la meme case, pour eviter qu'ils se superposent totalement.
function cellCenterPercent(row, col) {
  const size = 100 / 15;
  return { left: (col + 0.5) * size, top: (row + 0.5) * size };
}

function renderPawns(state) {
  const layer = document.getElementById('pawn-layer');
  if (!layer) return;
  layer.innerHTML = '';

  const myColor = getMyColor(state);
  const isMyTurn = state.status === 'playing' && state.players[state.turnIndex]?.id === socket.id;

  // Regrouper les pions par case affichee pour gerer les decalages visuels
  const occupancy = new Map();

  state.players.forEach((player) => {
    player.pawns.forEach((step, pawnIdx) => {
      let coord, key;
      if (step === -1) {
        coord = BASE_SLOTS[player.color][pawnIdx];
        key = `base-${player.color}-${pawnIdx}`;
      } else {
        coord = coordFor(player.color, step);
        key = step === FINAL_STEP ? `home-${player.color}` : `cell-${coordFor(player.color, step).join('-')}`;
      }
      if (!occupancy.has(key)) occupancy.set(key, []);
      occupancy.get(key).push({ player, pawnIdx, coord });
    });
  });

  occupancy.forEach((group) => {
    group.forEach((item, i) => {
      const { player, pawnIdx, coord } = item;
      const pos = cellCenterPercent(coord[0], coord[1]);

      // Petit decalage en cercle si plusieurs pions partagent la case
      if (group.length > 1) {
        const angle = (i / group.length) * Math.PI * 2;
        pos.left += Math.cos(angle) * 2.1;
        pos.top += Math.sin(angle) * 2.1;
      }

      const pawn = document.createElement('div');
      pawn.className = `pawn color-${player.color}`;
      pawn.style.left = pos.left + '%';
      pawn.style.top = pos.top + '%';
      if (!player.connected) pawn.classList.add('disconnected');

      const isMovable =
        isMyTurn &&
        player.color === myColor &&
        state.movablePawns.includes(pawnIdx) &&
        state.players[state.turnIndex]?.id === socket.id;

      if (isMovable) {
        pawn.classList.add('movable');
        pawn.title = 'Cliquer pour déplacer ce pion';
        pawn.addEventListener('click', () => {
          socket.emit('move_pawn', { code: roomCode, pawnIndex: pawnIdx });
        });
      }

      layer.appendChild(pawn);
    });
  });
}

function getMyColor(state) {
  const me = state.players.find((p) => p.id === socket.id);
  return me ? me.color : null;
}

// ---------------------------------------------------------------------------
// Panneau joueurs / de / journal
// ---------------------------------------------------------------------------

function renderPlayersPanel(state) {
  el.playersPanel.innerHTML = '';
  state.players.forEach((p, idx) => {
    const homeCount = p.pawns.filter((s) => s === FINAL_STEP).length;
    const row = document.createElement('div');
    row.className = 'player-row';
    if (idx === state.turnIndex && state.status === 'playing') row.classList.add('active-turn');
    if (!p.connected) row.classList.add('offline');
    row.innerHTML = `
      <span class="dot" style="background:${COLOR_HEX[p.color]}"></span>
      <span class="p-name">${escapeHtml(p.name)}${p.id === socket.id ? ' (vous)' : ''}</span>
      <span class="p-progress">${homeCount}/4 🏠</span>
      <span class="p-status">${p.connected ? '' : 'déconnecté'}</span>
    `;
    el.playersPanel.appendChild(row);
  });
}

function renderDiceFace(value) {
  el.diceFace.innerHTML = '';
  const layout = {
    1: [5],
    2: [1, 9],
    3: [1, 5, 9],
    4: [1, 3, 7, 9],
    5: [1, 3, 5, 7, 9],
    6: [1, 3, 4, 6, 7, 9],
  };
  const active = new Set(layout[value] || []);
  for (let i = 1; i <= 9; i++) {
    const pip = document.createElement('span');
    pip.className = 'pip';
    pip.style.gridArea = `${Math.ceil(i / 3)} / ${((i - 1) % 3) + 1}`;
    pip.style.opacity = active.has(i) ? '1' : '0';
    el.diceFace.appendChild(pip);
  }
}

function renderDiceAndTurn(state) {
  const current = state.players[state.turnIndex];
  const isMyTurn = state.status === 'playing' && current?.id === socket.id;

  el.turnIndicator.classList.toggle('my-turn', isMyTurn);
  if (state.status === 'playing' && current) {
    el.turnIndicator.textContent = isMyTurn ? 'À vous de jouer !' : `Tour de ${current.name}`;
  }

  if (state.dice && state.dice !== lastDiceShown) {
    el.dice.classList.add('rolling');
    setTimeout(() => el.dice.classList.remove('rolling'), 550);
  }
  lastDiceShown = state.dice;
  renderDiceFace(state.dice || 0);

  el.btnRoll.disabled = !(isMyTurn && state.canRoll);
  if (!isMyTurn) {
    el.diceHint.textContent = state.status === 'playing' ? `En attente de ${current?.name}…` : '';
  } else if (state.canRoll) {
    el.diceHint.textContent = 'Cliquez pour lancer le dé.';
  } else if (state.movablePawns.length > 0) {
    el.diceHint.textContent = 'Choisissez un pion à déplacer sur le plateau.';
  } else {
    el.diceHint.textContent = 'Aucun mouvement possible…';
  }
}

el.btnRoll.addEventListener('click', () => {
  socket.emit('roll_dice', { code: roomCode });
});

el.chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = el.chatInput.value.trim();
  if (!text) return;
  socket.emit('send_chat', { code: roomCode, message: text });
  el.chatInput.value = '';
});

function appendLog(entry) {
  const line = document.createElement('div');
  line.className = `log-entry ${entry.type}`;
  line.textContent = entry.message;
  el.logList.appendChild(line);
  el.logList.scrollTop = el.logList.scrollHeight;
}

socket.on('log_entry', appendLog);

// ---------------------------------------------------------------------------
// Evenements principaux de partie
// ---------------------------------------------------------------------------

socket.on('game_started', () => {
  showScreen('game');
  if (!boardBuilt) buildBoard();
  el.logList.innerHTML = '';
});

socket.on('state_update', (state) => {
  latestState = state;

  if (state.status === 'lobby') {
    showScreen('lobby');
    renderLobby(state);
    return;
  }

  if (state.status === 'playing' || state.status === 'finished') {
    if (screens.game.classList.contains('active') === false && state.status === 'playing') {
      showScreen('game');
    }
    if (!boardBuilt) buildBoard();
    el.gameRoomCode.textContent = state.code;
    renderPlayersPanel(state);
    renderDiceAndTurn(state);
    renderPawns(state);
  }
});

socket.on('game_over', ({ winner, winnerName, reason }) => {
  el.modalIcon.textContent = reason === 'abandon' ? '⚠️' : '🏆';
  el.modalTitle.textContent = reason === 'abandon' ? 'Partie interrompue' : 'Victoire !';
  if (winnerName) {
    el.modalText.textContent =
      reason === 'abandon'
        ? `${winnerName} remporte la partie suite au départ des autres joueurs.`
        : `${winnerName} (${COLOR_LABEL[winner] || winner}) a mené ses 4 pions à la maison !`;
  } else {
    el.modalText.textContent = 'Tous les joueurs ont quitté le salon.';
  }
  el.modal.classList.remove('hidden');
});

el.btnModalHome.addEventListener('click', () => {
  window.location.reload();
});

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Reconnexion propre : si le socket tombe puis revient, on ne peut pas
// reprendre la partie (pas de systeme de session dans cette version) —
// on informe simplement l'utilisateur.
socket.on('connect', () => {
  if (roomCode && latestState && latestState.status !== 'lobby') {
    // Un rechargement de page reinitialise l'etat local ; rien a faire ici.
  }
});

window.addEventListener('beforeunload', () => {
  if (roomCode) socket.emit('leave_room');
});
