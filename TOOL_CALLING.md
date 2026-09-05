# Speech → Tool-Call Plan (revised)

> **Core idea:** each page advertises a concrete, JSON "tool schema" of what can be done *here*. The free model acts as the **tool-caller** — it reads the page's toolset + the user's utterance and returns exactly one tool invocation. Voice→text is done **locally in the browser** (zero model). The model is only consulted where local routing can't decide.
>
> This reverses my earlier plan: the model is *in front*, choosing from per-page tools (like a browser agent's function calls), not hidden behind the last case.

---

## 1. Voice → text (local, free, no model)

| Browser | Engine |
|---|---|
| Chrome / Edge | `webkitSpeechRecognition` (on-device, no upload) |
| Others / unsupported | fallback: on-screen text input box → same pipeline |

Speech recognition yields a transcript string. **No model call for speech-to-text.**

---

## 2. Each page = a tool schema

Every page (from the ACTION_MATRIX) exposes a **tools** list. The schema for each tool has only what the caller needs to choose and run it:

```jsonc
class TeachCardTools {
  next     = { when: "always", params: {} }
  back     = { when: "always", params: {} }
  skip     = { when: "always", params: {} }
  repeat   = { when: "always", params: {} }
  slow     = { when: "always", params: { delta: -20 } }
  reveal   = { when: "always", params: {} }
  deepDive = { when: "always", params: {} }
  options  = { when: "always", params: {} }
  help     = { when: "always", params: {} }
  mute     = { when: "always", params: { on: true } }
  // No answer tools on the teach card → not advertised.
}
```

Each tool carries:
- `name`
- `summary` / human description (also reads aloud for `/options`)
- `params` signature
- **`when`** — a guard (e.g. `question` tools only listed when the card is a question)

The client builds the *current* toolset each render from the state + legality rules (this **keeps the model from proposing illegal actions** — legality is enforced by the page, not trusted to the model).

---

## 3. The free model = tool-caller (simulated function calling)

Because OpenRouter free models don't reliably implement native `tool_calls`, we **describe the toolset in the prompt and demand a JSON tool invocation** — the same shape real function calling returns:

```
You are the input-governor of a spaced-repetition vocabulary app.
Current word: "abate" (v) = become weaker / less intense.
Current screen: teach card (word shown, meaning hidden).

Tools available (your only allowed outputs):
1. next {}
2. back {}
3. skip {}
4. repeat {}
5. slow {delta: int}
6. reveal {}
7. deep_dive {}
8. options {}
9. help {}
10. mute {on: bool}

Learner just said: “show me what it means”
Respond with ONLY a JSON tool call:
{"tool": "reveal", "params": {}, "confidence": 0.9, "why": "user wants the definition revealed"}
```

Only the model returns one of: a tool name (from the schema), confidence, a one-line `why` (ignored by the app — it's for the log, not executed).

### What the model handles best (leave it there)
- Garbled / multi-word natural utterances: "I give up" → `reveal`; "go to the next one homie" → `next`; "jump to a synonym" → `deep_dive`.
- Answer choices: "second" / "that one" / "pick b" → `answer_option` with `optionIndex`.
- Free content: "what does it mean in one sentence" → `ask` with `text`.
- Search / Deep Dive questions → `search`, `dd_ask`.

### What the model never does (guardrails)
- **No destructive tool ordering or skipping legality** — the client parses the int into the *legal schema only*. The model cannot invoke a tool that isn't in the page's list.
- **No arbitrary prose out** — enforce JSON-only, schema bounds (`option 0…3`, `delta ±`), `max_tokens` ~90.
- **No trusting pronunciation** — transcript is used as-is; never mark a vocab wrong for an accent.

---

## 4. Runtime flow (what the browser does)

```
mic tap → browser STT → transcript (local)
                 │
                 ▼
   client computes current toolset (from state)
                 │
                 ▼
   local fast-path (zero model) tries: next, back, skip,
   no/yes, option letter/number, stop, mute
                 │   matches?
                 │   yes ────────► run(localTool)  (0ms, no network)
                 │   no (ambiguous/free)
                 ▼
   /api/intent  → free model → {tool, params, confidence}
                 │
                 ▼
   is tool legal on this page + params complete?
     ├─ yes → execute + spoken confirm
     ├─ legal but missing params → targeted follow-up ("which option?")
     └─ illegal/unknown → "say help" or read options (app-authored)
```

**Latency/cost tuning:** local matcher absorbs the common commands instantly; the model fires only on genuinely ambiguous or open-ended utterances — so quota burn and typing delay are minimal on the happy path.

---

## 5. Server additions (`server.js`)

One new endpoint reuses the existing free-model helper + rate limiter:

```
POST /api/intent
{
  "word": "abate",
  "definition": "become weaker or less intense",
  "screen": "question",              // the page id
  "tools": ["answer_option","answer_meaning","repeat", ...], // legal set
  "text": "i give up show me b"
}
→ HTTP 200
{
  "tool":"answer_option", "option":1, "confidence":0.85, "model":"minimax-m3:free"
}
```

Persist / reuse the same `models[]`, the `rateOk` limiter and the `persistEnrich` free model baseline — no new secrets.

**Client:**
- a `tools/` module in `app.js` (page→schema, legality, param grabbing)
- a `localFastpath()` array before the API call
- a small `toolRunner` that maps `{tool, params}` onto the existing render/move/answer/openCraft paths
- `speak(text)` + `listen(cb)` wrappers

---

## 6. Why this is the right design (and honest limits)

| Concern | Answer |
|---|---|
| "Next" latency | Local fast-path, 0ms — no model |
| Odd phrasing ("i give up", "homie next one") | Model maps to `reveal`/`next` → handled |
| Free spoken meaning | Model returns `answer_meaning` → semantic match (separate, US-11) |
| Free Deep Dive question | Model returns `dd_ask` → genie() answers |
| Cost | One `free` model, ~90 tokens, only on ambiguity |
| Privacy | STT local; nothing leaves device unless open speech/model asked |

---

## Build in this order

1. **`/api/intent`** + prompt/schema in `server.js` (free model call).
2. **Client `toolRegistry`** (per-page schemas + legality from ACTION_MATRIX).
3. **`localFastpath`** matcher → `toolRunner` → wire to existing render/move/answer.
4. **Mic `speechRecognition`** wrapper + text-input fallback.
5. **Spoken prompts/comments** tied to each tool's `when` + `voice_level` pref.
6. Test the live loop, then push & deploy (auto / manual, per `notes.md`).