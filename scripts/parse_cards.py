"""Parse Plastic_Surgery_Card_Bank_Complete.md into data/cards.json for the web game.

Usage: python3 scripts/parse_cards.py [path/to/Plastic_Surgery_Card_Bank_Complete.md]
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_SRC = os.path.expanduser(
    "~/claude/case_bank_all_files/Plastic_Surgery_Card_Bank_Complete.md")
OUT = os.path.join(ROOT, "data", "cards.json")
ASSET_DIR = os.path.join(ROOT, "public", "card-assets")


def clean(s):
    return re.sub(r"\*\*(.+?)\*\*", r"\1", s).strip()


def split_sections(body):
    """Return {section_key: text} keyed by the '## ' heading prefix."""
    parts = re.split(r"\n## ", "\n" + body)
    out = {"_head": parts[0]}
    for p in parts[1:]:
        heading, _, text = p.partition("\n")
        out[heading.strip()] = text.strip()
    return out


def find(sections, prefix):
    for k, v in sections.items():
        if k.startswith(prefix):
            return v
    return ""


def table(text, ncols):
    rows = []
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("|") or re.match(r"^\|[\s\-|:]+\|$", line):
            continue
        cells = [clean(c) for c in line.strip("|").split("|")]
        rows.append(cells[:ncols] + [""] * (ncols - len(cells)))
    return rows[1:]  # drop header row


def bullets(text):
    return [clean(l.lstrip("-* ").strip()) for l in text.splitlines()
            if re.match(r"^\s*[-*]\s+", l)]


def quote(text):
    lines = [l.lstrip(">").strip() for l in text.splitlines() if l.strip().startswith(">")]
    return "\n".join(l for l in lines if l) or clean(text)


def field(text, label):
    m = re.search(r"\*\*" + re.escape(label) + r"[^*]*:\*\*\s*(.*)", text)
    return clean(m.group(1)) if m else ""


def parse_card(group_no, group_name, card_no, title, body):
    s = split_sections(body)
    head = s["_head"]
    plpr = find(s, "6)")
    pl_part, _, pr_part = plpr.partition("**Problem representation")
    sys12 = find(s, "7)")
    chk = sys12.split("**System 2 checklist:**", 1)[-1]
    debrief = find(s, "8)")
    note = re.search(r"^>\s*(?:\*\*)?(?:หมายเหตุ|ข้อควรระวัง)[^*:]*:(?:\*\*)?\s*(.*)$", debrief, re.M)

    image = f"G{group_no}-CARD{card_no}-portrait.jpg"
    cid = f"G{group_no}C{card_no}"
    return {
        "id": cid,
        "group": group_no,
        "groupName": group_name,
        "card": card_no,
        "title": clean(title.split(":", 1)[-1]) if ":" in title else clean(title),
        "fullTitle": clean(title),
        "level": field(head, "Level"),
        "bloom": field(head, "Bloom's target"),
        "image": image if os.path.exists(os.path.join(ASSET_DIR, image)) else None,
        "learningFocus": bullets(find(s, "Learning focus")),
        "stem": quote(find(s, "1)")),
        "history": [{"q": q, "a": a} for q, a in table(find(s, "2)"), 2)],
        "exam": [{"q": q, "a": a} for q, a in table(find(s, "3)"), 2)],
        "investigations": [{"option": o, "rationale": r, "answer": a}
                           for o, r, a in table(find(s, "4)"), 3)],
        "mustNotMiss": bullets(find(s, "5)")),
        "problemList": [clean(re.sub(r"^\d+\.\s*", "", l)) for l in pl_part.splitlines()
                        if re.match(r"^\s*\d+\.", l)],
        "problemRepresentation": quote(pr_part.split("\n", 1)[-1]),
        "system1Trap": field(sys12, "System 1 trap").strip('"“”'),
        "system2Trigger": field(sys12, "System 2 trigger"),
        "system2Checklist": bullets(chk),
        "debrief": [{"q": q, "a": a} for q, a in table(debrief, 2)],
        "facultyNote": clean(note.group(1)) if note else "",
    }


EN_DIR = os.path.join(ROOT, "data", "en")
THAI = re.compile(r"[฀-๿]")
# Lay terms that must not appear in the medical-English sections.
LAY = re.compile(r"\b(tummy|belly|pee|poop|puke|throw(?:ing)? up|butt|boobs?|lumps?|bruis\w*|"
                 r"sour|punch\w*|black eye|nosebleed|cut|scab|pus)\b", re.I)
# American spelling only (haemorrhage → hemorrhage, oedema → edema, colour → color, -ise → -ize …).
# "aesthetic" stays: it is the standard US plastic-surgery term.
BRITISH_STEMS = re.compile(r"haem|aemi|aemo|oedem|anaesth|aesthes|paed|rrhoea|oesoph|ischaem|glycaem|volaem|gynaec|"
                           r"colour|odour|favour|behaviour|tumour|centre|litre|metre|fibre|counsell|signall", re.I)
ISE_WORD = re.compile(r"\b\w+is(?:e|ed|es|ing|ation|ations)\b", re.I)
ISE_OK = {"raise", "raised", "raises", "raising", "arise", "arises", "arising", "supervised", "supervise",
          "exercise", "exercised", "compromise", "compromised", "compromising", "revise", "revised", "precise",
          "promise", "advise", "advised", "concise", "otherwise", "wise", "rise", "noise", "poise", "poised",
          "surprise", "surprised", "comprise", "comprises", "comprising", "disguise", "expertise", "franchise",
          "premise", "devise", "incise", "incised", "excise", "excised", "circumcise", "bruise", "cruise", "praise",
          "despise", "enterprise", "improvise", "televised", "demise", "chemise", "anise", "treatise", "mise"}


class _British:
    def search(self, text):
        m = BRITISH_STEMS.search(text)
        if m:
            return m
        for m in ISE_WORD.finditer(text):
            if m.group(0).lower() not in ISE_OK:
                return m
        return None


BRITISH = _British()


def apply_english(cards):
    """Overlay data/en/G*.json: physical exam, problem list and problem representation
    are medical English only; the Thai card bank stays the source for everything else."""
    overlay = {}
    for name in sorted(os.listdir(EN_DIR)) if os.path.isdir(EN_DIR) else []:
        if name.endswith(".json"):
            overlay.update(json.load(open(os.path.join(EN_DIR, name), encoding="utf-8")))
    problems = []
    for c in cards:
        en = overlay.get(c["id"])
        if not en:
            problems.append(f"{c['id']} missing English exam/PL/PR")
            continue
        if len(en["exam"]) != len(c["exam"]):
            problems.append(f"{c['id']} exam rows {len(en['exam'])} != source {len(c['exam'])}")
        if len(en["problemList"]) != len(c["problemList"]):
            problems.append(f"{c['id']} PL items {len(en['problemList'])} != source {len(c['problemList'])}")
        texts = [r["q"] for r in en["exam"]] + [r["a"] for r in en["exam"]] + en["problemList"] + [en["problemRepresentation"]]
        for t in texts:
            if THAI.search(t):
                problems.append(f"{c['id']} Thai text in English section: {t[:60]}")
            m = LAY.search(t)
            if m:
                problems.append(f"{c['id']} lay term '{m.group(0)}': {t[:60]}")
            m = BRITISH.search(t)
            if m:
                problems.append(f"{c['id']} British spelling '{m.group(0)}' (use American): {t[:60]}")
        c["exam"] = en["exam"]
        c["problemList"] = en["problemList"]
        c["problemRepresentation"] = en["problemRepresentation"]
    return problems


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
    text = open(src, encoding="utf-8").read()
    cards, groups = [], []
    for gm in re.finditer(r"^# กลุ่ม (\d+) — (.+?) \(\d+ การ์ด\)\s*$(.*?)(?=^# กลุ่ม |\Z)",
                          text, re.M | re.S):
        gno, gname, gbody = int(gm.group(1)), gm.group(2).strip(), gm.group(3)
        groups.append({"no": gno, "name": gname})
        for cm in re.finditer(r"^# CARD (\d+) — (.+?)$(.*?)(?=^# CARD |\Z)", gbody, re.M | re.S):
            cards.append(parse_card(gno, gname, int(cm.group(1)), cm.group(2), cm.group(3)))

    problems = apply_english(cards)
    for c in cards:
        for k in ("stem", "history", "exam", "investigations", "mustNotMiss",
                  "problemList", "problemRepresentation", "system2Checklist", "debrief"):
            if not c[k]:
                problems.append(f"{c['id']} missing {k}")
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"groups": groups, "cards": cards}, f, ensure_ascii=False, indent=1)
    print(f"Parsed {len(cards)} cards in {len(groups)} groups -> {OUT}")
    for p in problems:
        print("WARN", p)


if __name__ == "__main__":
    main()
