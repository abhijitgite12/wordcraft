window.addEventListener('error',e=>{const c=document.querySelector('#card');if(c&&!c.dataset.error){c.dataset.error='1';c.innerHTML='<div class="empty-card"><div class="empty-icon">!</div><h2>Word Craft needs a refresh</h2><p>'+String(e.message||'Please reload the page.').replace(/[<>]/g,'')+'</p><button class="dive-main" onclick="location.reload()">Refresh</button></div>'}});window.addEventListener('unhandledrejection',e=>{console.error(e.reason)});
let words, score=0, wrong={}, seen={}, craftWord=null, feed=[], fi=0, asked=null, curWord=null, mix='mixed', cat='all';
const $=s=>document.querySelector(s),$$=s=>document.querySelectorAll(s);const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const shuffle=a=>[...a].sort(()=>Math.random()-.5);

// ---- telemetry: report loaded version + runtime errors to /api/log so we can see real behavior ----
function tele(e, msg, detail, ctx){ try{ for(const fail of [0]){ void fail; } const ver=(document.currentScript&&document.currentScript.src)||''; fetch('/api/log',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:e,msg,detail,ver:ver.length?ver.split('/').pop():'',ua:navigator.userAgent,ctx:ctx||''})}).catch(()=>{}); }catch(_){} }
if(!window.__telBound){ window.__telBound=true;
  window.addEventListener('error',ev=>{ tele('jserr', (ev.message||'').slice(0,160), (ev.error&&ev.error.stack?String(ev.error.stack).slice(0,300):ev.filename||'') ); });
  window.addEventListener('unhandledrejection',ev=>{ tele('promise', String(ev.reason||'').slice(0,160), 'unhandledrejection'); });
}


// ===== Vocal agent: always-on listening + agentic orchestration =====
const VOICE = { on: localStorage.getItem('wordCraftVoiceOn')!=='off', rate: Number(localStorage.getItem('wordCraftRate')||1), micOn:false, state:'off', rec:null,
  sessionID: localStorage.getItem('wordCraftSession') || (()=>{const s='wc-'+Math.random().toString(36).slice(2,10);localStorage.setItem('wordCraftSession',s);return s})() };
