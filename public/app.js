/* global io */
"use strict";

const socket = io();
const app = document.getElementById("app");
const SESSION_KEY = "crg-session";

let S = null; // latest server view
let clockSkew = 0;
const ui = {
  groupFilter: 0,
  pendingSel: null, // question the patient/facilitator is answering
  drafts: {}, // local-only input values keyed by element id
};

const ROLE_ICON = { facilitator: "🎓", patient: "🛏️", doctor: "🩺", scribe: "📝", bias: "⚖️" };
const ROLE_DESC = {
  facilitator: "คุมเวลาและลำดับขั้น เลือกการ์ด เปิด PE finding / เฉลย investigation / นำ debrief",
  patient: "ถือข้อมูลลับของผู้ป่วย ตอบเฉพาะเมื่อถูกถามตรงประเด็นเท่านั้น",
  doctor: "ซักประวัติแบบ hypothesis-driven ขอตรวจร่างกายอย่างเจาะจง และสั่ง investigation",
  scribe: "จดบันทึกให้ทีม เขียน Problem list + Problem representation one-liner",
  bias: "จับ anchoring / premature closure ระหว่างเล่น และนำ diagnostic time-out (ถ้ามี 4 คน Scribe ทำหน้าที่นี้แทน)",
};

// ---------- helpers ----------
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const player = (id) => (S && S.players.find((p) => p.id === id)) || { name: "?", role: null };
const roleLabel = (r) => (r && S.roles[r] ? S.roles[r].label : "ยังไม่เลือก");
const roleChip = (r) => (r ? `<span class="tag role-chip" data-role="${r}">${ROLE_ICON[r]} ${esc(roleLabel(r))}</span>` : `<span class="tag">ยังไม่เลือกบทบาท</span>`);
const levelTag = (l) => `<span class="tag ${/must/i.test(l) ? "must" : /should/i.test(l) ? "should" : ""}">${esc(l)}</span>`;
const draft = (id, fallback = "") => (id in ui.drafts ? ui.drafts[id] : fallback);

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.h);
  toast.h = setTimeout(() => t.classList.remove("show"), 3200);
}

function send(type, payload) {
  return new Promise((resolve) => {
    socket.emit("action", { type, payload }, (res) => {
      if (!res.ok) toast(res.error);
      resolve(res.ok);
    });
  });
}

function saveSession(code, playerId) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ code, playerId }));
  } catch {}
}
function loadSession() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
  } catch {
    return null;
  }
}
function clearSession() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {}
}

// ---------- socket ----------
socket.on("connect", () => {
  const sess = loadSession();
  if (!sess) return render();
  socket.emit("resume", sess, (res) => {
    if (!res.ok) {
      clearSession();
      S = null;
      render();
    }
  });
});
socket.on("state", (view) => {
  const prevPhase = S && S.phase;
  S = view;
  clockSkew = view.serverNow - Date.now();
  if (prevPhase !== view.phase) {
    ui.pendingSel = null;
    window.scrollTo({ top: 0 });
  }
  render();
});
socket.on("disconnect", () => toast("การเชื่อมต่อหลุด กำลังเชื่อมต่อใหม่…"));

// ---------- render with focus preservation ----------
function render() {
  const active = document.activeElement;
  // The focused field keeps what the user is typing, even if a broadcast carries an older value.
  const keep = active && active.id ? { id: active.id, s: active.selectionStart, e: active.selectionEnd, v: active.value } : null;
  const chatBox = document.querySelector(".chat");
  const chatAtBottom = !chatBox || chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 30;

  app.innerHTML = !S || !S.me ? viewHome() : S.phase === "lobby" ? viewLobby() : viewGame();

  if (keep) {
    const el = document.getElementById(keep.id);
    if (el) {
      if (el.dataset.sync && !el.readOnly) el.value = keep.v;
      el.focus();
      if (keep.s != null && el.setSelectionRange) try { el.setSelectionRange(keep.s, keep.e); } catch {}
    }
  }
  const chat = document.querySelector(".chat");
  if (chat && chatAtBottom) chat.scrollTop = chat.scrollHeight;
  const now = document.querySelector(".stepper .now");
  if (now) now.parentElement.scrollLeft = now.offsetLeft - now.parentElement.clientWidth / 2 + now.clientWidth / 2;
  tick();
}

// ---------- Home ----------
function viewHome() {
  const params = new URLSearchParams(location.search);
  const code = params.get("room") || "";
  return `
  <div class="wrap home">
    <div class="brand">
      <div class="brand-mark">Rx</div>
      <div><h1 style="margin:0">SimPlastic Reasoning</h1>
      <div class="muted small">Plastic Surgery Clinical Reasoning Card Game · 34 การ์ด · 4–5 ผู้เล่น</div></div>
    </div>
    <div class="panel stack">
      <label class="field"><span>ชื่อของคุณ</span>
        <input type="text" id="name" maxlength="24" placeholder="เช่น นศพ. มิ้นท์" value="${esc(draft("name"))}" autocomplete="off" /></label>
      ${code ? "" : `<button class="btn primary" data-act="create" style="width:100%">สร้างห้องใหม่</button>
      <div class="divider">หรือเข้าร่วมห้องที่มีอยู่</div>`}
      <div class="row">
        <input type="text" id="code" maxlength="4" placeholder="รหัสห้อง 4 ตัว" value="${esc(draft("code", code))}" style="flex:1;text-transform:uppercase" class="code" autocomplete="off" />
        <button class="btn ${code ? "primary" : ""}" data-act="join">เข้าร่วม</button>
      </div>
    </div>
    <div class="panel howto">
      <h3>ลำดับการเล่น</h3>
      <ol class="small">
        <li>สร้างห้อง แชร์รหัสให้เพื่อน 4–5 คน แต่ละคนเลือกบทบาท</li>
        <li>Facilitator เลือกการ์ดเคส ทุกคนอ่าน Opening stem</li>
        <li>Doctor ซักประวัติ → Patient เปิดข้อมูลเฉพาะที่ถูกถามตรงประเด็น</li>
        <li>Doctor ขอตรวจร่างกายอย่างเจาะจง → Facilitator เปิด finding</li>
        <li>ทีมเลือก investigation พร้อมเหตุผล → เฉลย</li>
        <li>Scribe เขียน Problem list + one-liner → เทียบกับ Expected PL/PR</li>
        <li>Bias monitor นำ diagnostic time-out (System 1 vs 2)</li>
        <li>Faculty debrief → Exit ticket รายบุคคล → สรุปผล</li>
      </ol>
    </div>
    <p class="disclaimer">เอกสารนี้เพื่อการศึกษาจำลองเท่านั้น ไม่ใช่คำแนะนำสำหรับผู้ป่วยจริง รายละเอียดเชิง protocol ต้องตรวจทานกับ local guideline ก่อนใช้สอนจริง</p>
  </div>`;
}

