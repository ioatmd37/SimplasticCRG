// SimPlastic CRG anonymous research data.
//   POST /ingest            game server only (Bearer INGEST_KEY) — upserts one response row
//   GET  /admin             summary page (HTTP Basic, password ADMIN_PASSWORD)
//   GET  /admin/export.csv  all rows as CSV (same auth)

const ROLES = new Set(["facilitator", "patient", "doctor", "scribe", "bias", "observer"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CASE_ID = /^G\d{1,2}C\d{1,2}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/ingest" && request.method === "POST") return await ingest(request, env);
      if (url.pathname === "/admin" || url.pathname === "/admin/export.csv") {
        if (request.method !== "GET") return text("Method not allowed", 405);
        if (!(await adminAuthorized(request, env))) {
          return new Response("Authentication required", {
            status: 401,
            headers: { "WWW-Authenticate": 'Basic realm="SimPlastic admin", charset="UTF-8"' },
          });
        }
        return url.pathname === "/admin" ? await adminPage(env) : await exportCsv(env);
      }
      return text("Not found", 404);
    } catch (err) {
      console.error(err);
      return text("Server error", 500);
    }
  },
};

// ---- auth ------------------------------------------------------------------

async function sameSecret(given, expected) {
  if (!expected || typeof given !== "string") return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function adminAuthorized(request, env) {
  const h = request.headers.get("Authorization") || "";
  if (!h.startsWith("Basic ")) return false;
  let decoded;
  try {
    decoded = new TextDecoder().decode(Uint8Array.from(atob(h.slice(6)), (c) => c.charCodeAt(0)));
  } catch {
    return false;
  }
  const password = decoded.slice(decoded.indexOf(":") + 1);
  return sameSecret(password, env.ADMIN_PASSWORD);
}

// ---- ingest ----------------------------------------------------------------

const clip = (s, n) => (typeof s === "string" ? s.trim().slice(0, n) || null : null);
const star = (n) => (Number.isInteger(n) && n >= 1 && n <= 5 ? n : null);

async function ingest(request, env) {
  const h = request.headers.get("Authorization") || "";
  if (!(await sameSecret(h.replace(/^Bearer /, ""), env.INGEST_KEY))) return text("Unauthorized", 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return text("Bad JSON", 400);
  }
  const { id, caseId, role, feedback, ticket } = body || {};
  if (!UUID.test(id || "") || !CASE_ID.test(caseId || "")) return text("Bad id or caseId", 400);
  if (role != null && !ROLES.has(role)) return text("Bad role", 400);
  if (!feedback && !ticket) return text("Nothing to store", 400);

  const f = feedback || {};
  const t = ticket || {};
  const row = {
    case_rating: feedback ? star(f.caseRating) : null,
    players_rating: feedback ? star(f.playersRating) : null,
    system_rating: feedback ? star(f.systemRating) : null,
    comment: clip(f.comment, 500),
    one_liner: clip(t.oneLiner, 600),
    must_not_miss: clip(t.mnm, 300),
    s1_s2_trigger: clip(t.trigger, 300),
  };
  if (feedback && (!row.case_rating || !row.players_rating || !row.system_rating)) return text("Bad ratings", 400);

  // Ticket and feedback arrive separately; COALESCE keeps whichever half is already stored.
  await env.DB.prepare(
    `INSERT INTO responses (id, play_date, case_id, role, case_rating, players_rating, system_rating,
                            comment, one_liner, must_not_miss, s1_s2_trigger)
     VALUES (?1, date('now'), ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT(id) DO UPDATE SET
       case_rating    = COALESCE(excluded.case_rating, case_rating),
       players_rating = COALESCE(excluded.players_rating, players_rating),
       system_rating  = COALESCE(excluded.system_rating, system_rating),
       comment        = COALESCE(excluded.comment, comment),
       one_liner      = COALESCE(excluded.one_liner, one_liner),
       must_not_miss  = COALESCE(excluded.must_not_miss, must_not_miss),
       s1_s2_trigger  = COALESCE(excluded.s1_s2_trigger, s1_s2_trigger)`,
  )
    .bind(
      id.toLowerCase(),
      caseId,
      role ?? null,
      row.case_rating,
      row.players_rating,
      row.system_rating,
      row.comment,
      row.one_liner,
      row.must_not_miss,
      row.s1_s2_trigger,
    )
    .run();
  return text("ok", 200);
}

// ---- admin -----------------------------------------------------------------

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const avg = (n) => (n == null ? "—" : Number(n).toFixed(2));

async function adminPage(env) {
  const totals = await env.DB.prepare(
    `SELECT COUNT(*) AS n, COUNT(case_rating) AS rated, COUNT(one_liner) AS tickets,
            AVG(case_rating) AS c, AVG(players_rating) AS p, AVG(system_rating) AS s
     FROM responses`,
  ).first();
  const byCase = (
    await env.DB.prepare(
      `SELECT case_id, COUNT(*) AS n, AVG(case_rating) AS c, AVG(players_rating) AS p, AVG(system_rating) AS s
       FROM responses GROUP BY case_id ORDER BY n DESC, case_id`,
    ).all()
  ).results;
  const recent = (
    await env.DB.prepare(
      `SELECT play_date, case_id, role, case_rating, players_rating, system_rating, comment, one_liner, must_not_miss, s1_s2_trigger
       FROM responses ORDER BY play_date DESC, rowid DESC LIMIT 200`,
    ).all()
  ).results;

  const html = `<!doctype html><html lang="th"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>SimPlastic admin</title>
<style>
  :root { color-scheme: light dark; --line: #8884; }
  body { font: 14px/1.5 -apple-system, "Segoe UI", "Noto Sans Thai", sans-serif; margin: 0 auto; max-width: 1100px; padding: 20px 16px; }
  h1 { font-size: 1.3rem; margin: 0 0 4px; } h2 { font-size: 1.05rem; margin: 28px 0 8px; }
  .muted { opacity: .65; } .cards { display: flex; flex-wrap: wrap; gap: 10px; }
  .card { border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; min-width: 130px; }
  .card b { display: block; font-size: 1.4rem; }
  .scroll { overflow-x: auto; } table { border-collapse: collapse; width: 100%; }
  th, td { border-bottom: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: top; }
  th { font-size: .8rem; text-transform: uppercase; letter-spacing: .03em; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  a.btn { display: inline-block; margin-top: 8px; padding: 6px 12px; border: 1px solid var(--line); border-radius: 8px; text-decoration: none; color: inherit; }
</style></head><body>
<h1>SimPlastic — ข้อมูลความพึงพอใจและ exit ticket</h1>
<p class="muted">ข้อมูลไม่ระบุตัวตน เฉพาะผู้เล่นที่ยินยอม · <a class="btn" href="/admin/export.csv">ดาวน์โหลด CSV</a></p>
<div class="cards">
  <div class="card"><span class="muted">คำตอบทั้งหมด</span><b>${totals.n}</b></div>
  <div class="card"><span class="muted">ให้คะแนน</span><b>${totals.rated}</b></div>
  <div class="card"><span class="muted">exit ticket</span><b>${totals.tickets}</b></div>
  <div class="card"><span class="muted">โจทย์ (เฉลี่ย)</span><b>${avg(totals.c)}</b></div>
  <div class="card"><span class="muted">ผู้เล่น (เฉลี่ย)</span><b>${avg(totals.p)}</b></div>
  <div class="card"><span class="muted">ระบบเกม (เฉลี่ย)</span><b>${avg(totals.s)}</b></div>
</div>
<h2>แยกตามเคส</h2>
<div class="scroll"><table><thead><tr><th>เคส</th><th class="num">จำนวน</th><th class="num">โจทย์</th><th class="num">ผู้เล่น</th><th class="num">ระบบเกม</th></tr></thead><tbody>
${byCase.map((r) => `<tr><td>${esc(r.case_id)}</td><td class="num">${r.n}</td><td class="num">${avg(r.c)}</td><td class="num">${avg(r.p)}</td><td class="num">${avg(r.s)}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">ยังไม่มีข้อมูล</td></tr>`}
</tbody></table></div>
<h2>ล่าสุด (200 รายการ)</h2>
<div class="scroll"><table><thead><tr><th>วันที่</th><th>เคส</th><th>บทบาท</th><th class="num">โจทย์</th><th class="num">ผู้เล่น</th><th class="num">ระบบ</th><th>ข้อเสนอแนะ</th><th>One-liner</th><th>Must-not-miss</th><th>S1→S2 trigger</th></tr></thead><tbody>
${recent.map((r) => `<tr><td>${esc(r.play_date)}</td><td>${esc(r.case_id)}</td><td>${esc(r.role)}</td><td class="num">${esc(r.case_rating)}</td><td class="num">${esc(r.players_rating)}</td><td class="num">${esc(r.system_rating)}</td><td>${esc(r.comment)}</td><td>${esc(r.one_liner)}</td><td>${esc(r.must_not_miss)}</td><td>${esc(r.s1_s2_trigger)}</td></tr>`).join("") || `<tr><td colspan="10" class="muted">ยังไม่มีข้อมูล</td></tr>`}
</tbody></table></div>
</body></html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY" },
  });
}

// Prefix cells a spreadsheet would treat as a formula, so opening the export can't run anything.
const csvCell = (v) => {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
};

async function exportCsv(env) {
  const { results } = await env.DB.prepare(
    `SELECT play_date, case_id, role, case_rating, players_rating, system_rating, comment, one_liner, must_not_miss, s1_s2_trigger
     FROM responses ORDER BY play_date, rowid`,
  ).all();
  const cols = ["play_date", "case_id", "role", "case_rating", "players_rating", "system_rating", "comment", "one_liner", "must_not_miss", "s1_s2_trigger"];
  const csv = "﻿" + [cols.join(","), ...results.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\r\n");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="simplastic-responses.csv"`,
      "Cache-Control": "no-store",
    },
  });
}

function text(body, status) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