let agentBusy=false;
const VoiceLabels={off:'Voice off',listening:'Listening',thinking:'Thinking…',speaking:'Saying…'};
// ---- state machine (Grok-style): off | listening | hearing | thinking | speaking ----
function setVoiceState(state, label, transcript){
  // If voice was turned off, a stale async response must not resurrect the active state.
  if(!VOICE.micOn && state!=='off' && !VOICE.forceTransient){ 
    // allow brief 'speaking'/'listening' only if voice is genuinely on; otherwise drop.
    return; 
  }
  VOICE.state=state;
  const pill=$('#voice-pill'), body=document.body;
  if(pill){ pill.dataset.state=state; const l=pill.querySelector('.vp-label'); if(l)l.textContent=label||VoiceLabels[state]||''; pill.classList.toggle('active',state!=='off'); }
  if(body){ body.classList.remove('v-off','v-listening','v-hearing','v-thinking','v-speaking'); body.classList.add('v-'+state); }
  const vb=$('#voice-btn'); if(vb){ vb.classList.toggle('on', state!=='off'&&state!=='v-off'); }
  if(typeof transcript==='string') setVoiceCaption(transcript,false);
  if(state==='off') setVoiceCaption('',false);
}
function setVoiceCaption(text,asAssistant){
  const cap=$('#voice-caption'); if(!cap)return;
  cap.textContent=text||'';
  cap.classList.toggle('assistant',!!asAssistant);
  cap.classList.toggle('user',!!text&&!asAssistant);
  cap.classList.toggle('hidden',!text);
}
// ---- serialized human-voice speech (Edge-TTS) with native fallback ----
const humanVoice = { on: localStorage.getItem('wordCraftHuman')!=='off' }; // default ON: the picked voice is THE voice everywhere; explicit off = fast native
// ---- smart "know when to speak" memory: track recent tutor lines so it never repeats itself ----
const talkMemory=[];
function rememberLine(text){ talkMemory.push({text, at:Date.now()}); if(talkMemory.length>40) talkMemory.shift(); }
function saidRecently(text, withinMs=8500){ const t=text.trim().toLowerCase(); return talkMemory.some(m=> (Date.now()-m.at)<withinMs && m.text.trim().toLowerCase()===t); }
function base64ToBlob(b64){ const bin=atob(b64), buf=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++)buf[i]=bin.charCodeAt(i); return new Blob([buf],{type:'audio/mpeg'}); }
let voiceSel = localStorage.getItem('wordCraftVoiceSel')||'en-US-AriaNeural';
function friendlyVoice(v){ const map={'en-US-AriaNeural':'Aria (female)','en-US-GuyNeural':'Guy (male)','en-US-JennyNeural':'Jenny (female)','en-US-EmmaNeural':'Emma (female)','en-US-BrianNeural':'Brian (male)','en-US-AvaNeural':'Ava (female)','en-US-AndrewMultilingualNeural':'Andrew (male)','en-US-ChristopherNeural':'Christopher (male)','en-US-MichelleNeural':'Michelle (female)','en-US-EricNeural':'Eric (male)'}; return map[v]||v; }
async function fetchTTS(text){
  try{ const r=await fetch('/api/tts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text, voice:voiceSel, rate:VOICE.rate||1})}); if(!r.ok)return null; const d=await r.json(); return d.audio?base64ToBlob(d.audio):null; }catch(e){return null}
}
let speakingBusy=false, activeLine='', pending='', ttsFetching=false, activeAudio=null;
let recGraceUntil=0, speakSeq=0; // turn-taking: grace window after speech + generation token that kills stale TTS
const ttsPlayer = document.createElement('audio'); ttsPlayer.preload='auto'; ttsPlayer.muted=true; (ttsPlayer.muted=false);
function finishLine(){ speakingBusy=false; activeLine=''; activeAudio=null; recGraceUntil=Date.now()+600; if(VOICE.micOn)setVoiceState('listening'); if(pending){ const p=pending; pending=''; speak(p,{force:true,human:true}); return; } if(tutorLive&&VOICE.on&&VOICE.micOn) scheduleGuide(); }
let _nativeVoice=null;
const VOICE_GENDER={'en-US-AriaNeural':'f','en-US-JennyNeural':'f','en-US-EmmaNeural':'f','en-US-AvaNeural':'f','en-US-MichelleNeural':'f','en-US-GuyNeural':'m','en-US-BrianNeural':'m','en-US-AndrewMultilingualNeural':'m','en-US-ChristopherNeural':'m','en-US-EricNeural':'m'};
const FEM_NAME=/female|aria|jenny|emma|ava|michelle|samantha|victoria|zira|susan|allison|kate|serena|sonia|catherine/i;
const MAL_NAME=/male|guy|brian|andrew|christopher|eric|david|daniel|alex|fred|george|ryan|thomas|james|mark|ravi/i;
function pickNativeVoice(){
  if(!window.speechSynthesis)return null;
  if(_nativeVoice)return _nativeVoice;
  const vs=window.speechSynthesis.getVoices?window.speechSynthesis.getVoices():[];
  if(!vs.length)return null;
  const want=VOICE_GENDER[voiceSel]||'f';
  const en=vs.filter(v=>/^en([-_].*)?$/i.test(v.lang));
  const matchGender=v=> want==='f' ? (FEM_NAME.test(v.name)&&!MAL_NAME.test(v.name)) : MAL_NAME.test(v.name);
  _nativeVoice = en.find(v=>/en-US/i.test(v.lang)&&matchGender(v)) || en.find(matchGender) || en.find(v=>/en-US/i.test(v.lang)) || en[0] || vs[0] || null;
  return _nativeVoice;
}
if(window.speechSynthesis && window.speechSynthesis.addEventListener){ window.speechSynthesis.addEventListener('voiceschanged',()=>{ _nativeVoice=null; }); }
function nativeSpeak(text){
  if(!window.speechSynthesis)return;
  pickNativeVoice();
  const u=new SpeechSynthesisUtterance(String(text)); u.rate=VOICE.rate; u.pitch=1;
  if(_nativeVoice)u.voice=_nativeVoice;
  u.onstart=()=>setVoiceState('speaking');
  u.onend=u.onerror=()=>{ finishLine(); };
  setVoiceCaption(String(text),true);
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}
function nativeStop(){ if(window.speechSynthesis)window.speechSynthesis.cancel(); }
let guideTimer=null, guideKey='';
function clearGuide(){ if(guideTimer){clearTimeout(guideTimer);guideTimer=null;} guideKey=''; }
function scheduleGuide(){
  clearGuide();
  guideTimer=setTimeout(()=>{ guideTimer=null; if(!VOICE.on||!VOICE.micOn)return; tutorGuideStep(); }, 1400);
}
// Guided tutor loop: after narrating, advance the lesson one natural step.
function tutorGuideStep(){
  // Fast-learning loop: teach cards advance on their own dwell timer, and quiz
  // cards wait for the learner - nothing to guide by hand anymore.
}
// Fast-learning pace: a fresh word card shows for ~2.6s, then the quiz comes to you.
// Any learner action (tap-to-study, drag, voice) cancels the auto-advance.
let teachTimer=null;
function clearTeach(){ if(teachTimer){clearTimeout(teachTimer);teachTimer=null;} }
function scheduleTeachAdvance(){
  clearTeach();
  teachTimer=setTimeout(()=>{
    teachTimer=null;
    const card=$('#card');
    if(cur()?.type!=='teach')return;
    if(card?.classList.contains('flipped')||card?.classList.contains('dragging')||card?.classList.contains('swiping'))return; // learner is studying it
    if(document.body.classList.contains('reviewing')||document.body.classList.contains('browsing'))return;
    move(1);
  },2600);
}
function stopAllAudio(){ speakSeq++; nativeStop(); if(activeAudio){ try{activeAudio.pause(); activeAudio.src='';}catch(e){} } activeAudio=null; speakingBusy=false; activeLine=''; pending=''; }
// ---- echo guard: is a heard phrase just our own narration coming back through the mic? ----
function normWords(s){ return String(s||'').toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(Boolean); }
function looksLikeEcho(heard){
  const rw=normWords(heard); if(!rw.length) return true;
  const now=Date.now();
  const lines=[activeLine, pending, ...talkMemory.filter(m=>now-m.at<12000).map(m=>m.text)];
  const resNorm=rw.join(' ');
  for(const line of lines){
    if(!line) continue;
    const lw=normWords(line); if(!lw.length) continue;
    const set=new Set(lw);
    const hit=rw.filter(w=>set.has(w)).length;
    if(hit/rw.length>=0.6) return true;                 // mostly our own words
    if(resNorm.length>3 && lw.join(' ').includes(resNorm)) return true; // verbatim fragment of a spoken line
  }
  return false;
}
// Main speak: serialized (never talks over itself), dedup'd, human voice preferred.
async function speak(text,{force=false,human=true,allowRepeat=false,forceHuman=false,ignoreMute=false}={}){
  if((!VOICE.on&&!ignoreMute)||!text)return;
  text=String(text).trim(); if(!text)return;
  if(speakingBusy && !force){
    // if we're already saying this exact thing, ignore; else queue for after.
    if(activeLine===text || saidRecently(text)) return;
    pending=text; return;
  }
  if(speakingBusy && force){ stopAllAudio(); }
  if(!allowRepeat && saidRecently(text)) return;
  const seq=++speakSeq;
  const ck=cardKey(); // this line belongs to the card it was born on
  speakingBusy=true; activeLine=text;
  rememberLine(text);
  setVoiceCaption(text,true); setVoiceState('speaking');
  const useHuman=human && humanVoice.on && !!window.fetch; // one voice everywhere: the selected Edge voice speaks every line
// useHuman: reuse one global audio element (unlocked by the mic-click gesture) to avoid autoplay block.
  if(useHuman){
    ttsFetching=true; const t0=Date.now(); let got=null;
    try{ got=await fetchTTS(text); }catch(e){}
    ttsFetching=false;
    if(seq!==speakSeq) return; // interrupted while fetching: never resurrect this audio
    if(!VOICE.on&&!ignoreMute){ finishLine(); return; } // muted while the line was being fetched: never play it
    if(cardKey()!==ck){ finishLine(); return; } // card changed mid-fetch: this line is stale, never play it
    // AI voice only: if the natural voice cannot play, the line is skipped (caption
    // already showed it) - the computer voice never sneaks in.
    if(!got || Date.now()-t0>9000){ finishLine(); return; }
    const url=URL.createObjectURL(got);
    const a=ttsPlayer; a.volume=1; a.src=url; activeAudio=a;
    a.onended=()=>{ URL.revokeObjectURL(url); activeAudio=null; finishLine(); };
    a.onerror=()=>{ URL.revokeObjectURL(url); activeAudio=null; finishLine(); };
    a.load(); a.play().catch(()=>{ URL.revokeObjectURL(url); activeAudio=null; finishLine(); });
  } else {
    nativeSpeak(text);
  }
}
function saidRecently(text){ const n=String(text||'').trim().toLowerCase(); const now=Date.now(); return talkMemory.some(m=>now-m.at<9000 && m.text.trim().toLowerCase()===n); }
function stopSpeak(){ stopAllAudio(); if(guideTimer){clearTimeout(guideTimer);guideTimer=null;} }
// On card change: end the current line like a person would - a fast natural fade,
// never a random mid-word chop. Queued/stale lines are dropped outright.
function softStopSpeak(){
  if(guideTimer){clearTimeout(guideTimer);guideTimer=null;}
  pending='';
  speakSeq++; // any in-flight TTS fetch dies when it returns
  const a=activeAudio; activeAudio=null; speakingBusy=false; activeLine='';
  if(a){ try{ let v=1; const step=()=>{ v-=0.34; if(v<=0){ try{a.pause();a.src='';a.volume=1;}catch(e){} return; } a.volume=v; setTimeout(step,85); }; step(); }catch(e){ try{a.pause();a.src='';a.volume=1;}catch(_){}} }
  else if(window.speechSynthesis && window.speechSynthesis.speaking){ nativeStop(); }
}


// ---- local reflexive fast-path (zero network) ----
// Only emergency voice controls bypass the agent. All learning language is
// intentionally interpreted by the page-aware orchestrator.
function localFastpath(text){
  const t=String(text||'').toLowerCase().trim(); if(!t)return null;
  if(/\b(stop|cancel|quiet|shut up)\b/.test(t))return {tool:'stop'};
  if(/\b(mute|voice off|turn off voice|silence)\b/.test(t))return {tool:'mute'};
  if(/\b(unmute|voice on|turn on voice)\b/.test(t))return {tool:'voice_on'};
  // Navigation reflex: "next page", "next card", "move on", "skip", "go back" NEVER wait for the model.
  if(/\b(next|skip|move on|continue|go forward|forward)\b/.test(t))return {tool:'next'};
  if(/\b(go back|back up|previous|last card|last one|back)\b/.test(t))return {tool:'back'};
  let m=t.match(/\b(?:load|show|open|bring up|go to|teach me|study)\s+(?:the\s+)?word\s+([a-z][a-z-]{1,30})/); if(m)return {tool:'load_word',query:m[1]};
  m=t.match(/\b(?:test|quiz)\s+me\s+(?:on|with|from)?\s*(?:the\s+)?([a-z]+)\s*(?:words|vocab|vocabulary|category)?/); if(m&&/^(gre|sat|core|academic|general|common)$/.test(m[1]))return {tool:'test_category',query:m[1]};
  // "load/show/go to <word>" - but never swallow a stopword as a bogus word lookup.
  m=t.match(/\b(?:load|show|open|go to)\s+([a-z][a-z-]{2,30})\b/); if(m&&!/^(the|a|an|to|of|it|this|that|these|those|me|my|page|card|next|back)$/.test(m[1]))return {tool:'load_word',query:m[1]};
  return null;
}
// ---- page context for the agent ----
function currentTools(){
  const c=cur(); const base=['next','back','skip','repeat','slow','fast','options','help','load_word','test_category','mute','voice_on','stop'];
  if(!c||c.type==='empty')return ['next','back','repeat','help','mute','voice_on','stop'];
  if(c.type==='test')return [...base,'answer_option','answer_meaning','reveal'];
  if(c.type==='relearn')return [...base,'reveal','deep_dive','yes','no'];
  return [...base,'reveal','deep_dive'];
}
function currentOptions(){
  if(cur()?.type!=='test')return [];
  return [...(document.querySelectorAll('.option')||[])].map(o=>String(o.dataset.a||'').trim()).filter(Boolean).slice(0,4);
}
function currentScreen(){
  const b=document.body;
  if(b.classList.contains('reviewing'))return 'review';
  if(b.classList.contains('browsing'))return 'browse';
  const c=cur(); if(!c||c.type==='empty')return 'empty';
  if(c.type==='relearn')return 'relearn';
  if(c.type==='test')return 'question';
  return document.querySelector('#card')?.classList.contains('flipped') ? 'teach_answer' : 'teach';
}
function currentWord(){ const c=cur(); return c?.word||null; }

// ---- Local, natural teaching narration (human tutor voice built from real card data) ----
let narrGuard='';
let actionReentrant=false;
// Holistic learner timeline sent to the orchestrator: voice, taps, navigation, answers, cards.
const interactionLog=[];
function recordInteraction(kind, detail){
  interactionLog.push({at:new Date().toISOString(),kind,detail:String(detail||'').slice(0,180),screen:currentScreen?.()||'' ,word:cur?.()?.word?.word||''});
  if(interactionLog.length>24)interactionLog.shift();
}
let prevUtterance='', lastUtteranceAt=0;
// tutorState tracks learner context ONLY to feed the orchestrator (model builds conversation);
// there are no scripted lines or hints here — the model writes everything.
const tutorState = { lastCorrect:true, consecutiveMiss:0, streak:0, seenWords:{} };
function bumpTutor(ev, w){ if(ev==='correct'){ tutorState.lastCorrect=true; tutorState.streak++; tutorState.consecutiveMiss=0; if(w) tutorState.seenWords[w.word]=(tutorState.seenWords[w.word]||0)+1; } else if(ev==='wrong'){ tutorState.lastCorrect=false; tutorState.consecutiveMiss++; if(w) tutorState.seenWords[w.word]=(tutorState.seenWords[w.word]||0)+1; } }

// Speak a natural teaching line tied to the current card (orchestrator-model written).
function narrate(moment){
  const w=cur()?.word; if(!w)return;
  orchSay({moment}, w);
}
// Narrate for an arbitrary word (deep-dive etc).
function narrateOn(moment, w){
  if(!tutorLive||!VOICE.on||!w)return;
  orchSay({moment}, w);
}
// Ask the orchestrator to write a natural line + may act. Model picks action.
let orchToken=0, orchBusy=false, lastOrchAt=0, lastOrchKey='';
async function orchSay(payload, w){
  if(!VOICE.on||!VOICE.micOn) return;        // voice off => zero orchestrator/network calls
  if(orchBusy) return;                       // never stack orchestrator turns
  const now=Date.now(); if(now-lastOrchAt<2200) return;  // natural pacing, avoids runaway loops
  lastOrchAt=now;
  if(!tutorLive&&payload&&!payload.text)return;
  const ww = w || cur()?.word; if(!ww)return;
  const tok=++orchToken;
  const ck=cardKey();
  const body={ session:VOICE.sessionID, text:payload.text||'', moment:payload.moment||'',
    word:ww.word, definition:ww.aiDefinition||ww.definition||'', pos:ww.partOfSpeech||'',
    example:ww.example||'', synonyms:ww.synonyms||[], antonyms:ww.antonyms||[],
    screen:currentScreen(), options:currentOptions(), tools:currentTools(),
    stats:`streak ${tutorState.streak}, consecutiveMiss ${tutorState.consecutiveMiss}, review ${Object.keys(wrong).length}`,
    history:interactionLog.slice(-16) };
  try{
    const r=await fetch('/api/orch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(!r.ok)return; const d=await r.json();
    if(tok!==orchToken)return; // stale (a newer narration superseded this)
    if(cardKey()!==ck)return;   // learner moved cards while the model thought: its say and action no longer apply
    lastOrchAt=Date.now();
    if(d.say) speak(d.say, {});
    if(d.action && d.action!=='none') await runAction({action:d.action,index:d.index,verdict:d.verdict,narration:d.say||'',say:d.say||''});
    else if(VOICE.micOn) setVoiceState('listening');
  }catch(e){}
}
// ---- always-on proactive tutoring toggle (speak the word on card transitions) ----
let tutorLive=false; function setTutorLive(v){ tutorLive=!!v; }
// Chat / natural connector when a new word appears: speak the word itself.
function sayOnCardChange(){
  if(!tutorLive||!VOICE.on)return;
  const c=cur(); if(!c||!c.word)return;
  const key=c.type+'|'+c.word.word;
  if(narrGuard===key)return; narrGuard=key;
  orchSay({moment: c.type==='relearn'?'relearn' : c.type==='test'?'question':'learn'}, c.word);

}

// ---- the agent decides the next action with full page context + memory ----
async function agentDecide(text){
  const w=currentWord();
  try{
    const r=await fetch('/api/orch',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({session:VOICE.sessionID, text, screen:currentScreen(), word:w?.word||'', pos:w?.partOfSpeech||'',
        definition:w?(w.aiDefinition||w.definition||''):'', options:currentOptions(), tools:currentTools(),
        example:w?.example||'', synonyms:w?.synonyms||[], antonyms:w?.antonyms||[],
        stats:`streak ${tutorState.streak}, consecutiveMiss ${tutorState.consecutiveMiss}`})});
    if(!r.ok)return null; return await r.json();
  }catch(e){return null}
}
// ---- act on the agent's decision ----
async function runAction(d){
  if(actionReentrant) return; actionReentrant=true;
  recordInteraction('tool',d?.action||'none');
  const legal=currentTools(); const w=currentWord();
  if(!d||!d.action||!legal.includes(d.action)){
    // Let the orchestrator decide how to respond naturally (no canned menu).
    setVoiceState(VOICE.micOn?'listening':'off');
    if(cur()?.word) orchSay({moment:'nudge'});
    return;
  }
  const n=String(d.narration||''); setVoiceState('thinking');
  switch(d.action){
    case 'next': move(1); break;
    case 'back': move(-1); break;
    case 'load_word': case 'search': loadWordCard(d.query, d.say); break;
    case 'test_category': startCategoryTest(d.query, d.say); break;
    case 'skip': move(1); break;
    case 'stop': stopSpeak(); setVoiceState(VOICE.micOn?'listening':'off'); return;
    case 'repeat': speak(w?(w.word+' — '+(w.aiDefinition||w.definition||'')):(n||'Repeating.')); break;
    case 'slow': VOICE.rate=Math.max(.5,VOICE.rate-.2);localStorage.setItem('wordCraftRate',VOICE.rate);speak(n||'Slower');break;
    case 'fast': VOICE.rate=Math.min(2,VOICE.rate+.2);localStorage.setItem('wordCraftRate',VOICE.rate);speak(n||'Faster.');break;
    case 'reveal': if(cur()?.type==='test'){ testReveal(); if(d.say)speak(d.say,{}); } else { showFlip(); if(d.say) speak(d.say,{}); else if(!tutorLive&&w) speak(w.word+' means '+(w.aiDefinition||w.definition||'')); } break;
    case 'deep_dive': if(w)openCraft(w); if(d.say)speak(d.say,{}); else if(n)speak(n); break;
    case 'options': if(n)speak(n,{}); else if(cur()?.word) orchSay({moment:'question'}); break;
    case 'help': if(n)speak(n,{}); else if(cur()?.word) orchSay({moment:'nudge'}); break;
    case 'review': showPage('review'); break;
    case 'browse': showPage('browse'); break;
    case 'mute': VOICE.on=false; stopSpeak(); setVoiceState('off'); localStorage.setItem('wordCraftVoiceOn','off'); return;
    case 'voice_on': VOICE.on=true; localStorage.setItem('wordCraftVoiceOn','on'); speak('Voice on.'); break;
    case 'answer_option': if(typeof d.index==='number'&&cur()?.type==='test'){const o=$$('.option')[d.index];if(o&&!o.classList.contains('disabled'))o.click();} else if(n)speak(n,{}); else if(cur()?.word) orchSay({moment:'question'}); break;
    case 'answer_meaning': answerFree(d.verdict, n); break;
    case 'yes': if(cur()?.type==='relearn'&&w){delete wrong[w.word];persist();update();move(1);} break;
    case 'no': if(n)speak(n,{}); else if(cur()?.word) orchSay({moment:'nudge'}); break;
    default: if(n)speak(n,{}); else if(cur()?.word) orchSay({moment:'nudge'}); break;
  }
  actionReentrant=false;
}
// free-spoken meaning: graded by the agent verdict (0 wrong, 1 close, 2 correct)
function answerFree(verdict, narration){
  if(guideTimer){clearTimeout(guideTimer);guideTimer=null;}
  const w=cur()?.word; if(!w)return;
  const right=correctAnswer(w);
  const opts=[...$$('.option')],rightIdx=opts.findIndex(x=>x.dataset.a===right);
  opts.forEach(x=>{x.classList.add('disabled');if(x.dataset.a===right)x.classList.add('correct')});
  let ok=false,head=null;
  if(verdict===2){ delete wrong[w.word]; score++; bumpTutor('correct',w); ok=true; head='✓ '+(narration||'Correct.'); }
  else if(verdict===1){ head='Close — '+(narration||'you have the right idea.'); }
  else{ wrong[w.word]=(wrong[w.word]||0)+1; bumpTutor('wrong',w); head='✗ '+(narration||'Not quite.'); const wobj=words.find(x=>x.word===w.word);feed.splice(fi+1,0,{type:'relearn',word:wobj}); }
  persist();update();
  tutorBeat(w,{correct:ok,chosenIdx:-1,rightIdx,container:$('#t-ans'),headline:head,spoken:narration||null});
  autoSizeCard();
}
// ---- handle an utterance: reflexive local first, else the agent ----
async function handleUtterance(text){
clearTeach();
if(guideTimer){clearTimeout(guideTimer);guideTimer=null;}
  text=String(text||'').trim(); if(!text)return;
  recordInteraction('voice',text);
  if(text===prevUtterance && Date.now()-lastUtteranceAt<1500) return; // ignore recognizer repeats
  prevUtterance=text; lastUtteranceAt=Date.now();
  setVoiceState('thinking','',text);
  clearBeat(); // learner is acting - never yank the card out from under them
  // Answer reflex: a spoken option pick on a quiz card runs instantly, no model wait.
  if(cur()?.type==='test'){
    const apick=parseAnswerPick(text);
    if(apick!==null){
      const o=$$('.option')[apick];
      if(o&&!o.classList.contains('disabled')){ setVoiceState('listening'); recordInteraction('voice-answer','option '+(apick+1)); answer(o); return; }
    }
    const cpick=matchOptionByContent(text);
    if(cpick!==null){
      const o=$$('.option')[cpick];
      if(o&&!o.classList.contains('disabled')){ setVoiceState('listening'); recordInteraction('voice-answer','option '+(cpick+1)+' by words'); answer(o); return; }
    }
  }
  const local=localFastpath(text);
  // Only safety controls bypass the orchestrator. Every learning utterance goes
  // through the page-aware agent so natural phrases can select the right tool.
  if(local && ['stop','mute','voice_on','next','back'].includes(local.tool)){
    setVoiceState('listening'); return runAction({action:local.tool,index:local.option,verdict:null,query:local.query,narration:''});
  }
  if(local && ['load_word','test_category'].includes(local.tool)){
    setVoiceState('listening'); return runAction({action:local.tool,query:local.query,narration:'',say:''});
  }
  if(agentBusy)return; agentBusy=true;
  const ck=cardKey();
  const d=await agentDecide(text); agentBusy=false;
  setVoiceState('listening');
  if(cardKey()!==ck)return; // card changed while the agent thought - its decision belongs to the old card
  if(d) await runAction({action:d.action,index:d.index,verdict:d.verdict??0,query:d.query||'',narration:d.say||d.narration||'',say:d.say||''});
  else if(cur()?.word) orchSay({moment:'nudge'}); // let the orchestrator respond naturally
  // re-listening handled by state
  if(VOICE.micOn) setVoiceState('listening');
}
// ---- always-on mic (continuous; restarts while mic on) ----
function startListening(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){ setVoiceState('off','',"Voice not supported here"); speak("Voice isn't supported in this browser."); VOICE.micOn=false; return; }
  if(!VOICE.on)return;
  const rec=new SR(); rec.lang='en-US'; rec.continuous=true; rec.interimResults=true; rec.maxAlternatives=1;
  rec.onstart=()=>{ if(!speakingBusy && Date.now()>=recGraceUntil) setVoiceState('listening'); };
  rec.onspeechstart=()=>{ if(!speakingBusy && Date.now()>=recGraceUntil) setVoiceState('listening'); };
  rec.onspeechend=()=>{ if(VOICE.micOn && !speakingBusy) setVoiceState('listening'); };
  rec.onresult=e=>{
    let f='',im='';
    for(let i=e.resultIndex;i<e.results.length;i++){ const tr=e.results[i][0].transcript; if(e.results[i].isFinal) f+=(' '+tr); else im+=(' '+tr); }
    const final=f.trim(), interim=im.trim(), heard=final||interim;
    // Turn-taking: while the app speaks (and for a beat after), its own voice echoes
    // back through the mic. Echo is dropped completely; a clearly non-echo final is
    // the user cutting in (barge-in): stop talking and listen.
    if(speakingBusy || VOICE.state==='speaking' || Date.now()<recGraceUntil){
      if(!heard || looksLikeEcho(heard)) return;
      if(!final){ setVoiceCaption(interim,false); return; }
      stopSpeak(); recGraceUntil=0;
      setVoiceState('thinking','',final); handleUtterance(final); return;
    }
    setVoiceCaption(heard,false);
    if(final){ setVoiceState('thinking','',final); handleUtterance(final); }
    else setVoiceState('listening');
  };
  rec.onerror=e=>{ if(e.error==='not-allowed'||e.error==='service-not-allowed'){ VOICE.micOn=false; setVoiceState('off'); } else if(VOICE.micOn && !speakingBusy) setVoiceState('listening'); };
  rec.onend=()=>{ if(VOICE.micOn) startListening(); };
  rec.start(); VOICE.rec=rec;
}
function toggleMic(on){
  on=(on===undefined)?!VOICE.micOn:on;
  orchToken++;            // invalidate any tutor narration already in flight
  // The voice button is the GLOBAL voice switch: off means the app says nothing at all.
  VOICE.on=!!on; try{localStorage.setItem('wordCraftVoiceOn',on?'on':'off');}catch(e){}
  VOICE.micOn=!!on;
  if(!on){ stopSpeak(); } // silence immediately when voice is turned off
  setTutorLive(on&&VOICE.on);
  if(on && VOICE.on){ setVoiceState('listening'); startListening(); sayOnCardChange(); }
  else{ if(VOICE.rec)VOICE.rec.abort(); VOICE.rec=null; setVoiceState('off'); setTutorLive(false); }
}
function initVoiceUI(){
  const btn=$('#voice-btn'), pill=$('#voice-pill');
  const toggle=()=>{ if(VOICE.micOn && (speakingBusy||VOICE.state==='speaking')){ stopSpeak(); recGraceUntil=Date.now()+250; setVoiceState('listening'); return; } toggleMic(!VOICE.micOn); };
  if(btn)btn.onclick=toggle; if(pill)pill.onclick=toggle;
  const vq=$('#vq-toggle'); if(vq){ vq.checked=humanVoice.on; vq.onchange=e=>{ humanVoice.on=vq.checked; try{localStorage.setItem('wordCraftHuman',humanVoice.on?'on':'off');}catch(e){} }; }
  const vs=$('#voice-sel'); if(vs){ vs.value=voiceSel; fetch('/api/voices').then(r=>r.ok?r.json():null).then(d=>{ if(!vs)return; if(d&&d.voices&&d.voices.length){ vs.innerHTML=d.voices.map(v=>'<option value="'+v+'">'+friendlyVoice(v)+'</option>').join(''); if(!d.voices.includes(voiceSel)){ voiceSel=d.voices[0]; try{localStorage.setItem('wordCraftVoiceSel',voiceSel);}catch(err){} } } vs.value=voiceSel; }).catch(()=>{}); vs.onchange=async e=>{ voiceSel=vs.value; _nativeVoice=null; try{localStorage.setItem('wordCraftVoiceSel',voiceSel);}catch(err){} // choosing a voice = use natural/Edge provider (that's where distinct voices live) so you hear it immediately
 humanVoice.on=true; const vq2=$('#vq-toggle'); if(vq2)vq2.checked=true; try{localStorage.setItem('wordCraftHuman','on');}catch(err){} speak('Hey - this is '+voiceSel.replace(/^en-US-/,'').replace(/MultilingualNeural$/,'').replace(/Neural$/,'')+'. Keep this one?',{human:true,allowRepeat:true,force:true,forceHuman:true,ignoreMute:true}); }; }
  const input=$('#voice-input'); const form=$('#voice-form');
  if(form)form.onsubmit=e=>{e.preventDefault();const v=input.value.trim();if(v){ if(speakingBusy)stopSpeak(); handleUtterance(v); input.value='';}};
  setVoiceState('off');
}

function levelOf(w){const d=w.difficulty||2;return d<=1?'Easy':d===2?'Medium':'Hard'}
function persist(){try{localStorage.setItem('satSparkWrong',JSON.stringify(wrong));localStorage.setItem('satSparkSeen',JSON.stringify(seen));localStorage.setItem('satSparkScore',score);localStorage.setItem('satSparkMix',mix);localStorage.setItem('satSparkCat',cat);}catch(e){}}
function weight(w){let m=wrong[w.word]||0;let mastered=seen[w.word]&&!m;if(m>0)return 1+m*3.5;if(mastered)return 0.35;return 1}
function eligibleWords(){let pool=words;if(mix!=='mixed')pool=pool.filter(w=>levelOf(w)===mix);if(cat!=='all')pool=pool.filter(w=>(Array.isArray(w.categories)?w.categories:[w.category||'general']).includes(cat));return pool}
function pick(){let pool=eligibleWords();if(!pool.length)return null;let tiers=pool.map(w=>({w,g:weight(w)})).filter(t=>t.g>0);let total=tiers.reduce((s,t)=>s+t.g,0),r=Math.random()*total,a=0;for(let t of tiers){a+=t.g;if(r<a)return t.w}return pool[Math.floor(Math.random()*pool.length)]}
function setFilters(){feed=[];fi=0;const pool=eligibleWords();if(!pool.length)feed=[{type:'empty'}];else ensureFeed();render();persist();}
function setMix(m){mix=m;$$('#mix-chips button').forEach(b=>b.classList.toggle('on',b.dataset.mix===m));setFilters()}
function setCat(c){cat=c;$$('#cat-chips button').forEach(b=>b.classList.toggle('on',b.dataset.cat===c));setFilters()}
(function(){$$('#mix-chips button').forEach(b=>b.onclick=()=>setMix(b.dataset.mix));$$('#cat-chips button').forEach(b=>b.onclick=()=>setCat(b.dataset.cat));})();
function ensureFeed(){while(fi>=feed.length){let w=pick();if(!w)break;feed.push({type:'teach',word:w});feed.push({type:'test',word:w})}}
function ensureAhead(count=3){while(feed.length<=fi+count){const before=feed.length;ensureFeed();if(feed.length===before){const w=pick();if(!w)break;feed.push({type:'teach',word:w},{type:'test',word:w})}}}
function cur(){return feed[fi]}
function cardKey(){ const c=cur(); return fi+'|'+(c?.type||'')+'|'+(c?.word?.word||''); }
function markSeen(w){seen[w.word]=(seen[w.word]||0)+1}
function renderReview(){const entries=Object.entries(wrong).sort((a,b)=>b[1]-a[1]);$('#header-review-count').textContent=entries.length||'';$('#review-list').innerHTML=entries.length?entries.map(([word,n])=>{const w=words.find(x=>x.word===word);return w?`<div class="word-row review-row" data-review="${esc(word)}"><b>${esc(word)}</b><span class="miss-count">missed ${n}×</span>${catTag(w)}${lvlBadge(w)}<span>${esc(displayDef(w))}</span></div>`:''}).join(''):'<p class="review-empty">No missed words yet. Keep going ✦</p>'}
function showPage(page){clearTeach();document.body.classList.toggle('reviewing',page==='review');document.body.classList.toggle('browsing',page==='browse');$('#review-page').classList.toggle('active',page==='review');$('#browse-page').classList.toggle('active',page==='browse')}
$('#review-link').onclick=()=>showPage('review');$('#browse-link').onclick=()=>showPage('browse');$('#back-learn').onclick=()=>showPage('learn');$('#back-browse').onclick=()=>showPage('learn');
$('#help-button').onclick=()=>$('#help-panel').classList.add('open');$('#close-help').onclick=()=>$('#help-panel').classList.remove('open');$('#help-panel').onclick=e=>{if(e.target.id==='help-panel')$('#help-panel').classList.remove('open')};
$('#prev-card').onclick=()=>move(-1);$('#next-card').onclick=()=>move(1);
function update(){persist();renderReview();$('#correct-total').textContent=score;$('#review-total').textContent=Object.keys(wrong).length;$('#progress-bar').style.width=Math.min(100,Object.keys(seen).length/words.length*100)+'%';$('#streak').textContent=localStorage.getItem('satSparkLast')===new Date().toDateString()?'1':'0';localStorage.setItem('satSparkLast',new Date().toDateString());$('#count').textContent=Object.keys(seen).length}
function highlightIn(word,sentence){if(!sentence)return '';let escw=word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');return esc(sentence).replace(new RegExp('\\b('+escw+')(s|es|ed|ing|d)?\\b','gi'),m=>`<b class="in-sen">${m}</b>`)}
function relationsHtml(w){let s=(w.synonyms||[]).map(x=>`<span class="syn">↗ ${esc(x)}</span>`).join('');let a=(w.antonyms||[]).map(x=>`<span class="ant">↘ ${esc(x)}</span>`).join('');if(!s&&!a)return '';return `<p class="relation-row">${s?`<b class="syn-tag">SYN</b> ${s}`:''}${a?`<b class="ant-tag">ANT</b> ${a}`:''}</p>`}
function exampleHtml(w){if(!w.example)return `<p class="example-empty" data-noexample="${w.word}">Crafting a vivid example…</p>`;return `<p class="example">${highlightIn(w.word,w.example)}</p><button class="regen-btn" data-regen="${w.word}">↻ another example</button>`}
const exCache={};
async function ensureExample(w){if(w.example||exCache[w.word]){w.example=w.example||exCache[w.word];fillExample(w);update();return}try{let r=await fetch('/api/example',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({word:w.word})});let d=await r.json();if(d.example){exCache[w.word]=d.example;w.example=d.example;localStorage.setItem('ex:'+w.word,d.example);fillExample(w);update()}}catch(e){}}
async function regenerateExample(w){const t=$('#card');if(!t)return;t.querySelector('.regen-btn').textContent='Crafting…';try{let r=await fetch('/api/example',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({word:w.word,force:true})});let d=await r.json();if(d.example){exCache[w.word]=d.example;w.example=d.example;localStorage.setItem('ex:'+w.word,d.example);fillExample(w)}}catch(e){t.querySelector('.regen-btn').textContent='↻ another example'}}
function fillExample(w){const el=$('#card [data-noexample="'+w.word+'"]');if(el)el.outerHTML=`<p class="example">${highlightIn(w.word,w.example)}</p><button class="regen-btn" data-regen="${w.word}">↻ another example</button>`;const rb=$('#card [data-regen="'+w.word+'"]');if(rb)rb.onclick=e=>{e.stopPropagation();regenerateExample(w)};autoSizeCard()}
function hydrateLocal(){try{for(const k of Object.keys(localStorage)){if(k.startsWith('ex:')){let wn=k.slice(3),v=localStorage.getItem(k);let x=words&&words.find&&words.find(w=>w.word===wn);if(x&&!x.example)x.example=v;}}}catch(e){}}

