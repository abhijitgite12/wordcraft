const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DuckDBInstance } = require('@duckdb/node-api');

const PORT = process.env.PORT || 4173;
const ROOT = __dirname;
// ---- build / deploy info (shown in the about badge) ----
function buildInfo(){
  const rCommit=process.env.RENDER_GIT_COMMIT, rBranch=process.env.RENDER_GIT_BRANCH;
  let commit=process.env.BUILD_COMMIT||rCommit||'', branch=process.env.BUILD_BRANCH||rBranch||'';
  // 'released' = the moment this build was released/baked.
  // Prefer Render's deploy date env if provided; else git commit timestamp; else server boot.
  let released='';
  if(process.env.RENDER_DEPLOY_DATE) released=process.env.RENDER_DEPLOY_DATE;
  try{
    const cg=require('child_process').execFileSync('git',['log','-1','--format=%cI'],{cwd:ROOT,encoding:'utf8',timeout:2500}).trim();
    if(cg) released=released||cg;
  }catch(e){}
  if(!released) released=new Date().toISOString();
  try{
    const g=require('child_process').execFileSync('git',['rev-parse','--short','HEAD'],{cwd:ROOT,encoding:'utf8',timeout:2500}).trim();
    if(!commit||commit==='dev') commit=g;
    let b=''; try{ b=require('child_process').execFileSync('git',['branch','--show-current'],{cwd:ROOT,encoding:'utf8',timeout:2500}).trim(); }catch(e){}
    if(b) branch=b;
  }catch(e){}
  return {commit:commit||'dev', branch, released, started:Date.now()};
}
const BUILD = buildInfo();
const WORDS_PATH = path.join(ROOT, 'words.json');
let words = JSON.parse(fs.readFileSync(WORDS_PATH, 'utf8'));

