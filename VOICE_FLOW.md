# Voice-Led Learning — User Stories & Flow

> Model: **voice is the primary navigation layer.** Every card speaks a prompt, accepts voice commands, and answers out loud. Touch/keys remain as the quiet parallel track so nothing blocks learners who prefer silent mode.

---

## 0. Global voice state & concurrency

A single, well-defined "voice transcript" drives everything. Exactly one utterance is in flight at any time.

- A soft chime marks the start and end of each listening window so the learner knows when to speak.
- Any recognized utterance immediately cancels in-flight speech (no talking over the narrator).
- A persistent **voice level** slider sets loudness (word-only … full narration).
- A **mute / voice-off** toggle disables all speaking but keeps on-screen prompts.
- The mic only engages when a 📢-style listening window is open; it never auto-starts on load.

---

## 1. Hearing a word (first / teach card)

**US-1 (Hear the word)**
*As a learner, I want to hear each word pronounced first, so I anchor the sound before reading.*

- **Given** I'm on a teach card and voice is on, **when** the card opens, **then** it plays: the word, then part of speech, then a short friendly definition.
- Commands available here: `play`, `repeat`, `slower`, `faster`, `reveal`, `show example`, `skip`, `next`, `back`.

**US-2 (Hear what happens next)**
*As a learner, I want to be told the next step in plain words, so I never guess.*

- After the word is read, the narrator speaks a short menu: “Next card, reveal, or deep dive. Say next, say reveal, or say skip.”
- A one-beat pause lets me interject; speaking the command while the prompt is playing **interrupts and acts immediately**.
- Screens always mirror this: the visible hint bar shows the same command chips.

**US-3 (Repeat / slow)**
*As a learner, I want to rehear or slow the narrator, so I can parse tricky words.*

- `repeat` replays the last phrase; `slower` / `faster` change native rate for the current card (persisted).

---

## 2. Moving between cards

**US-4 (Next)**
*As a learner, I want to move on by saying `next`, so I never have to touch the screen.*

- On the explain card: “What should I do?” → `next` advances to the test for the same word, or a fresh word if already tested.
- On the teach card: `next` goes to that word’s question card.

**US-5 (Back)**
*As a learner, I want to say `back` to revisit, so I can re-hear without losing my streak.*

- `back` returns to the previous card exactly; the browser back/history guard still applies. `back` on the first card does nothing (soft bounce + spoken “no previous card”).

**US-6 (Skip)**
*As a learner, I want to skip a word by saying `skip`, so optional words don’t block me.*

- `skip` marks the word as seen, does NOT count as a miss, moves to the next card, and speaks: “Skipped — next word.”
- A confirm is only required if skipped 3+ times in a row (voice: “Skip again? say yes.”).

**US-7 (Free edges on the teach card)**
*As a learner, I want the narrator to always name my options, so I never guess what can be said.*

- Every `×` prompt ends with a consistent rhythm: “Say next, back, skip, repeat, or help.”

---

## 3. Question / test card (multiple-choice or free-speech)

**US-8 (Two answer modes)**
*As a learner, I want to answer by option letter or by speaking freely, so I choose what’s easiest.*

- Hold **answer**: voice asks “What does *abate* mean?” with the 4 options read as **A B C D**.
- Say exactly `A`/`B`/`C`/`D` — or speak any letter word (“option two”).
- Say the full free-form meaning → sent to **semantic matching** (US-11).
- Tap the on-screen option still works, simultaneously.

**US-9 (Right / Wrong confirm)**
*As a learner, I want to hear right or wrong immediately, so the loop stays tight.*

- **Correct:** chime + “Correct.” → auto-advance to Explanation card for that word.
- **Wrong:** chime + “Not quite.” → narrator reads the right definition → **auto-advance to Explanation card**, word queued for review (miss count +1).

**US-10 (Auto-navigate to explain)**
*As a learner, I want the app to take me straight to the explanation after answering, so I see the answer in context immediately.*

- After both a right and wrong answer, the flow continues **without a tap**: right answers toggle to the back of the same card; wrong answers toggle to the back and offer `review again`.

---

## 4. Free speech / spoken meaning

**US-11 (Free speech matching)**
*As a learner, I can speak my own definition, so I’m not limited to the four choices.*

