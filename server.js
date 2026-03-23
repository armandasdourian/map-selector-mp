const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const MAPS = [
  'Ascent','Haven','Bind','Lotus','Split','Pearl',
  'Sunset','Breeze','Corrode','Abyss','Icebox','Fracture'
];

const AGENTS = [
  'Jett','Reyna','Raze','Phoenix','Yoru','Neon','Iso',
  'Sova','Breach','Skye','KAY/O','Fade','Gekko',
  'Omen','Brimstone','Astra','Viper','Harbor',
  'Killjoy','Cypher','Sage','Chamber','Deadlock','Vyse'
];

const rooms = new Map();

function genCode() {
  const c = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => c[Math.floor(Math.random() * c.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function shuffle(a) {
  a = [...a];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generatePlayerStats() {
  const duelists = ['Jett','Reyna','Raze','Phoenix','Neon','Iso','Yoru'];
  const inits = ['Sova','Breach','Skye','KAY/O','Fade','Gekko'];
  const controllers = ['Omen','Brimstone','Astra','Viper','Harbor'];
  const sentinels = ['Killjoy','Cypher','Sage','Chamber','Deadlock','Vyse'];

  const mainAgent = duelists[Math.floor(Math.random() * duelists.length)];
  const secAgent = inits[Math.floor(Math.random() * inits.length)];
  const thirdAgent = shuffle([...controllers, ...sentinels])[0];

  const comfort = shuffle([...MAPS]).slice(0, 3 + Math.floor(Math.random() * 2));
  const stats = {};

  MAPS.forEach(map => {
    const isComfort = comfort.includes(map);
    const isNew = map === 'Corrode';
    const isReworked = map === 'Breeze';

    const wr = isNew ? 30 + Math.floor(Math.random() * 15)
      : isComfort ? 52 + Math.floor(Math.random() * 14)
      : 34 + Math.floor(Math.random() * 18);
    const games = isNew ? 5 + Math.floor(Math.random() * 15)
      : isComfort ? 60 + Math.floor(Math.random() * 100)
      : 15 + Math.floor(Math.random() * 50);

    stats[map] = {
      wr,
      games,
      teamWr: Math.max(30, Math.min(70, wr + Math.floor(Math.random() * 10) - 5)),
      enemyWr: 42 + Math.floor(Math.random() * 16),
      teamPr: 5 + Math.floor(Math.random() * 10),
      enemyPr: 5 + Math.floor(Math.random() * 10),
      streak: isComfort && Math.random() > 0.7 ? 3 + Math.floor(Math.random() * 5) : 0,
      recent: Math.floor(Math.random() * 20),
      reworked: isReworked,
      isNew: isNew,
      agents: [
        { name: mainAgent, wr: Math.min(78, wr + 3 + Math.floor(Math.random() * 8)), kd: +(0.8 + Math.random() * 0.8).toFixed(1) },
        { name: secAgent, wr: Math.max(25, wr - 2 + Math.floor(Math.random() * 6)), kd: +(0.7 + Math.random() * 0.6).toFixed(1) },
        { name: thirdAgent, wr: Math.max(20, wr - 6 + Math.floor(Math.random() * 6)), kd: +(0.6 + Math.random() * 0.5).toFixed(1) }
      ]
    };
  });
  return stats;
}

function serialize(room) {
  const s = { ...room.state };
  if (room.system === 'mapAvoid' && !s.avoidCounts) {
    s.voters = Object.keys(s.avoids || {});
    delete s.avoids;
  }
  if (room.system === 'ow2Vote' && !s.weights) {
    s.voters = Object.keys(s.votes || {});
    delete s.votes;
  }
  if (room.system === 'curated' && !s.tally) {
    s.voters = Object.keys(s.votes || {});
    delete s.votes;
  }
  return {
    code: room.code,
    host: room.host,
    players: [...room.players.entries()].map(([id, p]) => ({ id, ...p })),
    system: room.system,
    phase: room.phase,
    state: s,
    config: room.config
  };
}

function broadcast(room) {
  io.to(room.code).emit('room-update', serialize(room));
}

function resolveVoteTally(s, room) {
  const tally = {};
  for (const maps of Object.values(s.votes)) {
    for (const m of maps) tally[m] = (tally[m] || 0) + 1;
  }
  s.tally = tally;
  let maxV = 0, winners = [];
  for (const [map, ct] of Object.entries(tally)) {
    if (ct > maxV) { maxV = ct; winners = [map]; }
    else if (ct === maxV) winners.push(map);
  }
  s.result = winners[Math.floor(Math.random() * winners.length)];
  room.phase = 'result';
}

function resolveRoulette(s, room) {
  const w = {};
  s.options.forEach(m => { w[m] = 1; });
  for (const m of Object.values(s.votes)) w[m] = (w[m] || 0) + 2;
  s.weights = w;
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (const [map, wt] of Object.entries(w)) {
    r -= wt;
    if (r <= 0) { s.result = map; break; }
  }
  if (!s.result) s.result = s.options[0];
  room.phase = 'result';
}

function resolveAvoids(s, room) {
  const avoidCounts = {};
  for (const maps of Object.values(s.avoids)) {
    for (const m of maps) avoidCounts[m] = (avoidCounts[m] || 0) + 1;
  }
  s.avoidCounts = avoidCounts;
  let remaining = MAPS.filter(m => !avoidCounts[m]);
  if (remaining.length === 0) {
    const minA = Math.min(...Object.values(avoidCounts));
    remaining = MAPS.filter(m => (avoidCounts[m] || 0) <= minA);
  }
  s.remaining = remaining;
  s.result = remaining[Math.floor(Math.random() * remaining.length)];
  room.phase = 'result';
}

io.on('connection', socket => {
  let roomCode = null;

  socket.on('create-room', ({ name }) => {
    if (roomCode) return;
    const code = genCode();
    const room = {
      code,
      host: socket.id,
      players: new Map([[socket.id, { name, team: 'a', isCaptain: true, stats: generatePlayerStats() }]]),
      system: null,
      phase: 'lobby',
      state: {},
      config: { poolSize: 7, maxAvoids: 2, curatedSize: 5, nudgeLevel: 0 }
    };
    rooms.set(code, room);
    socket.join(code);
    roomCode = code;
    socket.emit('joined', { code, playerId: socket.id });
    broadcast(room);
  });

  socket.on('join-room', ({ code, name }) => {
    if (roomCode) return;
    const c = (code || '').toUpperCase().trim();
    const room = rooms.get(c);
    if (!room) return socket.emit('error-msg', 'Room not found');
    if (room.players.size >= 10) return socket.emit('error-msg', 'Room full (10 max)');
    if (room.phase !== 'lobby') return socket.emit('error-msg', 'Game in progress');

    const aCount = [...room.players.values()].filter(p => p.team === 'a').length;
    const bCount = [...room.players.values()].filter(p => p.team === 'b').length;
    const team = aCount <= bCount ? 'a' : 'b';
    const needsCap = ![...room.players.values()].some(p => p.team === team && p.isCaptain);

    room.players.set(socket.id, { name, team, isCaptain: needsCap, stats: generatePlayerStats() });
    socket.join(c);
    roomCode = c;
    socket.emit('joined', { code: c, playerId: socket.id });
    broadcast(room);
  });

  socket.on('set-team', ({ playerId, team }) => {
    const room = rooms.get(roomCode);
    if (!room || room.host !== socket.id || room.phase !== 'lobby') return;
    const p = room.players.get(playerId);
    if (!p) return;
    p.team = team;
    p.isCaptain = false;
    if (![...room.players.values()].some(pl => pl.team === team && pl.isCaptain)) p.isCaptain = true;
    broadcast(room);
  });

  socket.on('set-captain', ({ playerId }) => {
    const room = rooms.get(roomCode);
    if (!room || room.host !== socket.id || room.phase !== 'lobby') return;
    const p = room.players.get(playerId);
    if (!p) return;
    for (const [, pl] of room.players) {
      if (pl.team === p.team) pl.isCaptain = false;
    }
    p.isCaptain = true;
    broadcast(room);
  });

  socket.on('update-config', cfg => {
    const room = rooms.get(roomCode);
    if (!room || room.host !== socket.id) return;
    Object.assign(room.config, cfg);
    broadcast(room);
  });

  socket.on('start-system', ({ system }) => {
    const room = rooms.get(roomCode);
    if (!room || room.host !== socket.id || room.phase !== 'lobby') return;

    room.system = system;
    room.phase = 'playing';

    switch (system) {
      case 'mapAvoid': {
        const maxA = room.config.maxAvoids || 2;
        room.state = { avoids: {}, maxAvoids: maxA, avoidCounts: null, remaining: null, result: null };
        break;
      }

      case 'ow2Vote': {
        const opts = shuffle(MAPS).slice(0, 3);
        room.state = { options: opts, votes: {}, weights: null, result: null };
        break;
      }

      case 'curated': {
        const cSize = room.config.curatedSize || 5;
        const pool = shuffle(MAPS).slice(0, cSize);
        room.state = { pool, votes: {}, tally: null, result: null };
        break;
      }

      case 'cs2Premier': {
        const hasA = [...room.players.values()].some(p => p.team === 'a');
        const hasB = [...room.players.values()].some(p => p.team === 'b');
        if (!hasA || !hasB) {
          room.system = null; room.phase = 'lobby'; room.state = {};
          socket.emit('error-msg', 'Both teams need at least 1 player for CS2 Premier');
          broadcast(room);
          return;
        }
        const poolSize = room.config.poolSize || 7;
        const pool = MAPS.slice(0, Math.min(poolSize, MAPS.length));
        let capA = null, capB = null;
        for (const [id, p] of room.players) {
          if (p.team === 'a' && p.isCaptain) capA = id;
          if (p.team === 'b' && p.isCaptain) capB = id;
        }
        if (!capA) {
          for (const [id, p] of room.players) {
            if (p.team === 'a') { p.isCaptain = true; capA = id; break; }
          }
        }
        if (!capB) {
          for (const [id, p] of room.players) {
            if (p.team === 'b') { p.isCaptain = true; capB = id; break; }
          }
        }
        const banOrder = [];
        for (let i = 0; i < pool.length - 1; i++) {
          banOrder.push(i % 2 === 0 ? capA : capB);
        }
        room.state = { pool, banned: [], banOrder, banIndex: 0, result: null };
        break;
      }

      default:
        room.system = null; room.phase = 'lobby'; room.state = {};
        break;
    }
    broadcast(room);
  });

  socket.on('action', data => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'playing') return;
    const s = room.state;

    switch (room.system) {
      case 'mapAvoid':
        if (data.action !== 'avoid' || !Array.isArray(data.maps)) return;
        if (s.avoids[socket.id]) return;
        s.avoids[socket.id] = data.maps.filter(m => MAPS.includes(m)).slice(0, s.maxAvoids);
        if (Object.keys(s.avoids).length >= room.players.size) {
          resolveAvoids(s, room);
        }
        break;

      case 'ow2Vote':
        if (data.action !== 'vote' || !s.options.includes(data.map)) return;
        s.votes[socket.id] = data.map;
        if (Object.keys(s.votes).length >= room.players.size) {
          resolveRoulette(s, room);
        }
        break;

      case 'curated':
        if (data.action !== 'vote' || !Array.isArray(data.maps)) return;
        if (s.votes[socket.id]) return;
        s.votes[socket.id] = data.maps.filter(m => s.pool.includes(m));
        if (Object.keys(s.votes).length >= room.players.size) {
          resolveVoteTally(s, room);
        }
        break;

      case 'cs2Premier':
        if (data.action !== 'ban') return;
        if (socket.id !== s.banOrder[s.banIndex]) return;
        if (s.banned.some(b => b.map === data.map) || !s.pool.includes(data.map)) return;
        s.banned.push({ map: data.map, by: socket.id });
        s.banIndex++;
        if (s.pool.filter(m => !s.banned.some(b => b.map === m)).length <= 1) {
          s.result = s.pool.find(m => !s.banned.some(b => b.map === m));
          room.phase = 'result';
        }
        break;
    }
    broadcast(room);
  });

  socket.on('reset', () => {
    const room = rooms.get(roomCode);
    if (!room || room.host !== socket.id) return;
    room.system = null;
    room.phase = 'lobby';
    room.state = {};
    broadcast(room);
  });

  socket.on('disconnect', () => {
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;

    room.players.delete(socket.id);

    if (room.players.size === 0) {
      rooms.delete(roomCode);
      return;
    }

    if (room.host === socket.id) {
      room.host = room.players.keys().next().value;
    }

    if (room.phase === 'playing') {
      const s = room.state;

      if (room.system === 'mapAvoid' && !s.avoidCounts) {
        delete s.avoids[socket.id];
        if (Object.keys(s.avoids).length >= room.players.size && room.players.size > 0) {
          resolveAvoids(s, room);
        }
      }
      if (room.system === 'ow2Vote' && !s.weights) {
        delete s.votes[socket.id];
        if (Object.keys(s.votes).length >= room.players.size && room.players.size > 0) {
          resolveRoulette(s, room);
        }
      }
      if (room.system === 'curated' && !s.tally) {
        delete s.votes[socket.id];
        if (Object.keys(s.votes).length >= room.players.size && room.players.size > 0) {
          resolveVoteTally(s, room);
        }
      }
      if (room.system === 'cs2Premier') {
        const idx = s.banOrder.indexOf(socket.id);
        if (idx >= 0) {
          const banTeam = idx % 2 === 0 ? 'a' : 'b';
          let replacement = null;
          for (const [id, p] of room.players) {
            if (p.team === banTeam) { replacement = id; break; }
          }
          if (replacement) {
            s.banOrder = s.banOrder.map(id => id === socket.id ? replacement : id);
          }
        }
      }
    }

    broadcast(room);
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log('');
  console.log('  VALORANT MAP SELECTOR // MULTIPLAYER');
  console.log('  http://localhost:' + PORT);
  console.log('');
});
