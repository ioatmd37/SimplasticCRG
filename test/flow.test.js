// End-to-end: real server + socket.io clients playing a full case.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { io } = require("socket.io-client");
const { cards } = require("../data/cards.json");

const PORT = 3999;
const URL = `http://localhost:${PORT}`;
let server;

before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, "..", "server", "index.js")], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((res) => server.stdout.once("data", res));
});
after(() => server.kill());

function client() {
  const s = io(URL, { transports: ["websocket"], forceNew: true });
  s.last = null;
  s.on("state", (v) => (s.last = v));
  s.call = (ev, data) => new Promise((res) => s.emit(ev, data, res));
  s.act = async (type, payload) => {
    const r = await s.call("action", { type, payload });
    await new Promise((r2) => setTimeout(r2, 30)); // let broadcasts land
    return r;
  };
  return s;
}

async function setupRoom(names, roles) {
  const socks = names.map(() => client());
  const created = await socks[0].call("create", { name: names[0] });
  assert.ok(created.ok, created.error);
  for (let i = 1; i < socks.length; i++) {
    const r = await socks[i].call("join", { code: created.code, name: names[i] });
    assert.ok(r.ok, r.error);
  }
  for (let i = 0; i < socks.length; i++) assert.ok((await socks[i].act("pickRole", { role: roles[i] })).ok);
  return { socks, code: created.code };
}

