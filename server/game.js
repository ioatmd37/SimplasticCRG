// Room state machine for the Plastic Surgery Clinical Reasoning card game.
// The server is authoritative: every action is validated by role + phase, and
// each player receives a view filtered so hidden card content never leaks.

const crypto = require("crypto");
const { cards, groups } = require("../data/cards.json");

const CARD_BY_ID = Object.fromEntries(cards.map((c) => [c.id, c]));

const ROLES = {
  facilitator: { label: "Facilitator / อาจารย์", required: true },
  patient: { label: "Patient / ผู้ป่วย-ผู้ปกครอง", required: true },
  doctor: { label: "Doctor / Examiner", required: true },
  scribe: { label: "Scribe / ผู้บันทึก", required: true },
  bias: { label: "Bias monitor", required: false },
  observer: { label: "Observer / ผู้สังเกตการณ์", required: false },
};

// Suggested minutes per phase (45–60 min session in the card bank's "วิธีใช้").
const PHASES = [
  { id: "lobby", label: "เข้าห้อง & เลือกบทบาท", minutes: 0 },
  { id: "case", label: "เลือกการ์ดเคส", minutes: 2 },
  { id: "stem", label: "Opening stem", minutes: 3 },
  { id: "history", label: "ซักประวัติ", minutes: 12 },
  { id: "exam", label: "ตรวจร่างกาย", minutes: 10 },
  { id: "investigations", label: "Investigation", minutes: 6 },
  { id: "plpr", label: "Problem list / PR", minutes: 7 },
  { id: "timeout", label: "Diagnostic time-out (S1/S2)", minutes: 5 },
  { id: "debrief", label: "Faculty debrief", minutes: 10 },
  { id: "exit", label: "Exit ticket", minutes: 3 },
  { id: "summary", label: "สรุปผล", minutes: 0 },
];
const PHASE_IDS = PHASES.map((p) => p.id);

const BIASES = [
  "Anchoring",
  "Premature closure",
  "Confirmation bias",
  "Availability bias",
  "Framing effect",
  "Search satisficing",
  "Overconfidence",
  "Diagnosis momentum",
];

// Physical examination, problem list and problem representation are medical English only.
const THAI = /[\u0E00-\u0E7F]/;
const requireEnglish = (text, what) => {
  if (THAI.test(text)) fail(`${what} ต้องเป็น medical English เท่านั้น (ห้ามมีภาษาไทย)`);
};

const MIN_PLAYERS = 4;
const MAX_PLAYERS = 6;

class GameError extends Error {}
const fail = (msg) => {
  throw new GameError(msg);
};

const rooms = new Map();

// Last visible action per role, drawn as speech bubbles / poses in the virtual exam room.
function stage(room, role, text, pose = "talk") {
  if (!role) return;
  room.stage[role] = { t: Date.now(), text: String(text || "").slice(0, 80), pose };
}

function newCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from(crypto.randomBytes(4), (b) => alphabet[b % alphabet.length]).join("");
  } while (rooms.has(code));
  return code;
}