// ---- Password protection ----
// The app is password-gated. The password is read from APP_PASSWORD (env). We never
// store or log the plaintext. We keep only a salted scrypt hash and compare on login.
const APP_PASSWORD = process.env.APP_PASSWORD || '';
function passwordIsActive(){ return APP_PASSWORD.length >= 4; }
function hashPassword(pw, salt){
  return crypto.scryptSync(pw, salt, 64).toString('hex');
}
// Sign constant-time comparison to avoid timing side channels.
function safeEqual(a,b){ const ba=Buffer.from(a), bb=Buffer.from(b); if(ba.length!==bb.length) return false; return crypto.timingSafeEqual(ba,bb); }
// Stateless signed-session cookies: survive restarts/ephemeral hosts (Render free).
// The token carries its own expiry + HMAC, so no server-side session map is needed.
const SESSION_SECRET = process.env.SESSION_SECRET || 'wordcraft-dev-secret';
const SESSION_MS = 1000*60*60*24*30; // 30 days
function sign(data){ return crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url'); }
function issueSession(){
  const payload = crypto.randomBytes(16).toString('hex') + '.' + (Date.now()+SESSION_MS);
  return payload + '.' + sign(payload);
}
function validSession(token){
  if(!token || typeof token!=='string') return false;
  const parts=token.split('.'); if(parts.length!==3) return false;
  const sig=parts[2]; const payload=parts[0]+'.'+parts[1];
  const expect=sign(payload);
  if(sig.length!==expect.length) return false;
  const a=Buffer.from(sig), b=Buffer.from(expect);
  if(!crypto.timingSafeEqual(a,b)) return false;
  const exp=Number(parts[1]);
  return Number.isFinite(exp) && exp > Date.now();
}
function cookieHeader(token){ return `sat_session=${token}; HttpOnly; SameSite=Lax; Path=/`; }
function parseCookies(req){
  const raw = req.headers.cookie || ''; const out = {};
  for (const part of raw.split(';')){ const i=part.indexOf('='); if(i>0) out[part.slice(0,i).trim()]=part.slice(i+1).trim(); }
  return out;
}
const PUBLIC_PATHS = { '/login': true, '/style.css': true, '/login.js': true, '/app.js': true };
function isAuthed(req){ const c=parseCookies(req); return validSession(c.sat_session); }
function loginPage(){
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Word Craft</title><style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:linear-gradient(135deg,#e6e1ff,#d9f3e5);height:100vh;display:grid;place-items:center;margin:0}.box{background:#fff;padding:38px 32px;border-radius:20px;box-shadow:0 20px 60px #30266b22;width:min(90vw,360px);text-align:center}.logo{width:52px;height:52px;border-radius:15px;background:#6555d8;color:#fff;display:grid;place-items:center;font-size:26px;margin:0 auto 12px}.box h1{font:700 24px Georgia,serif;margin:0 0 5px;color:#242332}.box p{color:#77758a;font-size:13px;margin:0 0 22px}input{width:100%;box-sizing:border-box;padding:14px;border:1px solid #e5e1f5;border-radius:12px;font-size:15px;outline-color:#6555d8;margin-bottom:12px}button{width:100%;padding:14px;border:0;border-radius:12px;background:#6555d8;color:#fff;font-weight:600;font-size:15px;cursor:pointer}.err{color:#e05245;font-size:12px;min-height:16px;margin-top:9px}</style></head><body><div class="box"><div class="logo">✦</div><h1>Word Craft</h1><p>A private study space. Enter the password.</p><form id="f"><input type="password" id="p" placeholder="Password" autocomplete="current-password" autofocus><button>Unlock</button></form><div class="err" id="err"></div></div><script src="/login.js"></script></body></html>`;
}

// Persist enriched fields (including AI-cleaned definitions) back to DuckDB + words.json
// so AI-generated content is reused instantly instead of being regenerated.
// NOTE: gated behind ALLOW_RW=1. On ephemeral free hosts (Render free) the disk is
// lost every redeploy/spin-down, so we default to read-only and keep only the
// in-memory copy for the current process + browser localStorage cache.
const ALLOW_RW = process.env.ALLOW_RW === '1';
function persistEnrich(word, enrich) {
  // Always update this process's memory cache; the browser also saves the result.
  // Only disk writes are disabled on ephemeral/read-only deployments.
  const w = words.find(x => x.word === word);
  if (!w) return;
  if (enrich.aiDefinition) w.aiDefinition = enrich.aiDefinition;
  if (enrich.example) w.example = enrich.example;
  if (enrich.synonyms) w.synonyms = enrich.synonyms;
  if (enrich.antonyms) w.antonyms = enrich.antonyms;
  if (!ALLOW_RW) return;
  try {
    fs.writeFileSync(WORDS_PATH, JSON.stringify(words, null, 2));
  } catch (e) { /* ignore */ }
  db().then(conn => conn.run(
    `UPDATE words SET example=CAST(? AS VARCHAR), synonyms=CAST(? AS VARCHAR), antonyms=CAST(? AS VARCHAR) WHERE word=CAST(? AS VARCHAR)`,
    [w.example||'', JSON.stringify(w.synonyms||[]), JSON.stringify(w.antonyms||[]), word]
  )).catch(()=>{});
}

// DuckDB-backed search over the full word table + relations.
let dbConnPromise = null;
function db() {
  if (!dbConnPromise) {
    dbConnPromise = (async () => {
      const inst = await DuckDBInstance.create(path.join(ROOT, 'data', 'sat.duckdb'));
      return inst.connect();
    })();
  }
  return dbConnPromise;
}
async function searchDb(q) {
  const conn = await db();
  const safe = String(q||'').replace(/'/g, "''").slice(0, 60);
  const r = await conn.run(`
    SELECT word, partOfSpeech, definition, level, category FROM words
    WHERE lower(word) LIKE '%${safe.toLowerCase()}%' OR lower(definition) LIKE '%${safe.toLowerCase()}%'
    ORDER BY (word LIKE '${safe.toLowerCase()}%') DESC, word LIMIT 60`
  );
  const ch = r.getChunk(0);
  const o = ch.getColumnsObject(['word','partOfSpeech','definition','level','category']);
  const out = [];
  for (let i = 0; i < (o.word||[]).length; i++) out.push({ word: o.word[i], partOfSpeech: o.partOfSpeech[i], definition: o.definition[i], level: o.level[i], category: o.category[i] });
  return out;
}
const models = [
  'google/gemma-4-31b-it:free',
  'minimax/minimax-m3:free',
  'z-ai/glm-5.2:free'
];

// Simple per-IP rate limiter for the AI endpoint so a public free host can't be abused.
const RATE_WINDOW_MS = 60_000, RATE_MAX = 15; const hits = new Map();
function rateOk(ip) {
  const now = Date.now(); const h = hits.get(ip) || { n: 0, start: now };
  if (now - h.start > RATE_WINDOW_MS) { h.n = 0; h.start = now; }
  h.n++; hits.set(ip, h);
  if (hits.size > 5000) { for (const [k, v] of hits) if (now - v.start > RATE_WINDOW_MS * 2) hits.delete(k); }
  return h.n <= RATE_MAX;
}

function send(res, status, data, type='application/json') {
  res.writeHead(status, {'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store'});
  res.end(type === 'application/json' ? JSON.stringify(data) : data);
}function clean(text) { return String(text || '').replace(/[<>]/g, '').slice(0, 500); }

// ---- Human neural TTS via Edge-TTS (free, no key) ----
const { execFileSync } = require('child_process');
const cacheDir = path.join(ROOT, '.tts');
let ttsReady = false;
try{ fs.mkdirSync(cacheDir,{recursive:true}); ttsReady = checkTTS(); }catch(e){}
function checkTTS(){ try{ execFileSync('python3',['-c','import edge_tts'],{timeout:3000,stdio:'pipe'}); return true; }catch(e){ return false; } }
// in-memory audio cache (text+voice -> base64), bounded
const ttsCache = new Map(); const TTS_MAX = 400;
const VOICES = process.env.TTS_VOICE || 'en-US-AriaNeural';
const VOICE_OPTIONS = ['en-US-AriaNeural','en-US-GuyNeural','en-US-JennyNeural','en-US-EmmaNeural','en-US-BrianNeural','en-US-AvaNeural','en-US-AndrewMultilingualNeural','en-US-ChristopherNeural','en-US-MichelleNeural','en-US-EricNeural'];
async function tts(text, voice){
  const v = (voice && (VOICE_OPTIONS.includes(voice)||VOICES.includes(voice))) ? voice : VOICES;
  const key = (v)+'::'+text;
  if (ttsCache.has(key)) return {buf:ttsCache.get(key), key, cached:true};
  const mp3 = path.join(cacheDir, Math.random().toString(36).slice(2)+'.mp3');
  execFileSync('python3',['-m','edge_tts','--voice',v,'--text',text,'--write-media',mp3],{timeout:20000,stdio:'pipe'});
  const buf = fs.readFileSync(mp3); fs.unlink(mp3,()=>{});
  if (ttsCache.size > TTS_MAX) ttsCache.delete(ttsCache.keys().next().value);
  ttsCache.set(key, buf);
  return {buf, voice:v, cached:false};
}
function bufToBase64(buf){ return buf.toString('base64'); }
function base64ToBuf(b){ return Buffer.from(b,'base64'); }
async function aiDefinition(body) {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not configured');
  const word = clean(body.word), source = clean(body.definition);
  if (!word || !source) throw new Error('A word and definition are required');
  const prompt = `Rewrite the dictionary definition of the vocabulary word “${word}” for a learner.

SOURCE DEFINITION (use this as a factual hint, but do not copy its awkward wording): “${source}”

Return valid JSON ONLY: {"definition":"..."}
Rules:
- Give the clearest modern meaning for the exact sense in the source.
- One short sentence, ideally 6–16 words.
- Never include the target word itself or a close derivative in the definition.
- Remove part-of-speech labels, dictionary abbreviations, control characters, etymology, examples, and cross-references.
- Do not add a second sense or information not supported by the source.
- Prefer concrete plain English. For “outset”, output something like “The beginning of something.”, not “At (or from) the outset from the beginning.”`;
  let last;
  for (const model of models) {
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method:'POST', headers:{'Authorization':`Bearer ${process.env.OPENROUTER_API_KEY}`,'Content-Type':'application/json','HTTP-Referer':'http://localhost:'+PORT,'X-Title':'Word Craft'},
        body:JSON.stringify({model,messages:[{role:'user',content:prompt}],temperature:0.2,max_tokens:100})
      });
      const j=await r.json();
      if(!r.ok){last=new Error(j.error?.message||`Model error ${r.status}`);continue;}
      let text=(j.choices?.[0]?.message?.content||'').replace(/^```json\\s*/,'').replace(/```\\s*$/,'').trim();
      const parsed=JSON.parse(text), definition=String(parsed.definition||'').replace(/[\\x00-\\x1f]/g,' ').trim();
      if(!definition) throw new Error('AI returned an empty definition');
      persistEnrich(word,{aiDefinition:definition});
      return {definition,cached:false,model};
    } catch(e){last=e;}
  }
  throw last||new Error('No free model responded');
}
async function genie(body) {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not configured');
  const word = clean(body.word), definition = clean(body.definition), mode = clean(body.mode || 'learn');
  if (!word || !definition) throw new Error('A word and definition are required');
  const prompt = `You are a warm, concise SAT vocabulary tutor for the word “${word}” (definition: “${definition}”).

THE LEARNER'S REQUEST/QUESTION (must be answered FIRST and directly, even if a canned quick-question was clicked): “${mode}”

Rules:
1. If the request is a specific question (e.g. “How is X the opposite of voracious?”), lead by answering THAT exact question clearly and directly, and honestly flag if the premise is inaccurate rather than silently agreeing.
2. Then provide the remaining fields.
Return valid JSON ONLY with exactly these keys: directAnswer, explanation, example, memoryHook, deeperQuestion, contextNote, synonyms, antonyms.
- 'directAnswer': a concise 1-3 sentence answer to the learner's exact request. It must be different in substance depending on the request: explain means plain English; memory means a memorable hook; near-syn means a direct contrast; test me means a mini-question or two; in the wild means useful context.
- 'explanation': supporting teaching content after the direct answer; distinguish the word from a related term if relevant.
- 'synonyms' and 'antonyms': arrays of 2-4 SHORT strings. Antonyms must be TRUE opposites of this exact word (e.g. voracious → sated/satisfied, NOT indifferent). If a true antonym is not sensible use an empty array.
- 'example': vivid original sentence.
- 'contextNote': if mentioning a book, label as an example of usage, never claim the exact word appears there; do not invent quotations.`;
  let last;
  for (const model of models) {
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', headers: {'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'http://localhost:'+PORT, 'X-Title': 'Word Craft'},
        body: JSON.stringify({model, messages:[{role:'user',content:prompt}], temperature:0.65, max_tokens:700})
      });
      const j = await r.json();
      if (!r.ok) { last = new Error(j.error?.message || `Model error ${r.status}`); continue; }
      let text = j.choices?.[0]?.message?.content || '';
      text = text.replace(/^```json\s*/,'').replace(/```\s*$/,'').trim();
      const parsed = JSON.parse(text);
      persistEnrich(word, { example: parsed.example||null, synonyms: parsed.synonyms&&parsed.synonyms.length? parsed.synonyms.slice(0,4) : null, antonyms: parsed.antonyms&&parsed.antonyms.length? parsed.antonyms.slice(0,4) : null });
      return {...parsed, model};
    } catch (e) { last = e; }
  }
  throw last || new Error('No free model responded');
}
// Map a free-form spoken utterance to one of the page's legal tools (intent classification).
// Reuses the same free OpenRouter models + rate limiter as genie/definition.
const INTENT_TOOLS = ['next','back','skip','repeat','slow','fast','reveal','answer_option','answer_meaning','deep_dive','dd_ask','options','help','review','browse','search','yes','no','mute','voice_on','stop','unknown'];
async function classifyIntent(body) {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not configured');
  const word = clean(body.word), definition = clean(body.definition), screen = clean(body.screen);
  const text = clean(body.text);
  const tools = Array.isArray(body.tools) ? body.tools.filter(t=>INTENT_TOOLS.includes(t)) : [];
  if (!text) throw new Error('An utterance is required');
  const toolList = tools.length ? tools.join(', ') : INTENT_TOOLS.join(', ');
  const prompt = `You route a learner's spoken utterance to ONE action in a vocabulary flashcard app.

Current word: "${word}" (${screen})
Definition: "${definition}"
Allowed tools (return exactly one of these): ${toolList}

Learner said: "${text}"

Return valid JSON ONLY: {"tool":"...","option":null,"query":null,"confidence":0.0,"why":"..."}
Rules:
- tool must be one of the allowed tools. If none fits, use "unknown".
- For answer_option, set option to 0-3 (A=0,B=1,C=2,D=3) when the learner indicates a choice ("b","second","that one"); else null.
- For search or dd_ask, put the learner's query in "query".
- For yes/no, tool is "yes" or "no".
- "next" if they want to advance, "reveal" if they want the answer shown, "repeat" if they want it re-read.
- confidence 0-1. why is one short phrase, not used by the app.`;
  let last;
  for (const model of models) {
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method:'POST', headers:{'Authorization':`Bearer ${process.env.OPENROUTER_API_KEY}`,'Content-Type':'application/json','HTTP-Referer':'http://localhost:'+PORT,'X-Title':'Word Craft'},
        body:JSON.stringify({model,messages:[{role:'user',content:prompt}],temperature:0,max_tokens:110})
      });
      const j=await r.json();
      if(!r.ok){last=new Error(j.error?.message||`Model error ${r.status}`);continue;}
      let textOut=(j.choices?.[0]?.message?.content||'').replace(/^```json\s*/,'').replace(/```\s*$/,'').trim();
      const parsed=JSON.parse(textOut);
      const tool = INTENT_TOOLS.includes(parsed.tool) ? parsed.tool : 'unknown';
      return { tool, option: Number.isInteger(parsed.option)&&parsed.option>=0&&parsed.option<=3 ? parsed.option : null,
        query: parsed.query ? String(parsed.query).slice(0,80) : null, confidence: Math.min(1,Math.max(0,Number(parsed.confidence)||0)), model };
    } catch(e){ last=e; }
  }
  throw last||new Error('No free model responded');
}
// ---- Vocal agent: full context + per-session memory (truly agentic) ----
// Each turn gets the whole page situation (screen, word, definition, options),
// a short rolling memory of the conversation, and must return ONE decision with
// a spoken narration + (for free-speech answers) an interpretation verdict.
const AGENT_ACTIONS = ['next','back','skip','repeat','slow','fast','reveal','answer_option','answer_meaning','deep_dive','dd_ask','options','help','review','browse','search','yes','no','mute','voice_on','stop','unknown'];
const agentMemory = new Map(); // sessionId -> [{role,text}]
async function agentTurn(body) {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not configured');
  const session = clean(body.session||'anon');
  const screen = clean(body.screen);
  const word = clean(body.word), definition = clean(body.definition);
  const pos = clean(body.pos);
  const userText = clean(body.text);
  const options = Array.isArray(body.options) ? body.options.map(clean).slice(0,4) : [];
  const legal = Array.isArray(body.tools) ? body.tools.filter(t=>AGENT_ACTIONS.includes(t)) : [];
  if (!userText) throw new Error('An utterance is required');
  const useMemory = body.memory !== false;
  if (useMemory) { const m = agentMemory.get(session)||[]; m.push({role:'user', note:userText}); agentMemory.set(session, m.slice(-8)); }
  const hist = useMemory ? (agentMemory.get(session)||[]).slice(-8).slice(0,-1) : [];
  const histText = hist.length ? hist.map(h=>h.role==='user'?'User: '+h.note : 'App: '+h.note).join('\n') : '(nothing yet)';
  const optText = options.length ? options.map((o,i)=>`${String.fromCharCode(65+i)}) ${o}`).join(' | ') : 'none (not a quiz card)';
  const actionList = legal.length ? legal.join(', ') : AGENT_ACTIONS.filter(a=>a!=='unknown').join(', ');
  const prompt = `You are the agent orchestrating a hands-free SAT/GRE flashcard app. You decide ONE next action and narrate it.

CURRENT PAGE:
- screen: ${screen}
- word: "${word}"${pos?' ('+pos+')':''}
- definition: "${definition}"
- options (A-D): ${optText}

ALLOWED ACTIONS (must pick one): ${actionList}
Guidance per action:
- answer_option: learner picks A/B/C/D -> set index (A=0,B=1,C=2,D=3).
- answer_meaning: learner speaks their own meaning. Judge it against the definition/options and set verdict (0=wrong,1=close,2=correct) and give the canonical meaning in narration.
- deep_dive / dd_ask: learner wants to learn/know something -> put their question/about in 'query'.
- reveal: show the answer/definition.
- repeat: re-say the last thing.
- yes / no, next, back, skip, review, browse, search, stop, mute, voice_on, options, help, unknown.

RECENT CONTEXT (last lines are assistant input):
${histText}

USER JUST SAID: "${userText}"

Return valid JSON ONLY with keys: action, index (number 0-3 or null), verdict (0/1/2 or null), query (string or null), narration (short spoken confirmation, 1 sentence), confidence (0-1). No text outside the JSON.`;
  let last;
  for (const model of models) {
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method:'POST', headers:{'Authorization':`Bearer ${process.env.OPENROUTER_API_KEY}`,'Content-Type':'application/json','HTTP-Referer':'http://localhost:'+PORT,'X-Title':'Word Craft'},
        body:JSON.stringify({model,messages:[{role:'user',content:prompt}],temperature:0.1,max_tokens:150})
      });
      const j=await r.json();
      if(!r.ok){last=new Error(j.error?.message||`Model error ${r.status}`);continue;}
      let str=(j.choices?.[0]?.message?.content||'').replace(/^```json\s*/,'').replace(/```\s*$/,'').trim();
      const p=JSON.parse(str);
      const action = AGENT_ACTIONS.includes(p.action) && p.action!=='unknown' ? p.action : null;
      const reply = { action, index: Number.isInteger(p.index)&&p.index>=0&&p.index<=3 ? p.index : null,
        verdict: [0,1,2].includes(p.verdict) ? p.verdict : null, query: p.query?String(p.query).slice(0,80):null,
        narration: p.narration?clean(p.narration).slice(0,200):'', confidence: Math.min(1,Math.max(0,Number(p.confidence)||0)), model };
      if (reply.action) { const a=agentMemory.get(session)||[]; a.push({role:'assistant', note:reply.narration}); agentMemory.set(session, a.slice(-8)); }
      return reply;
    } catch(e){ last=e; }
  }
  throw last||new Error('No free model responded');
}
// ---- Agentic orchestrator: proactive AND reactive turns in one loop step. ----
// The model writes natural spoken lines AND returns a page action (tool).
const ORCH_ACTIONS=['next','back','skip','repeat','slow','fast','reveal','answer_option','answer_meaning','deep_dive','dd_ask','options','help','review','browse','search','yes','no','mute','voice_on','stop','none'];
const tmem=new Map();
async function orch(body){
  if(!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not configured');
  const session=clean(body.session||'anon');
  const text=clean(body.text||'');
  const moment=clean(body.moment||'');
  const word=clean(body.word), def=clean(body.definition), pos=clean(body.pos||'');
  const ex=clean(body.example||'');
  const syn=Array.isArray(body.synonyms)?body.synonyms.map(clean).slice(0,3).join(', '):'';
  const ant=Array.isArray(body.antonyms)?body.antonyms.map(clean).slice(0,2).join(', '):'';
  const opts=Array.isArray(body.options)?body.options.map(clean).slice(0,4):[];
  const screen=clean(body.screen||'teach');
  const stats=clean(body.stats||'');
  const tools=Array.isArray(body.tools)?body.tools.filter(t=>ORCH_ACTIONS.includes(t)):[];
  const tl=tools.length?tools.join(', '):'next, back, skip, reveal, repeat, answer_option, deep_dive';
  const m=tmem.get(session)||[];
  const hist=m.slice(-8).map(x=>x.role==='u'?'User: '+x.txt:'Tutor: '+x.txt).join('\n')||'(fresh session)';
  const optText=opts.length?opts.map((o,i)=>String.fromCharCode(65+i)+') '+o).join(' | '):'none (not a quiz)';
  const sent={
    learn:'Introduce the word, say it clearly, and invite the learner to try it.',
    question:'Give the word as a quick test; ask for a choice A-D or their own words.',
    reveal:'After revealing, teach the meaning + example + a synonym.',
    correct:'Warmly confirm a CORRECT answer; acknowledge the streak if any.',
    wrong:'Encouragingly correct a WRONG answer; restate meaning + example.',
    relearn:'Gently reinforce a returning word; ask them to say it back.',
    nudge:'Nudge the stalled learner toward what to do now.',
    dive:'Invite a deep dive; ask what they want to know.',
    review:'Cheer them to review and pick a missed word.'
  };
  const job = text ? ('The learner just said: \"'+text+'\". Respond naturally, decide the next tool, and speak.') : ('Proactive beat ('+moment+'): '+(sent[moment]||sent.reveal));
  const prompt=`You are an attentive, warm human SAT and GRE vocab tutor, hell-bent on making sure the learner truly knows each word. You talk aloud the way a great teacher does: natural, warm, varied, never robotic or scripted.

CURRENT: screen=${screen}, word="${word}"${pos?' ('+pos+')':''}, definition="${def}".
Example: ${ex}. Synonyms: ${syn}. Antonyms: ${ant}. Quiz options: ${optText}. Learner stats: ${stats}.
Tools you can act with: ${tl}

Recent dialogue:
${hist}

${job}

Reply ONLY valid JSON:
{"say":"<short natural spoken line, 1-3 sentences, <55 words, in your tutor voice>",
 "action":"<pick one tool from the tools list, or 'none'>",
 "index":<0-3 if learner chose an option, else null>,
 "verdict":<0 wrong / 1 close / 2 correct when grading a spoken meaning, else null>,
 "done":<true if now wait for the learner, false if continue acting>}
Do not add text outside the JSON. Do not repeat phrases you already used.`;
  let last;
  for (const model of models) {
    try {
      const r=await fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{'Authorization':`Bearer ${process.env.OPENROUTER_API_KEY}`,'Content-Type':'application/json','HTTP-Referer':'http://localhost:'+PORT,'X-Title':'Word Craft'},body:JSON.stringify({model,messages:[{role:'user',content:prompt}],temperature:0.7,max_tokens:180})});
      const j=await r.json(); if(!r.ok){last=new Error(j.error?.message||`Model error ${r.status}`);continue;}
      let str=(j.choices?.[0]?.message?.content||'').replace(/^```json\s*/,'').replace(/```\s*$/,'').trim();
      const p=JSON.parse(str);
      const action=ORCH_ACTIONS.includes(p.action)?p.action:'none';
      const say=clean(p.say||'').slice(0,220);
      const out={action, say, index:(Number.isInteger(p.index)&&p.index>=0&&p.index<=3)?p.index:null, verdict:([0,1,2].includes(p.verdict)?p.verdict:null), done:(p.done!==false), model};
      const a=tmem.get(session)||[];
      if(text){ a.push({role:'u',txt:text}); }
      if(say){ a.push({role:'t',txt:say}); }
      tmem.set(session,(Math.max(0),(a.slice(-14))));
      return out;
    } catch(e){ last=e; }
  }
  throw last||new Error('No free model responded');
}

