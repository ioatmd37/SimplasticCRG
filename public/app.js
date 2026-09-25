/* global io */
"use strict";

const socket = io();
const app = document.getElementById("app");
const SESSION_KEY = "crg-session";
const APP_VERSION = "0.2.0";
const APP_TITLE = "💡 SimPlastic - The Clinical Reasoning Game";
const CREDIT = "Developed by Phachara Longmeewong, MD, FRCST (ThPRS)";
const DEVELOPER = { name: "Phachara Longmeewong, MD", email: "L_phachara@kkumail.com" };
const NO_PII_NOTE = `<p class="small pii-note">⚠ ห้ามใส่ชื่อ หรือข้อมูลที่ระบุตัวบุคคล/ผู้ป่วยจริง</p>`;
const creditLine = () => `<p class="credit">${CREDIT}</p>`;
const brandWordmark = () => `<span class="brand-text" style="font-size:.85rem">SimPlastic <span class="muted" style="font-weight:600">- The Clinical Reasoning Game</span> <span class="brand-version">v${APP_VERSION}</span></span>`;

let S = null; // latest server view
let clockSkew = 0;
const ui = {
  groupFilter: 0,
  carouselIndex: 0, // position within the (filtered) case list while browsing on the case-select screen
  carouselDir: 1, // which way the card most recently moved (1 = forward/next, -1 = back/prev), for the slide-in animation
  pendingSel: null, // question the patient/facilitator is answering
  drafts: {}, // local-only input values keyed by element id
  micFor: null, // id of the field currently being dictated into
  micLang: (() => { try { return localStorage.getItem("crg-mic-lang") || "th-TH"; } catch { return "th-TH"; } })(),
  soundOn: (() => { try { return localStorage.getItem("crg-sound") !== "off"; } catch { return true; } })(),
  animatedRoles: new Set(), // roles whose room-stage sprite has already played its entrance
  feedbackDismissed: false, // viewer closed the end-of-game satisfaction pop-up without submitting
  feedbackDraft: { caseRating: 0, playersRating: 0, systemRating: 0 }, // local star picks before submit
  chatOpen: (() => { try { return localStorage.getItem("crg-chat-open") !== "closed"; } catch { return true; } })(),
  chatPos: (() => { try { return JSON.parse(localStorage.getItem("crg-chat-pos") || "null"); } catch { return null; } })(), // {x,y} top-left px, null = default corner
  chatUnread: 0, // messages received while the panel is collapsed
};

// ---------- 8-bit sound effects (synthesized, no audio files) ----------
// Shared AudioContext for sfx + music. Browsers require a user gesture before audio
// can actually make sound, so this is only ever called from inside a click handler.
let audioCtxShared = null;
function getAudioCtx() {
  if (!ui.soundOn) return null;
  if (!audioCtxShared) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtxShared = new AC();
  }
  if (audioCtxShared.state === "suspended") audioCtxShared.resume();
  return audioCtxShared;
}

const sfx = (() => {
  const get = getAudioCtx;
  // One square-wave blip: freq (Hz), start offset (s), duration (s), peak volume.
  function blip(freq, t0, dur, vol = 0.05) {
    const c = get();
    if (!c) return;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(freq, c.currentTime + t0);
    gain.gain.setValueAtTime(0, c.currentTime + t0);
    gain.gain.linearRampToValueAtTime(vol, c.currentTime + t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + t0 + dur);
    osc.connect(gain).connect(c.destination);
    osc.start(c.currentTime + t0);
    osc.stop(c.currentTime + t0 + dur + 0.02);
  }
  return {
    click: () => blip(520, 0, 0.05, 0.04),
    confirm: () => {
      blip(660, 0, 0.06, 0.045);
      blip(880, 0.06, 0.09, 0.045);
    },
    error: () => {
      blip(220, 0, 0.09, 0.05);
      blip(140, 0.09, 0.13, 0.05);
    },
    reveal: () => {
      blip(784, 0, 0.05, 0.04);
      blip(988, 0.05, 0.05, 0.04);
      blip(1319, 0.1, 0.09, 0.04);
    },
    // Classic "got a coin" blip (B5 -> high E6) for claiming a role in the lobby.
    coin: () => {
      blip(987.77, 0, 0.05, 0.05);
      blip(1318.51, 0.05, 0.22, 0.05);
    },
    toggle: () => {
      ui.soundOn = !ui.soundOn;
      try {
        localStorage.setItem("crg-sound", ui.soundOn ? "on" : "off");
      } catch {}
      if (ui.soundOn) {
        blip(660, 0, 0.07, 0.045);
        if (!S || !S.me) music.start(); // still on the opening screen
      } else {
        music.stop();
      }
    },
  };
})();