// ---------- Lobby ----------
function viewLobby() {
  const me = S.me;
  const link = `${location.origin}${location.pathname}?room=${S.code}`;
  const isHost = me.id === S.hostId;
  const roleCards = Object.entries(S.roles)
    .map(([r, def]) => {
      const holder = S.players.find((p) => p.role === r);
      const mine = holder && holder.id === me.id;
      return `<button class="role-card ${mine ? "mine" : ""}" data-role="${r}" data-act="pickRole" data-v="${r}" ${holder && !mine ? "disabled" : ""}>
        <span class="title">${ROLE_ICON[r]} ${esc(def.label)}</span>
        <span class="small muted">${esc(ROLE_DESC[r])}</span>
        <span class="taken">${holder ? `${mine ? "✓ คุณ" : "ถูกเลือกโดย " + esc(holder.name)}` : def.required ? `<span class="tag must">จำเป็น</span>` : `<span class="tag">ไม่บังคับ (คนที่ 5)</span>`}</span>
      </button>`;
    })
    .join("");
  const slots = [];
  for (let i = 0; i < S.limits.max; i++) {
    const p = S.players[i];
    slots.push(
      p
        ? `<li class="${p.connected ? "" : "offline"}"><span class="role-dot" data-role="${p.role || ""}"></span>
            <span style="flex:1">${esc(p.name)}${p.id === S.hostId ? ' <span class="tag">host</span>' : ""}${p.id === me.id ? ' <span class="muted small">(คุณ)</span>' : ""}</span>
            ${roleChip(p.role)}
            ${isHost && p.id !== me.id ? `<button class="btn sm ghost danger" data-act="kick" data-v="${p.id}" title="นำออก">✕</button>` : ""}</li>`
        : `<li class="muted"><span class="role-dot"></span> ว่าง ${i >= S.limits.min ? "(ไม่บังคับ)" : ""}</li>`,
    );
  }
  const canStart = !S.lobbyProblems.length;
  return `
  <header class="topbar"><div class="wrap row spread">
    <div class="row"><div class="brand-mark" style="width:34px;height:34px;font-size:.9rem">Rx</div><b>SimPlastic Reasoning</b></div>
    <button class="btn sm ghost" data-act="leave">ออกจากห้อง</button>
  </div></header>
  <div class="wrap">
    <div class="layout" style="grid-template-columns:minmax(0,1fr) 320px">
      <main class="stack">
        <div class="panel">
          <div class="row spread">
            <div><div class="muted small">ขั้นที่ 1 · เข้าห้อง & เลือกบทบาท</div><h2 style="margin:0">เลือกบทบาทของคุณ</h2></div>
            ${me.role ? `<button class="btn sm ghost" data-act="pickRole" data-v="">ยกเลิกบทบาท</button>` : ""}
          </div>
          <p class="muted small">แต่ละบทบาทเลือกได้ 1 คน ต้องมีครบ 4 บทบาทหลัก · ถ้ามีคนที่ 5 ให้เป็น Bias monitor</p>
          <div class="roles">${roleCards}</div>
        </div>
      </main>
      <aside class="stack" style="position:static">
        <div class="panel">
          <div class="muted small">รหัสห้อง</div>
          <div class="code" style="font-size:2rem">${esc(S.code)}</div>
          <button class="btn sm" data-act="copy" data-v="${esc(link)}">คัดลอกลิงก์เชิญ</button>
        </div>
        <div class="panel players">
          <h3>ผู้เล่น ${S.players.length}/${S.limits.max}</h3>
          <ul>${slots.join("")}</ul>
        </div>
        <div class="panel stack">
          ${canStart ? `<p class="small" style="color:var(--ok)">✓ พร้อมเริ่มเกม</p>` : `<ul class="checklist-problems">${S.lobbyProblems.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`}
          ${isHost || me.role === "facilitator"
            ? `<button class="btn primary" style="width:100%" data-act="startGame" ${canStart ? "" : "disabled"}>เริ่มเกม →</button>`
            : `<p class="muted small">รอ host หรือ Facilitator กดเริ่มเกม</p>`}
        </div>
      </aside>
    </div>
  </div>`;
}

// ---------- Game shell ----------
function viewGame() {
  const cv = S.caseView;
  const idx = S.phases.findIndex((p) => p.id === S.phase);
  const stepper = S.phases
    .slice(1)
    .map((p, i) => `<div class="${i + 1 < idx ? "done" : i + 1 === idx ? "now" : ""}">${i + 1}. ${esc(p.label)}</div>`)
    .join("");
  const ctrl = S.powers.control;
  const nav =
    ctrl && S.phase !== "summary"
      ? `<div class="row">
          ${idx > 1 ? `<button class="btn sm ghost" data-act="advance" data-v="back">← ย้อนกลับ</button>` : ""}
          <button class="btn sm primary" data-act="advance" data-v="next" ${S.phase === "case" && !S.caseId ? "disabled" : ""}>${nextLabel()} →</button>
        </div>`
      : "";
  const main = {
    case: viewCase,
    stem: viewStem,
    history: () => viewQA("history"),
    exam: () => viewQA("exam"),
    investigations: viewInvest,
    plpr: viewPlpr,
    timeout: viewTimeout,
    debrief: viewDebrief,
    exit: viewExit,
    summary: viewSummary,
  }[S.phase]();

  return `
  <header class="topbar"><div class="wrap">
    <div class="row spread">
      <div class="row">
        <div class="brand-mark" style="width:34px;height:34px;font-size:.9rem">Rx</div>
        <div><b>${cv ? esc(cv.title) : "SimPlastic Reasoning"}</b>
        <div class="muted small">ห้อง <span class="code">${esc(S.code)}</span> · ${roleChip(S.me.role)}</div></div>
      </div>
      <div class="row"><span class="timer muted small" id="timer"></span>${nav}</div>
    </div>
    <div class="stepper">${stepper}</div>
  </div></header>
  <div class="wrap">
    <div class="layout" ${cv ? "" : 'style="grid-template-columns:minmax(0,1fr) 300px"'}>
      ${cv ? `<aside class="case-col">${viewCaseCard(cv)}</aside>` : ""}
      <main class="stack">${roleGuide()}${main}</main>
      <aside class="stack">${viewSide()}</aside>
    </div>
    <p class="disclaimer">เพื่อการศึกษาจำลองเท่านั้น ไม่ใช่คำแนะนำสำหรับผู้ป่วยจริง · รายละเอียด protocol ให้ตรวจทานกับ local guideline</p>
  </div>`;
}

function nextLabel() {
  const i = S.phases.findIndex((p) => p.id === S.phase);
  const n = S.phases[i + 1];
  return n ? `ไป: ${n.label}` : "ถัดไป";
}

function viewCaseCard(cv) {
  return `<div class="panel case-card stack">
    ${cv.image ? `<img src="card-assets/${esc(cv.image)}" alt="ภาพประกอบเคส ${esc(cv.title)}" />` : `<div class="noimg">🩹</div>`}
    <div class="row">${levelTag(cv.level)}<span class="tag">${esc(cv.groupName)}</span></div>
    <h3 style="margin:0">${esc(cv.title)}</h3>
    <div class="stem pre small">${esc(cv.stem)}</div>
    ${cv.learningFocus ? `<details><summary class="small">Learning focus</summary><ul class="small">${cv.learningFocus.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></details>` : ""}
  </div>`;
}

// What should *I* be doing in this phase?
function roleGuide() {
  const r = S.me.role;
  const P = S.powers;
  const g = {
    case: { facilitator: "เลือกการ์ดเคสที่จะเล่น (หรือสุ่ม) แล้วกด “ไป: Opening stem”" },
    stem: {
      facilitator: "ให้ทุกคนอ่าน opening stem และตั้ง hypothesis เบื้องต้นก่อนเริ่มซักประวัติ",
      doctor: "อ่าน stem แล้วคิด 2–3 hypothesis ที่จะใช้นำการซักประวัติ",
      patient: "อ่าน stem และทบทวนข้อมูลลับของคุณ (จะเห็นในขั้นถัดไป) — ห้ามเปิดข้อมูลเอง",
      scribe: "เริ่มจด hypothesis เริ่มต้นของทีมในบันทึกด้านขวา",
      bias: "สังเกตว่าทีม anchor กับคำใน stem เร็วเกินไปหรือไม่",
    },
    history: {
      doctor: "ถามทีละคำถามอย่างเจาะจง (hypothesis-driven) — ผู้ป่วยจะตอบเฉพาะที่ถามตรงประเด็น",
      patient: "เลือกคำถามที่รอตอบ แล้วกดข้อมูลในการ์ดที่ตรงกับคำถาม ถ้าไม่ตรงข้อใดให้กด “ไม่มีข้อมูล”",
      facilitator: "สังเกตการซักประวัติ คุณเห็นการ์ดข้อมูลผู้ป่วยทั้งหมด",
      scribe: "จดข้อมูลที่ได้ลงบันทึก และเสนอคำถามให้ Doctor ผ่านแชท",
      bias: "ถ้าทีมหยุดถามเร็วหรือไม่ถาม red flag ให้ติด flag",
    },
    exam: {
      doctor: "ขอตรวจอย่างเจาะจง เช่น “ตรวจ palate ด้วยไฟฉาย” — การขอกว้างๆ จะไม่ได้ finding",
      facilitator: "เลือกคำขอตรวจ แล้วเปิด finding ที่ตรงกับการตรวจที่ขอเท่านั้น",
      patient: "พักบทบาท — สังเกตการตรวจ",
      scribe: "บันทึก positive และ pertinent negative",
      bias: "ระวัง search satisficing — เจอสิ่งแรกแล้วหยุดหาต่อ",
    },
    investigations: {
      doctor: "เลือกเฉพาะ investigation ที่เปลี่ยน management พร้อมเหตุผล แล้วกดยืนยัน",
      scribe: "ช่วยเลือกและเขียนเหตุผล",
      facilitator: "หลังทีมยืนยัน เฉลยจะเปิดให้ทุกคน อภิปรายตัวเลือกที่ไม่ใช่ priority",
    },
    plpr: {
      scribe: "เขียน Problem list (1–5 ข้อ) และ one-liner ร่วมกับทีม แล้วกดส่ง",
      facilitator: "หลังทีมส่ง ให้คะแนนความใกล้เคียงกับ Expected PL/PR (1–5)",
    },
    timeout: {
      bias: "นำทีมไล่ System 2 checklist ทีละข้อ และรวบรวม must-not-miss ของทีม",
      facilitator: "เมื่อทีมพร้อม กดเฉลย System 1 trap / System 2 trigger / must-not-miss",
    },
    debrief: { facilitator: "เปิดคำถาม debrief ทีละข้อ ให้ทีมตอบก่อนเปิดประเด็นที่ scaffold" },
    exit: { _all: "ทุกคนกรอก exit ticket ของตัวเอง 3 ข้อ" },
    summary: { _all: "ดูสรุปผล ดาวน์โหลดรายงาน หรือเริ่มเคสใหม่" },
  }[S.phase] || {};
  let text = g[r] || g._all;
  if (!text && r === "scribe" && P.bias) text = g.bias;
  if (!text) text = "ร่วมอภิปรายกับทีม — ส่งความเห็นผ่านแชทได้";
  const extra = r === "scribe" && P.bias ? ` <span class="muted small">(มี 4 คน: คุณทำหน้าที่ Bias monitor ด้วย)</span>` : "";
  return `<div class="guide" data-role="${r}"><b>${ROLE_ICON[r]} บทบาทของคุณตอนนี้:</b> ${esc(text)}${extra}</div>`;
}

// ---------- Phase: case ----------
function viewCase() {
  if (!S.powers.control || !S.catalog) {
    return `<div class="panel"><h2>รอ Facilitator เลือกการ์ด…</h2><p class="muted">อย่าเพิ่งเดา — ข้อมูลทั้งหมดจะถูกปลดล็อกทีละส่วนตามที่ทีมถามและตรวจ</p></div>`;
  }
  const { groups, cards } = S.catalog;
  const shown = cards.filter((c) => !ui.groupFilter || c.group === ui.groupFilter);
  return `<div class="panel stack">
    <div class="row spread"><h2 style="margin:0">เลือกการ์ดเคส</h2><button class="btn" data-act="selectCase" data-v="random">🎲 สุ่มการ์ด</button></div>
    <div class="tabs">
      <button class="btn sm ${!ui.groupFilter ? "on" : ""}" data-act="groupFilter" data-v="0">ทั้งหมด (${cards.length})</button>
      ${groups.map((g) => `<button class="btn sm ${ui.groupFilter === g.no ? "on" : ""}" data-act="groupFilter" data-v="${g.no}">${g.no}. ${esc(g.name)}</button>`).join("")}
    </div>
    <div class="card-grid">
      ${shown
        .map(
          (c) => `<button class="pick ${S.caseId === c.id ? "on" : ""}" data-act="selectCase" data-v="${c.id}">
          ${c.image ? `<img src="card-assets/${esc(c.image)}" alt="" loading="lazy" />` : `<div class="noimg">🩹</div>`}
          <div class="body"><div class="muted small">G${c.group} · Card ${c.card}</div><b>${esc(c.title)}</b><div>${levelTag(c.level)}</div></div>
        </button>`,
        )
        .join("")}
    </div>
    ${S.caseId ? `<p class="small">เลือกแล้ว: <b>${esc(cards.find((c) => c.id === S.caseId).title)}</b> — กด “ไป: Opening stem” ด้านบนเพื่อเริ่ม</p>` : ""}
  </div>`;
}

// ---------- Phase: stem ----------
function viewStem() {
  const cv = S.caseView;
  return `<div class="panel stack">
    <h2>Opening stem</h2>
    <div class="stem pre">${esc(cv.stem)}</div>
    <p class="muted small">ข้อมูลอื่นทั้งหมดถูกซ่อนไว้ ทีมต้อง “ถาม” และ “ขอตรวจ” เพื่อปลดล็อก</p>
    ${S.powers.scribe ? `<p class="small">💡 Scribe: จด hypothesis เริ่มต้นของทีมในบันทึกด้านขวา</p>` : ""}
  </div>`;
}

// ---------- Phase: history / exam ----------
function viewQA(kind) {
  const isHist = kind === "history";
  const P = S.powers;
  const answerer = isHist ? P.patient : P.facilitator;
  const qs = S.questions.filter((q) => q.kind === kind);
  const rows = S.caseView[kind];
  const rowByIdx = Object.fromEntries(rows.map((r) => [r.idx, r]));
  const pending = qs.filter((q) => q.status === "pending");
  if (answerer && (!ui.pendingSel || !pending.some((q) => q.id === ui.pendingSel))) ui.pendingSel = pending[0] ? pending[0].id : null;

  const ask = P.doctor
    ? `<div class="panel stack">
        <h3>${isHist ? "ถามผู้ป่วย" : "ขอตรวจร่างกาย"}</h3>
        <div class="row">
          <input type="text" id="ask-${kind}" maxlength="300" style="flex:1" placeholder="${isHist ? "เช่น ดูดนมแล้วมีนมไหลออกทางจมูกไหม" : "เช่น ตรวจ palate ด้วยไฟฉายและไม้กดลิ้น"}" value="${esc(draft("ask-" + kind))}" />
          <button class="btn primary" data-act="ask" data-v="${kind}">${isHist ? "ถาม" : "ขอตรวจ"}</button>
        </div>
      </div>`
    : "";

  const thread = qs.length
    ? `<ul class="thread">${qs
        .slice()
        .reverse()
        .map((q) => {
          const r = q.rowIdx != null ? rowByIdx[q.rowIdx] : null;
          const sel = answerer && q.id === ui.pendingSel;
          return `<li class="${sel ? "sel" : ""}" ${answerer && q.status === "pending" ? `data-act="selPending" data-v="${q.id}" style="cursor:pointer;border-radius:8px;padding-left:8px"` : ""}>
            <div class="bubble-q"><span class="role-dot" data-role="doctor"></span> ${esc(player(q.by).name)}: ${esc(q.text)}</div>
            ${q.status === "pending"
              ? `<div class="pending">⏳ รอ${isHist ? "ผู้ป่วยตอบ" : " facilitator เปิด finding"}${sel ? " — เลือกข้อมูลด้านล่างเพื่อตอบ" : ""}</div>`
              : q.status === "noinfo"
                ? `<div class="bubble-a noinfo">${isHist ? "ผู้ป่วย: “ไม่แน่ใจ / ไม่มีข้อมูลในส่วนนี้”" : "ไม่มี finding เพิ่มเติมจากการตรวจนี้ (ลองระบุให้เจาะจงขึ้น)"}</div>`
                : `<div class="bubble-a"><span class="muted small">${esc(r ? r.q : "")}</span><br>${esc(r && r.a)}</div>`}
          </li>`;
        })
        .join("")}</ul>`
    : `<p class="muted">ยังไม่มี${isHist ? "คำถาม" : "คำขอตรวจ"}</p>`;

  let holder = "";
  if (answerer) {
    holder = `<div class="panel stack">
      <div class="row spread"><h3 style="margin:0">${isHist ? "🔒 การ์ดข้อมูลผู้ป่วย (เห็นเฉพาะคุณ)" : "🔒 PE finding cards"}</h3>
      ${ui.pendingSel ? `<button class="btn sm" data-act="answer" data-v="noinfo">ไม่มีข้อมูล/ไม่ตรงข้อใด</button>` : ""}</div>
      ${ui.pendingSel
        ? `<div class="guide" data-role="doctor"><b>${isHist ? "คำถามที่กำลังตอบ" : "คำขอตรวจที่กำลังเปิด"}${pending.length > 1 ? ` (รออีก ${pending.length - 1})` : ""}:</b> ${esc(qs.find((q) => q.id === ui.pendingSel).text)}</div>
           <p class="small muted">กดข้อที่ตรงกับ${isHist ? "คำถาม" : "การตรวจ"}นี้ (เปิดเฉพาะที่ถูกถามตรงประเด็น)</p>`
        : `<p class="small muted">ยังไม่มี${isHist ? "คำถาม" : "คำขอตรวจ"}รอตอบ</p>`}
      <ul class="rows">${rows
        .map(
          (r) => `<li class="${r.revealed ? "revealed" : ""}">
          <div class="row spread"><span class="k">${esc(r.q)}</span>
          ${ui.pendingSel ? `<button class="btn sm primary" data-act="answer" data-v="${r.idx}">${isHist ? "ตอบด้วยข้อนี้" : "เปิด finding"}</button>` : r.revealed ? `<span class="tag ok">เปิดแล้ว</span>` : ""}</div>
          <div class="small">${esc(r.a)}</div></li>`,
        )
        .join("")}</ul>
    </div>`;
  } else if (P.facilitator && isHist) {
    holder = `<details class="panel"><summary>การ์ดข้อมูลผู้ป่วยทั้งหมด (facilitator)</summary><ul class="rows">${rows
      .map((r) => `<li class="${r.revealed ? "revealed" : ""}"><span class="k">${esc(r.q)}</span><div class="small">${esc(r.a)}</div></li>`)
      .join("")}</ul></details>`;
  }

  const unlocked = rows.filter((r) => r.revealed).length;
  return `${ask}
    ${answerer ? holder : ""}
    <div class="panel"><div class="row spread"><h3 style="margin:0">${isHist ? "บทสนทนาซักประวัติ" : "การตรวจร่างกาย"}</h3>
      <span class="tag">${S.powers.facilitator || answerer ? `ปลดล็อก ${unlocked}/${rows.length}` : `ปลดล็อก ${unlocked} ข้อ`}</span></div>${thread}</div>
    ${answerer ? "" : holder}`;
}

// ---------- Phase: investigations ----------
function viewInvest() {
  const P = S.powers;
  const inv = S.caseView.investigations;
  const sel = S.invest.selected;
  const submitted = S.invest.submitted;
  const canEdit = (P.doctor || P.scribe) && !submitted;
  const body = inv
    .map((r) => {
      const chosen = r.idx in sel;
      return `<tr class="${chosen ? "chosen" : ""}">
        <td style="width:36%"><label class="row" style="align-items:flex-start;flex-wrap:nowrap">
          <input type="checkbox" ${chosen ? "checked" : ""} ${canEdit ? `data-act="toggleInvest" data-v="${r.idx}"` : "disabled"} style="margin-top:5px" />
          <span>${esc(r.option)}</span></label></td>
        <td>${chosen
          ? canEdit
            ? `<input type="text" id="inv-${r.idx}" data-sync="inv" data-v="${r.idx}" placeholder="เหตุผล: ผลนี้จะเปลี่ยน management อย่างไร" value="${esc(sel[r.idx])}" />`
            : `<span class="small">${esc(sel[r.idx]) || '<span class="muted">(ไม่ได้ระบุเหตุผล)</span>'}</span>`
          : `<span class="muted small">—</span>`}</td>
        ${r.answer != null ? `<td class="small"><div class="muted">${esc(r.rationale)}</div><b>${esc(r.answer)}</b></td>` : ""}
      </tr>`;
    })
    .join("");
  const reveal = inv[0] && inv[0].answer != null;
  return `<div class="panel stack">
    <div class="row spread"><h2 style="margin:0">Investigation options</h2>${submitted ? `<span class="tag ok">ทีมยืนยันแล้ว</span>` : ""}</div>
    <p class="muted small">เลือกเฉพาะสิ่งที่เปลี่ยนการตัดสินใจ — การ order เหมาทั้งหมดไม่ใช่ clinical reasoning ที่ดี</p>
    <div style="overflow-x:auto"><table class="grid"><thead><tr><th>ตัวเลือก</th><th>เหตุผลของทีม</th>${reveal ? `<th>${submitted ? "เฉลย" : "เฉลย (facilitator เห็นก่อน)"}</th>` : ""}</tr></thead><tbody>${body}</tbody></table></div>
    ${P.doctor && !submitted ? `<button class="btn primary" data-act="submitInvest">ยืนยันคำสั่ง investigation</button>` : ""}
  </div>`;
}

// ---------- Phase: PL/PR ----------
function viewPlpr() {
  const P = S.powers;
  const { pl, pr, submitted, rating } = S.plpr;
  const edit = P.scribe && !submitted;
  const exp = S.caseView.expected;
  const team = `<div class="stack">
    <label class="field"><span>Problem list ของทีม (1–5 ข้อ)</span>
      <textarea id="pl" rows="6" data-sync="plpr" ${edit ? "" : "readonly"} placeholder="1. …">${esc(pl)}</textarea></label>
    <label class="field"><span>Problem representation (one-liner)</span>
      <textarea id="pr" rows="4" data-sync="plpr" ${edit ? "" : "readonly"} placeholder="อายุ/เพศ, time course, mechanism, key +/−, clinical concern">${esc(pr)}</textarea></label>
    ${edit ? `<button class="btn primary" data-act="submitPlpr">ส่ง PL/PR ของทีม</button>` : ""}
    ${!P.scribe && !submitted ? `<p class="muted small">Scribe กำลังเขียน — เสนอความเห็นผ่านแชทได้</p>` : ""}
  </div>`;
  const expected = exp
    ? `<div class="stack"><div><b>Expected Problem list</b>${P.facilitator && !submitted ? ' <span class="muted small">(เห็นเฉพาะ facilitator)</span>' : ""}
        <ol class="small">${exp.problemList.map((x) => `<li>${esc(x)}</li>`).join("")}</ol></div>
        <div><b>Expected one-liner</b><div class="stem small">${esc(exp.problemRepresentation)}</div></div></div>`
    : `<div class="muted">🔒 Expected PL/PR จะเปิดหลังทีมส่ง</div>`;
  const stars = submitted
    ? `<div class="row"><span class="small">คะแนนความใกล้เคียงจาก facilitator:</span><span class="stars">${[1, 2, 3, 4, 5]
        .map((n) => `<button class="${rating >= n ? "on" : ""}" ${P.facilitator ? `data-act="ratePlpr" data-v="${n}"` : "disabled"} aria-label="${n} ดาว">★</button>`)
        .join("")}</span></div>`
    : "";
  return `<div class="panel stack"><h2>Problem list & Problem representation</h2>
    <div class="compare">${team}${expected}</div>${stars}</div>`;
}

// ---------- Phase: time-out ----------
function viewTimeout() {
  const P = S.powers;
  const cv = S.caseView;
  const t = S.timeout;
  const checklist = cv.system2Checklist
    .map(
      (x, i) => `<li><label class="row" style="align-items:flex-start;flex-wrap:nowrap">
        <input type="checkbox" ${t.checks[i] ? "checked" : ""} ${P.bias ? `data-act="check" data-v="${i}"` : "disabled"} style="margin-top:5px" />
        <span>${esc(x)}</span></label></li>`,
    )
    .join("");
  const s = cv.s1s2;
  return `<div class="panel stack">
    <h2>Diagnostic time-out — System 1 vs System 2</h2>
    <p class="muted small">หยุดคิดช้าลง: ทีมไล่ตอบ checklist ทีละข้อ ก่อนสรุป</p>
    <ul class="rows" style="list-style:none">${checklist}</ul>
    <label class="field"><span>Must-not-miss ของทีม (เรียงจากอันตรายที่สุด)</span>
      <textarea id="mnm" rows="4" data-sync="mnm" ${(P.bias || P.scribe) && !t.revealed ? "" : "readonly"} placeholder="1. …">${esc(t.mnm)}</textarea></label>
    ${S.flags.length ? `<div><b>Bias flags ระหว่างเคส (${S.flags.length})</b>${S.flags.map(flagHtml).join("")}</div>` : `<p class="muted small">ไม่มี bias flag ระหว่างเคส</p>`}
  </div>
  <div class="panel stack">
    <div class="row spread"><h3 style="margin:0">เฉลย System 1 / System 2</h3>
    ${P.facilitator && !t.revealed ? `<button class="btn primary" data-act="revealTimeout">เฉลยให้ทุกคน</button>` : ""}</div>
    ${s
      ? `${P.facilitator && !t.revealed ? '<p class="muted small">(เห็นเฉพาะ facilitator จนกว่าจะกดเฉลย)</p>' : ""}
        <div><b>System 1 trap:</b> “${esc(s.trap)}”</div>
        <div><b>System 2 trigger:</b> ${esc(s.trigger)}</div>
        <div><b>Must-not-miss:</b><ol class="small">${s.mustNotMiss.map((x) => `<li>${esc(x)}</li>`).join("")}</ol></div>`
      : `<p class="muted">🔒 รอ facilitator เฉลย</p>`}
  </div>`;
}

// ---------- Phase: debrief ----------
function viewDebrief() {
  const P = S.powers;
  const rows = S.caseView.debrief;
  const list = rows
    .map((r, i) => {
      const shown = i < S.debriefShown;
      if (!shown && !P.facilitator) return i === S.debriefShown ? `<li class="muted">🔒 คำถามถัดไป…</li>` : "";
      return `<li class="${shown ? "revealed" : ""}"><div class="k">${esc(r.q)}</div><div class="small">${esc(r.a)}</div>
        ${P.facilitator && !shown ? `<span class="muted small">(ยังไม่เปิดให้ทีม)</span>` : ""}</li>`;
    })
    .join("");
  return `<div class="panel stack">
    <div class="row spread"><h2 style="margin:0">Faculty debrief — Management reasoning</h2>
    ${P.facilitator && S.debriefShown < rows.length ? `<button class="btn primary" data-act="debriefNext">เปิดคำถามถัดไป (${S.debriefShown + 1}/${rows.length})</button>` : ""}</div>
    <ul class="rows">${list}</ul>
    ${S.caseView.facultyNote ? `<div class="guide small" data-role="facilitator"><b>หมายเหตุอาจารย์:</b> ${esc(S.caseView.facultyNote)}</div>` : ""}
  </div>`;
}

// ---------- Phase: exit ----------
function viewExit() {
  const mine = S.tickets[S.me.id];
  const f = (id, label, ph, v) =>
    `<label class="field"><span>${label}</span><textarea id="${id}" rows="${id === "t-one" ? 3 : 2}" placeholder="${ph}">${esc(draft(id, v || ""))}</textarea></label>`;
  return `<div class="panel stack">
    <div class="row spread"><h2 style="margin:0">Exit ticket (รายบุคคล)</h2><span class="tag">${S.ticketCount}/${S.players.length} ส่งแล้ว</span></div>
    ${f("t-one", "1. One-liner สุดท้ายของคุณ", "Problem representation หลังจบ debrief", mine && mine.oneLiner)}
    ${f("t-mnm", "2. Must-not-miss ที่สำคัญที่สุด 1 ข้อ", "", mine && mine.mnm)}
    ${f("t-trig", "3. Trigger ของคุณเองที่ทำให้เปลี่ยนจาก System 1 → System 2", "", mine && mine.trigger)}
    <button class="btn primary" data-act="ticket">${mine ? "อัปเดต exit ticket" : "ส่ง exit ticket"}</button>
    ${mine ? `<p class="small" style="color:var(--ok)">✓ ส่งแล้ว</p>` : ""}
  </div>`;
}

// ---------- Phase: summary ----------
function viewSummary() {
  const st = S.stats;
  const cv = S.caseView;
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const stat = (label, v, sub) => `<div class="stat"><span class="muted small">${label}</span><b>${v}</b><span class="small muted">${sub || ""}</span></div>`;
  const tickets = S.players
    .map((p) => {
      const t = S.tickets[p.id];
      return `<li><div class="row"><b>${esc(p.name)}</b>${roleChip(p.role)}</div>${
        t ? `<div class="small"><b>One-liner:</b> ${esc(t.oneLiner)}<br><b>Must-not-miss:</b> ${esc(t.mnm)}<br><b>S1→S2 trigger:</b> ${esc(t.trigger)}</div>` : `<span class="muted small">ไม่ได้ส่ง</span>`
      }</li>`;
    })
    .join("");
  const table = (rows, a, b) => `<table class="grid"><tbody>${rows.map((r) => `<tr class="${r.revealed ? "chosen" : ""}"><td style="width:40%">${esc(r[a])}</td><td>${esc(r[b])}</td></tr>`).join("")}</tbody></table>`;
  return `<div class="panel stack">
    <div class="row spread"><h2 style="margin:0">สรุปผลเคส</h2>
      <div class="row"><button class="btn" data-act="download">⬇ ดาวน์โหลดรายงาน (.md)</button>
      ${S.powers.control ? `<button class="btn primary" data-act="restart">เล่นเคสใหม่</button>` : ""}</div></div>
    <div class="stats">
      ${stat("ซักประวัติครอบคลุม", pct(st.historyCovered, st.historyTotal) + "%", `${st.historyCovered}/${st.historyTotal} ข้อ · ${st.questionsAsked} คำถาม`)}
      ${stat("ตรวจร่างกายครอบคลุม", pct(st.examCovered, st.examTotal) + "%", `${st.examCovered}/${st.examTotal} ข้อ · ${st.examsRequested} คำขอ`)}
      ${stat("เลือก investigation ที่ไม่ใช่ priority", `${st.lowPriorityChosen}/${st.lowPriorityTotal}`, "ยิ่งน้อยยิ่งดี")}
      ${stat("PL/PR rating", S.plpr.rating ? "★".repeat(S.plpr.rating) : "—", "จาก facilitator")}
      ${stat("S2 checklist", `${st.checklistDone}/${st.checklistTotal}`, "")}
      ${stat("Bias flags", st.flags, "")}
    </div>
  </div>
  <div class="panel"><h3>Exit tickets</h3><ul class="thread">${tickets}</ul></div>
  <div class="panel stack"><h3>การ์ดฉบับเต็ม (แถวสีเขียว = ทีมปลดล็อกแล้ว)</h3>
    <details><summary>ข้อมูลผู้ป่วย (${st.historyCovered}/${st.historyTotal})</summary>${table(cv.history, "q", "a")}</details>
    <details><summary>Physical examination (${st.examCovered}/${st.examTotal})</summary>${table(cv.exam, "q", "a")}</details>
    <details><summary>Expected PL/PR</summary><ol class="small">${cv.expected.problemList.map((x) => `<li>${esc(x)}</li>`).join("")}</ol><div class="stem small">${esc(cv.expected.problemRepresentation)}</div></details>
    <details><summary>System 1 / 2 และ Must-not-miss</summary><p class="small"><b>Trap:</b> ${esc(cv.s1s2.trap)}<br><b>Trigger:</b> ${esc(cv.s1s2.trigger)}</p><ol class="small">${cv.s1s2.mustNotMiss.map((x) => `<li>${esc(x)}</li>`).join("")}</ol></details>
  </div>`;
}

function reportMarkdown() {
  const cv = S.caseView;
  const st = S.stats;
  const L = [];
  L.push(`# SimPlastic Reasoning — ${cv.title}`, "", `ห้อง ${S.code} · ${new Date().toLocaleString("th-TH")} · ${cv.groupName} · ${cv.level}`, "");
  L.push("## ผู้เล่น", ...S.players.map((p) => `- ${p.name} — ${roleLabel(p.role)}`), "");
  L.push("## ซักประวัติ", ...S.questions.filter((q) => q.kind === "history").map((q) => `- Q: ${q.text} → ${q.status === "answered" ? cv.history[q.rowIdx].a : "(ไม่มีข้อมูล)"}`), "");
  L.push("## ตรวจร่างกาย", ...S.questions.filter((q) => q.kind === "exam").map((q) => `- ${q.text} → ${q.status === "answered" ? cv.exam[q.rowIdx].a : "(ไม่มี finding)"}`), "");
  L.push("## Investigation ที่เลือก", ...Object.entries(S.invest.selected).map(([i, why]) => `- ${cv.investigations[i].option} — เหตุผล: ${why || "-"} — เฉลย: ${cv.investigations[i].answer}`), "");
  L.push("## PL/PR ของทีม", S.plpr.pl, "", `> ${S.plpr.pr}`, "", `Rating: ${S.plpr.rating || "-"}/5`, "");
  L.push("## Expected PL/PR", ...cv.expected.problemList.map((x, i) => `${i + 1}. ${x}`), "", `> ${cv.expected.problemRepresentation}`, "");
  L.push("## Must-not-miss ของทีม", S.timeout.mnm || "-", "");
  L.push("## Bias flags", ...(S.flags.length ? S.flags.map((f) => `- [${f.phase}] ${f.bias}: ${f.note}`) : ["-"]), "");
  L.push("## Exit tickets", ...S.players.map((p) => {
    const t = S.tickets[p.id];
    return t ? `- **${p.name}**: ${t.oneLiner} | MNM: ${t.mnm} | Trigger: ${t.trigger}` : `- **${p.name}**: (ไม่ได้ส่ง)`;
  }), "");
  L.push("## สถิติ", `- History ${st.historyCovered}/${st.historyTotal}, Exam ${st.examCovered}/${st.examTotal}, Non-priority investigation ${st.lowPriorityChosen}/${st.lowPriorityTotal}`, "");
  L.push("> เพื่อการศึกษาจำลองเท่านั้น ไม่ใช่คำแนะนำสำหรับผู้ป่วยจริง");
  return L.join("\n");
}

// ---------- Sidebar ----------
function flagHtml(f) {
  return `<div class="flag"><b>${esc(f.bias)}</b> <span class="muted small">· ${esc(player(f.by).name)} · ${esc((S.phases.find((p) => p.id === f.phase) || {}).label || f.phase)}</span>${f.note ? `<div>${esc(f.note)}</div>` : ""}</div>`;
}

function viewSide() {
  const P = S.powers;
  const inCase = !["case", "summary"].includes(S.phase);
  const players = `<div class="panel players"><h3>ทีม</h3><ul>${S.players
    .map((p) => `<li class="${p.connected ? "" : "offline"}"><span class="role-dot" data-role="${p.role}"></span><span style="flex:1">${esc(p.name)}${p.id === S.me.id ? " (คุณ)" : ""}</span><span class="small muted">${ROLE_ICON[p.role] || ""}</span></li>`)
    .join("")}</ul></div>`;
  const notes = inCase
    ? `<div class="panel stack"><h3 style="margin:0">📝 บันทึกของทีม</h3>
        <textarea id="notes" rows="6" data-sync="notes" ${P.scribe ? "" : "readonly"} placeholder="${P.scribe ? "จด hypothesis, ข้อมูลสำคัญ, pertinent negative…" : "Scribe จะจดที่นี่"}">${esc(S.notes)}</textarea></div>`
    : "";
  const flags = inCase
    ? `<div class="panel stack"><h3 style="margin:0">⚖️ Bias flags</h3>
        ${P.bias
          ? `<select id="flag-bias">${S.biases.map((b) => `<option ${draft("flag-bias") === b ? "selected" : ""}>${esc(b)}</option>`).join("")}</select>
             <input type="text" id="flag-note" maxlength="300" placeholder="เกิดอะไรขึ้น" value="${esc(draft("flag-note"))}" />
             <button class="btn sm" data-act="flag">ติด flag</button>`
          : ""}
        ${S.flags.length ? S.flags.slice(-5).reverse().map(flagHtml).join("") : `<p class="muted small">ยังไม่มี</p>`}</div>`
    : "";
  const chat = `<div class="panel stack"><h3 style="margin:0">💬 แชท</h3>
    <div class="chat">${S.chat.map((m) => { const p = player(m.by); return `<div><span class="role-dot" data-role="${p.role}"></span> <b>${esc(p.name)}</b>: ${esc(m.text)}</div>`; }).join("") || '<span class="muted small">ยังไม่มีข้อความ</span>'}</div>
    <div class="row"><input type="text" id="chat" maxlength="300" style="flex:1" placeholder="พิมพ์ข้อความ" value="${esc(draft("chat"))}" /><button class="btn sm" data-act="chat">ส่ง</button></div></div>`;
  return players + notes + flags + chat;
}

// ---------- Timer ----------
function tick() {
  const el = document.getElementById("timer");
  if (!el || !S) return;
  const ph = S.phases.find((p) => p.id === S.phase);
  if (!ph || !ph.minutes) return (el.textContent = "");
  const elapsed = Math.max(0, Math.floor((Date.now() + clockSkew - S.phaseStartedAt) / 1000));
  const left = ph.minutes * 60 - elapsed;
  const mm = (s) => `${Math.floor(Math.abs(s) / 60)}:${String(Math.abs(s) % 60).padStart(2, "0")}`;
  el.textContent = left >= 0 ? `⏱ เหลือ ${mm(left)} / ${ph.minutes} นาที` : `⏱ เกินเวลา ${mm(left)}`;
  el.classList.toggle("over", left < 0);
}
setInterval(tick, 1000);

// ---------- Events ----------
const syncTimers = {};
function debounced(key, fn, ms = 350) {
  clearTimeout(syncTimers[key]);
  syncTimers[key] = setTimeout(fn, ms);
}

app.addEventListener("input", (e) => {
  const el = e.target;
  if (!el.id) return;
  const sync = el.dataset.sync;
  if (!sync) {
    ui.drafts[el.id] = el.value;
    return;
  }
  if (sync === "notes") debounced("notes", () => send("notes", { text: el.value }));
  if (sync === "plpr") debounced("plpr", () => send("plpr", { pl: document.getElementById("pl").value, pr: document.getElementById("pr").value }));
  if (sync === "mnm") debounced("mnm", () => send("mnm", { text: el.value }));
  if (sync === "inv") debounced("inv" + el.dataset.v, () => send("toggleInvest", { idx: el.dataset.v, reason: el.value }));
});

app.addEventListener("change", (e) => {
  if (e.target.id === "flag-bias") ui.drafts["flag-bias"] = e.target.value;
});

app.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
  const id = e.target.id;
  const map = { chat: "chat", "ask-history": "ask", "ask-exam": "ask", name: "create", code: "join", "flag-note": "flag" };
  if (!map[id]) return;
  e.preventDefault();
  const btn = app.querySelector(`[data-act="${map[id]}"]`) || (id === "name" && app.querySelector('[data-act="join"]'));
  if (btn) btn.click();
});

