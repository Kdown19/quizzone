const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ─── Preset Questions ────────────────────────────────────────────────
let presetQuestions = [];
try {
  presetQuestions = JSON.parse(fs.readFileSync(path.join(__dirname, "questions.json"), "utf8"));
  console.log(`Loaded ${presetQuestions.length} preset questions`);
} catch (e) {
  console.log("No preset questions found");
}

app.get("/api/questions", (req, res) => {
  if (req.query.key !== "hostonly") return res.status(403).json({ error: "nope" });
  res.json(presetQuestions);
});

// ─── Game State ──────────────────────────────────────────────────────
// code -> { questions, players: {pid: name}, sockets: {pid: ws}, phase, qi,
//           answers, clients, host, hostKey, timer, timeLeft, cleanup }
const games = {};
const EMPTY_GAME_TTL = 30 * 60 * 1000; // keep a game alive 30 min after everyone leaves

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = "";
    for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (games[code]);
  return code;
}

function randomKey() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function isLive(ws) {
  return !!ws && ws.readyState === 1;
}

function sendTo(ws, msg) {
  if (isLive(ws)) ws.send(JSON.stringify(msg));
}

function broadcast(code, msg) {
  const game = games[code];
  if (!game) return;
  const data = JSON.stringify(msg);
  game.clients.forEach((ws) => {
    if (isLive(ws)) ws.send(data);
  });
}

function normName(s) {
  return String(s || "").trim().toLowerCase();
}

function getPlayerList(game) {
  return Object.entries(game.players).map(([id, name]) => ({
    id,
    name,
    connected: isLive(game.sockets[id]),
  }));
}

function broadcastPlayers(code) {
  const game = games[code];
  if (game) broadcast(code, { type: "players", players: getPlayerList(game) });
}

function getScores(game) {
  const scores = {};
  Object.keys(game.players).forEach((pid) => (scores[pid] = 0));
  for (let i = 0; i < game.questions.length; i++) {
    const ans = game.answers[i] || {};
    Object.entries(ans).forEach(([pid, choice]) => {
      if (choice === game.questions[i].correct) {
        scores[pid] = (scores[pid] || 0) + 100;
      }
    });
  }
  return Object.entries(scores)
    .map(([pid, score]) => ({ pid, name: game.players[pid], score }))
    .sort((a, b) => b.score - a.score);
}

function questionMsg(game, code, time) {
  const q = game.questions[game.qi];
  return {
    type: "question",
    qi: game.qi,
    total: game.questions.length,
    question: q.q,
    options: q.options,
    time,
    code,
  };
}

function revealMsg(game) {
  const q = game.questions[game.qi];
  return {
    type: "reveal",
    correct: q.correct,
    answerCount: Object.keys(game.answers[game.qi] || {}).length,
  };
}

function answerCountMsg(game) {
  return {
    type: "answer_count",
    count: Object.keys(game.answers[game.qi] || {}).length,
    total: Object.keys(game.players).length,
  };
}

// Put a (re)connecting client on whatever screen the game is currently on.
// pid = the player's id, or null for the host.
function syncState(ws, game, code, pid) {
  const mine = pid && game.answers[game.qi] ? game.answers[game.qi][pid] : undefined;
  switch (game.phase) {
    case "question":
      sendTo(ws, questionMsg(game, code, game.timeLeft));
      if (pid && mine !== undefined) sendTo(ws, { type: "already_answered", choice: mine });
      if (!pid) sendTo(ws, answerCountMsg(game));
      break;
    case "reveal":
      sendTo(ws, questionMsg(game, code, 0));
      sendTo(ws, { ...revealMsg(game), yourChoice: mine });
      break;
    case "scoreboard":
      sendTo(ws, { type: "scoreboard", scores: getScores(game), qi: game.qi, total: game.questions.length });
      break;
    case "results":
      sendTo(ws, { type: "results", scores: getScores(game) });
      break;
    // "lobby": the joined / host_resumed message is enough
  }
}

// Replace an old socket (dead phone, old tab) with a new one
function retire(game, oldWs, newWs) {
  if (!oldWs || oldWs === newWs) return;
  sendTo(oldWs, { type: "kicked" });
  game.clients.delete(oldWs);
  try { oldWs.close(); } catch {}
}

function scheduleCleanup(code) {
  const game = games[code];
  if (!game) return;
  clearTimeout(game.cleanup);
  game.cleanup = setTimeout(() => {
    const g = games[code];
    if (g && g.clients.size === 0) {
      clearInterval(g.timer);
      delete games[code];
    }
  }, EMPTY_GAME_TTL);
}

