# SimPlastic Reasoning

A real-time multiplayer web game for the Plastic Surgery Clinical Reasoning card bank (34 cards, นศพ. ปี 5). A table of 4–5 players each takes a role and plays one case card through the full session flow.

## Run

```bash
npm install
npm start          # http://localhost:3000
npm test           # end-to-end flow tests (4- and 5-player)
npm run cards      # re-parse the card bank → data/cards.json
```

To play on a LAN, have the other players open `http://<this-machine-ip>:3000`.

## Roles

| Role | Required | What they do |
|---|---|---|
| Facilitator | ✓ | Picks the case, moves between phases, reveals PE findings, rates the PL/PR, reveals S1/S2, leads the debrief |
| Patient | ✓ | Holds the secret info card and reveals only the row that matches each question |
| Doctor/Examiner | ✓ | Takes the history, requests specific exams, orders investigations |
| Scribe | ✓ | Keeps the team's notes and writes the PL + one-liner |
| Bias monitor | 5th player | Flags biases during the case and leads the time-out. With 4 players, the Scribe takes over these duties. |

## Game flow

1. **Lobby**: create a room, share the 4-letter code or invite link, and have each player pick a role
2. **Case**: the facilitator picks a card (filter by group, or 🎲 random)
3. **Opening stem**
4. **History**: the doctor asks and the patient answers from their card
5. **Physical exam**: the doctor requests an exam and the facilitator reveals the finding
6. **Investigations**: choose options with reasons, submit, then answers are revealed
7. **PL/PR**: the scribe writes and submits, then it's compared with the Expected PL/PR and rated 1–5
8. **Diagnostic time-out**: work through the System 2 checklist and the team's must-not-miss, then reveal the S1 trap and S2 trigger
9. **Faculty debrief**: questions are revealed one at a time
10. **Exit ticket**: each player fills one in
11. **Summary**: coverage stats, tickets, the full card, and a report download (.md)

Each phase has a suggested timer (about 55 min in total). Only the facilitator can move forward or back.

## Language rule

Physical examination (exam requests and findings), the problem list and the problem representation are **medical English only, with no lay terms**.
- Card content: `data/en/G*.json` overrides the exam rows, PL and PR of all 34 cards. The Thai card bank is unchanged and is still the source for everything else, including the patient's answers, which stay in the patient's own words.
- `npm run cards` prints a WARN if any English section contains Thai text or a banned lay term, or if its row count doesn't match the Thai source.
- Player input: exam requests, the team's PL/PR and the exit-ticket one-liner are rejected by the server if they contain Thai. The mic in those fields always transcribes in English.

## Architecture

- `scripts/parse_cards.py`: Markdown card bank → `data/cards.json`
- `server/game.js`: room state machine. Every action is checked against the player's role and the current phase, and `viewFor()` sends each player only what their role may see. Hidden rows are never sent to the client.
- `server/index.js`: Express + Socket.IO. Players can reload and keep their seat (via sessionStorage).
- `public/`: vanilla JS single-page client with no build step
- Rooms are in memory and are cleared after 6 h idle

> For simulated education only. Not advice for real patients.
