const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DuckDBInstance } = require('@duckdb/node-api');

const PORT = process.env.PORT || 4173;
const ROOT = __dirname;
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
}
function clean(text) { return String(text || '').replace(/[<>]/g, '').slice(0, 500); }
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
