const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const game = require("./game");

const PORT = Number(process.env.PORT) || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "..", "public")));

// Each socket joins its room channel; state is pushed per socket so each
// player receives only the view their role is allowed to see.
function broadcast(room) {
  for (const [, s] of io.sockets.sockets) {
    if (s.data.code === room.code) s.emit("state", game.viewFor(room, s.data.playerId));
  }
}

function bind(socket, room, player) {
  socket.data.code = room.code;
  socket.data.playerId = player.id;
  socket.join(room.code);
  player.connected = true;
}

io.on("connection", (socket) => {
  const reply = (cb, fn) => {
    try {
      const out = fn();
      if (typeof cb === "function") cb({ ok: true, ...out });
    } catch (err) {
      if (!(err instanceof game.GameError)) console.error(err);
      if (typeof cb === "function") cb({ ok: false, error: err instanceof game.GameError ? err.message : "เกิดข้อผิดพลาด" });
    }
  };

  socket.on("create", ({ name } = {}, cb) =>
    reply(cb, () => {
      const room = game.createRoom();
      let player;
      try {
        player = game.addPlayer(room, name);
      } catch (e) {
        game.rooms.delete(room.code);
        throw e;
      }
      bind(socket, room, player);
      broadcast(room);
      return { code: room.code, playerId: player.id };
    }),
  );

  socket.on("join", ({ code, name } = {}, cb) =>
    reply(cb, () => {
      const room = game.getRoom(code);
      if (!room) throw new game.GameError("ไม่พบห้องนี้");
      const player = game.addPlayer(room, name);
      bind(socket, room, player);
      broadcast(room);
      return { code: room.code, playerId: player.id };
    }),
  );

  socket.on("resume", ({ code, playerId } = {}, cb) =>
    reply(cb, () => {
      const room = game.getRoom(code);
      const player = room && room.players[playerId];
      if (!player) throw new game.GameError("เซสชันหมดอายุ");
      bind(socket, room, player);
      broadcast(room);
      return { code: room.code, playerId };
    }),
  );

  socket.on("action", ({ type, payload } = {}, cb) =>
    reply(cb, () => {
      const room = game.getRoom(socket.data.code);
      if (!room) throw new game.GameError("ไม่ได้อยู่ในห้อง");
      game.act(room, socket.data.playerId, type, payload);
      broadcast(room);
      return {};
    }),
  );

  socket.on("leave", (_, cb) =>
    reply(cb, () => {
      const room = game.getRoom(socket.data.code);
      if (room && room.phase === "lobby") {
        delete room.players[socket.data.playerId];
        if (room.hostId === socket.data.playerId) room.hostId = Object.keys(room.players)[0] || null;
        if (!room.hostId) game.rooms.delete(room.code);
        else broadcast(room);
      }
      socket.leave(socket.data.code);
      socket.data = {};
      return {};
    }),
  );

  socket.on("disconnect", () => {
    const room = game.getRoom(socket.data.code);
    const player = room && room.players[socket.data.playerId];
    if (!player) return;
    const stillHere = [...io.sockets.sockets.values()].some(
      (s) => s.id !== socket.id && s.data.playerId === player.id,
    );
    if (!stillHere) player.connected = false;
    broadcast(room);
  });
});

setInterval(() => game.sweep(), 10 * 60 * 1000).unref();

server.listen(PORT, () => console.log(`SimPlastic CRG running on http://localhost:${PORT}`));
