const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, "public")));

// ─── Game State ──────────────────────────────────────────────────────
const games = {}; // code -> { questions, players, phase, qi, answers, host }

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function broadcast(code, msg) {
  const game = games[code];
  if (!game) return;
  const data = JSON.stringify(msg);
  game.clients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(data);
  });
}

function getPlayerList(game) {
  return Object.entries(game.players).map(([id, name]) => ({ id, name }));
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

// ─── WebSocket ───────────────────────────────────────────────────────
wss.on("connection", (ws) => {
  let myCode = null;
  let myId = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      // HOST: Create game
      case "create": {
        const code = generateCode();
        games[code] = {
          questions: msg.questions,
          players: {},
          phase: "lobby",
          qi: 0,
          answers: {},
          clients: new Set([ws]),
          host: ws,
          timer: null,
        };
        myCode = code;
        ws.send(JSON.stringify({ type: "created", code }));
        break;
      }

      // PLAYER: Join game
      case "join": {
        const code = msg.code.toUpperCase().trim();
        const game = games[code];
        if (!game) {
          ws.send(JSON.stringify({ type: "error", message: "Game not found" }));
          return;
        }
        if (game.phase !== "lobby") {
          ws.send(JSON.stringify({ type: "error", message: "Game already in progress" }));
          return;
        }
        myCode = code;
        myId = "p_" + Math.random().toString(36).slice(2, 8);
        game.players[myId] = msg.name;
        game.clients.add(ws);
        ws.send(JSON.stringify({ type: "joined", playerId: myId }));
        broadcast(code, { type: "players", players: getPlayerList(game) });
        break;
      }

      // HOST: Start question
      case "start_question": {
        const game = games[myCode];
        if (!game || ws !== game.host) return;
        const qi = msg.qi !== undefined ? msg.qi : 0;
        game.qi = qi;
        game.phase = "question";
        game.answers[qi] = {};

        const q = game.questions[qi];
        broadcast(myCode, {
          type: "question",
          qi,
          total: game.questions.length,
          question: q.q,
          options: q.options,
          time: q.time,
        });

        // Server-side timer
        clearInterval(game.timer);
        let t = q.time;
        game.timer = setInterval(() => {
          t--;
          broadcast(myCode, { type: "tick", time: t });
          if (t <= 0) {
            clearInterval(game.timer);
            game.phase = "reveal";
            broadcast(myCode, {
              type: "reveal",
              correct: q.correct,
              answerCount: Object.keys(game.answers[qi] || {}).length,
            });
          }
        }, 1000);
        break;
      }

      // HOST: End question early
      case "end_early": {
        const game = games[myCode];
        if (!game || ws !== game.host) return;
        clearInterval(game.timer);
        game.phase = "reveal";
        const q = game.questions[game.qi];
        broadcast(myCode, {
          type: "reveal",
          correct: q.correct,
          answerCount: Object.keys(game.answers[game.qi] || {}).length,
        });
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
        if (!game || game.phase !== "question") return;
        if (!game.answers[game.qi]) game.answers[game.qi] = {};
        if (game.answers[game.qi][myId] !== undefined) return; // already answered
        game.answers[game.qi][myId] = msg.choice;
        broadcast(myCode, {
          type: "answer_count",
          count: Object.keys(game.answers[game.qi]).length,
          total: Object.keys(game.players).length,
        });
        break;
      }
    }
  });

  ws.on("close", () => {
    if (myCode && games[myCode]) {
      games[myCode].clients.delete(ws);
      // Clean up empty games after 5 min
      if (games[myCode].clients.size === 0) {
        clearInterval(games[myCode].timer);
        setTimeout(() => {
          if (games[myCode] && games[myCode].clients.size === 0) {
            delete games[myCode];
          }
        }, 300000);
      }
    }
  });
});

// ─── Start ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`QuizZone running on port ${PORT}`);
});