// Opening-screen theme: a short looping chiptune (curious, upbeat i–VI–III–VII progression),
// scheduled with a lookahead so it loops without drift. Stops the moment a room is joined.
const music = (() => {
  const TEMPO = 152; // BPM
  const LOOKAHEAD_MS = 25;
  const SCHEDULE_AHEAD = 0.1; // seconds
  const N = {
    F3: 174.61, G3: 196.0, A3: 220.0, C4: 261.63,
    F4: 349.23, G4: 392.0, A4: 440.0, B4: 493.88, C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99,
  };
  // 16 eighth-note steps = 2 bars. Am (i) – F (VI) – C (III) – G (VII): a classic
  // rising, adventurous game-overworld progression that loops back to A on step 0.
  const LEAD = [N.A4, N.C5, N.E5, N.C5, N.F4, N.A4, N.C5, N.A4, N.C5, N.E5, N.G5, N.E5, N.G4, N.B4, N.D5, N.B4];
  const BASS = [N.A3, 0, N.A3, 0, N.F3, 0, N.F3, 0, N.C4, 0, N.C4, 0, N.G3, 0, N.G3, 0];

  let step = 0;
  let nextTime = 0;
  let timer = null;
  let playing = false;

  function tone(type, freq, t, dur, vol) {
    const c = getAudioCtx();
    if (!c) return;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(c.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  function scheduleStep(i, t) {
    const stepDur = 60 / TEMPO / 2;
    if (LEAD[i]) tone("square", LEAD[i], t, stepDur * 0.82, 0.03);
    if (BASS[i]) tone("triangle", BASS[i], t, stepDur * 1.7, 0.05);
  }

  function scheduler() {
    const c = getAudioCtx();
    if (!c) return;
    while (nextTime < c.currentTime + SCHEDULE_AHEAD) {
      scheduleStep(step, nextTime);
      nextTime += 60 / TEMPO / 2;
      step = (step + 1) % LEAD.length;
    }
  }

  return {
    start() {
      if (playing) return;
      const c = getAudioCtx();
      if (!c) return; // sound is off, or no AudioContext support
      playing = true;
      step = 0;
      nextTime = c.currentTime + 0.05;
      timer = setInterval(scheduler, LOOKAHEAD_MS);
    },
    stop() {
      playing = false;
      if (timer) clearInterval(timer);
      timer = null;
    },
    get playing() {
      return playing;
    },
  };
})();

const ROLE_ICON = { facilitator: "🎓", patient: "🛏️", doctor: "🩺", scribe: "📝", bias: "⚖️", observer: "👀" };
// Small round avatar cropped from each role's own sprite, used everywhere a role is
// labeled (role cards, chips, captions, guides). ROLE_ICON's emoji stays only as the
// sprite-load-failure fallback inside the room stage itself, not as a label icon.
const roleAvatar = (role, size = 20) =>
  role
    ? `<img src="game-assets/sprites/${role === "patient" ? "patient-mystery" : role}-1.png" alt="" class="role-avatar" style="width:${size}px;height:${size}px" onerror="this.style.visibility='hidden'" />`
    : "";

// Virtual exam room: sprite sheets are 1 row x 4 frames (idle A, idle B, talk, action) on a
// magenta chroma-key background, dropped in public/game-assets/sprites/. Falls back to a
// role-colored emoji tile until a file exists at that path (checked via onerror).
const ROOM_BG = "game-assets/room-day.webp";
const ROOM_BG_NIGHT = "game-assets/room-night.webp";
const ROOM_POS = {
  observer: { x: 7, y: 88, facing: "right" },
  facilitator: { x: 21, y: 80, facing: "right" },
  patient: { x: 49, y: 76, facing: "right" },
  doctor: { x: 65, y: 84, facing: "left" },
  scribe: { x: 77, y: 86, facing: "left" },
  bias: { x: 93, y: 92, facing: "left" },
};
function patientSpriteKey(cv) {
  const s = `${cv.stem || ""} ${cv.title || ""}`;
  if (/ทารก|แรกเกิด|neonat/i.test(s)) return "baby";
  const m = s.match(/อายุ\s*(\d+)\s*(ปี|วัน|เดือน|สัปดาห์)/);
  if (m && m[2] !== "ปี") return "baby";
  const n = m ? Number(m[1]) : null;
  const female = /หญิง/.test(s) && !/ชาย/.test(s);
  if (n != null) {
    if (n < 13) return "child";
    if (n >= 60) return female ? "elder-f" : "elder-m";
  }
  return female ? "adult-f" : "adult-m";
}
function spriteKey(role, cv) {
  // Before a case is picked (lobby), nobody knows who the patient is yet.
  if (role === "patient") return `patient-${cv ? patientSpriteKey(cv) : "mystery"}`;
  return role;
}
function spriteSrc(role, cv, frame) {
  return `game-assets/sprites/${spriteKey(role, cv)}-${frame}.png`;
}
const ROLE_DESC = {
  facilitator: "คุมเวลาและลำดับขั้น เลือกการ์ด เปิด PE finding / เฉลย investigation / นำ debrief",
  patient: "ถือข้อมูลลับของผู้ป่วย ตอบเฉพาะเมื่อถูกถามตรงประเด็นเท่านั้น",
  doctor: "ซักประวัติแบบ hypothesis-driven ขอตรวจร่างกายอย่างเจาะจง และสั่ง investigation",
  scribe: "จดบันทึกให้ทีม เขียน Problem list + Problem representation one-liner",
  bias: "จับ anchoring / premature closure ระหว่างเล่น และนำ diagnostic time-out (ถ้ามี 4 คน Scribe ทำหน้าที่นี้แทน)",
  observer: "ดูเกมได้ทุกอย่างเท่ากับทีม (ไม่เห็นข้อมูลลับของผู้ป่วย/facilitator) แต่กดหรือแก้ไขอะไรไม่ได้ เหมาะกับผู้เยี่ยมชม",
};

// What "Ready" means for each role, shown on the ready toggle and its confirmation.
const ROLE_READY_LABEL = {
  facilitator: "พร้อมจะสอนแล้ว",
  patient: "พร้อมจะให้ถามแล้ว",
  doctor: "พร้อมจะสืบค้นโรคแล้ว",
  scribe: "พร้อมจะบันทึกแล้ว",
  bias: "พร้อมจะจับผิดแล้ว",
  observer: "พร้อมจะสังเกตแล้ว",
};

// ---------- helpers ----------
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const player = (id) => (S && S.players.find((p) => p.id === id)) || { name: "?", role: null };
const roleLabel = (r) => (r && S.roles[r] ? S.roles[r].label : "ยังไม่เลือก");
const roleChip = (r) => (r ? `<span class="tag role-chip" data-role="${r}">${roleAvatar(r, 16)} ${esc(roleLabel(r))}</span>` : `<span class="tag">ยังไม่เลือกบทบาท</span>`);
const levelTag = (l) => `<span class="tag ${/must/i.test(l) ? "must" : /should/i.test(l) ? "should" : ""}">${esc(l)}</span>`;
const draft = (id, fallback = "") => (id in ui.drafts ? ui.drafts[id] : fallback);

// ---------- speech to text (Web Speech API: Chrome, Edge, Safari) ----------
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
const speechOK = !!SpeechRec && window.isSecureContext;
let rec = null;

// Fields that must be medical English: exam requests, PL, PR and the exit-ticket one-liner.
const EN_ONLY = new Set(["ask-exam", "pl", "pr", "t-one"]);
const hasThai = (s) => /[\u0E00-\u0E7F]/.test(s || "");
const enWarn = (id, v) => (EN_ONLY.has(id) && hasThai(v) ? `<div class="en-warn small">⚠ ช่องนี้ต้องเป็น medical English เท่านั้น — พบภาษาไทย</div>` : "");

const micBtn = (id) =>
  speechOK
    ? `<button type="button" class="btn sm mic ${ui.micFor === id ? "on" : ""}" data-act="mic" data-v="${id}" title="${ui.micFor === id ? "หยุดฟัง" : "พูดเพื่อพิมพ์"}" aria-label="พูดเพื่อพิมพ์" aria-pressed="${ui.micFor === id}">${ui.micFor === id ? "⏹" : `<img src="game-assets/icons/mic.png" alt="" class="icon-mic" />`}</button>`
    : "";
const soundToggleBtn = () =>
  `<button type="button" class="btn sm ghost" data-act="soundToggle" title="${ui.soundOn ? "ปิดเสียง" : "เปิดเสียง"}" aria-label="สลับเสียง" aria-pressed="${ui.soundOn}">${ui.soundOn ? "🔊" : "🔇"}</button>`;

// discard=true drops any audio not yet transcribed (used after sending or changing phase).
function stopMic(discard = false) {
  if (!rec) return;
  if (discard) {
    rec.onresult = null;
    rec.abort();
  } else rec.stop();
}

function startMic(id) {
  stopMic(true);
  const r = new SpeechRec();
  r.lang = EN_ONLY.has(id) ? "en-US" : ui.micLang;
  r.continuous = true;
  r.interimResults = true;
  let base = null;
  r.onresult = (e) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (base === null) base = el.value ? el.value.replace(/\s*$/, " ") : "";
    let finalText = "";
    let interim = "";
    for (let i = 0; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += t;
      else interim += t;
    }
    el.value = (base + finalText + interim).slice(0, el.maxLength > 0 ? el.maxLength : 4000);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  r.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") toast("ไม่ได้รับอนุญาตให้ใช้ไมโครโฟน — อนุญาตในเบราว์เซอร์ก่อน");
    else if (e.error === "no-speech") toast("ไม่ได้ยินเสียง ลองใหม่อีกครั้ง");
    else if (e.error !== "aborted") toast("ถอดเสียงไม่สำเร็จ: " + e.error);
  };
  r.onend = () => {
    if (rec === r) {
      rec = null;
      ui.micFor = null;
      render();
    }
  };
  rec = r;
  ui.micFor = id;
  try {
    r.start();
  } catch {
    rec = null;
    ui.micFor = null;
  }
  render();
  const el = document.getElementById(id);
  if (el) el.focus();
}

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
      if (!res.ok) {
        toast(res.error);
        sfx.error();
      } else if (type === "answer") {
        sfx.reveal();
      } else if (type === "pickRole" && payload && payload.role) {
        sfx.coin();
      } else if (["startGame", "submitInvest", "submitPlpr", "revealTimeout", "ticket", "toggleReady"].includes(type)) {
        sfx.confirm();
      }
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

// Browsers block audio until a user gesture; this starts the opening theme on the
// visitor's first tap/click, but only while the opening screen is still showing.
document.addEventListener(
  "pointerdown",
  () => {
    if ((!S || !S.me) && ui.soundOn && !music.playing) music.start();
  },
  { capture: true },
);

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
  const firstStateThisSession = !S;
  const prevChatLen = S ? S.chat.length : 0;
  S = view;
  if (!firstStateThisSession && !ui.chatOpen && view.chat.length > prevChatLen && view.chat[view.chat.length - 1].by !== view.me?.id) {
    ui.chatUnread += view.chat.length - prevChatLen;
  }
  clockSkew = view.serverNow - Date.now();
  if (view.me) music.stop(); // safety net: never let the opening theme play once seated in a room
  // On a fresh page load resuming an existing room, don't replay the entrance
  // animation for players who were already there — only for ones who join afterwards.
  if (firstStateThisSession) for (const p of view.players) if (p.role) ui.animatedRoles.add(p.role);
  if (prevPhase !== view.phase) {
    ui.pendingSel = null;
    stopMic(true);
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

  if (!S || S.phase !== "summary") {
    ui.feedbackDismissed = false;
    ui.feedbackDraft = { caseRating: 0, playersRating: 0, systemRating: 0 };
  }
  app.innerHTML = !S || !S.me ? viewHome() : S.phase === "lobby" ? viewLobby() : viewGame();
  const cardNo = S && (S.caseView?.no ?? S.catalog?.cards.find((c) => c.id === S.caseId)?.no);
  document.title = cardNo ? `${APP_TITLE} : Card No. ${String(cardNo).padStart(2, "0")}` : APP_TITLE;

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
  <div class="home-screen" style="background-image:url(game-assets/room-night.webp)">
    <div class="home-sound-toggle">${soundToggleBtn()}</div>
    <div class="home-content">
      <img src="game-assets/logo.webp" alt="SimPlastic — The Clinical Reasoning Game" class="logo-image" />
      <p class="tagline">Plastic Surgery · 34 การ์ด · 4–6 ผู้เล่น</p>

      <div class="join-card stack">
        <input type="text" id="code" maxlength="4" inputmode="text" placeholder="รหัสห้อง" value="${esc(draft("code", code))}" class="pin-input" autocomplete="off" autocapitalize="characters" />
        <input type="text" id="name" maxlength="24" placeholder="ชื่อของคุณ" value="${esc(draft("name"))}" class="name-input" autocomplete="off" />
        <button class="btn-huge primary" data-act="join">เข้าร่วมห้อง →</button>
        ${code ? "" : `<div class="home-or">หรือ</div><button class="btn-huge ghost" data-act="create">สร้างห้องใหม่ (สำหรับ Facilitator)</button>`}
      </div>

      <details class="howto-collapse">
        <summary>วิธีเล่น</summary>
        <ol class="small">
          <li>สร้างห้อง แชร์รหัสให้เพื่อน 4–6 คน แต่ละคนเลือกบทบาท</li>
          <li>Facilitator เลือกการ์ดเคส ทุกคนอ่าน Opening stem</li>
          <li>Doctor ซักประวัติ → Patient เปิดข้อมูลเฉพาะที่ถูกถามตรงประเด็น</li>
          <li>Doctor ขอตรวจร่างกายอย่างเจาะจง → Facilitator เปิด finding</li>
          <li>ทีมเลือก investigation พร้อมเหตุผล → เฉลย</li>
          <li>Scribe เขียน Problem list + one-liner → เทียบกับ Expected PL/PR</li>
          <li>Bias monitor นำ diagnostic time-out (System 1 vs 2)</li>
          <li>Faculty debrief → Exit ticket รายบุคคล → สรุปผล</li>
        </ol>
      </details>
      <p class="disclaimer">เอกสารนี้เพื่อการศึกษาจำลองเท่านั้น ไม่ใช่คำแนะนำสำหรับผู้ป่วยจริง รายละเอียดเชิง protocol ต้องตรวจทานกับ local guideline ก่อนใช้สอนจริง</p>
      ${creditLine()}
    </div>
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
      // Always minimal: icon + title only. The description lives in the info box above.
      const pickable = !holder || mine;
      const portrait = `game-assets/sprites/${r === "patient" ? "patient-mystery" : r}-portrait.png`;
      const status = holder
        ? mine
          ? me.ready
            ? `✓ ${esc(ROLE_READY_LABEL[r])}`
            : "✓ คุณ"
          : "เลือกแล้วโดย " + esc(holder.name)
        : def.required
          ? `<span class="tag must">จำเป็น</span>`
          : `<span class="tag">ไม่บังคับ</span>`;
      return `<div class="role-card sf ${mine ? "mine" : ""} ${pickable ? "" : "locked"}" data-role="${r}"
        ${pickable && !(mine && me.ready) ? `data-act="pickRole" data-v="${r}"` : ""} title="${esc(ROLE_DESC[r])}">
        <div class="role-portrait"><img src="${portrait}" alt="" onerror="this.style.visibility='hidden'" /></div>
        ${mine && me.ready ? `<span class="role-ready-badge">✓</span>` : ""}
        <div class="role-nameplate"><span class="title">${esc(def.label)}</span><span class="taken">${status}</span></div>
      </div>`;
    })
    .join("");
  // Floating caption over the room image (near the floor) instead of a separate box:
  // your picked role's description, or a prompt before you've picked one.
  const roomCaption = me.role
    ? `<b data-role="${me.role}">${roleAvatar(me.role, 18)} ${esc(S.roles[me.role].label)}:</b> ${esc(ROLE_DESC[me.role])}`
    : "เลือกบทบาทด้านล่างเพื่อดูรายละเอียด";
  const readyBtn = me.role
    ? `<button type="button" class="btn sm ${me.ready ? "ghost" : "primary"}" data-act="toggleReady">${me.ready ? `✓ ${esc(ROLE_READY_LABEL[me.role])} (กดแก้ไข)` : "✓ พร้อม"}</button>`
    : "";
  const slots = [];
  for (let i = 0; i < S.limits.max; i++) {
    const p = S.players[i];
    slots.push(
      p
        ? `<li class="${p.connected ? "" : "offline"}"><span class="role-dot" data-role="${p.role || ""}"></span>
            <span style="flex:1">${esc(p.name)}${p.id === S.hostId ? ' <span class="tag">host</span>' : ""}${p.id === me.id ? ' <span class="muted small">(คุณ)</span>' : ""}</span>
            ${p.ready ? `<span class="tag ok" title="พร้อมแล้ว">✓</span>` : ""}
            ${roleChip(p.role)}
            ${isHost && p.id !== me.id ? `<button class="btn sm ghost danger" data-act="kick" data-v="${p.id}" title="นำออก">✕</button>` : ""}</li>`
        : `<li class="muted"><span class="role-dot"></span> ว่าง ${i >= S.limits.min ? "(ไม่บังคับ)" : ""}</li>`,
    );
  }
  const canStart = !S.lobbyProblems.length;
  return `
  <div class="home-screen lobby-screen" style="background-image:url(game-assets/room-night.webp)">
    <div class="home-sound-toggle">${soundToggleBtn()}</div>
    <div class="lobby-content">
      <div class="row spread lobby-top">
        <div class="row"><img src="game-assets/icons/bulb.png" alt="SP-CRG" class="brand-bulb" />
          <span style="color:#fff">${brandWordmark()}</span><span class="code-chip">${esc(S.code)}</span></div>
        <button class="btn sm ghost" data-act="leave" style="color:#fff;border-color:rgba(255,255,255,.4)">ออกจากห้อง</button>
      </div>

      ${roomStage(true, ROOM_BG_NIGHT, roomCaption)}

      <div class="lobby-grid">
        <div class="join-card">
          <div class="row spread">
            <div><div class="muted small">ขั้นที่ 1 · เลือกบทบาท</div><h2 style="margin:0">เลือกบทบาทของคุณ</h2></div>
            ${readyBtn}
          </div>
          <p class="muted small">เลือกได้บทบาทละ 1 คน · ต้องมีครบ 4 บทบาทหลัก (Bias monitor และ Observer ไม่บังคับ)</p>
          ${me.consent === null ? "" : `<p class="small muted">การเก็บข้อมูล: <b>${me.consent ? "ยินยอม" : "ไม่ยินยอม"}</b> · <button type="button" class="linkish" data-act="consentReset">เปลี่ยน</button></p>`}
          <div class="roles">${roleCards}</div>
        </div>
        <div class="stack">
          <div class="join-card">
            <div class="muted small">รหัสห้อง · แชร์ลิงก์เชิญ</div>
            <div class="code" style="font-size:1.8rem">${esc(S.code)}</div>
            <button class="btn sm" data-act="copy" data-v="${esc(link)}" style="width:100%">คัดลอกลิงก์เชิญ</button>
          </div>
          <div class="join-card players">
            <h3>ผู้เล่น ${S.players.length}/${S.limits.max}</h3>
            <ul>${slots.join("")}</ul>
          </div>
          <div class="join-card stack">
            ${canStart ? `<p class="small" style="color:var(--ok)">✓ พร้อมเริ่มเกม</p>` : `<ul class="checklist-problems">${S.lobbyProblems.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`}
            ${isHost || me.role === "facilitator"
              ? `<button class="btn-huge primary" data-act="startGame" ${canStart ? "" : "disabled"}>เริ่มเกม →</button>`
              : `<p class="muted small">รอ host หรือ Facilitator กดเริ่มเกม</p>`}
          </div>
        </div>
      </div>
      ${creditLine()}
    </div>
  </div>
  ${me.consent === null ? viewConsentModal() : ""}`;
}

