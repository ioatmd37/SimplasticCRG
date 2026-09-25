// Anonymous research data: only consenting players are forwarded, with no names or room codes.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { io } = require("socket.io-client");

const PORT = 3998;
const SINK_PORT = 3997;
const KEY = "test-ingest-key";
let server;
let sink;
const received = [];

before(async () => {
  sink = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ auth: req.headers.authorization, body: JSON.parse(body) });
      res.setHeader("Connection", "close");
      res.end("ok");
    });
  });
  await new Promise((r) => sink.listen(SINK_PORT, r));
  server = spawn(process.execPath, [path.join(__dirname, "..", "server", "index.js")], {
    env: { ...process.env, PORT: String(PORT), INGEST_URL: `http://localhost:${SINK_PORT}/ingest`, INGEST_KEY: KEY },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((res) => server.stdout.once("data", res));
});
after(() => {
  server.kill();
  sink.closeAllConnections();
  sink.close();
});

function client() {
  const s = io(`http://localhost:${PORT}`, { transports: ["websocket"], forceNew: true });
  s.last = null;
  s.on("state", (v) => (s.last = v));
  s.call = (ev, data) => new Promise((res) => s.emit(ev, data, res));
  s.act = async (type, payload) => {
    const r = await s.call("action", { type, payload });
    await new Promise((r2) => setTimeout(r2, 30));
    return r;
  };
  return s;
}
const settle = () => new Promise((r) => setTimeout(r, 200));

test("consenting players' ticket + feedback reach the data store anonymously; others don't", async (t) => {
  const names = ["Fac Name", "Pat Name", "Doc Name", "Scr Name"];
  const roles = ["facilitator", "patient", "doctor", "scribe"];
  const socks = names.map(() => client());
  t.after(() => socks.forEach((s) => s.close()));
  const { code } = await socks[0].call("create", { name: names[0] });
  for (let i = 1; i < 4; i++) await socks[i].call("join", { code, name: names[i] });
  for (let i = 0; i < 4; i++) await socks[i].act("pickRole", { role: roles[i] });
  const [fac, pat, doc, scr] = socks;

  assert.equal(doc.last.me.consent, null, "consent starts unanswered");
  await doc.act("setConsent", { agree: true });
  await pat.act("setConsent", { agree: false });
  assert.equal(doc.last.me.consent, true);
  assert.ok(fac.last.players.every((p) => !("consent" in p)), "others' consent choices are hidden");

  await fac.act("startGame");
  await fac.act("selectCase", { caseId: "G1C1" });
  for (let i = 0; i < 8; i++) await fac.act("advance", { to: "next" }); // -> exit
  assert.equal(fac.last.phase, "exit");
  const ticket = { oneLiner: "A neonate with cleft lip", mnm: "airway", trigger: "stridor" };
  for (const s of [doc, pat, scr]) assert.ok((await s.act("ticket", ticket)).ok);
  await fac.act("advance", { to: "next" }); // -> summary
  await doc.act("submitFeedback", { caseRating: 4, playersRating: 5, systemRating: 3, comment: "good" });
  await pat.act("submitFeedback", { caseRating: 2, playersRating: 2, systemRating: 2 });
  await settle();

  // Only the doctor consented: one ticket post and one feedback post, same row id.
  assert.equal(received.length, 2, JSON.stringify(received));
  assert.ok(received.every((r) => r.auth === `Bearer ${KEY}`));
  const [a, b] = received.map((r) => r.body);
  assert.equal(a.id, b.id);
  assert.match(a.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(a.ticket, ticket);
  assert.deepEqual(b.feedback, { caseRating: 4, playersRating: 5, systemRating: 3, comment: "good" });
  for (const r of [a, b]) {
    assert.equal(r.caseId, "G1C1");
    assert.equal(r.role, "doctor");
    const json = JSON.stringify(r);
    assert.ok(!names.some((n) => json.includes(n)), "no player names");
    assert.ok(!json.includes(code), "no room code");
  }

  // A new game gets a fresh anonymous id.
  await fac.act("restart");
  await fac.act("selectCase", { caseId: "G1C1" });
  for (let i = 0; i < 8; i++) await fac.act("advance", { to: "next" }); // -> exit
  await doc.act("ticket", ticket);
  await settle();
  assert.equal(received.length, 3);
  assert.notEqual(received[2].body.id, a.id);
});