function createRoom() {
  const room = {
    code: newCode(),
    hostId: null,
    phase: "lobby",
    phaseStartedAt: Date.now(),
    players: {}, // id -> { id, name, role, connected, joinedAt }
    caseId: null,
    questions: [], // { id, kind: history|exam, by, text, status: pending|answered|noinfo, rowIdx, t }
    revealed: { history: [], exam: [] },
    invest: { selected: {}, submitted: false }, // idx -> reason
    notes: "",
    plpr: { pl: "", pr: "", submitted: false, rating: null },
    flags: [], // { id, by, bias, note, t }
    timeout: { checks: {}, mnm: "", revealed: false },
    debrief: { shown: 0 },
    tickets: {}, // playerId -> { oneLiner, mnm, trigger }
    chat: [],
    stage: {}, // role -> { t, text, pose }
    touchedAt: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

const getRoom = (code) => rooms.get(String(code || "").toUpperCase()) || null;

function roleHolder(room, role) {
  return Object.values(room.players).find((p) => p.role === role) || null;
}

// With 4 players nobody takes "bias", so the scribe also carries the bias-monitor duties.
function hasPower(room, player, role) {
  if (player.role === role) return true;
  if (role === "bias" && player.role === "scribe" && !roleHolder(room, "bias")) return true;
  return false;
}

function isController(room, player) {
  // Facilitator runs the table; the host can stand in until a facilitator is chosen.
  return player.role === "facilitator" || (!roleHolder(room, "facilitator") && player.id === room.hostId);
}

function lobbyReady(room) {
  const ps = Object.values(room.players);
  const problems = [];
  if (ps.length < MIN_PLAYERS) problems.push(`ต้องมีผู้เล่นอย่างน้อย ${MIN_PLAYERS} คน (ตอนนี้ ${ps.length})`);
  for (const [r, def] of Object.entries(ROLES)) {
    if (def.required && !roleHolder(room, r)) problems.push(`ยังไม่มี ${def.label}`);
  }
  const noRole = ps.filter((p) => !p.role);
  if (noRole.length) problems.push(`ยังไม่ได้เลือกบทบาท: ${noRole.map((p) => p.name).join(", ")}`);
  return problems;
}

function addPlayer(room, name) {
  name = String(name || "").trim().slice(0, 24);
  if (!name) fail("กรุณาใส่ชื่อ");
  if (room.phase !== "lobby") fail("เกมเริ่มไปแล้ว เข้าร่วมไม่ได้");
  const ps = Object.values(room.players);
  if (ps.length >= MAX_PLAYERS) fail(`ห้องเต็มแล้ว (${MAX_PLAYERS} คน)`);
  if (ps.some((p) => p.name === name)) fail("ชื่อนี้มีในห้องแล้ว");
  const player = { id: crypto.randomUUID(), name, role: null, connected: true, joinedAt: Date.now() };
  room.players[player.id] = player;
  if (!room.hostId) room.hostId = player.id;
  return player;
}

function setPhase(room, phase) {
  room.phase = phase;
  room.phaseStartedAt = Date.now();
}

function card(room) {
  return room.caseId ? CARD_BY_ID[room.caseId] : null;
}

// ---- actions -------------------------------------------------------------

const actions = {
  pickRole(room, p, { role }) {
    if (room.phase !== "lobby") fail("เลือกบทบาทได้เฉพาะในล็อบบี้");
    if (role === null) {
      p.role = null;
      return;
    }
    if (!ROLES[role]) fail("ไม่รู้จักบทบาทนี้");
    const holder = roleHolder(room, role);
    if (holder && holder.id !== p.id) fail(`${holder.name} เลือกบทบาทนี้แล้ว`);
    p.role = role;
    stage(room, role, "พร้อม!", "act");
  },

  kick(room, p, { playerId }) {
    if (p.id !== room.hostId) fail("เฉพาะ host");
    if (room.phase !== "lobby") fail("นำผู้เล่นออกได้เฉพาะในล็อบบี้");
    if (playerId === p.id) fail("นำตัวเองออกไม่ได้");
    delete room.players[playerId];
  },

  startGame(room, p) {
    if (room.phase !== "lobby") fail("เกมเริ่มไปแล้ว");
    if (p.id !== room.hostId && p.role !== "facilitator") fail("เฉพาะ host หรือ facilitator");
    const problems = lobbyReady(room);
    if (problems.length) fail(problems.join(" • "));
    setPhase(room, "case");
  },

  selectCase(room, p, { caseId }) {
    if (room.phase !== "case") fail("เลือกเคสได้เฉพาะขั้นเลือกการ์ด");
    if (!isController(room, p)) fail("เฉพาะ facilitator");
    if (caseId === "random") {
      const pool = cards;
      caseId = pool[crypto.randomInt(pool.length)].id;
    }
    if (!CARD_BY_ID[caseId]) fail("ไม่พบการ์ด");
    room.caseId = caseId;
  },

  advance(room, p, { to }) {
    if (!isController(room, p)) fail("เฉพาะ facilitator เป็นผู้เปลี่ยนขั้น");
    const i = PHASE_IDS.indexOf(room.phase);
    const target = to === "back" ? PHASE_IDS[i - 1] : PHASE_IDS[i + 1];
    if (!target || target === "lobby") fail("ไปขั้นนั้นไม่ได้");
    if (room.phase === "case" && to !== "back" && !room.caseId) fail("ยังไม่ได้เลือกการ์ด");
    setPhase(room, target);
    stage(room, "facilitator", "▶ " + PHASES.find((x) => x.id === target).label, "act");
  },

  ask(room, p, { text, kind }) {
    const k = kind === "exam" ? "exam" : "history";
    if (room.phase !== k) fail(k === "exam" ? "ขอตรวจได้ในขั้นตรวจร่างกาย" : "ถามได้ในขั้นซักประวัติ");
    if (!hasPower(room, p, "doctor")) fail("เฉพาะ Doctor เป็นผู้ถาม/ขอตรวจ (ทีมส่งคำแนะนำทางแชทได้)");
    text = String(text || "").trim().slice(0, 300);
    if (!text) fail("พิมพ์คำถามก่อน");
    if (k === "exam") requireEnglish(text, "คำขอตรวจร่างกาย");
    room.questions.push({ id: crypto.randomUUID(), kind: k, by: p.id, text, status: "pending", rowIdx: null, t: Date.now() });
    stage(room, "doctor", text, "talk");
  },

  answer(room, p, { questionId, rowIdx, noInfo }) {
    const q = room.questions.find((x) => x.id === questionId);
    if (!q) fail("ไม่พบคำถาม");
    const owner = q.kind === "history" ? "patient" : "facilitator";
    if (p.role !== owner) fail(q.kind === "history" ? "เฉพาะผู้ป่วยเป็นผู้ตอบ" : "เฉพาะ facilitator เปิด finding");
    const rows = card(room)[q.kind];
    if (noInfo) {
      q.status = "noinfo";
      q.rowIdx = null;
      stage(room, owner, q.kind === "history" ? "ไม่แน่ใจเหมือนกัน…" : "No further finding", "talk");
      return;
    }
    rowIdx = Number(rowIdx);
    if (!Number.isInteger(rowIdx) || rowIdx < 0 || rowIdx >= rows.length) fail("แถวไม่ถูกต้อง");
    q.status = "answered";
    q.rowIdx = rowIdx;
    const list = room.revealed[q.kind];
    if (!list.includes(rowIdx)) list.push(rowIdx);
    stage(room, owner, q.kind === "history" ? rows[rowIdx].a : "✨ " + rows[rowIdx].q, q.kind === "history" ? "talk" : "act");
  },

  toggleInvest(room, p, { idx, reason }) {
    if (room.phase !== "investigations") fail("ไม่ใช่ขั้น investigation");
    if (!hasPower(room, p, "doctor") && !hasPower(room, p, "scribe")) fail("เฉพาะ Doctor/Scribe เลือก investigation");
    if (room.invest.submitted) fail("ส่งคำตอบแล้ว");
    idx = Number(idx);
    if (!card(room).investigations[idx]) fail("ไม่พบตัวเลือก");
    if (reason === null) delete room.invest.selected[idx];
    else room.invest.selected[idx] = String(reason || "").slice(0, 300);
  },

  submitInvest(room, p) {
    if (room.phase !== "investigations") fail("ไม่ใช่ขั้น investigation");
    if (!hasPower(room, p, "doctor")) fail("เฉพาะ Doctor เป็นผู้ยืนยันคำสั่ง");
    if (!Object.keys(room.invest.selected).length) fail("เลือกอย่างน้อย 1 ตัวเลือก");
    room.invest.submitted = true;
    stage(room, "doctor", "🧪 ยืนยันคำสั่ง investigation", "act");
  },

  notes(room, p, { text }) {
    if (!hasPower(room, p, "scribe")) fail("เฉพาะ Scribe แก้ไขบันทึก");
    room.notes = String(text || "").slice(0, 4000);
    stage(room, p.role, "✍️", "act");
  },

  plpr(room, p, { pl, pr }) {
    if (room.phase !== "plpr") fail("ไม่ใช่ขั้น PL/PR");
    if (!hasPower(room, p, "scribe")) fail("เฉพาะ Scribe เขียน PL/PR");
    if (room.plpr.submitted) fail("ส่งแล้ว");
    room.plpr.pl = String(pl ?? room.plpr.pl).slice(0, 3000);
    room.plpr.pr = String(pr ?? room.plpr.pr).slice(0, 1500);
    stage(room, "scribe", "✍️", "act");
  },

  submitPlpr(room, p) {
    if (room.phase !== "plpr") fail("ไม่ใช่ขั้น PL/PR");
    if (!hasPower(room, p, "scribe")) fail("เฉพาะ Scribe ส่ง PL/PR");
    if (!room.plpr.pl.trim() || !room.plpr.pr.trim()) fail("เขียนทั้ง Problem list และ one-liner ก่อนส่ง");
    requireEnglish(room.plpr.pl, "Problem list");
    requireEnglish(room.plpr.pr, "Problem representation");
    room.plpr.submitted = true;
    stage(room, "scribe", "📋 ส่ง PL/PR แล้ว!", "act");
  },

  ratePlpr(room, p, { rating }) {
    if (p.role !== "facilitator") fail("เฉพาะ facilitator");
    if (!room.plpr.submitted) fail("ทีมยังไม่ส่ง PL/PR");
    rating = Number(rating);
    if (![1, 2, 3, 4, 5].includes(rating)) fail("คะแนน 1–5");
    room.plpr.rating = rating;
  },

  flag(room, p, { bias, note }) {
    if (!hasPower(room, p, "bias")) fail("เฉพาะ Bias monitor");
    if (["lobby", "case", "summary"].includes(room.phase)) fail("ยังไม่อยู่ในช่วงเล่นเคส");
    if (!BIASES.includes(bias)) fail("เลือกชนิด bias");
    stage(room, p.role === "bias" ? "bias" : p.role, "🚩 " + bias, "act");
    room.flags.push({ id: crypto.randomUUID(), by: p.id, bias, note: String(note || "").slice(0, 300), phase: room.phase, t: Date.now() });
  },

  check(room, p, { idx, value }) {
    if (room.phase !== "timeout") fail("ไม่ใช่ขั้น time-out");
    if (!hasPower(room, p, "bias")) fail("เฉพาะ Bias monitor นำ checklist");
    if (!card(room).system2Checklist[idx]) fail("ไม่พบข้อ");
    room.timeout.checks[idx] = !!value;
  },

  mnm(room, p, { text }) {
    if (room.phase !== "timeout") fail("ไม่ใช่ขั้น time-out");
    if (!hasPower(room, p, "bias") && !hasPower(room, p, "scribe")) fail("เฉพาะ Bias monitor/Scribe");
    if (room.timeout.revealed) fail("เฉลยแล้ว");
    room.timeout.mnm = String(text || "").slice(0, 2000);
  },

  revealTimeout(room, p) {
    if (room.phase !== "timeout") fail("ไม่ใช่ขั้น time-out");
    if (p.role !== "facilitator") fail("เฉพาะ facilitator");
    room.timeout.revealed = true;
    stage(room, "facilitator", "🔓 เฉลย System 1 / System 2", "act");
  },

  debriefNext(room, p) {
    if (room.phase !== "debrief") fail("ไม่ใช่ขั้น debrief");
    if (p.role !== "facilitator") fail("เฉพาะ facilitator");
    room.debrief.shown = Math.min(room.debrief.shown + 1, card(room).debrief.length);
    stage(room, "facilitator", card(room).debrief[room.debrief.shown - 1].q, "talk");
  },

  ticket(room, p, { oneLiner, mnm, trigger }) {
    if (room.phase !== "exit") fail("ไม่ใช่ขั้น exit ticket");
    const clip = (s, n) => String(s || "").trim().slice(0, n);
    const t = { oneLiner: clip(oneLiner, 600), mnm: clip(mnm, 300), trigger: clip(trigger, 300), t: Date.now() };
    if (!t.oneLiner || !t.mnm || !t.trigger) fail("กรอกให้ครบทั้ง 3 ข้อ");
    requireEnglish(t.oneLiner, "One-liner (problem representation)");
    room.tickets[p.id] = t;
  },

  chat(room, p, { text }) {
    text = String(text || "").trim().slice(0, 300);
    if (!text) return;
    room.chat.push({ by: p.id, text, t: Date.now() });
    stage(room, p.role, text, "talk");
    if (room.chat.length > 200) room.chat.shift();
  },

  restart(room, p) {
    if (!isController(room, p)) fail("เฉพาะ facilitator");
    Object.assign(room, {
      caseId: null,
      questions: [],
      revealed: { history: [], exam: [] },
      invest: { selected: {}, submitted: false },
      notes: "",
      plpr: { pl: "", pr: "", submitted: false, rating: null },
      flags: [],
      timeout: { checks: {}, mnm: "", revealed: false },
      debrief: { shown: 0 },
      tickets: {},
      stage: {},
    });
    setPhase(room, "case");
  },
};

function act(room, playerId, type, payload = {}) {
  const p = room.players[playerId];
  if (!p) fail("ไม่พบผู้เล่นในห้องนี้");
  const fn = actions[type];
  if (!fn) fail("ไม่รู้จักคำสั่ง");
  fn(room, p, payload || {});
  room.touchedAt = Date.now();
}

// ---- views ---------------------------------------------------------------

function summaryStats(room, c) {
  const invest = c.investigations.map((row, i) => ({
    ...row,
    chosen: i in room.invest.selected,
    lowPriority: /ไม่ใช่ priority|ไม่ใช่ first|ไม่จำเป็น|ไม่ควร/.test(row.answer),
  }));
  return {
    historyCovered: room.revealed.history.length,
    historyTotal: c.history.length,
    examCovered: room.revealed.exam.length,
    examTotal: c.exam.length,
    questionsAsked: room.questions.filter((q) => q.kind === "history").length,
    examsRequested: room.questions.filter((q) => q.kind === "exam").length,
    lowPriorityChosen: invest.filter((x) => x.chosen && x.lowPriority).length,
    lowPriorityTotal: invest.filter((x) => x.lowPriority).length,
    checklistDone: Object.values(room.timeout.checks).filter(Boolean).length,
    checklistTotal: c.system2Checklist.length,
    flags: room.flags.length,
    tickets: Object.keys(room.tickets).length,
  };
}

function viewFor(room, playerId) {
  const me = room.players[playerId] || null;
  const c = card(room);
  const phaseIdx = PHASE_IDS.indexOf(room.phase);
  const past = (id) => phaseIdx >= PHASE_IDS.indexOf(id);
  const isFac = me && me.role === "facilitator";
  const done = room.phase === "summary";

  let caseView = null;
  if (c && past("stem")) {
    const rows = (kind, full) =>
      c[kind].map((r, i) => {
        const open = full || done || room.revealed[kind].includes(i);
        return { idx: i, q: r.q, a: open ? r.a : null, revealed: room.revealed[kind].includes(i) };
      });
    caseView = {
      id: c.id,
      title: c.title,
      groupName: c.groupName,
      level: c.level,
      bloom: c.bloom,
      image: c.image,
      stem: c.stem,
      learningFocus: past("debrief") || isFac ? c.learningFocus : null,
      // Row prompts are only shown to the card holder; others see what was unlocked.
      history: rows("history", isFac || (me && me.role === "patient")).filter(
        (r) => isFac || (me && me.role === "patient") || done || r.revealed,
      ),
      exam: rows("exam", isFac).filter((r) => isFac || done || r.revealed),
      investigations: past("investigations")
        ? c.investigations.map((r, i) => ({
            idx: i,
            option: r.option,
            rationale: room.invest.submitted || isFac ? r.rationale : null,
            answer: room.invest.submitted || isFac ? r.answer : null,
          }))
        : null,
      expected:
        (room.plpr.submitted && past("plpr")) || isFac || done
          ? { problemList: c.problemList, problemRepresentation: c.problemRepresentation }
          : null,
      system2Checklist: past("timeout") ? c.system2Checklist : null,
      s1s2:
        room.timeout.revealed || isFac || done
          ? { trap: c.system1Trap, trigger: c.system2Trigger, mustNotMiss: c.mustNotMiss }
          : null,
      debrief: past("debrief")
        ? c.debrief.map((r, i) => ({ q: r.q, a: isFac || done || i < room.debrief.shown ? r.a : null }))
        : null,
      facultyNote: isFac || done ? c.facultyNote : null,
    };
  }

  return {
    code: room.code,
    me,
    hostId: room.hostId,
    phase: room.phase,
    phaseStartedAt: room.phaseStartedAt,
    phases: PHASES,
    roles: ROLES,
    biases: BIASES,
    limits: { min: MIN_PLAYERS, max: MAX_PLAYERS },
    players: Object.values(room.players).sort((a, b) => a.joinedAt - b.joinedAt),
    lobbyProblems: room.phase === "lobby" ? lobbyReady(room) : [],
    powers: me
      ? {
          control: isController(room, me),
          doctor: hasPower(room, me, "doctor"),
          scribe: hasPower(room, me, "scribe"),
          bias: hasPower(room, me, "bias"),
          patient: me.role === "patient",
          facilitator: isFac,
        }
      : {},
    catalog: room.phase === "case" ? { groups, cards: cards.map(({ id, group, card, title, level, image }) => ({ id, group, card, title, level, image })) } : null,
    caseId: room.phase === "case" ? room.caseId : c && c.id,
    caseView,
    questions: room.questions,
    invest: room.invest,
    notes: room.notes,
    stage: room.stage,
    plpr: room.plpr,
    flags: room.flags,
    timeout: room.timeout,
    debriefShown: room.debrief.shown,
    tickets: done || isFac ? room.tickets : me && room.tickets[me.id] ? { [me.id]: room.tickets[me.id] } : {},
    ticketCount: Object.keys(room.tickets).length,
    chat: room.chat.slice(-60),
    stats: done && c ? summaryStats(room, c) : null,
    serverNow: Date.now(),
  };
}

function sweep(maxIdleMs = 6 * 3600 * 1000) {
  const now = Date.now();
  for (const [code, room] of rooms) if (now - room.touchedAt > maxIdleMs) rooms.delete(code);
}

module.exports = { createRoom, getRoom, addPlayer, act, viewFor, sweep, GameError, rooms };