function lvlBadge(w){const l=levelOf(w);return `<span class="lvl ${l.toLowerCase()}">${l}</span>`}
function catTag(w){const cats=Array.isArray(w.categories)?w.categories:[w.category||'general'];const labels={ 'sat-hf':'SAT 🔥', gre:'GRE', core:'Core', academic:'Academic', general:'' };return cats.map(c=>labels[c]?`<span class="cat cat-${c}">${labels[c]}</span>`:'').join('')}
const definitionRequests={};
async function refreshDefinition(w){if(w.aiDefinition||definitionRequests[w.word])return definitionRequests[w.word];definitionRequests[w.word]=fetch('/api/definition',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({word:w.word})}).then(r=>r.ok?r.json():null).then(d=>{if(d&&d.definition){w.aiDefinition=d.definition;localStorage.setItem('def:'+w.word,d.definition);if(cur()?.word===w.word)render()}}).catch(()=>{}).finally(()=>{delete definitionRequests[w.word]});return definitionRequests[w.word]}
function hydrateDefinitions(){try{for(const k of Object.keys(localStorage)){if(k.startsWith('def:')){const w=words&&words.find(x=>x.word===k.slice(4));if(w&&!w.aiDefinition)w.aiDefinition=localStorage.getItem(k)}}}catch(e){}}
function displayDef(w){let s=String(typeof w==='string'?w:(w.aiDefinition||w.definition)||'').replace(/[\u007f]/g,' ').replace(/\[[^\]]*\]/g,'').replace(/^\s*[—-]?\s*(?:adj|n|v|adv)\.?\s*/i,'').replace(/^\s*\([^)]*\)\s*/,'').replace(/^\s*[—-]\s*/,'').replace(/\s+/g,' ').trim();s=s.split(/\s+[—-]\s*(?:n|v|adj|adv)\.?/i)[0].trim();s=s.replace(/\b(?:foll\.|usu\.|colloq\.|esp\.)\s*/gi,'').trim();
// Keep the first useful sense only; numbered dictionary senses are not learner-friendly.
s=s.replace(/^(?:\w+\s+)?(?:\d+\s*)/, '').split(/\s+\d+\s+/)[0].trim();
// Drop derivative/cross-reference text after the first complete sentence.
const sentence=s.match(/^.+?[.!?](?:\s|$)/);if(sentence)s=sentence[0].trim();
return s.charAt(0).toUpperCase()+s.slice(1)}
function shortDef(w){let s=displayDef(w);return s.length>145?s.slice(0,142).replace(/[,;:]?\s+\S*$/,'')+'…':s}
function teachHtml(w){return `<div class="face front"><div class="card-top"><span class="pos">${esc(w.partOfSpeech)}</span><span class="top-tags">${catTag(w)}${lvlBadge(w)}</span></div><h1>${esc(w.word)}</h1><p class="hint">Think of the meaning… tap to reveal</p></div><div class="face back"><div class="card-top"><span class="pos">${esc(w.partOfSpeech)}</span><span class="top-tags">${catTag(w)}${lvlBadge(w)}</span></div><h2>${esc(w.word)}</h2><p class="definition">${esc(displayDef(w))}</p>${exampleHtml(w)}${relationsHtml(w)}<button class="dive-main" data-dive="${w.word}">✦ Deep Dive</button></div>`}
function relearnHtml(w){return `<div class="relearn-card"><div class="relearn-label">↻ RELEARN — you missed this one</div><div class="card-top"><span class="pos">${esc(w.partOfSpeech)}</span><span class="top-tags">${catTag(w)}${lvlBadge(w)}</span></div><h2>${esc(w.word)}</h2><p class="definition">${esc(displayDef(w))}</p>${exampleHtml(w)}${relationsHtml(w)}<div class="relearn-actions"><button class="dive-main" data-dive="${w.word}">✦ Deep Dive</button><button class="micro got" id="retry-btn">✓ Got it now</button></div><p class="relearn-hint">or swipe ↓ to review again</p></div>`}
function testHtml(w){let which=(Math.random()*3|0);asked=which;let q,opts;
const rightDef=()=>deleak(shortDef(w),w.word);
const distractors=(map)=>{const out=[];for(const x of shuffle(words.filter(x=>x.word!==w.word))){const t=map(x);if(t&&!leaksWord(t,w.word))out.push(t);if(out.length>=3)break}return out};
if(which===0){q=`Which meaning best fits <b>${esc(w.word)}</b>?`;opts=shuffle([rightDef(),...distractors(shortDef)])}
else if(which===1){let syn=(w.synonyms||[])[0]||null;if(!syn||leaksWord(syn,w.word)){asked=0;q=`Which meaning best fits <b>${esc(w.word)}</b>?`;opts=shuffle([rightDef(),...distractors(shortDef)])}else{q=`Pick the closest <b>SYNONYM</b> of <b>${esc(w.word)}</b>`;opts=shuffle([syn,...distractors(x=>x.word)])}}
else{let ant=(w.antonyms||[])[0]||null;if(!ant||leaksWord(ant,w.word)){asked=0;q=`Which meaning best fits <b>${esc(w.word)}</b>?`;opts=shuffle([rightDef(),...distractors(shortDef)])}else{q=`Pick the <b>OPPOSITE</b> (antonym) of <b>${esc(w.word)}</b>`;opts=shuffle([ant,...distractors(x=>x.word)])}}
return `<div class="test-card"><div class="card-top"><div class="test-label">⚡ QUICK TEST</div><span class="top-tags">${catTag(w)}${lvlBadge(w)}</span></div><p class="test-q">${q}</p><div class="options">${opts.map((x,i)=>`<button class="option" data-n="${i+1}" data-a="${esc(x)}">${esc(x)}</button>`).join('')}</div><p class="hint" style="text-align:center;margin:8px 0 0">tap an option, or tap the card to reveal</p><button class="test-dive" data-dive="${w.word}">✦ Deep Dive</button><div class="tutor-beat" id="t-ans"></div></div>`}
function correctAnswer(w){if(asked===0)return deleak(shortDef(w),w.word);if(asked===1)return (w.synonyms||[])[0];return (w.antonyms||[])[0]}
// Answer-leak guard: an option must never contain the target word or a form of it.
function leaksWord(text, word){
  const w=String(word||'').toLowerCase(); if(!w)return false;
  const fs=[w, w+'s', w+'es', w+'ed', w+'ing', w+'ly', w+'ness', w+'ity', w+'tion', w+'er', w+'ers', w+'ist', w+'ism'];
  if(w.endsWith('e'))fs.push(w.slice(0,-1)+'ing', w.slice(0,-1)+'ed', w.slice(0,-1)+'er', w.slice(0,-1)+'est');
  if(w.endsWith('y')&&w.length>2)fs.push(w.slice(0,-1)+'ily', w.slice(0,-1)+'iness', w.slice(0,-1)+'ies', w.slice(0,-1)+'ied', w.slice(0,-1)+'ier', w.slice(0,-1)+'iest');
  const t=' '+String(text||'').toLowerCase().replace(/[^a-z0-9\s]/g,' ')+' ';
  return fs.some(f=>t.includes(' '+f+' '));
}
// Last-resort deleak for the CORRECT option when data still leaks: rewrite the
// common self-reference patterns, never leaving the word visible.
function deleak(text, word){
  let s=String(text||''); const w=String(word||'').toLowerCase(); if(!w||!leaksWord(s,w))return s;
  const W=w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  s=s.replace(new RegExp('^A '+W+'\\w* (?:person|one|individual)\\s+', 'i'), 'A person ');
  s=s.replace(new RegExp('^(?:A|An|The)?\\s*'+W+'\\w*\\s+(?:is|means|describes|refers to)\\s+', 'i'), '');
  s=s.replace(new RegExp('^Someone who is '+W+'\\w*\\s+', 'i'), 'Someone ');
  s=s.replace(new RegExp('^Something that is '+W+'\\w*\\s+', 'i'), 'Something ');
  s=s.replace(new RegExp('\\b'+W+'\\w*\\b', 'gi'), 'this');
  return s.charAt(0).toUpperCase()+s.slice(1);
}
function stackPreviewHtml(item){if(!item||!item.word)return '';const w=item.word;if(item.type==='test')return `<div class="stack-test"><div class="stack-preview-top"><span>⚡ QUICK TEST</span><span>→</span></div><p>Which meaning best fits <b>${esc(w.word)}</b>?</p><div class="stack-options"><i></i><i></i><i></i><i></i></div></div>`;return `<div class="stack-teach"><div class="stack-preview-top"><span>${esc(w.partOfSpeech||'WORD')}</span><span>→</span></div><strong>${esc(w.word)}</strong><small>${esc(displayDef(w))}</small></div>`}
function renderStack(){ensureAhead(3);const previous=$('#stack-prev');if(previous)previous.innerHTML=stackPreviewHtml(feed[fi-1]);const layers=[['#stack-next',1],['#stack-second',2],['#stack-third',3]];layers.forEach(([selector,offset])=>{const el=$(selector);if(el)el.innerHTML=stackPreviewHtml(feed[fi+offset])});$('#stack-prev')?.style.setProperty('--stack-progress','0');$('#stack-next')?.style.setProperty('--stack-progress','0');$('#stack-second')?.style.setProperty('--stack-progress','0');$('#stack-third')?.style.setProperty('--stack-progress','0')}
function commitMove(dir){clearBeat();softStopSpeak();if(dir<0&&fi===0)return;if(dir>0){fi++;ensureFeed()}else fi=Math.max(0,fi-1);recordInteraction('navigation',dir>0?'next':'back');render()}
function springCard(){CARD.classList.add('spring-back');CARD.style.transform='';$('#cardzone')?.classList.remove('dragging-left','dragging-right');$('#stack-prev')?.style.setProperty('--stack-progress','0');$('#stack-next')?.style.setProperty('--stack-progress','0');$('#stack-second')?.style.setProperty('--stack-progress','0');$('#stack-third')?.style.setProperty('--stack-progress','0');setTimeout(()=>CARD.classList.remove('spring-back'),430)}
function syncWordUrl(word){if(!word||document.body.classList.contains('reviewing')||document.body.classList.contains('browsing'))return;const u=new URL(location.href);u.search='';u.searchParams.set('w',word.word);history.replaceState(null,'',u)}
function autoSizeCard(){const zone=$('#cardzone'),c=$('#card');if(!zone||!c)return;let need=0;c.querySelectorAll('.face,.test-card,.relearn-card,.empty-card').forEach(f=>{f.style.height='100%';need=Math.max(need,f.scrollHeight)});need=Math.max(340,Math.min(700,need));zone.style.height=need+'px'}
function render(){let c=cur();if(!c||c.type==='empty'){ const level=mix==='mixed'?'any level':mix, type=cat==='all'?'all categories':cat;$('#card').innerHTML=`<div class="empty-card"><div class="empty-icon">✦</div><h2>No words in this mix</h2><p>There are no ${esc(type)} words at ${esc(level)} level yet.</p><button id="reset-filters" class="dive-main">Show Mixed</button></div>`;$('#reset-filters').onclick=()=>{mix='mixed';cat='all';$$('#mix-chips button').forEach(b=>b.classList.toggle('on',b.dataset.mix==='mixed'));$$('#cat-chips button').forEach(b=>b.classList.toggle('on',b.dataset.cat==='all'));setFilters()};return}curWord=c.word;markSeen(c.word);syncWordUrl(c.word);renderStack();if(c.word&&!c.word.aiDefinition)refreshDefinition(c.word);let html;
if(c.type==='teach'){html=teachHtml(c.word)}else if(c.type==='relearn'){html=relearnHtml(c.word)}else{html=testHtml(c.word)}$('#card').innerHTML=html;$('#card').classList.remove('flipped');
if(!c.word.example)ensureExample(c.word);
$('#card [data-regen]')&&($('#card [data-regen]').onclick=e=>{e.stopPropagation();regenerateExample(cur().word)});
autoSizeCard();$('#gesture').innerHTML=c.type==='test'?'swipe <b>left</b> · next word &nbsp;|&nbsp; <b>right</b> · back &nbsp;|&nbsp; tap, press <b>1-4</b>, or say <b>option 2</b>':(c.type==='relearn'?'swipe <b>left</b> · continue &nbsp;|&nbsp; <b>right</b> · back &nbsp;|&nbsp; <b>tap</b> Deep Dive':'swipe <b>left</b> · next &nbsp;|&nbsp; <b>right</b> · back &nbsp;|&nbsp; <b>tap</b> · reveal');let rb=$('#retry-btn');if(rb)rb.onclick=()=>{delete wrong[c.word.word];persist();update();move(1)};craftWord=c.word;update();if(c.type==='teach')scheduleTeachAdvance();else clearTeach()}
function showFlip(){clearTeach();recordInteraction('reveal','card flip');let c=$('#card');if(c.querySelector('.face')&&!c.classList.contains('flipped')&&!c.classList.contains('dragging')&&!c.classList.contains('swiping')){c.style.transform='';c.classList.add('flipping');requestAnimationFrame(()=>{c.classList.add('flipped');setTimeout(()=>c.classList.remove('flipping'),620)});if(tutorLive)narrate('reveal')}}
function move(dir){clearTeach();softStopSpeak();let c=$('#card');if(c.classList.contains('swiping'))return;if(dir<0&&fi===0){springCard();return}c.classList.add('swiping',dir>0?'moving-left':'moving-right');setTimeout(()=>{c.classList.remove('swiping','moving-left','moving-right');commitMove(dir);sayOnCardChange()},340)}
$('#card').addEventListener('click',e=>{if(suppressClick)return;let d=e.target.closest('[data-dive]');if(d){openCraft(words.find(w=>w.word===d.dataset.dive));return}let opt=e.target.closest('.option');if(opt&&!opt.classList.contains('disabled')){answer(opt);return}if($('#card').querySelector('.face'))showFlip();else if(cur()?.type==='test')testReveal()});
function celebrate(origin,big=false){if(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;const box=document.createElement('div');box.className='confetti';const r=origin?.getBoundingClientRect?.();box.style.left=(r?r.left+r.width/2:innerWidth/2)+'px';box.style.top=(r?r.top+r.height/2:innerHeight/2)+'px';for(let i=0;i<(big?24:12);i++){const p=document.createElement('i');p.style.setProperty('--x',(Math.random()*130-65)+'px');p.style.setProperty('--y',(Math.random()*90+35)+'px');p.style.setProperty('--r',(Math.random()*360)+'deg');p.style.setProperty('--d',(Math.random()*.2)+'s');p.style.background=['#6555d8','#ff785f','#2f9e62','#e8a13a','#7654c7'][i%5];box.appendChild(p)}document.body.appendChild(box);setTimeout(()=>box.remove(),1100)}

// ===== Tutor beat: instant right/wrong feedback + teach + auto-advance =====
// Deterministic and local-first: the panel renders instantly from card data, the
// spoken line plays immediately, and an AI note (when the brain is reachable)
// upgrades the "why / hook" slot in place. The loop NEVER depends on the network.
let beatTimer=null, beatToken=0;
function clearBeat(){ if(beatTimer){clearTimeout(beatTimer);clearInterval(beatTimer);beatTimer=null;} }
const BEAT_CHEERS=['Nailed it.','Sharp.','Exactly right.','Clean hit.','That\'s the one.','Too easy for you.','Knew you had it.'];
const BEAT_MISSES=['Not quite.','Close, but no.','That one slipped.','Good swing, wrong ball.'];
const pickBeat=a=>a[Math.random()*a.length|0];
function streakLine(){ return tutorState.streak>=3?(' That\'s '+tutorState.streak+' in a row.'):'' }
// Fetch the AI tutor note (why + hook). Null when unreachable - panel keeps local content.
const tutorNoteCache={};
async function fetchTutorNote(w,res){
  const key=w.word+'|'+(res.correct?'c':'w');
  if(key in tutorNoteCache)return tutorNoteCache[key];
  try{
    const opts=[...$$('.option')];
    const chosen=(typeof res.chosenIdx==='number'&&opts[res.chosenIdx])?opts[res.chosenIdx].dataset.a:'';
    const right=(typeof res.rightIdx==='number'&&opts[res.rightIdx])?opts[res.rightIdx].dataset.a:'';
    const r=await fetch('/api/tutor-note',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({word:w.word,definition:w.aiDefinition||w.definition||'',result:res.correct?'correct':'wrong',chosen,right})});
    if(!r.ok){ tutorNoteCache[key]=null; return null; }
    const d=await r.json();
    const note=[d.why?('<b>Why:</b> '+esc(d.why)):'', d.hook?('<b>Hook:</b> '+esc(d.hook)):''].filter(Boolean).join('<br>');
    tutorNoteCache[key]=note||null; return tutorNoteCache[key];
  }catch(e){ tutorNoteCache[key]=null; return null; }
}
function tutorBeat(w,res){
  const box=res.container||$('#t-ans'); if(!box)return;
  const tok=++beatToken;
  clearBeat();
  const def=displayDef(w);
  const cheer=res.correct?pickBeat(BEAT_CHEERS):pickBeat(BEAT_MISSES);
  const defaultHead=res.reveal ? ('The answer is option '+String((res.rightIdx??0)+1)+'.') : (res.correct ? (cheer+streakLine()) : (cheer+(typeof res.rightIdx==='number'&&res.rightIdx>=0?(' The answer is option '+String(res.rightIdx+1)+'.'):'')));
  const head=res.headline||defaultHead;
  box.className='tutor-beat show '+((res.correct||res.reveal)?'good':'bad');
  box.innerHTML=
    '<div class="tb-head">'+(res.correct?'✓':(res.reveal?'✦':'✗'))+' <b>'+esc(head)+'</b></div>'+
    '<div class="tb-word"><b>'+esc(w.word)+'</b> <span class="tb-pos">'+esc(w.partOfSpeech||'')+'</span> · '+esc(def)+'</div>'+
    (w.example?'<div class="tb-ex">'+highlightIn(w.word,w.example)+'</div>':'')+
    '<div class="tb-why" data-tb-why></div>'+
    '<div class="tb-foot"><span class="tb-prog">✓ '+score+' · 🔥 '+tutorState.streak+' · ↺ '+Object.keys(wrong).length+'</span>'+
    '<button class="tb-next" data-tb-next>Next → <i data-tb-count></i></button></div>';
  box.querySelector('[data-tb-next]').onclick=e=>{e.stopPropagation();advanceAfterBeat()};
  // Spoken feedback: short and immediate, so voice users always hear the verdict.
  const spoken=res.spoken||(res.reveal ? ('The answer is option '+String((res.rightIdx??0)+1)+'. '+w.word+' means '+def+'.')
                                        : (res.correct ? (cheer+' '+w.word+' means '+def+streakLine())
                                        : (cheer+' '+w.word+' actually means '+def+'. Let\'s learn it properly.')));
  if(VOICE.on) speak(spoken,{force:true});
  // AI enrichment upgrades the why/hook slot in place (no re-render, no layout jump).
  fetchTutorNote(w,res).then(note=>{ if(tok!==beatToken||!note)return; const slot=box.querySelector('[data-tb-why]'); if(slot)slot.innerHTML=note; });
  // Auto-advance with a visible countdown on the Next button. Any learner action cancels it.
  const wait=res.correct?3600:(res.reveal?5200:3000), t0=Date.now(), cnt=box.querySelector('[data-tb-count]');
  // self-correcting: countdown and advance are computed from t0 every tick, so
  // setTimeout drift can never desync the label from the actual advance
  beatTimer=setInterval(()=>{
    const el=Date.now()-t0, left=Math.ceil((wait-el)/1000);
    if(cnt)cnt.textContent=left>0?('· '+left):'';
    if(el>=wait){ clearInterval(beatTimer); beatTimer=null; advanceAfterBeat(); }
  },250);
}
function advanceAfterBeat(){ clearBeat(); if(cur()&&cur().type==='test') move(1); }
// Tap-to-reveal on a quiz card: highlights the right option and shows the same
// teach-back panel as a miss, WITHOUT touching score/misses - the learner asked to see it.
function testReveal(){
  const c=cur(); if(!c||c.type!=='test'||!c.word)return;
  const opts=[...$$('.option')]; if(!opts.length||opts.every(o=>o.classList.contains('disabled')))return; // already answered/revealed: keep the verdict
  const w=c.word, right=correctAnswer(w), rightIdx=opts.findIndex(x=>x.dataset.a===right);
  recordInteraction('reveal','test reveal');
  clearBeat();
  opts.forEach(x=>{x.classList.add('disabled');if(x.dataset.a===right)x.classList.add('correct')});
  tutorBeat(w,{correct:false,reveal:true,rightIdx,container:$('#t-ans')});
  autoSizeCard();
}
// Voice answer by CONTENT: what the learner said is matched against the visible
// options - exact words, word stems, or close spellings all count as a pick.
const OPT_STOP=new Set(['a','an','the','of','to','in','on','for','or','and','at','by','is','it','as','be','that','this','with','from','one','ones','someone','something','etc','pl','often','mean','means','meaning','think','guess','say','its','it\'s']);
function stemWord(w){ return String(w||'').replace(/ies$/,'y').replace(/(ational|ization|iveness|ments|ment|ness|ity|ing|ers|er|ed|es|ly|al|ic|s)$/,''); }
function lev1(a,b){ if(a===b)return true; if(Math.abs(a.length-b.length)>1)return false; let i=0,j=0,edits=0; while(i<a.length&&j<b.length){ if(a[i]===b[j]){i++;j++;continue} edits++; if(edits>1)return false; if(a.length>b.length)i++; else if(b.length>a.length)j++; else{i++;j++} } return edits+(a.length-i)+(b.length-j)<=1; }
function wordMatches(said,opt){ const s=stemWord(said),o=stemWord(opt); if(!s||!o)return false; return s===o||said===opt||(Math.min(s.length,o.length)>=4&&lev1(s,o)); }
function matchOptionByContent(text){
  const all=[...$$('.option')]; const opts=all.filter(o=>!o.classList.contains('disabled')); if(!opts.length)return null;
  const said=normWords(text).filter(w=>!OPT_STOP.has(w)&&w.length>2); if(!said.length)return null;
  const owList=opts.map(o=>normWords(o.dataset.a||o.textContent).filter(w=>!OPT_STOP.has(w)&&w.length>2));
  let bestIdx=null,bestHits=0,bestCov=0,bestDist=false;
  opts.forEach((o,k)=>{
    const ow=owList[k]; if(!ow.length)return;
    const hitsW=ow.filter(w=>said.some(s=>wordMatches(s,w))); if(!hitsW.length)return;
    const cov=hitsW.length/ow.length;
    // distinctive: a matched word that no other option contains - saying it clearly points here
    const dist=hitsW.some(w=>!owList.some((other,j)=>j!==k&&other.some(x=>wordMatches(w,x))));
    const hits=hitsW.length;
    if(hits>bestHits||(hits===bestHits&&cov>bestCov)){ bestIdx=all.indexOf(o); bestHits=hits; bestCov=cov; bestDist=dist; }
  });
  if(bestIdx===null)return null;
  const ow=normWords(all[bestIdx].dataset.a||'').filter(w=>!OPT_STOP.has(w)&&w.length>2);
  if(ow.length===1)return bestIdx;   // single-word option (synonym/antonym quiz): one hit is the whole option
  return (bestHits>=2||bestCov>=0.6||bestDist)?bestIdx:null;
}
// Voice answer reflex: on a quiz card, a spoken option pick NEVER waits for the model.
// Handles "option 3", "mark option 3", "I mean mark option 3", "the third one", "c", "go with 2".
function parseAnswerPick(t){
  t=String(t||'').toLowerCase().trim();
  if(!t||t.length>64)return null;
  const map={'1':0,'2':1,'3':2,'4':3,'a':0,'b':1,'c':2,'d':3,one:0,two:1,three:2,four:3,
    first:0,second:1,third:2,fourth:3,'1st':0,'2nd':1,'3rd':2,'4th':3};
  let m=t.match(/(?:option|choice|mark|pick|select|number|go(?:es)? with|go for|answer is|answers?|say|it'?s|i'?ll take|i mean|mean|is)\s*(?:option\s*)?(?:number\s*)?([1-4abcd])\b/);
  if(m)return map[m[1]];
  m=t.match(/(?:option|choice|number|pick|mark)\s+(one|two|three|four)\b/); if(m)return map[m[1]];
  m=t.match(/(?:^|\s)(first|second|third|fourth|1st|2nd|3rd|4th)(?:\s+one)?\s*[.!?]?$/); if(m)return map[m[1]];
  m=t.match(/^([1-4abcd])[.!?]?$/); if(m)return map[m[1]];
  return null;
}
function answer(btn){
  if(guideTimer){clearTimeout(guideTimer);guideTimer=null;}
  let w=cur().word,right=correctAnswer(w),correct=btn.dataset.a===right;
  const opts=[...$$('.option')],rightIdx=opts.findIndex(x=>x.dataset.a===right),chosenIdx=opts.indexOf(btn);
  recordInteraction('answer',correct?'correct':'incorrect');
  opts.forEach(x=>{x.classList.add('disabled');if(x.dataset.a===right)x.classList.add('correct')});
  if(!correct){
    // flash the verdict, then carry the learner to the relearn/learn page for THIS word
    btn.classList.add('wrong','learning-miss');setTimeout(()=>btn.classList.remove('learning-miss'),550);
    wrong[w.word]=(wrong[w.word]||0)+1;bumpTutor('wrong',w);
    const wobj=words.find(x=>x.word===w.word);feed.splice(fi+1,0,{type:'relearn',word:wobj});
  }else{
    score++;delete wrong[w.word];bumpTutor('correct',w);
    btn.classList.add('locked-in');celebrate(btn,false);
  }
  persist();update();
  tutorBeat(w,{correct,chosenIdx,rightIdx,container:$('#t-ans')});
  autoSizeCard();
}
const CARD=$('#card');let drag=null,suppressClick=false;
function dragStart(e){clearTeach();clearBeat();if(e.pointerType&&e.pointerType!=='mouse')return;if(e.button!==undefined&&e.button!==0)return;if(e.target.closest('button,.option'))return;if(CARD.classList.contains('swiping'))return;drag={id:e.pointerId||'mouse',startX:e.clientX,startY:e.clientY,lastX:e.clientX,lastTime:performance.now(),vx:0,moved:false,axisLocked:false};CARD.setPointerCapture?.(e.pointerId);CARD.classList.add('dragging')}
function dragMove(e){const id=e.pointerId??'touch';if(!drag||id!==drag.id)return;const now=performance.now(),dx=e.clientX-drag.startX,dy=e.clientY-drag.startY;if(!drag.axisLocked&&Math.hypot(dx,dy)>8){if(Math.abs(dy)>Math.abs(dx)*1.15){drag.axisLocked='vertical';return}drag.axisLocked='horizontal'}if(drag.axisLocked==='vertical')return;const dt=Math.max(1,now-drag.lastTime);drag.vx=(e.clientX-drag.lastX)/dt;drag.lastX=e.clientX;drag.lastTime=now;if(Math.abs(dx)>6)drag.moved=true;if(!drag.moved)return;const width=CARD.getBoundingClientRect().width||400,clamp=Math.max(-width*1.35,Math.min(width*1.35,dx));const resistance=Math.abs(dx)>width*.55?width*.55+(Math.abs(dx)-width*.55)*.35:Math.abs(dx);const x=Math.sign(dx)*resistance;CARD.style.transform=`translate3d(${x}px,${Math.min(18,Math.abs(x)/width*18)}px,0) rotate(${x/width*11}deg)`;const progress=Math.min(1,Math.abs(x)/(width*.55));CARD.style.setProperty('--swipe-progress',progress);$('#cardzone')?.classList.toggle('dragging-left',dx<0);$('#cardzone')?.classList.toggle('dragging-right',dx>0);$('#stack-prev')?.style.setProperty('--stack-progress',progress);$('#stack-next')?.style.setProperty('--stack-progress',progress);$('#stack-second')?.style.setProperty('--stack-progress',progress);$('#stack-third')?.style.setProperty('--stack-progress',progress);$('#stamp-next')?.classList.toggle('visible',dx<0);$('#stamp-back')?.classList.toggle('visible',dx>0);e.preventDefault()}
function dragEnd(e){const id=e.pointerId??'touch';if(!drag||id!==drag.id)return;const d=drag,dx=e.clientX-d.startX,velocity=d.vx;drag=null;CARD.classList.remove('dragging');$('#cardzone')?.classList.remove('dragging-left','dragging-right');CARD.releasePointerCapture?.(e.pointerId);const width=CARD.getBoundingClientRect().width||400;const fling=Math.abs(dx)>width*(id==='touch'?.24:.32)||Math.abs(velocity)>(id==='touch'?.45:.65);const dir=dx<0?1:-1;if(d.moved){if(dir<0&&fi===0){suppressClick=true;setTimeout(()=>suppressClick=false,350);springCard();return}suppressClick=true;setTimeout(()=>suppressClick=false,350);if(fling){const exitX=dx<0?-width*1.25:width*1.25;CARD.style.transform=`translate3d(${exitX}px,${Math.min(70,Math.abs(dx)*.18)}px,0) rotate(${(dx<0?-1:1)*-10}deg)`;CARD.classList.add('swiping',dx<0?'exiting-left':'exiting-right');setTimeout(()=>{CARD.style.transform='';CARD.classList.remove('swiping','exiting-left','exiting-right');$('#stamp-next')?.classList.remove('visible');$('#stamp-back')?.classList.remove('visible');commitMove(dir)},260)}else springCard()}else{CARD.style.transform=''}}
CARD.addEventListener('pointerdown',dragStart);CARD.addEventListener('pointermove',dragMove,{passive:false});CARD.addEventListener('pointerup',dragEnd);CARD.addEventListener('pointercancel',dragEnd);
CARD.addEventListener('touchstart',e=>{if(e.target.closest('button,.option')||CARD.classList.contains('swiping'))return;const t=e.changedTouches[0];drag={id:'touch',startX:t.clientX,startY:t.clientY,lastX:t.clientX,lastTime:performance.now(),vx:0,moved:false,axisLocked:false};CARD.classList.add('dragging')},{passive:true});
CARD.addEventListener('touchmove',e=>{if(!drag||drag.id!=='touch')return;const t=e.changedTouches[0];const dx=t.clientX-drag.startX,dy=t.clientY-drag.startY;if(!drag.axisLocked&&Math.hypot(dx,dy)>8){if(Math.abs(dy)>Math.abs(dx)*1.15){drag.axisLocked='vertical';return}drag.axisLocked='horizontal'}if(drag.axisLocked==='horizontal'){e.preventDefault();dragMove({pointerId:'touch',clientX:t.clientX,clientY:t.clientY,preventDefault:()=>e.preventDefault()})}},{passive:false});
CARD.addEventListener('touchend',e=>{if(!drag||drag.id!=='touch')return;const t=e.changedTouches[0];dragEnd({pointerId:'touch',clientX:t.clientX,clientY:t.clientY})},{passive:true});
CARD.addEventListener('touchcancel',e=>{if(drag?.id==='touch'){springCard();drag=null;CARD.classList.remove('dragging')}},{passive:true});
document.addEventListener('keydown',e=>{if(e.key!=='Escape')return;const m=$('#settings-menu');if(m&&m.classList.contains('open')){m.classList.remove('open');$('#settings-btn').classList.remove('open')}$('#craft-panel')?.classList.remove('open');$('#help-panel')?.classList.remove('open');const vp=$('#version-pop');if(vp)vp.hidden=true;const ts=$('#ts-results');if(ts)ts.hidden=true;});
document.addEventListener('keydown',e=>{if(['INPUT','TEXTAREA'].includes(document.activeElement.tagName))return;let n=Number(e.key);if(n>=1&&n<=4){let o=$$('.option')[n-1];if(o&&!o.classList.contains('disabled'))o.click();return}if(e.key==='ArrowRight')move(1);if(e.key==='ArrowLeft')move(-1);if(e.key===' '){if($('#card').querySelector('.face'))showFlip();else move(1)}});
const ddCache={}; // word|kind|ask -> answer, instant repeat dives
function openCraft(x){clearBeat();recordInteraction('deep-dive','open '+(x?.word||''));craftWord=x;let c=$('#craft-panel');c.classList.add('open');$('#craft-sub').textContent=`Exploring “${x.word}”`;$('#craft-body').innerHTML=`<div class="steps"><p class="step-head">Quick questions</p><div class="prompt-chips"><button data-kind="explain" data-ask="Explain it simply and give a vivid example.">✦ Explain</button><button data-kind="memory" data-ask="Give a fun, sticky memory hook for remembering it.">🧠 Memory hook</button><button data-kind="origin" data-ask="Tell the origin story of this word - its etymology and how its meaning evolved.">🌱 Origin</button><button data-kind="nearsyn" data-ask="Contrast this word with its closest near-synonym - what is the real difference?">⚔️ Near-syn</button><button data-kind="wild" data-ask="Where does this word show up in real life - books, news, movies, work?">🎬 In the wild</button><button data-kind="test" data-ask="Quiz me on this word with one quick question.">❓ Test me</button></div><p class="step-head or">OR ask anything</p></div>`;if(tutorLive)narrateOn('dive',x)}
$('#close-craft').onclick=()=>$('#craft-panel').classList.remove('open');
document.addEventListener('click',e=>{const p=$('#craft-panel');if(p&&p.classList.contains('open')&&!e.target.closest('#craft-panel')&&!e.target.closest('[data-dive]'))p.classList.remove('open')});
function ddSec(ico,label,body,x){return body?`<div class="dd-sec"><span class="dd-ico">${ico}</span><div class="dd-txt"><b>${label}</b><p>${highlightIn(x.word,body)}</p></div></div>`:''}
function ddRender(x,d,kind){
  const rel=(d.synonyms&&d.synonyms.length)||(d.antonyms&&d.antonyms.length)?`<div class="dd-rel">${(d.synonyms||[]).map(t=>`<span class="dd-chip syn">↗ ${esc(t)}</span>`).join('')}${(d.antonyms||[]).map(a=>`<span class="dd-chip ant">↘ ${esc(a)}</span>`).join('')}</div>`:'';
  let secs='';
  if(kind==='explain')secs=ddSec('📖','Plain English',d.explanation,x)+ddSec('✍️','Try it',d.example,x);
  else if(kind==='memory')secs=ddSec('🧠','Memory hook',d.memoryHook,x)+ddSec('✍️','See it',d.example,x);
  else if(kind==='origin')secs=ddSec('🌱','Word origin',d.etymology||d.contextNote,x)+ddSec('📖','What it means today',d.explanation,x);
  else if(kind==='nearsyn')secs=ddSec('⚔️','The real difference',d.explanation,x)+ddSec('✍️','Try it',d.example,x);
  else if(kind==='wild')secs=ddSec('🎬','In the wild',d.contextNote,x)+ddSec('✍️','Example',d.example,x);
  else if(kind==='test')secs=(d.deeperQuestion?`<div class="dd-quiz"><b>❓ Your turn</b><p>${highlightIn(x.word,d.deeperQuestion)}</p>${d.deeperAnswer?`<button class="dd-reveal" id="dd-reveal">tap to reveal answer</button><p class="dd-ans" id="dd-ans" style="display:none">${highlightIn(x.word,d.deeperAnswer)}</p>`:''}</div>`:'');
  else secs=ddSec('📖','Plain English',d.explanation,x)+ddSec('✍️','Try it',d.example,x)+ddSec('🧠','Memory hook',d.memoryHook,x)+ddSec('🌱','Origin',d.etymology,x)+ddSec('🎬','Context',d.contextNote,x);
  return `<div class="answer"><button class="quick-back" id="quick-back">← Quick questions</button><div class="direct-answer"><span class="answer-kicker">ANSWER</span><p>${highlightIn(x.word,d.directAnswer||d.explanation||'')}</p></div>${secs}${rel}</div>`;
}
function wireDd(x){const b=document.getElementById('quick-back');if(b)b.onclick=()=>openCraft(x);const rv=document.getElementById('dd-reveal');if(rv)rv.onclick=()=>{rv.style.display='none';const a=document.getElementById('dd-ans');if(a)a.style.display='block'}}
async function askCraft(q,kind){let x=craftWord||words.find(w=>w.word===curWord)||pick();const ck=x.word+'|'+(kind||'ask')+'|'+q;if(ddCache[ck]){$('#craft-body').innerHTML=ddRender(x,ddCache[ck],kind);wireDd(x);return}$('#craft-body').innerHTML='<p class="dd-thinking">✦ crafting your answer…</p>';try{let r=await fetch('/api/genie',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({word:x.word,definition:x.definition,mode:q})});let d=await r.json();if(!r.ok)throw Error(d.error);ddCache[ck]=d;$('#craft-body').innerHTML=ddRender(x,d,kind);wireDd(x)}catch(e){$('#craft-body').innerHTML=`<p class="bad-q">Deep Dive is taking a tiny break: ${esc(e.message)}</p><p>Your flashcards still work without AI.</p>`}}
$('#craft-form').onsubmit=e=>{e.preventDefault();let q=$('#craft-input').value.trim();if(q){$('#craft-input').value='';askCraft(q,null)}};document.addEventListener('click',e=>{let b=e.target.closest('[data-ask]');if(b)askCraft(b.dataset.ask,b.dataset.kind||null)});
let fontSize=Number(localStorage.getItem('wordCraftFont')||135);function applyFontSize(){fontSize=Math.max(85,Math.min(140,fontSize));document.documentElement.style.setProperty('--fs',fontSize/100);$('#fs-label').textContent=fontSize+'%';try{localStorage.setItem('wordCraftFont',fontSize)}catch(e){}}$('#fs-minus').onclick=e=>{e.stopPropagation();fontSize-=10;applyFontSize()};$('#fs-plus').onclick=e=>{e.stopPropagation();fontSize+=10;applyFontSize()};
// ---- version / about badge ----
const vbtn=$('#version-btn'), vpop=$('#version-pop'), vbody=$('#vp-body'), vclose=$('#vp-close');
function showAbout(){
  vpop.hidden=false; vbody.innerHTML='Loading…';
  fetch('/api/version').then(r=>r.ok?r.json():null).then(async v=>{
    if(!v) throw 0;
    const now=new Date(v.started);
    const fmt=(x)=>{ const d=new Date(x); return (!isNaN(d))?d.toLocaleString([],{month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit'}):'—'; };
    const shortc=(c)=>{c=c||'';return !!c&&c!=='dev'?(c.length>10?c.slice(0,7):c):(c||'dev');};
    let rel=new Date(v.released); if(isNaN(rel)) rel=new Date(0);
    // Prefer the exact commit date from GitHub (by SHA) for the true release time.
    if(v.commit && v.commit!=='dev'){
      try{
        const c=shortc(v.commit);
        const rp=await fetch('https://api.github.com/repos/abhijitgite12/wordcraft/commits/'+c,{headers:{Accept:'application/vnd.github+json'}});
        if(rp.ok){ const p=await rp.json(); if(p&&p.commit&&p.commit.committer&&p.commit.committer.date){ rel=new Date(p.commit.committer.date); } }
      }catch(e){}
    }
    vbody.innerHTML=`<div class="vr"><b>Version</b> ${esc(shortc(v.commit))}</div><div class="vr"><b>Branch</b> ${esc(v.branch||'—')}</div><div class="vr"><b>Released</b> ${esc(fmt(rel))}</div><div class="vr"><b>Server up</b> ${esc(fmt(now))}</div>`;
  }).catch(()=>{vbody.textContent='No version info available.'});
}
function toggleAbout(){ const showing=!vpop.hidden; if(!showing){ showAbout(); vpop.hidden=false; } else { vpop.hidden=true; } }
if(vbtn)vbtn.onclick=e=>{e.stopPropagation();toggleAbout();};
if(vclose)vclose.onclick=()=>{vpop.hidden=true;};
if(vpop)vpop.onclick=e=>{ if(e.target===vpop)vpop.hidden=true; };
document.addEventListener('click',e=>{ if(vpop&&!e.target.closest('#version-btn')&&!e.target.closest('.version-pop')) vpop.hidden=true; });
function refreshThemeSwatches(){const cur=document.body.dataset.theme;$$('#settings-menu .sm-swatches [data-theme]').forEach(b=>b.classList.toggle('on',b.dataset.theme===cur));}
$('#settings-btn').onclick=e=>{const m=$('#settings-menu');const opening=!m.classList.contains('open');m.classList.toggle('open');$('#settings-btn').classList.toggle('open',opening);if(opening)setTimeout(refreshThemeSwatches,0);e.stopPropagation()};$('#settings-btn').onpointerdown=e=>e.stopPropagation();
document.addEventListener('click',e=>{const m=$('#settings-menu');if(m&&m.classList.contains('open')&&!e.target.closest('#settings-menu')&&!e.target.closest('#settings-btn')){m.classList.remove('open');$('#settings-btn').classList.remove('open')}});
$$('#settings-menu .sm-swatches [data-theme]').forEach(b=>b.onclick=()=>{document.body.dataset.theme=b.dataset.theme;try{localStorage.setItem('satSparkTheme',b.dataset.theme);}catch(e){}refreshThemeSwatches()});
// Real classical recordings from Wikimedia Commons. Compositions are public domain;
// individual recordings carry the credit/license shown in the sound menu.
const CLASSICAL=[
 {name:'Mozart — Piano Sonata No. 11, I',license:'CC BY-SA 3.0',url:'https://upload.wikimedia.org/wikipedia/commons/9/9b/Mozart_-_Piano_Sonata_No._11_in_A_major_-_I._Andante_grazioso.ogg'},
 {name:'Beethoven — Piano Sonata No. 28, I',license:'Public domain',url:'https://upload.wikimedia.org/wikipedia/commons/f/fe/Beethoven_-_Piano_Sonata_No._28_in_A_Major%2C_Op._101_-_I._Etwas_lebhaft%2C_und_mit_der_innigsten_Empfindung.ogg'},
 {name:'Mozart — Piano Sonata No. 11, II',license:'CC BY-SA 3.0',url:'https://upload.wikimedia.org/wikipedia/commons/e/e7/Mozart_-_Piano_Sonata_No._11_in_A_major_-_II._Allegro_moderato.ogg'},
 {name:'Beethoven — 32 Variations in C minor',license:'Public domain',url:'https://upload.wikimedia.org/wikipedia/commons/b/b2/Beethoven_-_32_Variations_in_C_Minor%2C_WoO_80.ogg'},
 {name:'Mozart — Piano Sonata No. 12, II',license:'CC BY-SA 3.0',url:'https://upload.wikimedia.org/wikipedia/commons/d/d0/Mozart_-_Piano_Sonata_No._12_in_F_Major%2C_K.332_-_II._Adagio.ogg'},
 {name:'Beethoven — Piano Sonata No. 28, II',license:'Public domain',url:'https://upload.wikimedia.org/wikipedia/commons/b/bb/Beethoven_-_Piano_Sonata_No._28_in_A_Major%2C_Op._101_-_II._Lebhaft._Marschm%C3%A4%C3%9Fig.ogg'},
 {name:'Mozart — Piano Sonata No. 11, III Turkish March',license:'CC BY-SA 3.0',url:'https://upload.wikimedia.org/wikipedia/commons/b/bf/Mozart_-_Piano_Sonata_No._11_in_A_major_-_III._Allegro_%28Turkish_March%29.ogg'},
 {name:'Mozart — Piano Sonata No. 14',license:'Public domain',url:'https://upload.wikimedia.org/wikipedia/commons/8/86/Mozart_-_Piano_Sonata_No._14.ogg'},
 {name:'Mozart — Piano Sonata in A minor, I',license:'CC BY-SA 2.0',url:'https://upload.wikimedia.org/wikipedia/commons/6/67/Mozart_Piano_Sonata_Amin1.ogg'},
 {name:'Mozart — Piano Sonata in A minor, II',license:'CC BY-SA 2.0',url:'https://upload.wikimedia.org/wikipedia/commons/e/e7/Mozart_Piano_Sonata_Amin2.ogg'},
 {name:'Beethoven — Moonlight Sonata, II',license:'CC BY-SA 2.0',url:'https://upload.wikimedia.org/wikipedia/commons/4/47/Beethoven_Moonlight_2nd_movement.ogg'},
 {name:'Beethoven — Moonlight Sonata, III',license:'CC BY-SA 2.0',url:'https://upload.wikimedia.org/wikipedia/commons/d/d4/Beethoven_Moonlight_3rd_movement.ogg'},
 {name:'Beethoven — Piano Sonata No. 8, Op. 13',license:'CC BY 4.0',url:'https://upload.wikimedia.org/wikipedia/commons/2/2e/Piano_Sonata_No.8%2C_Op.13_%E2%80%93_Ludwig_Van_Beethoven.oga'}
];
const audio=$('#study-audio');let audioIndex=0,volume=Number(localStorage.getItem('wordCraftVolume')||25),musicWanted=localStorage.getItem('wordCraftMusic')!=='off',sessionTimer=null,trackTimer=null,playing=false,muted=false,playlist=[];
$('#volume').value=volume;audio.volume=volume/100;
function shufflePlaylist(){playlist=CLASSICAL.map((_,i)=>i).sort(()=>Math.random()-.5);audioIndex=playlist.shift()??0}
function loadMusic(){const piece=CLASSICAL[audioIndex%CLASSICAL.length];audio.src=piece.url;audio.dataset.title=piece.name;$('#music-credit').textContent=`Now: ${piece.name} · ${piece.license} · Wikimedia Commons`;$('#music-now').textContent=`${piece.name} · ${piece.license}`;}
function fadeVolume(from,to,ms,done){const start=performance.now();const step=now=>{const p=Math.max(0,Math.min(1,(now-start)/ms));const next=Math.max(0,Math.min(1,(from+(to-from)*p)/100));audio.volume=next;if(p<1)requestAnimationFrame(step);else if(done)done()};requestAnimationFrame(step)}
function scheduleTrack(){if(trackTimer)clearTimeout(trackTimer);trackTimer=setTimeout(transitionTrack,120000+Math.random()*180000)}
function transitionTrack(){if(!playing)return;const oldVol=volume;fadeVolume(oldVol,0,1800,()=>{audio.pause();if(!playlist.length)shufflePlaylist();audioIndex=playlist.shift();loadMusic();audio.volume=0;audio.play().then(()=>fadeVolume(0,oldVol,1800)).catch(()=>{});scheduleTrack()})}
function playMusic(){if(!playlist.length)shufflePlaylist();loadMusic();audio.volume=0;const p=audio.play();if(p&&p.catch)p.catch(()=>{playing=false;$('#sound-button').textContent='🎵';if(document.getElementById('music-main'))document.getElementById('music-main').textContent='Play'});playing=true;muted=false;fadeVolume(0,volume,1600);scheduleTrack();if(!sessionTimer)sessionTimer=setTimeout(()=>{stopMusic();$('#music-credit').textContent='15-minute study session complete ✦'},15*60*1000);$('#sound-button').textContent='🔊 Music';$('#sound-button').classList.add('on');if(document.getElementById('music-main'))document.getElementById('music-main').textContent='Mute';localStorage.setItem('wordCraftMusic','on')}
function stopMusic(){audio.pause();playing=false;if(sessionTimer){clearTimeout(sessionTimer);sessionTimer=null}if(trackTimer){clearTimeout(trackTimer);trackTimer=null}audio.volume=volume/100;$('#sound-button').textContent='🎵 Music';$('#sound-button').classList.remove('on');if(document.getElementById('music-main'))document.getElementById('music-main').textContent='Play';localStorage.setItem('wordCraftMusic','off')}
audio.addEventListener('ended',()=>{if(playing)transitionTrack()});
function toggleSound(){if(playing)stopMusic();else playMusic()}
function toggleMute(){if(audio.muted||muted){audio.muted=false;muted=false;$('#mute-button').textContent='Mute';if(!playing)playMusic()}else{audio.muted=true;muted=true;$('#mute-button').textContent='Unmute';$('#sound-button').textContent='🔇 Muted';localStorage.setItem('wordCraftMusic','off')}}
$('#sound-button').onclick=()=>toggleSound();$('#volume').oninput=e=>{volume=Number(e.target.value);audio.volume=volume/100;try{localStorage.setItem('wordCraftVolume',volume)}catch(err){}};$('#volume').value=volume;
function activateDefaultMusic(/* no autoplay: music only starts when the user presses Play */){ document.removeEventListener('pointerdown',activateDefaultMusic); }
document.addEventListener('pointerdown',activateDefaultMusic,{once:true,passive:true});
function renderList(q=''){let m=words.filter(w=>(w.word+' '+(w.definition||'')+' '+(Array.isArray(w.categories)?w.categories.join(' '):w.category||'')).toLowerCase().includes(q.toLowerCase())).slice(0,120);$('#word-list').innerHTML=m.map(w=>`<div class="word-row" data-w="${esc(w.word)}"><b>${esc(w.word)}</b>${catTag(w)}${lvlBadge(w)}<span>${esc(w.definition)}</span></div>`).join('')}
function editDistance(a,b){a=a.toLowerCase();b=b.toLowerCase();if(a===b)return 0;if(!a.length)return b.length;if(!b.length)return a.length;let prev=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){let row=[i];for(let j=1;j<=b.length;j++)row[j]=Math.min(row[j-1]+1,prev[j]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));prev=row}return prev[b.length]}
function fuzzyResults(q){const query=q.toLowerCase().trim(),tokens=query.split(/\s+/).filter(Boolean);return words.map(w=>{const word=w.word.toLowerCase(),def=(w.definition||'').toLowerCase();let score=0;if(word===query)score+=1000;if(word.startsWith(query))score+=300;if(word.includes(query))score+=180;if(def.includes(query))score+=120;for(const t of tokens){if(def.includes(t))score+=30;const d=editDistance(t,word);if(d<=2)score+=80-d*20}score-=Math.min(editDistance(query,word),12)*3;return {w,score}}).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,80).map(x=>x.w)}
function dbSearch(q){const m=fuzzyResults(q);$('#word-list').innerHTML=m.map(w=>`<div class="word-row" data-w="${esc(w.word)}"><b>${esc(w.word)}</b>${catTag(w)}${lvlBadge(w)}<span>${esc(displayDef(w))}</span></div>`).join('')||'<p class="search-empty">No close matches yet — try a shorter clue.</p>'}
function studyWord(x){if(!x)return;showPage('learn');feed=[{type:'teach',word:x},{type:'test',word:x}];fi=0;render()}
$('#search').oninput=async e=>{let q=e.target.value.trim();if(q.length>=2)dbSearch(q);else renderList()};$('#word-list').onclick=e=>{let r=e.target.closest('[data-w]');if(r)studyWord(words.find(w=>w.word===r.dataset.w))};$('#review-list').onclick=e=>{let r=e.target.closest('[data-review]');if(r)studyWord(words.find(w=>w.word===r.dataset.review))};
(async()=>{let r=await fetch('/api/words');words=(await r.json()).words;hydrateLocal();hydrateDefinitions();wrong=JSON.parse(localStorage.getItem('satSparkWrong')||'{}');seen=JSON.parse(localStorage.getItem('satSparkSeen')||'{}');score=+localStorage.getItem('satSparkScore')||0;mix=localStorage.getItem('satSparkMix')||'mixed';cat=localStorage.getItem('satSparkCat')||'all';document.body.dataset.theme=localStorage.getItem('satSparkTheme')||'sunrise';applyFontSize();if(musicWanted){$('#sound-button').textContent='🔊';$('#sound-button').classList.add('on')}$$('#mix-chips button').forEach(b=>b.classList.toggle('on',b.dataset.mix===mix));$$('#cat-chips button').forEach(b=>b.classList.toggle('on',b.dataset.cat===cat));const requested=new URLSearchParams(location.search).get('w');if(requested){const shared=words.find(w=>w.word.toLowerCase()===requested.toLowerCase());if(shared){feed=[{type:'teach',word:shared},{type:'test',word:shared}];fi=0}}ensureFeed();render();renderList();initVoiceUI();tele('load','app booted',JSON.stringify({view:"WD-app",hasBtn:!!document.getElementById('version-btn'),hasVoice:typeof orchSay==='function',hasTTS:!!navigator.userAgent,voiceSel:(typeof voiceSel==='string'?voiceSel:'')}))})().catch(e=>console.error(e));// ---- tutor tool: load a specific word as the current flashcard ----
function findWord(q){const t=String(q||'').toLowerCase().trim().replace(/[^a-z-]/g,'');if(!t)return null;
  const exact=words.find(w=>w.word.toLowerCase()===t);if(exact)return exact;
  // similarity search: closest word by edit distance / prefix / substring
  let best=null,bestD=1e9;for(const w of words){const s=w.word.toLowerCase();let d=1e9;
    if(s.startsWith(t))d=0;else if(s.includes(t))d=1;else d=editDistance(t,s);
    if(d<bestD){bestD=d;best=w}}
  const okLen=t.length>=5?2:(t.length>=3?1:0);
  return bestD<=okLen?best:null}