// ---------- Research-data consent (asked once per player, in the lobby) ----------
function viewConsentModal() {
  return `<div class="modal-backdrop">
    <div class="modal panel stack consent-modal" role="dialog" aria-modal="true" aria-labelledby="consent-title">
      <h2 id="consent-title" style="margin:0">การยินยอมให้เก็บข้อมูลเพื่อพัฒนาการเรียนการสอน</h2>
      <p>เกมนี้ขอเก็บ<b>คะแนนความพึงพอใจ ข้อเสนอแนะ และ exit ticket</b> ของคุณ พร้อมเคสที่เล่น บทบาท และวันที่ เพื่อนำไปปรับปรุงเกมและการสอน clinical reasoning</p>
      <ul class="small">
        <li><b>ไม่เก็บชื่อ</b> รหัสห้อง หรือข้อมูลใดที่ระบุตัวคุณได้ กรุณาอย่าพิมพ์ชื่อตัวเองหรือข้อมูลผู้ป่วยจริงลงในช่องข้อความ</li>
        <li>การยินยอม<b>เป็นไปโดยสมัครใจ</b> ถ้าไม่ยินยอม คุณยังเล่นได้ครบและได้ใบประกาศเหมือนเดิม และไม่มีผลต่อการประเมินใดๆ</li>
        <li>เนื่องจากข้อมูลไม่ระบุตัวตน หลังส่งแล้วจะ<b>ขอถอนย้อนหลังไม่ได้</b></li>
        <li>ข้อมูลเข้าถึงได้เฉพาะผู้พัฒนาเท่านั้น</li>
        <li>ติดต่อสอบถาม: ${esc(DEVELOPER.name)} · <a href="mailto:${esc(DEVELOPER.email)}">${esc(DEVELOPER.email)}</a></li>
      </ul>
      <div class="row spread">
        <button type="button" class="btn ghost" data-act="consent" data-v="no">ไม่ยินยอม</button>
        <button type="button" class="btn primary" data-act="consent" data-v="yes">ยินยอม</button>
      </div>
    </div>
  </div>`;
}

