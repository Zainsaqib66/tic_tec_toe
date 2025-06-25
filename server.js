// server.js
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs").promises;
const session = require("express-session");
const bcrypt = require("bcryptjs");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const SESSION_SECRET = process.env.SESSION_SECRET || "your-strong-secret";

// --- SESSION SETUP ---
const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, secure: false, sameSite: "lax" }
});
app.use(express.json());
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, "public")));

const wrap = mw => (socket, next) => mw(socket.request, {}, next);
io.use(wrap(sessionMiddleware));

// --- USER STORAGE ---
const USERS_FILE = path.join(__dirname, "users.json");
const activeUsers = new Set();

async function readUsers() {
  try {
    const txt = await fs.readFile(USERS_FILE, "utf8");
    return JSON.parse(txt);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}
async function writeUsers(users) {
  await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
}

// --- AUTH ROUTES ---
app.post("/api/register", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Username & password required" });
  const users = await readUsers();
  if (users.find(u => u.username === username)) {
    return res.status(400).json({ error: "Username taken" });
  }
  const hash = await bcrypt.hash(password, 10);
  users.push({ username, password: hash });
  await writeUsers(users);
  res.json({ success: true });
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  const users = await readUsers();
  const user = users.find(u => u.username === username);
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(400).json({ error: "Invalid credentials" });
  }
  if (activeUsers.has(username)) {
    return res.status(400).json({ error: "Already logged in" });
  }
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: "Session error" });
    req.session.username = username;
    activeUsers.add(username);
    res.json({ success: true, username });
  });
});

app.get("/api/me", (req, res) => {
  if (req.session.username) {
    res.json({ username: req.session.username });
  } else {
    res.status(401).json({ error: "Not authenticated" });
  }
});

app.post("/api/logout", (req, res) => {
  const user = req.session.username;
  if (user) {
    activeUsers.delete(user);
    req.session.destroy(() => res.json({ success: true }));
  } else {
    res.json({ success: true });
  }
});

// --- GAME & CHAT LOGIC ---
io.use((socket, next) => {
  socket.request.session.username ? next() : next(new Error("unauthorized"));
});

const WAIT_TIMEOUT = 20_000;
const waiting = { "3": null, "4": null };
const rooms = {};
const rematches = {};

function makeRoomId(a, b, g) {
  return [a, b].sort().join("<->") + "@" + g;
}

io.on("connection", socket => {
  socket.on("joinGame", ({ grid }) => {
    grid = String(grid);
    const other = waiting[grid];
    if (other && other.id !== socket.id) {
      clearTimeout(other.waitTimer);
      waiting[grid] = null;
      const room = makeRoomId(socket.id, other.id, grid);
      socket.join(room);
      other.join(room);
      rooms[room] = {
        grid: +grid,
        board: Array(+grid * +grid).fill(null),
        turn: 0,
        gameOver: false,
        players: [other, socket],
      };
      rooms[room].players.forEach((p, idx) => {
        p.emit("start", {
          room,
          grid: +grid,
          yourMark: idx === 0 ? "X" : "O",
          opponentMark: idx === 0 ? "O" : "X",
          turn: 0
        });
      });
    } else {
      waiting[grid] = socket;
      socket.emit("waitingOpponent");
      socket.waitTimer = setTimeout(() => {
        if (waiting[grid] === socket) {
          waiting[grid] = null;
          socket.emit("timeout");
        }
      }, WAIT_TIMEOUT);
    }
  });

  socket.on("cancelWait", ({ grid }) => {
    grid = String(grid);
    if (waiting[grid] === socket) {
      clearTimeout(socket.waitTimer);
      waiting[grid] = null;
      socket.emit("gotoMenu");
    }
  });

  socket.on("move", ({ room, idx }) => {
    const game = rooms[room];
    if (!game || game.gameOver) return;
    const you = game.players.findIndex(p => p.id === socket.id);
    if (you !== game.turn) return;
    const mark = you === 0 ? "X" : "O";
    if (!game.board[idx]) {
      game.board[idx] = mark;
      const g = game.grid;
      const lines = [];
      for (let i = 0; i < g; i++) {
        lines.push(
          Array.from({ length: g }, (_, j) => i * g + j),
          Array.from({ length: g }, (_, j) => j * g + i)
        );
      }
      lines.push(
        Array.from({ length: g }, (_, i) => i * g + i),
        Array.from({ length: g }, (_, i) => i * g + (g - 1 - i))
      );
      const winLine = lines.find(l => l.every(i => game.board[i] === mark));
      if (winLine) {
        game.gameOver = true;
        io.to(room).emit("gameover", { winner: mark, board: game.board, winLine });
        game.players.forEach(p => p.leave(room));
        return;
      }
      if (game.board.every(c => c !== null)) {
        game.gameOver = true;
        io.to(room).emit("gameover", { winner: null, board: game.board, winLine: [] });
        game.players.forEach(p => p.leave(room));
        return;
      }
      game.turn = 1 - game.turn;
      io.to(room).emit("update", { board: game.board, turn: game.turn });
    }
  });

  socket.on("chatMessage", ({ room, message }) => {
    const u = socket.request.session.username;
    io.to(room).emit("chatMessage", { username: u, message });
  });

  socket.on("rematchRequest", ({ room }) => {
    const game = rooms[room];
    if (!game || !game.gameOver) return;
    rematches[room] = rematches[room] || new Set();
    rematches[room].add(socket.id);
    const other = game.players.find(p => p.id !== socket.id);
    if (rematches[room].size === 1) {
      other.emit("opponentRematch");
    } else {
      game.board = Array(game.grid * game.grid).fill(null);
      game.turn = 0;
      game.gameOver = false;
      rematches[room].clear();
      game.players.forEach(p => p.join(room));
      game.players.forEach((p, idx) => {
        p.emit("rematchStart", { yourMark: idx === 0 ? "X" : "O", turn: 0 });
      });
    }
  });

  socket.on("backToMenu", ({ room }) => {
    const game = rooms[room];
    if (game) {
      const idx = game.players.findIndex(p => p.id === socket.id);
      game.players[1 - idx].emit("opponentBack");
      socket.emit("gotoMenu");
      game.players.forEach(p => p.leave(room));
      delete rooms[room];
    } else {
      socket.emit("gotoMenu");
    }
  });

  socket.on("exitGame", ({ room }) => {
    const game = rooms[room];
    if (!game) return;
    const idx = game.players.findIndex(p => p.id === socket.id);
    const other = game.players[1 - idx];
    other.emit("opponentExit", { winner: idx === 0 ? "O" : "X", board: game.board });
    socket.emit("gotoMenu");
    game.players.forEach(p => p.leave(room));
    delete rooms[room];
  });

  socket.on("disconnect", () => {
    const user = socket.request.session.username;
    if (user) activeUsers.delete(user);
    Object.keys(waiting).forEach(g => {
      if (waiting[g] === socket) {
        clearTimeout(socket.waitTimer);
        waiting[g] = null;
      }
    });
    for (const room of Object.keys(rooms)) {
      const game = rooms[room];
      const idx = game.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        game.players[1 - idx].emit("opponentLeft");
        game.players.forEach(p => p.leave(room));
        delete rooms[room];
        break;
      }
    }
  });
});

server.listen(3000, () => console.log("Server running on http://localhost:3000"));