test("5-player full flow with hidden information", async () => {
  const roles = ["facilitator", "patient", "doctor", "scribe", "bias"];
  const { socks } = await setupRoom(["Fac", "Pat", "Doc", "Scr", "Bia"], roles);
  const [fac, pat, doc, scr, bia] = socks;
  const card = cards.find((c) => c.id === "G1C1");

  // A 6th player can join as the optional Observer; a 7th is rejected
  const code = fac.last.code;
  const obs = client();
  const joined = await obs.call("join", { code, name: "Six" });
  assert.ok(joined.ok, joined.error);
  assert.ok((await obs.call("action", { type: "pickRole", payload: { role: "observer" } })).ok);
  assert.equal((await obs.act("advance", { to: "next" })).ok, false, "observer has no control powers");
  const extra = client();
  assert.equal((await extra.call("join", { code, name: "Seven" })).ok, false);
  extra.close();

  // Role conflicts rejected
  assert.equal((await doc.act("pickRole", { role: "patient" })).ok, false);
  assert.equal((await doc.act("startGame")).ok, false, "only host/facilitator can start");
  assert.ok((await fac.act("startGame")).ok);
  assert.equal(fac.last.phase, "case");
  assert.equal((await doc.act("selectCase", { caseId: "G1C1" })).ok, false);
  assert.ok((await fac.act("selectCase", { caseId: "G1C1" })).ok);
  assert.ok((await fac.act("advance", { to: "next" })).ok);
  assert.equal(doc.last.phase, "stem");
  assert.equal(doc.last.caseView.stem, card.stem);
  assert.equal(doc.last.caseView.history.length, 0, "doctor sees no history rows yet");
  assert.equal(pat.last.caseView.history.length, card.history.length, "patient holds the info card");
  assert.equal(doc.last.caseView.expected, null);
  assert.equal(doc.last.caseView.title, null, "diagnosis title hidden from learners");
  assert.equal(fac.last.caseView.title, card.title, "facilitator sees the title");
  assert.equal(doc.last.caseView.no, 1);

  await fac.act("advance", { to: "next" }); // history
  assert.equal((await pat.act("ask", { text: "x" })).ok, false, "patient cannot ask");
  assert.ok((await doc.act("ask", { text: "ดูดนมเป็นอย่างไร" })).ok);
  const q = doc.last.questions[0];
  assert.equal((await doc.act("answer", { questionId: q.id, rowIdx: 1 })).ok, false, "doctor cannot answer");
  assert.ok((await pat.act("answer", { questionId: q.id, rowIdx: 1 })).ok);
  assert.deepEqual(doc.last.caseView.history.map((r) => r.a), [card.history[1].a]);
  await doc.act("ask", { text: "มีเลือดออกไหม" });
  await pat.act("answer", { questionId: doc.last.questions[1].id, noInfo: true });
  assert.equal(scr.last.questions[1].status, "noinfo");
  assert.ok((await bia.act("flag", { bias: "Anchoring", note: "ทีมเชื่อว่า isolated เร็วไป" })).ok);
  assert.equal((await doc.act("flag", { bias: "Anchoring" })).ok, false);

  await fac.act("advance", { to: "next" }); // exam
  assert.equal(doc.last.caseView.exam.length, 0);
  const thaiExam = await doc.act("ask", { kind: "exam", text: "ตรวจ palate" });
  assert.equal(thaiExam.ok, false, "exam requests must be medical English");
  assert.match(thaiExam.error, /medical English/);
  await doc.act("ask", { kind: "exam", text: "Inspect the hard and soft palate" });
  assert.equal((await pat.act("answer", { questionId: doc.last.questions[2].id, rowIdx: 2 })).ok, false, "patient cannot reveal PE");
  assert.ok((await fac.act("answer", { questionId: doc.last.questions[2].id, rowIdx: 2 })).ok);
  assert.equal(doc.last.caseView.exam[0].a, card.exam[2].a);
  assert.equal(pat.last.caseView.exam.length, 1);

  await fac.act("advance", { to: "next" }); // investigations
  assert.equal(doc.last.caseView.investigations[0].answer, null, "answers hidden before submit");
  assert.ok(fac.last.caseView.investigations[0].answer, "facilitator sees answers");
  await doc.act("toggleInvest", { idx: 0, reason: "ดู feeding" });
  await doc.act("toggleInvest", { idx: 6, reason: "" });
  assert.ok((await doc.act("submitInvest")).ok);
  assert.equal(doc.last.caseView.investigations[0].answer, card.investigations[0].answer);

  await fac.act("advance", { to: "next" }); // plpr
  assert.equal((await doc.act("plpr", { pl: "x", pr: "y" })).ok, false, "only scribe writes");
  await scr.act("plpr", { pl: "1. cleft lip", pr: "ทารก 5 วัน…" });
  assert.equal((await scr.act("submitPlpr")).ok, false, "Thai PR rejected on submit");
  await scr.act("plpr", { pr: "A 5-day-old female neonate with isolated unilateral cleft lip…" });
  assert.equal(doc.last.plpr.pl, "1. cleft lip");
  assert.equal(doc.last.caseView.expected, null);
  assert.ok((await scr.act("submitPlpr")).ok);
  assert.deepEqual(doc.last.caseView.expected.problemList, card.problemList);
  assert.ok((await fac.act("ratePlpr", { rating: 4 })).ok);

  await fac.act("advance", { to: "next" }); // timeout
  assert.equal(doc.last.caseView.s1s2, null);
  assert.equal((await scr.act("check", { idx: 0, value: true })).ok, false, "5p: scribe lacks bias power");
  assert.ok((await bia.act("check", { idx: 0, value: true })).ok);
  await bia.act("mnm", { text: "submucous cleft" });
  await fac.act("revealTimeout");
  assert.equal(doc.last.caseView.s1s2.trap, card.system1Trap);

  await fac.act("advance", { to: "next" }); // debrief
  assert.equal(doc.last.caseView.title, card.title, "title revealed at debrief");
  assert.equal(doc.last.caseView.debrief[0].a, null);
  await fac.act("debriefNext");
  assert.equal(doc.last.caseView.debrief[0].a, card.debrief[0].a);
  assert.equal(doc.last.caseView.debrief[1].a, null);
  assert.equal(doc.last.caseView.facultyNote, null);

  await fac.act("advance", { to: "next" }); // exit
  assert.equal((await doc.act("ticket", { oneLiner: "a" })).ok, false, "all three fields needed");
  assert.equal((await doc.act("ticket", { oneLiner: "ทารก", mnm: "m", trigger: "t" })).ok, false, "one-liner must be English");
  for (const s of socks) assert.ok((await s.act("ticket", { oneLiner: "one", mnm: "mnm", trigger: "trig" })).ok);
  assert.equal(doc.last.ticketCount, 5);
  assert.equal(Object.keys(doc.last.tickets).length, 1, "only own ticket before summary");

  await fac.act("advance", { to: "next" }); // summary
  const st = doc.last.stats;
  assert.equal(st.historyCovered, 1);
  assert.equal(st.examCovered, 1);
  assert.equal(st.lowPriorityChosen, 1, "CT/MRI option flagged as non-priority");
  assert.equal(Object.keys(doc.last.tickets).length, 5);
  assert.equal(doc.last.caseView.history.length, card.history.length);

  assert.ok((await fac.act("restart")).ok);
  assert.equal(doc.last.phase, "case");
  assert.equal(doc.last.questions.length, 0);
  assert.equal(obs.last.powers.control, false);
  obs.close();
  socks.forEach((s) => s.close());
});