function take(id) {
  const v = (ui.drafts[id] ?? "").trim();
  return v;
}
function clearDraft(...ids) {
  ids.forEach((id) => delete ui.drafts[id]);
}

app.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act]");
  if (!el || el.disabled) return;
  const act = el.dataset.act;
  const v = el.dataset.v;

  switch (act) {
    case "create":
    case "join": {
      const name = take("name") || (document.getElementById("name") || {}).value || "";
      const code = act === "join" ? take("code") || new URLSearchParams(location.search).get("room") || "" : undefined;
      if (!name.trim()) return toast("กรุณาใส่ชื่อ");
      if (act === "join" && !code) return toast("กรุณาใส่รหัสห้อง");
      socket.emit(act, { name, code }, (res) => {
        if (!res.ok) return toast(res.error);
        saveSession(res.code, res.playerId);
        history.replaceState(null, "", `?room=${res.code}`);
      });
      return;
    }
    case "leave":
      socket.emit("leave", {}, () => {
        clearSession();
        S = null;
        history.replaceState(null, "", location.pathname);
        render();
      });
      return;
    case "copy":
      try {
        await navigator.clipboard.writeText(v);
        toast("คัดลอกลิงก์แล้ว");
      } catch {
        toast(v);
      }
      return;
    case "pickRole":
      return send("pickRole", { role: v || null });
    case "kick":
      return send("kick", { playerId: v });
    case "startGame":
      return send("startGame");
    case "groupFilter":
      ui.groupFilter = Number(v);
      return render();
    case "selectCase":
      return send("selectCase", { caseId: v });
    case "advance":
      return send("advance", { to: v });
    case "ask": {
      const id = "ask-" + v;
      const text = take(id);
      if (!text) return toast("พิมพ์คำถามก่อน");
      if (await send("ask", { kind: v, text })) {
        clearDraft(id);
        render();
      }
      return;
    }
    case "selPending":
      ui.pendingSel = v;
      return render();
    case "answer":
      if (!ui.pendingSel) return;
      return send("answer", v === "noinfo" ? { questionId: ui.pendingSel, noInfo: true } : { questionId: ui.pendingSel, rowIdx: Number(v) });
    case "toggleInvest": {
      const on = el.checked;
      return send("toggleInvest", { idx: v, reason: on ? "" : null });
    }
    case "submitInvest":
      if (confirm("ยืนยันคำสั่ง investigation? หลังยืนยันจะเปิดเฉลยให้ทุกคน")) send("submitInvest");
      return;
    case "submitPlpr":
      clearTimeout(syncTimers.plpr);
      await send("plpr", { pl: document.getElementById("pl").value, pr: document.getElementById("pr").value });
      if (confirm("ส่ง PL/PR ของทีม? หลังส่งจะแก้ไม่ได้และจะเปิด Expected PL/PR")) send("submitPlpr");
      return;
    case "ratePlpr":
      return send("ratePlpr", { rating: Number(v) });
    case "check":
      return send("check", { idx: Number(v), value: el.checked });
    case "revealTimeout":
      clearTimeout(syncTimers.mnm);
      return send("revealTimeout");
    case "debriefNext":
      return send("debriefNext");
    case "flag": {
      const bias = ui.drafts["flag-bias"] || (document.getElementById("flag-bias") || {}).value;
      if (await send("flag", { bias, note: take("flag-note") })) {
        clearDraft("flag-note");
        render();
      }
      return;
    }
    case "ticket": {
      const val = (id) => (document.getElementById(id) || {}).value || "";
      if (await send("ticket", { oneLiner: val("t-one"), mnm: val("t-mnm"), trigger: val("t-trig") })) toast("บันทึก exit ticket แล้ว");
      return;
    }
    case "chat": {
      const text = take("chat");
      if (!text) return;
      if (await send("chat", { text })) {
        clearDraft("chat");
        render();
      }
      return;
    }
    case "download": {
      const blob = new Blob([reportMarkdown()], { type: "text/markdown;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `simplastic-${S.caseView.id}-${S.code}.md`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      return;
    }
    case "restart":
      if (confirm("เริ่มเคสใหม่กับทีมเดิม? ข้อมูลเคสนี้จะถูกล้าง (ดาวน์โหลดรายงานก่อนถ้าต้องการ)")) send("restart");
      return;
  }
});

render();