// ---------- Game shell ----------
// showEmpty=true (lobby) also draws a dashed placeholder for roles nobody has picked
// yet. A role's sprite gets a one-time "pop in" entrance the first time it's seen
// filled (tracked in ui.animatedRoles), so later re-renders (chat, timers, ...) don't
// keep replaying it.
function roomStage(showEmpty = false, bg = ROOM_BG, caption = null) {
  const cv = S.caseView;
  const sprites = Object.keys(ROOM_POS)
    .map((role) => {
      const p = S.players.find((x) => x.role === role);
      const pos = ROOM_POS[role];
      const posStyle = `left:${pos.x}%;top:${pos.y}%`;
      if (!p) {
        if (!showEmpty) return "";
        return `<div class="room-sprite empty-slot" style="${posStyle}">
          <div class="sprite-frame idle empty"><span class="sprite-fallback-icon">${ROLE_ICON[role]}</span></div>
          <div class="sprite-name muted">ว่าง</div>
        </div>`;
      }
      const src = spriteSrc(role, cv, 1);
      const firstSeen = !ui.animatedRoles.has(role);
      ui.animatedRoles.add(role);
      return `<div class="room-sprite ${firstSeen ? "sprite-enter" : ""}" id="spr-${role}" data-role="${role}" data-facing="${pos.facing}"
        style="${posStyle}">
        <div class="bubble" id="bub-${role}" hidden></div>
        <div class="sprite-frame idle" data-frame="1">
          <img src="${src}" alt="" onerror="this.closest('.sprite-frame').classList.add('fallback')" />
          <span class="sprite-fallback-icon">${ROLE_ICON[role]}</span>
        </div>
        <div class="sprite-name">${esc(p.name)}</div>
      </div>`;
    })
    .join("");
  const captionHtml = caption ? `<div class="room-caption">${caption}</div>` : "";
  return `<div class="room-stage" style="background-image:url(${bg})">${sprites}${captionHtml}</div>`;
}

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
        <img src="game-assets/icons/bulb.png" alt="SP-CRG" class="brand-bulb" style="width:34px;height:34px" />
        <div>${cv ? `<b>${esc(cv.title)}</b>` : brandWordmark()}
        <div class="muted small">ห้อง <span class="code">${esc(S.code)}</span> · ${roleChip(S.me.role)}</div></div>
      </div>
      <div class="row">${soundToggleBtn()}${speechOK ? `<button class="btn sm ghost" data-act="micLang" title="ภาษาที่ใช้ถอดเสียง">🎙 ${ui.micLang === "th-TH" ? "ไทย" : "EN"}</button>` : ""}<span class="timer muted small" id="timer"></span>${nav}</div>
    </div>
    <div class="stepper">${stepper}</div>
  </div></header>
  <div class="wrap">
    ${roomStage(false, ROOM_BG, S.me.role ? roleGuide() : null)}
    <div class="layout" ${cv ? "" : 'style="grid-template-columns:minmax(0,1fr) 300px"'}>
      ${cv ? `<aside class="case-col">${viewCaseCard(cv)}</aside>` : ""}
      <main class="stack">${main}</main>
      <aside class="stack">${viewSide()}</aside>
    </div>
    <p class="disclaimer">เพื่อการศึกษาจำลองเท่านั้น ไม่ใช่คำแนะนำสำหรับผู้ป่วยจริง · รายละเอียด protocol ให้ตรวจทานกับ local guideline</p>
    ${creditLine()}
  </div>
  ${viewChatWidget()}
  ${S.me.consent === null ? viewConsentModal() : S.phase === "summary" && !S.feedbackSubmitted && !ui.feedbackDismissed ? viewFeedbackModal() : ""}`;
}

// ---------- End-of-game satisfaction pop-up ----------
function starRow(id, label) {
  const v = ui.feedbackDraft[id];
  const stars = [1, 2, 3, 4, 5]
    .map(
      (n) =>
        `<button type="button" class="star-btn" data-act="fbStar" data-id="${id}" data-v="${n}" aria-label="${n} ดาว">
          <img src="game-assets/icons/star-${n <= v ? "filled" : "outline"}.png" alt="" />
        </button>`,
    )
    .join("");
  return `<div class="fb-row"><span class="fb-label">${label}</span><div class="fb-stars">${stars}</div></div>`;
}

function viewFeedbackModal() {
  const d = ui.feedbackDraft;
  const canSubmit = d.caseRating && d.playersRating && d.systemRating;
  return `<div class="modal-backdrop">
    <div class="modal panel stack">
      <div class="row spread"><h2 style="margin:0">ให้คะแนนความพึงพอใจ</h2><button type="button" class="btn sm ghost" data-act="fbSkip" aria-label="ปิด">✕</button></div>
      <p class="muted small">ช่วยให้คะแนน 1–5 ดาว เพื่อพัฒนาเกมนี้ต่อไป</p>
      ${starRow("caseRating", "โจทย์ (เคส)")}
      ${starRow("playersRating", "ผู้เล่น (ทีม)")}
      ${starRow("systemRating", "ระบบเกม")}
      <label class="field"><span>ข้อเสนอแนะเพิ่มเติม (ถ้ามี)</span>
        <textarea id="fb-comment" rows="3" placeholder="เขียนความคิดเห็นของคุณ…">${esc(draft("fb-comment"))}</textarea></label>
      ${NO_PII_NOTE}
      <div class="row spread">
        <button type="button" class="btn ghost" data-act="fbSkip">ข้าม</button>
        <button type="button" class="btn primary" data-act="fbSubmit" ${canSubmit ? "" : "disabled"}>ส่งคะแนน</button>
      </div>
    </div>
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