function loadWordCard(q,say){const w=findWord(q);if(!w){speak(say||`I couldn't find ${q||'that word'} in our set. Try another word.`);return}
  recordInteraction('tool','load_word:'+w.word);studyWord(w);
  if(say)speak(say,{});else speak('Here is '+w.word+'. Tap the card when you are ready to see what it means.')}
// ---- tutor tool: quick quiz on a category of words ----
function categoryKey(q){const t=String(q||'').toLowerCase();
  if(/\bgre\b/.test(t))return 'gre';if(/\bsat\b|high frequen/.test(t))return 'sat-hf';
  if(/\bcore\b/.test(t))return 'core';if(/\bacademic\b/.test(t))return 'academic';return 'general'}
function startCategoryTest(q,say){const key=categoryKey(q);
  const pool=words.filter(w=>(w.categories||[w.category]).includes(key));
  if(!pool.length){speak(say||`I don't have a ${q||key} category in the word set.`);return}
  const picks=pool.slice().sort(()=>Math.random()-.5).slice(0,5);
  feed=picks.map(w=>({type:'test',word:w}));fi=0;render();
  recordInteraction('tool','test_category:'+key);
  speak(say||('Quick test on '+key.replace('sat-hf','SAT high-frequency')+' words — five of them, starting now.'))}
