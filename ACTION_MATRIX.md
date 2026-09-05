# Voice Action Matrix — page state × intent → action

> Each page is a **state**. Each state has a set of **legal actions**. The intent classifier maps an utterance to an intent; the state decides whether that intent is legal *right now*, and if ambiguous, asks a targeted follow-up.

Three layers, always in order:

1. **Intent** — "what does the user want?" (free-model classifier, bounded enum)
2. **State** — "what is allowed on this page right now?"
3. **Action** — the concrete behaviour + the spoken confirmation.

---

## Intent enum (bounded, model returns exactly one)

| Intent | Meaning |
|---|---|
| `next` | advance |
| `back` | go to previous |
| `skip` | skip this word (not a miss) |
| `repeat` | replay the last narration |
| `slow` / `fast` | change narration rate |
| `reveal` | show the answer / definition |
| `answer_option` | pick A/B/C/D (carries `option`) |
| `answer_meaning` | free-spoken definition |
| `deep_dive` | open Deep Dive on current word |
| `dd_ask` | ask a question inside Deep Dive |
| `options` | read the current options / commands |
| `help` | explain what I can say here |
| `review` | go to review deck |
| `browse` | go to word bank |
| `search` | search for a word (carries `query`) |
| `yes` / `no` | confirmation |
| `mute` / `voice_on` | toggle speaking |
| `stop` | end the listening window |
| `unknown` | couldn't decide (carries `reason`) |

---

## State → legal actions

Each row: **what the page is**, **legal intents** (anything else → rejected with a spoken hint), and the **default** when the user just says `next`.

### S1 — Teach card (front: word visible, meaning hidden)
Legal: `next`, `back`, `skip`, `repeat`, `slow`, `fast`, `reveal`, `deep_dive`, `options`, `help`, `mute`, `voice_on`, `stop`, `review`, `browse`
- `reveal` → flip to back (S2). **Default** `next` → go to this word's question (S3).
- `answer_option` / `answer_meaning` here → reject: "We haven't got to the question yet. Say reveal, or next."
- `deep_dive` → open DD panel (S6) on this word.

### S2 — Teach card (back: definition revealed)
Legal: `next`, `back`, `skip`, `repeat`, `slow`, `fast`, `reveal`(re-read), `deep_dive`, `options`, `help`, `mute`, `voice_on`, `stop`
- `next` → this word's question (S3). `back` → front (S1).
- `reveal` → re-read the definition (idempotent).

### S3 — Question / test card (MCQ)
Legal: `answer_option`, `answer_meaning`, `repeat`, `slow`, `fast`, `options`, `help`, `mute`, `voice_on`, `stop`, `back`, `skip`
- `answer_option` **with** `option` → submit that choice → verdict (S4).
- `answer_option` **without** `option` → ask once: "Which one — A, B, C, or D?"
- `answer_meaning` → free-speech → semantic match (US-11) → verdict.
- `reveal` here → **not legal** on a fresh question. Map to "give up?" → confirm: "Say yes to see the answer — it counts as a miss." On `yes` → reveal + miss.
- `next` here → reject: "Answer first, or say skip." (`skip` is legal.)

### S4 — Verdict (right / wrong, shown after answering)
Legal: `next`, `repeat`, `slow`, `fast`, `options`, `help`, `mute`, `voice_on`, `stop`
- **Right:** auto-narrates "Correct." then immediately goes to explain (S2-back) — no command needed. `next` → next word.
- **Wrong:** narrates "Not quite. <definition>." → explain (S2-back). `next` → next word. `repeat` → re-hear the definition.
- `back` → return to the question to try again (only if wrong).

### S5 — Relearn card (missed word, dashed border)
Legal: `next`, `back`, `repeat`, `slow`, `fast`, `reveal`(re-read), `deep_dive`, `options`, `help`, `mute`, `voice_on`, `stop`, `yes`/`no`
- `yes` (to "got it now?") → clear miss, advance. `no` → keep in review.
- `next` → advance (word stays queued if not confirmed).

### S6 — Deep Dive panel (open, on a word)
Legal: `dd_ask`, `repeat`, `slow`, `fast`, `next`(close), `back`(close), `options`, `help`, `mute`, `voice_on`, `stop`
- `dd_ask` → free speech question → mapped to a DD prompt chip (Explain / Memory / Near-syn / Context / Test me).
- `next` / `back` → close panel, return to underlying card.

### S7 — Review page
Legal: `review`(start), `next`, `back`, `repeat`, `options`, `help`, `mute`, `voice_on`, `stop`, `browse`, `search`
- `next` → start studying the first review word. `search` + query → jump to a word.

### S8 — Browse / word bank page
Legal: `search`, `next`(select first result), `back`(to learn), `repeat`, `options`, `help`, `mute`, `voice_on`, `stop`
- `search` + query → run search, read top 3 results aloud.
- `next` → open the first result as a study card.

### S9 — Help panel
Legal: `help`(re-read), `back`(close), `next`(close), `stop`, `mute`, `voice_on`
- Any other intent → close help and re-route to the underlying state's handler.

### S10 — Settings / theme menu (open)
Legal: `mute`, `voice_on`, `slow`, `fast`, `back`(close), `next`(close), `stop`

### S11 — Empty state (no words in mix)
Legal: `next`(reset filters), `back`, `repeat`, `help`, `mute`, `voice_on`, `stop`

---

## Ambiguity & rejection rules (app-side, not model)

- **`unknown`** → speak once: "I didn't catch that. Say *help* to hear what you can do here." Do not loop infinitely — after 2 unknowns, auto-read the options.
- **Legal but missing data** → targeted follow-up:
  - `answer_option` no number → "Which one — A, B, C, or D?"
  - `search` no query → "What word are you looking for?"
  - `dd_ask` no question → "What would you like to know?"
- **Illegal for this state** → spoken hint + redirect, never silent:
  - `answer_option` on teach card → "Not yet — say reveal, or next."
  - `reveal` on fresh question → "That counts as a miss. Say yes to see it."
  - `next` on question → "Answer first, or say skip."
- **Destructive / repeated** → confirm only when needed:
  - `skip` 3rd time in a row → "Skip again? Say yes."
  - `back` on first card → soft bounce, "No previous card."
- **Safety intents** (`stop`, `mute`, `voice_on`) → always executed instantly, no confirm.

---

## Confirmation narration (each action speaks what happened)

| Action | Spoken confirmation |
|---|---|
| next | "Next." (or "Next word: <word>.") |
| back | "Back." |
| skip | "Skipped — next word." |
| reveal | "Here it is. <definition>" |
| answer_option | "Correct." / "Not quite. <definition>" |
| answer_meaning | "Good recall." / "Close — you said <key idea>." / "Not quite. <definition>" |
| deep_dive | "Deep dive on <word>. What would you like to know?" |
| dd_ask | "Let me think…" then reads the answer |
| options | reads A/B/C/D (or the command list) |
| help | reads the command set for this screen |
| mute / voice_on | "Voice off." / "Voice on." |
| stop | (silent) ends listening |

---

## Runtime flow

```
utterance
  └─ Tier 1 local fast-path (next/back/skip/repeat/yes/no/letters) → action if legal
  └─ else Tier 2 free-model classify → {intent, option, query, confidence}
       └─ state.legal(intent)?
            ├─ yes & complete → execute + speak confirmation
            ├─ yes & missing data → targeted follow-up
            └─ no → spoken hint + redirect (or confirm for destructive)
       └─ unknown / low confidence → "say help" → auto-options after 2
```

Every action is **visible on screen too** (never voice-only), so a user can always tap the equivalent control.