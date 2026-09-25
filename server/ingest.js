// Forwards consenting players' anonymous exit tickets and satisfaction ratings to the
// Cloudflare Worker in cloudflare/. Sent from the server (never the browser) so the
// INGEST_KEY stays secret. Does nothing when INGEST_URL/INGEST_KEY aren't set (local dev).
// Fire-and-forget: a slow or failing data store must never block or break a game.

const URL_ = process.env.INGEST_URL;
const KEY = process.env.INGEST_KEY;

function send(payload) {
  if (!URL_ || !KEY) return;
  fetch(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  })
    .then((res) => {
      if (!res.ok) console.error(`ingest: HTTP ${res.status}`);
    })
    .catch((err) => console.error("ingest:", err.message));
}

module.exports = { send };