// What should *I* be doing in this phase? — shown as a floating caption over the room-stage image.
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
  return `<b data-role="${r}">${roleAvatar(r, 18)} บทบาทของคุณตอนนี้:</b> ${esc(text)}${extra}`;
}

// ---------- Phase: case ----------
function viewCase() {
  if (!S.powers.control || !S.catalog) {
    return `<div class="panel"><h2>รอ Facilitator เลือกการ์ด…</h2><p class="muted">อย่าเพิ่งเดา — ข้อมูลทั้งหมดจะถูกปลดล็อกทีละส่วนตามที่ทีมถามและตรวจ</p></div>`;
  }
  const { groups, cards } = S.catalog;
  const shown = cards.filter((c) => !ui.groupFilter || c.group === ui.groupFilter);
  if (ui.carouselIndex >= shown.length) ui.carouselIndex = 0;
  if (ui.carouselIndex < 0) ui.carouselIndex = shown.length - 1;
  const current = shown[ui.carouselIndex];
  const picked = current && S.caseId === current.id;
  return `<div class="panel stack">
    <div class="row spread"><h2 style="margin:0">เลือกการ์ดเคส</h2><button class="btn" data-act="carouselRandom">🎲 สุ่มการ์ด</button></div>
    <div class="tabs">
      <button class="btn sm ${!ui.groupFilter ? "on" : ""}" data-act="groupFilter" data-v="0">ทั้งหมด (${cards.length})</button>
      ${groups.map((g) => `<button class="btn sm ${ui.groupFilter === g.no ? "on" : ""}" data-act="groupFilter" data-v="${g.no}">${g.no}. ${esc(g.name)}</button>`).join("")}
    </div>
    ${!current ? `<p class="muted">ไม่มีการ์ดในกลุ่มนี้</p>` : viewCaseCarousel(shown, current, groups, picked)}
  </div>`;
}