- The app transcribes, then scores against definition + synonyms + key concepts:
  - **Strong match** → correct
  - **Partial match** (“reduced”) → “You’re close — you mentioned reducing, which is the key idea.”
  - **Weak match** → “Not quite. <canonical definition>.”
- Always **shows the transcript on screen** so I can self-correct.
- Never marks wrong purely on pronunciation/accent mismatch.

**US-12 (Deep Dive via voice)**
*As a learner, I want to ask Deep Dive by voice and get the answer back, so I can explore meaning hands-free.*

While a word is active: say `deep dive` → prompt: “What would you like to know?”
- Free speech (e.g., “give me an example” / “what’s a memory hook?”) → mapped to a **Deep Dive prompt chip** (Explain / Memory / Near-syn / Context …).
- The spoken reply is wrapped in the usual Deep Dive highlights; an on-screen **Read aloud** button replays it.

**US-13 (Fallback)**
*As a learner, if my speech isn’t recognized, I want to still advance, so failure never traps me.*

If transcription returns low/empty confidence on free talk: narrator says “I didn’t catch that — try again, or say **read options**.” The options remain available on touch.

---

## 5. Voice navigation anywhere

**US-14 (Universal command set)**
*As a learner in any card, I want the same command vocabulary, so I know voice works everywhere.*

| Command | In a learn | In test | In Deep Dive / review |
|---|---|---|---|
| `next` | next card | submit/advance | next result |
| `back` | previous card | previous | close panel |
| `skip` | skip word | skip | skip |
| `repeat` | repeat speak | repeat question | repeat answer |
| `options` | — | read the 4 options | list the menu |
| `deep dive` | open DD on current | open DD | — |
| `help` / `what can I say` | read command set for this screen | same | same |
| `mute` / `voice on` | toggle speaking answers | same | same |

Every help speech ends with “or say **help** anytime.”

**US-15 (Escape hatches)**
*I want to stop voice anytime, so I’m never trapped in a listening window.*

- `cancelled`/`mute`, `mute`, or tapping outside the mic zone immediately ended listening and clears any queued narration.

---

## 6. Adaptive pacing / review

**US-16 (Adaptive prompting)**
*As a learner who keeps missing a word, I want the app to simplify the ask, so I still succeed.*

- On repeated misses for the same word, voice walk-down:
  1. hear word
  2. say the word (repeat back)
  3. choose from options
  4. speak a simpler definition
- The difficulty re-advances on success.

**US-17 (Review deck by voice)**
*As a learner, I want review-stack by voice too, so I can restudy without touching the screen.*

- From say `review` on the menu: “You have 12 words to review.” `start` → loop through the same teach→test→explain flow with voice, then “done — 8 correct.”

---

## 7. Privacy / technical guardrails

**US-18** — Microphone only engages in an active listening window, never an autostart.
**US-19** — Audio never leaves the device unless the learner taps **“Check my speaking with AI”**; that call goes to the existing `/api` endpoint, with the established no-key-in-browser rule.
**US-20** — Settings persist: `voice-level`, `speak-word-only|word+def|full`, `read-examples`, `speed`, `mic-on`.
**US-21** — Browser speech recognition is used where supported; a clear “not supported in this browser” voice + on-screen notice appears otherwise.

---

## Suggested build order (same as agreed)

1. **Phase A — Listen** →  `speak()` helper, word 🔈 on teach cards, voice level in settings, `next` command.
2. **Phase B — Speak**: mic listen-window on test card, option letters answer, free speech, “correct / not quite” confirm, auto-navigate to explain.
3. **Phase C — Deep voice**: deep-dive prompt, read-aloud toggle.
4. **Phase D — Full voice nav**: `next/back/skip/help/options/mute` everywhere, adaptive pacing.

---

## Definition of Done per feature
- Voice prompt plays on entering the state (unless muted).
- Listening window has start/stop chime + visible mic pulse.
- Every visible action has a voice alias parseable by recognition.
- Every outcome is spoken (+ always shown visually).
- No browser permission is requested until the learner taps the mic; never an autostart.
- `speak` + `listen` are fully polyfilled/mocked when an engine is unsupported.