// ─── WebSocket ───────────────────────────────────────────────────────
wss.on("connection", (ws) => {
  let myCode = null;
  let myId = null;

  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      // HOST: Create game
      case "create": {
        if (!Array.isArray(msg.questions) || msg.questions.length === 0) return;
        const code = generateCode();
        const hostKey = randomKey();
        games[code] = {
          questions: msg.questions,
          players: {},
          sockets: {},
          phase: "lobby",
          qi: 0,
          answers: {},
          clients: new Set([ws]),
          host: ws,
          hostKey,
          timer: null,
          timeLeft: 0,
          cleanup: null,
        };
        myCode = code;
        myId = null;
        sendTo(ws, { type: "created", code, hostKey });
        break;
      }

      // HOST: Get back control of a game after a refresh / dropped connection
      case "host_rejoin": {
        const code = String(msg.code || "").toUpperCase().trim();
        const game = games[code];
        if (!game || msg.hostKey !== game.hostKey) {
          sendTo(ws, { type: "error", reason: "not_found", message: "That game has ended" });
          return;
        }
        retire(game, game.host, ws);
        game.host = ws;
        game.clients.add(ws);
        clearTimeout(game.cleanup);
        myCode = code;
        myId = null;
        sendTo(ws, { type: "host_resumed", code, questions: game.questions, phase: game.phase, qi: game.qi });
        sendTo(ws, { type: "players", players: getPlayerList(game) });
        syncState(ws, game, code, null);
        break;
      }

      // PLAYER: Join (or rejoin) a game
      case "join": {
        const code = String(msg.code || "").toUpperCase().trim();
        const name = String(msg.name || "").trim().slice(0, 24);
        const game = games[code];
        if (!game) {
          sendTo(ws, { type: "error", reason: "not_found", message: "Game not found. Check the code." });
          return;
        }
        if (!name) {
          sendTo(ws, { type: "error", message: "Enter a name" });
          return;
        }

        // Rejoin: match by saved player id first, then by name (case-insensitive)
        let pid = null;
        let byId = false;
        if (msg.playerId && game.players[msg.playerId]) {
          pid = msg.playerId;
          byId = true;
        }
        if (!pid) {
          for (const [id, n] of Object.entries(game.players)) {
            if (normName(n) === normName(name)) { pid = id; break; }
          }
        }

        if (pid) {
          const old = game.sockets[pid];
          // In the lobby, a name match with someone still connected is probably a
          // different person who picked the same name.
          if (!byId && game.phase === "lobby" && isLive(old) && old !== ws) {
            sendTo(ws, {
              type: "error",
              message: "That name is taken. If it's you, wait 30 seconds and try again.",
            });
            return;
          }
          retire(game, old, ws);
          myCode = code;
          myId = pid;
          game.clients.add(ws);
          game.sockets[pid] = ws;
          clearTimeout(game.cleanup);
          sendTo(ws, {
            type: "joined",
            playerId: pid,
            name: game.players[pid],
            code,
            phase: game.phase,
            reconnected: true,
          });
          syncState(ws, game, code, pid);
          broadcastPlayers(code);
          return;
        }

        // Brand-new player: only allowed in the lobby
        if (game.phase !== "lobby") {
          sendTo(ws, {
            type: "error",
            message: "This game already started. If you were playing, use the exact same name you joined with.",
          });
          return;
        }
        pid = "p_" + Math.random().toString(36).slice(2, 8);
        game.players[pid] = name;
        game.sockets[pid] = ws;
        game.clients.add(ws);
        clearTimeout(game.cleanup);
        myCode = code;
        myId = pid;
        sendTo(ws, { type: "joined", playerId: pid, name, code, phase: "lobby" });
        broadcastPlayers(code);
        break;
      }

      // HOST: Start question
      case "start_question": {
        const game = games[myCode];
        if (!game || ws !== game.host) return;
        const qi = msg.qi !== undefined ? msg.qi : 0;
        if (qi < 0 || qi >= game.questions.length) return;
        game.qi = qi;
        game.phase = "question";
        game.answers[qi] = {};

        const q = game.questions[qi];
        game.timeLeft = q.time;
        broadcast(myCode, questionMsg(game, myCode, q.time));

        // Server-side timer
        clearInterval(game.timer);
        const code = myCode;
        game.timer = setInterval(() => {
          game.timeLeft--;
          broadcast(code, { type: "tick", time: game.timeLeft });
          if (game.timeLeft <= 0) {
            clearInterval(game.timer);
            game.phase = "reveal";
            broadcast(code, revealMsg(game));
          }
        }, 1000);
        break;
      }

      // HOST: End question early
      case "end_early": {
        const game = games[myCode];
        if (!game || ws !== game.host || game.phase !== "question") return;
        clearInterval(game.timer);
        game.timeLeft = 0;
        game.phase = "reveal";
        broadcast(myCode, revealMsg(game));
        break;
      }

      // HOST: Show scoreboard between questions
      case "show_scoreboard": {
        const game = games[myCode];
        if (!game || ws !== game.host) return;
        game.phase = "scoreboard";
        broadcast(myCode, { type: "scoreboard", scores: getScores(game), qi: game.qi, total: game.questions.length });
        break;
      }

      // HOST: Show results
      case "show_results": {
        const game = games[myCode];
        if (!game || ws !== game.host) return;
        game.phase = "results";
        broadcast(myCode, { type: "results", scores: getScores(game) });
        break;
      }

      // PLAYER: Submit answer
      case "answer": {
        const game = games[myCode];
        if (!game || game.phase !== "question" || !myId || !game.players[myId]) return;
        if (!Number.isInteger(msg.choice) || msg.choice < 0 || msg.choice > 3) return;
        if (!game.answers[game.qi]) game.answers[game.qi] = {};
        if (game.answers[game.qi][myId] !== undefined) return; // already answered
        game.answers[game.qi][myId] = msg.choice;
        broadcast(myCode, answerCountMsg(game));
        break;
      }
    }
  });

  ws.on("close", () => {
    const game = games[myCode];
    if (!game) return;
    game.clients.delete(ws);
    if (myId && game.sockets[myId] === ws) {
      delete game.sockets[myId];
      broadcastPlayers(myCode); // host sees who dropped
    }
    if (game.clients.size === 0) scheduleCleanup(myCode);
  });
});

// Heartbeat: phones that die never say goodbye, so ping everyone and drop
// sockets that stop answering (~30 s). That frees their name for a rejoin.
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 15000);

// ─── Start ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`QuizZone running on port ${PORT}`);
});