function serve(req,res) {
  const pathname = req.url.split('?')[0];
  const file = pathname === '/' ? 'index.html' : pathname.replace(/^\//,'');
  const safe = path.normalize(file).replace(/^\.\.(\/|\\)/,'');
  const full = path.join(ROOT,'public',safe);
  if (!full.startsWith(path.join(ROOT,'public'))) return send(res,403,{error:'Forbidden'});
  const mime = {'html':'text/html','js':'text/javascript','css':'text/css','json':'application/json'}[path.extname(full).slice(1)] || 'text/plain';
  fs.readFile(full,(err,data)=> err ? send(res,404,{error:'Not found'}) : send(res,200,data,mime));
}
function loginJs(build){
  return `document.getElementById('f').addEventListener('submit',async e=>{e.preventDefault();const p=document.getElementById('p').value;const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p})});document.getElementById('p').value='';if(r.ok){location.href='/'}else{document.getElementById('err').textContent=r.status===429?'Too many attempts. Try later.':'Wrong password.'}});`;
}
function guard(req,res){
  const route = req.url.split('?')[0];
  if (route==='/login') return send(res,200,loginPage(),'text/html');
  if (route==='/login.js') return send(res,200,loginJs(),'text/javascript');
  if (PUBLIC_PATHS[route]) return serve(req,res);
  return false;
}
const server=http.createServer((req,res)=>{
  const ip = req.socket.remoteAddress || 'x';
  const route = req.url.split('?')[0];
  // Login route (not gated)
  if (req.method==='POST' && route==='/api/login'){
    if (!passwordIsActive()) return send(res,200,{ok:true,session:(()=>{const t=issueSession();res.setHeader('Set-Cookie',cookieHeader(t));return t})()});
    let raw=''; req.on('data',c=>{raw+=c;if(raw.length>4000)req.destroy();});
    req.on('end',()=>{
      try{
        const {password=''}=JSON.parse(raw||'{}');
        if (passwordIsActive() && !safeEqual(password, APP_PASSWORD)){ return send(res,401,{error:'bad'}) }
        const t=issueSession(); res.setHeader('Set-Cookie',cookieHeader(t)); return send(res,200,{ok:true});
      }catch(e){send(res,400,{error:'bad request'})}
    }); return;
  }
  // Public asset/login + logout
  if (req.method==='GET'){
    if (route==='/login') return send(res,200,loginPage(),'text/html');
    if (route==='/login.js') return send(res,200,loginJs(),'text/javascript');
    if (route==='/logout'){ res.setHeader('Set-Cookie','sat_session=; Max-Age=0; Path=/'); return send(res,200,{ok:true}); }
  }
  // Everything else requires auth
  if (!isAuthed(req)){
    if (req.method==='GET'){
      // allow the login page's own assets
      if (route==='/login'||route==='/login.js'||route==='/style.css'||route==='/app.js') return guard(req,res);
      res.statusCode=302; res.setHeader('Location','/login'); res.end(); return;
    }
    return send(res,401,{error:'unauthorized'});
  }
  if (req.method==='GET' && route==='/api/words') return send(res,200,{words});
  if (req.method==='GET' && route==='/api/version') return send(res,200,BUILD);
  if (req.method==='POST' && route==='/api/search') {
    let raw=''; req.on('data',c=>{raw+=c; if(raw.length>2000) req.destroy();});
    req.on('end',async()=>{try{const {q=''}=JSON.parse(raw||'{}');send(res,200,{results:await searchDb(String(q).slice(0,60))})}catch(e){send(res,500,{error:e.message})}}); return;
  }
  if (req.method==='POST' && route==='/api/definition') {
    if (!process.env.OPENROUTER_API_KEY) return send(res,503,{error:'AI not configured on server'});
    if (!rateOk(ip)) return send(res,429,{error:'Too many requests. Take a short break ✨'});
    let raw=''; req.on('data',c=>{raw+=c; if(raw.length>4000) req.destroy();});
    req.on('end',async()=>{try{
      const {word=''}=JSON.parse(raw||'{}'), w=words.find(x=>x.word===String(word).toLowerCase());
      if(!w)return send(res,404,{error:'word not found'});
      if(w.aiDefinition)return send(res,200,{definition:w.aiDefinition,cached:true});
      send(res,200,await aiDefinition({word:w.word,definition:w.definition}));
    }catch(e){send(res,500,{error:e.message})}}); return;
  }
  if (req.method==='POST' && route==='/api/genie') {
    if (!process.env.OPENROUTER_API_KEY) return send(res,503,{error:'AI not configured on server'});
    if (!rateOk(ip)) return send(res,429,{error:'Too many requests. Take a short break ✨'});
    let raw=''; req.on('data',c=>{raw+=c; if(raw.length>20000) req.destroy();});
    req.on('end',async()=>{try {send(res,200,await genie(JSON.parse(raw)));} catch(e) {send(res,500,{error:e.message});}}); return;
  }
  if (req.method==='POST' && route==='/api/intent') {
    if (!process.env.OPENROUTER_API_KEY) return send(res,503,{error:'AI not configured on server'});
    if (!rateOk(ip)) return send(res,429,{error:'Too many requests. Take a short break ✨'});
    let raw=''; req.on('data',c=>{raw+=c; if(raw.length>4000) req.destroy();});
    req.on('end',async()=>{try {send(res,200,await classifyIntent(JSON.parse(raw)));} catch(e) {send(res,500,{error:e.message});}}); return;
  }
  if (req.method==='POST' && route==='/api/agent') {
    if (!process.env.OPENROUTER_API_KEY) return send(res,503,{error:'AI not configured on server'});
    if (!rateOk(ip)) return send(res,429,{error:'Too many requests. Take a short break ✨'});
    let raw=''; req.on('data',c=>{raw+=c; if(raw.length>4000) req.destroy();});
    req.on('end',async()=>{try {send(res,200,await agentTurn(JSON.parse(raw)));} catch(e) {send(res,500,{error:e.message});}}); return;
  }
  // Agentic orchestrator loop turn (model writes speech + picks page tool)
  if (req.method==='POST' && route==='/api/orch') {
    if (!process.env.OPENROUTER_API_KEY) return send(res,503,{error:'AI not configured on server'});
    if (!rateOk(ip)) return send(res,429,{error:'Too many requests. Take a short break ✨'});
    let raw=''; req.on('data',c=>{raw+=c; if(raw.length>6000) req.destroy();});
    req.on('end',async()=>{try {send(res,200,await orch(JSON.parse(raw)));} catch(e) {send(res,500,{error:e.message});}}); return;
  }
  // List selectable neural voices for the picker
  if (req.method==='GET' && route==='/api/voices') return send(res,200,{voices:VOICE_OPTIONS});
  // Human neural TTS (Edge-TTS). Returns base64 mp3. Cached server+client side.
  if (req.method==='POST' && route==='/api/tts') {
    let raw=''; req.on('data',c=>{raw+=c; if(raw.length>4000) req.destroy();});
    req.on('end',async()=>{
      try{
        const {text='', voice=''}=JSON.parse(raw||'{}');
        const t=String(text).trim().slice(0,500);
        if(!t) return send(res,400,{error:'text required'});
        if(!ttsReady) return send(res,501,{error:'TTS unavailable'});
        if(!rateOk(ip)) return send(res,429,{error:'Too many requests. Take a short break ✨'});
        const r=await tts(t, voice);
        send(res,200,{audio:bufToBase64(r.buf), key:r.key, cached:r.cached, voice:r.voice||''});
      }catch(e){ send(res,500,{error:e.message}); }
    }); return;
  }
  // Fast cached example lookup: returns instantly when already generated, else generates + caches.
  if (req.method==='POST' && route==='/api/example') {
    let raw=''; req.on('data',c=>{raw+=c; if(raw.length>2000) req.destroy();});
    req.on('end',async()=>{
      try{
        const {word='', force=false}=JSON.parse(raw||'{}');
        const w = words.find(x=>x.word===String(word).toLowerCase());
        if (!w) return send(res,404,{error:'word not found'});
        if (w.example && !force) return send(res,200,{example:w.example, cached:true});
        if (!process.env.OPENROUTER_API_KEY || !rateOk(ip)) return send(res,202,{example:w.example||'', cached:false});
        const g = await genie({word:w.word, definition:w.definition, mode:'Give one vivid original example sentence using the word.'});
        send(res,200,{example:g.example||'', cached:true}); // persistEnrich already saved it
      }catch(e){send(res,500,{error:e.message})}
    }); return;
  }
  if (req.method==='GET') return serve(req,res);
  send(res,405,{error:'Method not allowed'});
});
server.listen(PORT,()=>console.log(`Word Craft running on port ${PORT} • ${words.length} words ${'OPENROUTER_API_KEY' in process.env ? '• AI on' : '• AI off (set key for Deep Dive)'}`));