// The small preview of the previous/next card beside the featured one, plus the dots
// strip and confirm button below it. Split out from viewCase() only to keep that
// function's template literal from nesting an inline IIFE.
function viewCaseCarousel(shown, current, groups, picked) {
  const n = shown.length;
  const peek = (offset) => {
    if (n < 2) return "";
    // With only 2 cards, prev and next are the same card — show it once, on the side it's headed to.
    if (n === 2 && offset === -1) return "";
    const c = shown[(((ui.carouselIndex + offset) % n) + n) % n];
    return `<button type="button" class="peek-card ${offset < 0 ? "prev" : "next"}" data-act="carouselNav" data-v="${offset}" aria-label="${offset < 0 ? "การ์ดก่อนหน้า" : "การ์ดถัดไป"}: ${esc(c.title)}" title="${esc(c.title)}">
      ${c.image ? `<img src="card-assets/${esc(c.image)}" alt="" loading="lazy" />` : `<div class="noimg">🩹</div>`}
    </button>`;
  };
  return `<div class="carousel">
      <button type="button" class="carousel-nav prev" data-act="carouselNav" data-v="-1" aria-label="การ์ดก่อนหน้า" ${n < 2 ? "disabled" : ""}>‹</button>
      <div class="carousel-track">
        ${peek(-1)}
        <div class="carousel-card ${picked ? "picked" : ""} ${ui.carouselDir === 1 ? "dir-next" : "dir-prev"}" data-key="${current.id}">
          ${current.image ? `<img src="card-assets/${esc(current.image)}" alt="" />` : `<div class="noimg">🩹</div>`}
          <div class="carousel-info">
            <div class="row" style="justify-content:center">${levelTag(current.level)}<span class="tag">G${current.group} · ${esc(groups.find((g) => g.no === current.group)?.name || "")}</span></div>
            <h3>${esc(current.title)}</h3>
            <div class="carousel-info-sub">การ์ดที่ ${ui.carouselIndex + 1} / ${n}</div>
          </div>
        </div>
        ${peek(1)}
      </div>
      <button type="button" class="carousel-nav next" data-act="carouselNav" data-v="1" aria-label="การ์ดถัดไป" ${n < 2 ? "disabled" : ""}>›</button>
    </div>
    <div class="carousel-dots">${shown
      .map((c, i) => `<button type="button" class="dot ${i === ui.carouselIndex ? "on" : ""} ${S.caseId === c.id ? "picked" : ""}" data-act="carouselJump" data-v="${i}" title="${esc(c.title)}"></button>`)
      .join("")}</div>
    <button class="btn-huge primary" data-act="selectCase" data-v="${current.id}" style="max-width:320px;margin:0 auto">${picked ? "✓ เลือกการ์ดนี้แล้ว" : "เลือกการ์ดนี้ →"}</button>
    ${S.caseId && !picked ? `<p class="small muted" style="text-align:center">เลือกไว้ก่อนหน้า: <b>${esc(S.catalog.cards.find((c) => c.id === S.caseId)?.title || "")}</b></p>` : ""}`;
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
        ${isHist ? "" : `<p class="small muted" style="margin:0">ระบุการตรวจเป็น <b>medical English</b> เท่านั้น — ห้ามใช้ภาษาไทยหรือศัพท์ชาวบ้าน</p>`}
        <div class="row">
          <input type="text" id="ask-${kind}" maxlength="300" style="flex:1" placeholder="${isHist ? "เช่น ดูดนมแล้วมีนมไหลออกทางจมูกไหม" : "e.g. Inspect the hard and soft palate with a pen torch and tongue depressor"}" value="${esc(draft("ask-" + kind))}" />
          ${micBtn("ask-" + kind)}
          <button class="btn primary" data-act="ask" data-v="${kind}">${isHist ? "ถาม" : "ขอตรวจ"}</button>
        </div>
        ${isHist ? "" : `<div id="warn-ask-exam">${enWarn("ask-exam", draft("ask-exam"))}</div>`}
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
            ? `<div class="row" style="flex-wrap:nowrap"><input type="text" id="inv-${r.idx}" data-sync="inv" data-v="${r.idx}" maxlength="300" placeholder="เหตุผล: ผลนี้จะเปลี่ยน management อย่างไร" value="${esc(sel[r.idx])}" />${micBtn("inv-" + r.idx)}</div>`
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
    <p class="small muted" style="margin:0">เขียน PL/PR เป็น <b>medical English</b> เท่านั้น — ห้ามใช้ภาษาไทยหรือศัพท์ชาวบ้าน</p>
    <label class="field"><span class="row spread">Problem list ของทีม (1–5 ข้อ) ${edit ? micBtn("pl") : ""}</span>
      <textarea id="pl" rows="6" data-sync="plpr" ${edit ? "" : "readonly"} placeholder="1. …">${esc(pl)}</textarea></label>
    <div id="warn-pl">${enWarn("pl", pl)}</div>
    <label class="field"><span class="row spread">Problem representation (one-liner) ${edit ? micBtn("pr") : ""}</span>
      <textarea id="pr" rows="4" data-sync="plpr" ${edit ? "" : "readonly"} placeholder="Age/sex, time course, mechanism, key positives/negatives, main clinical concern">${esc(pr)}</textarea></label>
    <div id="warn-pr">${enWarn("pr", pr)}</div>
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
    <label class="field"><span class="row spread">Must-not-miss ของทีม (เรียงจากอันตรายที่สุด) ${(P.bias || P.scribe) && !t.revealed ? micBtn("mnm") : ""}</span>
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
    `<label class="field"><span class="row spread">${label} ${micBtn(id)}</span><textarea id="${id}" rows="${id === "t-one" ? 3 : 2}" placeholder="${ph}">${esc(draft(id, v || ""))}</textarea></label>`;
  return `<div class="panel stack">
    <div class="row spread"><h2 style="margin:0">Exit ticket (รายบุคคล)</h2><span class="tag">${S.ticketCount}/${S.players.length} ส่งแล้ว</span></div>
    ${NO_PII_NOTE}
    <p class="small muted">ส่ง exit ticket เพื่อรับใบประกาศ (certificate) ตอนจบเกม</p>
    ${f("t-one", "1. One-liner สุดท้ายของคุณ (medical English)", "Final problem representation in medical English", mine && mine.oneLiner)}
    <div id="warn-t-one">${enWarn("t-one", draft("t-one", mine && mine.oneLiner))}</div>
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
      <div class="row">${S.tickets[S.me.id]
        ? `<button class="btn primary" data-act="certificate">🏅 ดาวน์โหลดใบประกาศ (PDF)</button>`
        : `<span class="small muted" title="ใบประกาศออกให้ผู้ที่ส่ง exit ticket">ไม่ได้ส่ง exit ticket จึงไม่มีใบประกาศ</span>`}
      <button class="btn" data-act="download">⬇ ดาวน์โหลดรายงาน (.md)</button>
      ${S.powers.control ? `<button class="btn primary" data-act="restart">เล่นเคสใหม่</button>` : ""}</div></div>
    <div class="stats">
      ${stat("ซักประวัติครอบคลุม", pct(st.historyCovered, st.historyTotal) + "%", `${st.historyCovered}/${st.historyTotal} ข้อ · ${st.questionsAsked} คำถาม`)}
      ${stat("ตรวจร่างกายครอบคลุม", pct(st.examCovered, st.examTotal) + "%", `${st.examCovered}/${st.examTotal} ข้อ · ${st.examsRequested} คำขอ`)}
      ${stat("เลือก investigation ที่ไม่ใช่ priority", `${st.lowPriorityChosen}/${st.lowPriorityTotal}`, "ยิ่งน้อยยิ่งดี")}
      ${stat("PL/PR rating", S.plpr.rating ? "★".repeat(S.plpr.rating) : "—", "จาก facilitator")}
      ${stat("S2 checklist", `${st.checklistDone}/${st.checklistTotal}`, "")}
      ${stat("Bias flags", st.flags, "")}
      ${stat("ความพึงพอใจเฉลี่ย", st.feedback.count ? `${((st.feedback.caseAvg + st.feedback.playersAvg + st.feedback.systemAvg) / 3).toFixed(1)} ★` : "—", `${st.feedback.count}/${S.players.length} คนให้คะแนน`)}
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

// ---------- Certificate (PDF, built entirely in the browser: the name never leaves this device) ----------
const loadScript = (src) =>
  new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const el = Object.assign(document.createElement("script"), { src, onload: resolve, onerror: () => reject(new Error("load " + src)) });
    document.head.appendChild(el);
  });

async function loadCertificateAssets() {
  if (!document.getElementById("cert-fonts")) {
    const link = Object.assign(document.createElement("link"), {
      id: "cert-fonts",
      rel: "stylesheet",
      href: "https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&family=Great+Vibes&display=swap",
    });
    document.head.appendChild(link);
    await new Promise((r) => { link.onload = r; link.onerror = r; });
  }
  await Promise.all([
    loadScript("vendor/html2canvas.min.js"),
    loadScript("vendor/jspdf.umd.min.js"),
    document.fonts.load('700 40px "Cinzel"'),
    document.fonts.load('60px "Great Vibes"'),
    document.fonts.load('600 20px "IBM Plex Sans Thai"'),
  ]);
}

function certificateHtml({ name, caseTitle, role, date, facilitator }) {
  return `<div class="cert">
    <div class="cert-frame">
      <img class="cert-logo" src="game-assets/logo.webp" alt="" />
      <div class="cert-kicker">Certificate of Participation</div>
      <div class="cert-line">This is to certify that</div>
      <div class="cert-name">${esc(name)}</div>
      <div class="cert-line">has completed the clinical reasoning simulation</div>
      <div class="cert-case">${esc(caseTitle)}</div>
      <div class="cert-line small">as <b>${esc(role)}</b> · ${esc(date)}</div>
      <div class="cert-signs">
        <div class="cert-sign">
          <div class="cert-script">${esc(facilitator || "—")}</div>
          <div class="cert-sign-rule"></div>
          <div class="cert-sign-name">${esc(facilitator || "")}</div>
          <div class="cert-sign-title">Facilitator</div>
        </div>
        <div class="cert-seal">SP<br />CRG</div>
        <div class="cert-sign">
          <div class="cert-script">Phachara Longmeewong</div>
          <div class="cert-sign-rule"></div>
          <div class="cert-sign-name">${esc(DEVELOPER.name)}</div>
          <div class="cert-sign-title">Developer</div>
        </div>
      </div>
      <div class="cert-foot">SimPlastic — The Clinical Reasoning Game · Plastic Surgery · Educational simulation only</div>
    </div>
  </div>`;
}

async function downloadCertificate() {
  toast("กำลังสร้างใบประกาศ…");
  await loadCertificateAssets();
  const facilitator = S.players.find((p) => p.role === "facilitator");
  const data = {
    name: S.me.name,
    caseTitle: S.caseView.title,
    role: S.roles[S.me.role]?.label || "",
    date: new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }),
    facilitator: facilitator && facilitator.name,
  };
  const host = document.createElement("div");
  host.className = "cert-host";
  host.innerHTML = certificateHtml(data);
  document.body.appendChild(host);
  try {
    await Promise.all([...host.querySelectorAll("img")].map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; }))));
    const canvas = await window.html2canvas(host.firstElementChild, { scale: 2, backgroundColor: "#fbf8f1", useCORS: true, logging: false });
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
    pdf.setProperties({ title: `SimPlastic certificate — ${data.caseTitle}`, author: DEVELOPER.name });
    pdf.addImage(canvas.toDataURL("image/jpeg", 0.95), "JPEG", 0, 0, 297, 210);
    const safe = data.name.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "player";
    pdf.save(`SimPlastic-certificate-${safe}.pdf`);
    sfx.coin();
  } finally {
    host.remove();
  }
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
  L.push(
    "## ความพึงพอใจ",
    `- ผู้ให้คะแนน: ${st.feedback.count}/${S.players.length}`,
    st.feedback.count ? `- โจทย์: ${st.feedback.caseAvg}★ · ผู้เล่น: ${st.feedback.playersAvg}★ · ระบบเกม: ${st.feedback.systemAvg}★` : "- ยังไม่มีใครให้คะแนน",
    ...(st.feedback.comments.length ? ["- ข้อเสนอแนะ:", ...st.feedback.comments.map((c) => `  - ${c}`)] : []),
    "",
  );
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
    .map((p) => `<li class="${p.connected ? "" : "offline"}"><span class="role-dot" data-role="${p.role}"></span><span style="flex:1">${esc(p.name)}${p.id === S.me.id ? " (คุณ)" : ""}</span><span class="small muted">${roleAvatar(p.role, 16)}</span></li>`)
    .join("")}</ul></div>`;
  const notes = inCase
    ? `<div class="panel stack"><div class="row spread"><h3 style="margin:0">📝 บันทึกของทีม</h3>${P.scribe ? micBtn("notes") : ""}</div>
        <textarea id="notes" rows="6" data-sync="notes" ${P.scribe ? "" : "readonly"} placeholder="${P.scribe ? "จด hypothesis, ข้อมูลสำคัญ, pertinent negative…" : "Scribe จะจดที่นี่"}">${esc(S.notes)}</textarea></div>`
    : "";
  const flags = inCase
    ? `<div class="panel stack"><h3 style="margin:0">⚖️ Bias flags</h3>
        ${P.bias
          ? `<select id="flag-bias">${S.biases.map((b) => `<option ${draft("flag-bias") === b ? "selected" : ""}>${esc(b)}</option>`).join("")}</select>
             <div class="row" style="flex-wrap:nowrap"><input type="text" id="flag-note" maxlength="300" placeholder="เกิดอะไรขึ้น" value="${esc(draft("flag-note"))}" />${micBtn("flag-note")}</div>
             <button class="btn sm" data-act="flag">ติด flag</button>`
          : ""}
        ${S.flags.length ? S.flags.slice(-5).reverse().map(flagHtml).join("") : `<p class="muted small">ยังไม่มี</p>`}</div>`
    : "";
  return players + notes + flags;
}