// ---- top-center search bar: type a word, it becomes the flashcard ----
function topSearchResults(q){const t=q.toLowerCase().trim();if(t.length<2)return [];
  const catHit=/^(gre|sat|core|academic|general)\b/.test(t);
  // similarity search: word/definition ranking (exact + prefix rank above fuzzy matches)
  const hits=fuzzyResults(t).slice(0,catHit?4:8);
  const out=hits.map(w=>({w,label:w.word}));
  if(catHit)out.unshift({cat:/^gre/.test(t)?'gre':/^sat/.test(t)?'sat-hf':/^core/.test(t)?'core':/^academic/.test(t)?'academic':'general',label:t.toUpperCase()+' words'});
  return out}
function wireTopSearch(){const inp=$('#top-search'),box=$('#ts-results');if(!inp||!box)return;
  const close=()=>{box.hidden=true};
  inp.addEventListener('input',()=>{const r=topSearchResults(inp.value);
    box.innerHTML=r.map(x=>`<div class="ts-row" data-word="${x.w?esc(x.w.word):''}" data-cat="${x.cat||''}">${x.cat?'⚡ <b>'+esc(x.label)+'</b> <small>start a quick quiz</small>':'<b>'+esc(x.label)+'</b><small>'+esc(displayDef(x.w)).slice(0,60)+'…</small>'}</div>`).join('')||'';
    box.hidden=!r.length});
  inp.addEventListener('keydown',e=>{if(e.key!=='Enter')return;e.preventDefault();const t=inp.value.trim();if(!t)return;
    const m=/^(gre|sat|core|academic|general)\b/.exec(t.toLowerCase());
    if(m){startCategoryTest(m[1]);inp.value='';close();return}
    const w=findWord(t);if(w){loadWordCard(t);inp.value='';close()}});
  box.addEventListener('pointerdown',e=>{const r=e.target.closest('.ts-row');if(!r)return;
    if(r.dataset.cat){startCategoryTest(r.dataset.cat)}else if(r.dataset.word){loadWordCard(r.dataset.word)}
    inp.value='';close()});
  document.addEventListener('click',e=>{if(!e.target.closest('.top-search'))close()});
}
wireTopSearch();
// ---- semantic search (last-declared, end wins) ----
function semanticResults(q){const ql=String(q||'').toLowerCase().trim();if(ql.length<2)return[];
  const qwords=ql.split(/\s+/).filter(w=>w.length>2);const scored=[];
  for(const w of words){
    const def=String(w.definition||w.aiDefinition||'').toLowerCase();
    const syn=(w.synonyms||[]).map(s=>String(s).toLowerCase());
    let score=0; if(syn.includes(ql))score+=60;
    for(const tw of qwords){ if(def.split(/\s+/).includes(tw))score+=32; else if(def.includes(tw))score+=10; if(syn.some(s=>s===tw))score+=16; if(String(w.word).toLowerCase()===tw)score+=500; }
    if(score>0)scored.push({w,score});
  }
  return scored.sort((a,b)=>b.score-a.score).slice(0,5).map(x=>x.w);}
function topSearchResults(q){
  q=String(q||'').trim(); if(q.length<2)return[];
  const ql=q.toLowerCase();
  const bc=(ql.match(/^(gre|sat|core|academic|general)\b/)||[])[0]||'';
  const cat=bc?{gre:'gre',sat:'sat-hf',core:'core',academic:'academic',general:'general'}[bc]:'';
  const out=[]; if(cat)out.push({cat,label:cat.toUpperCase()+' words'});
  const used=new Set();
  const sim=fuzzyResults(ql).filter(x=>x&&x.word&&String(x.word).toLowerCase()!==ql&&!used.has(x.word)).slice(0,5);
  sim.forEach(x=>{used.add(x.word);out.push({w:x,label:x.word})});
  const sem=semanticResults(ql).filter(x=>x&&!used.has(x.word)).slice(0,5);
  sem.forEach(x=>out.push({w:x,label:x.word}));
  return out;}