test("4 players: scribe carries bias-monitor duties; lobby validation", async () => {
  const { socks } = await setupRoom(["A", "B", "C"], ["facilitator", "patient", "doctor"]);
  const [fac] = socks;
  assert.equal((await fac.act("startGame")).ok, false, "3 players cannot start");
  const d = client();
  await d.call("join", { code: fac.last.code, name: "D" });
  await d.act("pickRole", { role: "bias" });
  const r = await fac.act("startGame");
  assert.equal(r.ok, false, "scribe is required");
  assert.match(r.error, /Scribe/);
  await d.act("pickRole", { role: "scribe" });
  assert.ok((await fac.act("startGame")).ok);
  assert.ok(d.last.powers.bias, "scribe has bias power without a bias player");
  await fac.act("selectCase", { caseId: "random" });
  await fac.act("advance", { to: "next" });
  assert.ok((await d.act("flag", { bias: "Premature closure" })).ok);

  // Reconnect keeps the seat
  const pid = d.last.me.id;
  d.close();
  const d2 = client();
  assert.ok((await d2.call("resume", { code: fac.last.code, playerId: pid })).ok);
  await new Promise((r2) => setTimeout(r2, 30));
  assert.equal(d2.last.me.role, "scribe");
  [...socks, d2].forEach((s) => s.close());
});

test("lobby: ready toggle resets on role change and blocks with no role", async () => {
  const { socks } = await setupRoom(["A", "B", "C", "D"], ["facilitator", "patient", "doctor", "scribe"]);
  const [fac, , doc] = socks;
  assert.equal((await doc.act("toggleReady")).ok, true);
  assert.equal(doc.last.me.ready, true);
  assert.equal(doc.last.players.find((p) => p.name === "C").ready, true);
  // Picking a (or no) role clears readiness.
  assert.ok((await doc.act("pickRole", { role: "doctor" })).ok);
  assert.equal(doc.last.me.ready, false);
  await doc.act("toggleReady");
  assert.equal(doc.last.me.ready, true);
  await doc.act("pickRole", { role: null });
  assert.equal(doc.last.me.ready, false);
  assert.equal((await doc.act("toggleReady")).ok, false, "no role picked");
  // Only usable in the lobby.
  await doc.act("pickRole", { role: "doctor" });
  await fac.act("startGame");
  assert.equal((await doc.act("toggleReady")).ok, false, "lobby only");
  socks.forEach((s) => s.close());
});

test("card data: exam, PL and PR are medical English only", () => {
  const THAI = /[\u0E00-\u0E7F]/;
  for (const c of cards) {
    const texts = [...c.exam.flatMap((r) => [r.q, r.a]), ...c.problemList, c.problemRepresentation];
    for (const t of texts) assert.ok(!THAI.test(t), `${c.id}: ${t.slice(0, 50)}`);
    assert.ok(c.exam.length >= 8, `${c.id} exam rows`);
  }
});