// ---------- Floating chat widget: separate from the main layout, collapsible and draggable ----------
function chatMessages() {
  return (
    S.chat.map((m) => { const p = player(m.by); return `<div><span class="role-dot" data-role="${p.role}"></span> <b>${esc(p.name)}</b>: ${esc(m.text)}</div>`; }).join("") ||
    '<span class="muted small">ยังไม่มีข้อความ</span>'
  );
}

function viewChatWidget() {
  const posStyle = ui.chatPos ? `left:${ui.chatPos.x}px;top:${ui.chatPos.y}px;right:auto;bottom:auto` : "";
  if (!ui.chatOpen) {
    return `<button type="button" class="chat-fab" data-act="chatToggle" style="${posStyle}" aria-label="เปิดแชท">
      💬${ui.chatUnread ? `<span class="chat-badge">${ui.chatUnread > 9 ? "9+" : ui.chatUnread}</span>` : ""}
    </button>`;
  }
  return `<div class="chat-widget" style="${posStyle}">
    <div class="chat-widget-header" data-act="chatDragHandle">
      <span>💬 แชท</span>
      <button type="button" class="chat-widget-close" data-act="chatToggle" aria-label="ย่อแชท">–</button>
    </div>
    <div class="chat">${chatMessages()}</div>
    <div class="row"><input type="text" id="chat" maxlength="300" style="flex:1" placeholder="พิมพ์ข้อความ" value="${esc(draft("chat"))}" />${micBtn("chat")}<button class="btn sm" data-act="chat">ส่ง</button></div>
  </div>`;
}

// ---------- Timer ----------
function poseRoom() {
  if (!S || !S.stage) return;
  const now = Date.now() + clockSkew;
  const cv = S.caseView;
  for (const role of Object.keys(ROOM_POS)) {
    const spr = document.getElementById("spr-" + role);
    if (!spr) continue;
    const frame = spr.querySelector(".sprite-frame");
    const img = frame.querySelector("img");
    const bubble = document.getElementById("bub-" + role);
    const ev = S.stage[role];
    const recent = ev && now - ev.t < 3500;
    // Frames: 1/2 = idle bob (alternate every ~900ms), 3 = talk, 4 = action.
    const n = recent && ev.pose === "talk" ? 3 : recent && ev.pose === "act" ? 4 : 1 + (Math.floor(now / 900) % 2);
    if (frame.dataset.frame !== String(n)) {
      frame.dataset.frame = String(n);
      img.src = spriteSrc(role, cv, n);
      if (n >= 3) {
        frame.classList.remove("pop");
        void frame.offsetWidth; // restart the CSS animation
        frame.classList.add("pop");
      }
    }
    if (recent && ev.text) {
      bubble.textContent = ev.text.length > 60 ? ev.text.slice(0, 57) + "…" : ev.text;
      bubble.hidden = false;
    } else {
      bubble.hidden = true;
    }
  }
}

function tick() {
  poseRoom();
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
  const warn = document.getElementById("warn-" + el.id);
  if (warn) warn.innerHTML = enWarn(el.id, el.value);
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

// ---------- Dragging the floating chat widget (header when open, the button itself when collapsed) ----------
const chatDrag = { active: null, justDragged: false };
app.addEventListener("pointerdown", (e) => {
  const handle = e.target.closest(".chat-widget-header, .chat-fab");
  if (!handle || e.target.closest(".chat-widget-close")) return;
  const widget = handle.closest(".chat-widget") || handle;
  const rect = widget.getBoundingClientRect();
  chatDrag.active = { widget, startX: e.clientX, startY: e.clientY, origX: rect.left, origY: rect.top, moved: false };
});
document.addEventListener("pointermove", (e) => {
  const d = chatDrag.active;
  if (!d) return;
  const dx = e.clientX - d.startX;
  const dy = e.clientY - d.startY;
  if (!d.moved && Math.hypot(dx, dy) < 4) return;
  d.moved = true;
  const w = d.widget.offsetWidth;
  const h = d.widget.offsetHeight;
  const x = Math.max(4, Math.min(window.innerWidth - w - 4, d.origX + dx));
  const y = Math.max(4, Math.min(window.innerHeight - h - 4, d.origY + dy));
  Object.assign(d.widget.style, { left: x + "px", top: y + "px", right: "auto", bottom: "auto" });
  d.finalX = x;
  d.finalY = y;
});
document.addEventListener("pointerup", () => {
  const d = chatDrag.active;
  if (!d) return;
  chatDrag.active = null;
  if (!d.moved) return;
  chatDrag.justDragged = true;
  setTimeout(() => (chatDrag.justDragged = false), 250);
  ui.chatPos = { x: d.finalX, y: d.finalY };
  try { localStorage.setItem("crg-chat-pos", JSON.stringify(ui.chatPos)); } catch {}
});

app.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act]");
  if (!el || el.disabled) return;
  const act = el.dataset.act;
  const v = el.dataset.v;
  if (act !== "soundToggle") sfx.click();

  switch (act) {
    case "soundToggle":
      sfx.toggle();
      return render();
    case "chatToggle":
      if (chatDrag.justDragged) return; // don't toggle right after a drag release
      ui.chatOpen = !ui.chatOpen;
      if (ui.chatOpen) ui.chatUnread = 0;
      try { localStorage.setItem("crg-chat-open", ui.chatOpen ? "open" : "closed"); } catch {}
      return render();
    case "create":
    case "join": {
      const name = take("name") || (document.getElementById("name") || {}).value || "";
      const code = act === "join" ? take("code") || new URLSearchParams(location.search).get("room") || "" : undefined;
      if (!name.trim()) return toast("กรุณาใส่ชื่อ");
      if (act === "join" && !code) return toast("กรุณาใส่รหัสห้อง");
      socket.emit(act, { name, code }, (res) => {
        if (!res.ok) return toast(res.error);
        music.stop();
        ui.animatedRoles.clear();
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
    case "mic":
      if (ui.micFor === v) {
        stopMic();
        return;
      }
      startMic(v);
      return;
    case "micLang":
      ui.micLang = ui.micLang === "th-TH" ? "en-US" : "th-TH";
      try {
        localStorage.setItem("crg-mic-lang", ui.micLang);
      } catch {}
      if (ui.micFor) startMic(ui.micFor);
      else render();
      toast(ui.micLang === "th-TH" ? "ถอดเสียงเป็นภาษาไทย" : "Speech-to-text: English");
      return;
    case "pickRole":
      return send("pickRole", { role: v || null });
    case "kick":
      return send("kick", { playerId: v });
    case "toggleReady":
      return send("toggleReady");
    case "startGame":
      return send("startGame");
    case "groupFilter":
      ui.groupFilter = Number(v);
      ui.carouselIndex = 0;
      return render();
    case "carouselNav": {
      const n = S.catalog.cards.filter((c) => !ui.groupFilter || c.group === ui.groupFilter).length;
      ui.carouselDir = Number(v) >= 0 ? 1 : -1;
      ui.carouselIndex = n ? (((ui.carouselIndex + Number(v)) % n) + n) % n : 0;
      return render();
    }
    case "carouselJump": {
      const target = Number(v);
      ui.carouselDir = target >= ui.carouselIndex ? 1 : -1;
      ui.carouselIndex = target;
      return render();
    }
    case "carouselRandom": {
      const list = S.catalog.cards.filter((c) => !ui.groupFilter || c.group === ui.groupFilter);
      if (!list.length) return;
      let next = ui.carouselIndex;
      if (list.length > 1) while (next === ui.carouselIndex) next = Math.floor(Math.random() * list.length);
      ui.carouselDir = next >= ui.carouselIndex ? 1 : -1;
      ui.carouselIndex = next;
      sfx.reveal();
      return render();
    }
    case "selectCase":
      return send("selectCase", { caseId: v });
    case "advance":
      return send("advance", { to: v });
    case "ask": {
      const id = "ask-" + v;
      const text = take(id);
      if (!text) return toast("พิมพ์คำถามก่อน");
      if (EN_ONLY.has(id) && hasThai(text)) return toast("คำขอตรวจร่างกายต้องเป็น medical English เท่านั้น");
      if (ui.micFor === id) stopMic(true);
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
      if (ui.micFor === "chat") stopMic(true);
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
    case "fbStar":
      ui.feedbackDraft[el.dataset.id] = Number(v);
      return render();
    case "consent":
      return send("setConsent", { agree: v === "yes" });
    case "consentReset":
      return send("setConsent", { agree: null });
    case "certificate":
      el.disabled = true;
      try {
        await downloadCertificate();
      } catch (err) {
        console.error(err);
        toast("สร้างใบประกาศไม่สำเร็จ ลองใหม่อีกครั้ง");
      } finally {
        el.disabled = false;
      }
      return;
    case "fbSkip":
      ui.feedbackDismissed = true;
      return render();
    case "fbSubmit": {
      const comment = (document.getElementById("fb-comment") || {}).value || "";
      if (await send("submitFeedback", { ...ui.feedbackDraft, comment })) {
        clearDraft("fb-comment");
        toast("ขอบคุณสำหรับความคิดเห็น!");
        render();
      }
      return;
    }
  }
});

render();
