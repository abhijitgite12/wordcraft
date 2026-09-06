window.addEventListener('error',e=>{const c=document.querySelector('#card');if(c&&!c.dataset.error){c.dataset.error='1';c.innerHTML='<div class="empty-card"><div class="empty-icon">!</div><h2>Word Craft needs a refresh</h2><p>'+String(e.message||'Please reload the page.').replace(/[<>]/g,'')+'</p><button class="dive-main" onclick="location.reload()">Refresh</button></div>'}});window.addEventListener('unhandledrejection',e=>{console.error(e.reason)});
let words, score=0, wrong={}, seen={}, craftWord=null, feed=[], fi=0, asked=null, curWord=null, mix='mixed', cat='all';
const $=s=>document.querySelector(s),$$=s=>document.querySelectorAll(s);const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const shuffle=a=>[...a].sort(()=>Math.random()-.5);

// ===== Vocal agent: always-on listening + agentic orchestration =====
const VOICE = { on: localStorage.getItem('wordCraftVoiceOn')!=='off', rate: Number(localStorage.getItem('wordCraftRate')||1), micOn:false, state:'off', rec:null,
  sessionID: localStorage.getItem('wordCraftSession') || (()=>{const s='wc-'+Math.random().toString(36).slice(2,10);localStorage.setItem('wordCraftSession',s);return s})() };
let agentBusy=false;
const VoiceLabels={off:'Voice off',listening:'Listening',hearing:'Hearing you…',thinking:'Thinking…',speaking:'Saying…'};
// ---- state machine (Grok-style): off | listening | hearing | thinking | speaking ----
function setVoiceState(state, label, transcript){
  VOICE.state=state;
  const pill=$('#voice-pill'), body=document.body;
  if(pill){ pill.dataset.state=state; const l=pill.querySelector('.vp-label'); if(l)l.textContent=label||VoiceLabels[state]||''; pill.classList.toggle('active',state!=='off'); }
  if(body){ body.classList.remove('v-off','v-listening','v-hearing','v-thinking','v-speaking'); body.classList.add('v-'+state); }
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
const humanVoice = { on: localStorage.getItem('wordCraftHuman')!=='off' }; // default ON
// ---- smart "know when to speak" memory: track recent tutor lines so it never repeats itself ----
const talkMemory=[];
function rememberLine(text){ talkMemory.push({text, at:Date.now()}); if(talkMemory.length>40) talkMemory.shift(); }
function saidRecently(text, withinMs=8500){ const t=text.trim().toLowerCase(); return talkMemory.some(m=> (Date.now()-m.at)<withinMs && m.text.trim().toLowerCase()===t); }
function base64ToBlob(b64){ const bin=atob(b64), buf=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++)buf[i]=bin.charCodeAt(i); return new Blob([buf],{type:'audio/mpeg'}); }
let voiceSel = localStorage.getItem('wordCraftVoiceSel')||'en-US-AriaNeural';
function friendlyVoice(v){ const map={'en-US-AriaNeural':'Aria (female)','en-US-GuyNeural':'Guy (male)','en-US-JennyNeural':'Jenny (female)','en-US-EmmaNeural':'Emma (female)','en-US-BrianNeural':'Brian (male)','en-US-AvaNeural':'Ava (female)','en-US-AndrewMultilingualNeural':'Andrew (male)','en-US-ChristopherNeural':'Christopher (male)','en-US-MichelleNeural':'Michelle (female)','en-US-EricNeural':'Eric (male)'}; return map[v]||v; }
async function fetchTTS(text){
  try{ const r=await fetch('/api/tts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text, voice:voiceSel})}); if(!r.ok)return null; const d=await r.json(); return d.audio?base64ToBlob(d.audio):null; }catch(e){return null}
}
let speakingBusy=false, activeLine='', pending='', ttsFetching=false, activeAudio=null;
const ttsPlayer = document.createElement('audio'); ttsPlayer.preload='auto'; ttsPlayer.muted=true; (ttsPlayer.muted=false);
function finishLine(){ speakingBusy=false; activeLine=''; activeAudio=null; if(VOICE.micOn)setVoiceState('listening'); if(pending){ const p=pending; pending=''; speak(p,{force:true,human:true}); } }
function nativeSpeak(text){
  if(!window.speechSynthesis)return;
  const u=new SpeechSynthesisUtterance(String(text)); u.rate=VOICE.rate; u.pitch=1;
  u.onstart=()=>setVoiceState('speaking');
  u.onend=u.onerror=()=>{ finishLine(); };
  setVoiceCaption(String(text),true);
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}
function nativeStop(){ if(window.speechSynthesis)window.speechSynthesis.cancel(); }
function stopAllAudio(){ nativeStop(); if(activeAudio){ try{activeAudio.pause(); activeAudio.src='';}catch(e){} } activeAudio=null; speakingBusy=false; activeLine=''; pending=''; }
// Main speak: serialized (never talks over itself), dedup'd, human voice preferred.
async function speak(text,{force=false,human=true,allowRepeat=false}={}){
  if(!VOICE.on||!text)return;
  text=String(text).trim(); if(!text)return;
  if(speakingBusy && !force){
    // if we're already saying this exact thing, ignore; else queue for after.
    if(activeLine===text || saidRecently(text)) return;
    pending=text; return;
  }
  if(speakingBusy && force){ stopAllAudio(); }
  if(!allowRepeat && saidRecently(text)) return;
  speakingBusy=true; activeLine=text;
  rememberLine(text);
  setVoiceCaption(text,true); setVoiceState('speaking');
  const brief=text.length<45;
  const useHuman=human && humanVoice.on && !brief && !!window.fetch && !ttsFetching;
// useHuman: reuse one global audio element (unlocked by the mic-click gesture) to avoid autoplay block.
  if(useHuman){
    ttsFetching=true; const t0=Date.now(); let got=null;
    try{ got=await fetchTTS(text); }catch(e){}
    ttsFetching=false;
    if(!got || Date.now()-t0>1500){ if(!activeAudio) nativeSpeak(text); return; }
    const url=URL.createObjectURL(got);
    const a=ttsPlayer; a.src=url; activeAudio=a;
    a.onended=()=>{ URL.revokeObjectURL(url); activeAudio=null; finishLine(); };
    a.onerror=()=>{ URL.revokeObjectURL(url); activeAudio=null; nativeSpeak(text); };
    a.load(); a.play().catch(()=>{ URL.revokeObjectURL(url); activeAudio=null; nativeSpeak(text); });
  } else {
    nativeSpeak(text);
  }
}
function saidRecently(text){ const n=String(text||'').trim().toLowerCase(); const now=Date.now(); return talkMemory.some(m=>now-m.at<9000 && m.text.trim().toLowerCase()===n); }
function stopSpeak(){ stopAllAudio(); }


// ---- local reflexive fast-path (zero network) ----
function localFastpath(text){
  const t=String(text||'').toLowerCase().trim(); if(!t)return null;
  const has=w=>t.includes(w), any=arr=>arr.some(has);
  if(any(['stop','cancel','quiet','shut up']))return {tool:'stop'};
  if(any(['mute','voice off','turn off voice','silence']))return {tool:'mute'};
  if(any(['unmute','voice on','turn on voice']))return {tool:'voice_on'};
  if(any(['help','what can i','what do i','what can you','commands','options list']))return {tool:'help'};
  if(any(['read options','what are the options','say the options']))return {tool:'options'};
  if(any(['yes','yeah','yep','sure','ok','okay','fine','right'])&&!has('no '))return {tool:'yes'};
  if(any(['no','nope','nah','not yet']))return {tool:'no'};
  if(any(['next','go','continue','forward','move on','advance','let it slide']))return {tool:'next'};
  if(any(['back','previous','go back','return','undo']))return {tool:'back'};
  if(any(['skip','pass','dont know','dunno','dont want']))return {tool:'skip'};
  if(any(['repeat','again','say it again','read again','what','pardon','slower','one more time','replay']))return {tool:'repeat'};
  if(any(['reveal','show me','show it','show answer','give up','just tell me','i give up','what is it','let me see','flip']))return {tool:'reveal'};
  if(any(['deep dive','deep-dive','explain more','learn more','dive']))return {tool:'deep_dive'};
  const m=t.match(/\b([abcd])\b/); if(m)return {tool:'answer_option',option:'abcd'.indexOf(m[1])};
  const n=t.match(/\b([1-4])\b/); if(n)return {tool:'answer_option',option:Number(n[1])-1};
  const ord={'first':0,'second':1,'third':2,'fourth':3}; for(const k in ord) if(t.includes(k))return {tool:'answer_option',option:ord[k]};
  return null;
}
// ---- page context for the agent ----
function currentTools(){
  const c=cur(); const base=['next','back','skip','repeat','slow','fast','options','help','mute','voice_on','stop'];
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
let orchToken=0;
async function orchSay(payload, w){
  if(!tutorLive&&payload&&!payload.text)return;
  const ww = w || cur()?.word; if(!ww)return;
  const tok=++orchToken;
  const body={ session:VOICE.sessionID, text:payload.text||'', moment:payload.moment||'',
    word:ww.word, definition:ww.aiDefinition||ww.definition||'', pos:ww.partOfSpeech||'',
    example:ww.example||'', synonyms:ww.synonyms||[], antonyms:ww.antonyms||[],
    screen:currentScreen(), options:currentOptions(), tools:currentTools(),
    stats:`streak ${tutorState.streak}, consecutiveMiss ${tutorState.consecutiveMiss}, review ${Object.keys(wrong).length}` };
  try{
    const r=await fetch('/api/orch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(!r.ok)return; const d=await r.json();
    if(tok!==orchToken)return; // stale (a newer narration superseded this)
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
    case 'skip': move(1); break;
    case 'stop': stopSpeak(); setVoiceState(VOICE.micOn?'listening':'off'); return;
    case 'repeat': speak(w?(w.word+' — '+(w.aiDefinition||w.definition||'')):(n||'Repeating.')); break;
    case 'slow': VOICE.rate=Math.max(.5,VOICE.rate-.2);localStorage.setItem('wordCraftRate',VOICE.rate);speak(n||'Slower');break;
    case 'fast': VOICE.rate=Math.min(2,VOICE.rate+.2);localStorage.setItem('wordCraftRate',VOICE.rate);speak(n||'Faster.');break;
    case 'reveal': showFlip(); if(d.say) speak(d.say,{}); else if(!tutorLive&&w) speak(w.word+' means '+(w.aiDefinition||w.definition||'')); break;
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
  const w=cur()?.word; const note=$('#t-ans');
  if(verdict===2){ delete wrong[w.word]; score++; bumpTutor('correct',w); if(note){note.textContent='✦ Correct. '+(narration||'');note.className='answer-note good';} celebrate(note,false); speak(narration||('Correct! '+w.word+' means '+displayDef(w)+'.')); }
  else if(verdict===1){ if(note){note.textContent='Close — '+(narration||'you have the right idea.')+' The full meaning is '+displayDef(w)+'.';note.className='answer-note good';} speak('Close — '+(narration||('you have the right idea. '+w.word+' means '+displayDef(w)))); }
  else{ wrong[w.word]=(wrong[w.word]||0)+1; bumpTutor('wrong',w); if(note){note.textContent='Not quite. '+(narration||(w.aiDefinition||w.definition||''));note.className='answer-note bad';} speak('Not quite. '+(narration||(w.aiDefinition||w.definition||''))+'. We will revisit it.'); const wobj=words.find(x=>x.word===w.word);feed.splice(fi+1,0,{type:'relearn',word:wobj}); }
  persist(); update(); autoSizeCard();
}
// ---- handle an utterance: reflexive local first, else the agent ----
async function handleUtterance(text){
  text=String(text||'').trim(); if(!text)return;
  if(text===prevUtterance && Date.now()-lastUtteranceAt<1500) return; // ignore recognizer repeats
  prevUtterance=text; lastUtteranceAt=Date.now();
  setVoiceState('thinking','',text);
  const local=localFastpath(text);
  if(local){ setVoiceState('listening'); return runAction({action:local.tool,index:local.option,verdict:null,query:local.query,narration:''}); }
  if(agentBusy)return; agentBusy=true;
  const d=await agentDecide(text); agentBusy=false;
  setVoiceState('listening');
  if(d) await runAction({action:d.action,index:d.index,verdict:d.verdict??0,query:d.query||'',narration:d.say||d.narration||'',say:d.say||''});
  else speak("I didn't catch that. Say help.");
  // re-listening handled by state
  if(VOICE.micOn) setVoiceState('listening');
}
// ---- always-on mic (continuous; restarts while mic on) ----
function startListening(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){ setVoiceState('off','',"Voice not supported here"); speak("Voice isn't supported in this browser."); VOICE.micOn=false; return; }
  if(!VOICE.on)return;
  const rec=new SR(); rec.lang='en-US'; rec.continuous=true; rec.interimResults=true; rec.maxAlternatives=1;
  rec.onstart=()=>setVoiceState('listening');
  rec.onspeechstart=()=>setVoiceState('hearing');
  rec.onspeechend=()=>{ if(VOICE.micOn) setVoiceState('listening'); };
  rec.onresult=e=>{
    let interim='',final='';
    let f='',im='';
    for(let i=e.resultIndex;i<e.results.length;i++){ const tr=e.results[i][0].transcript; if(e.results[i].isFinal) f+=(' '+tr); else im+=(' '+tr); }
    final=f.trim(); interim=im.trim();
    setVoiceCaption(final||interim,false);
    if(final){ setVoiceState('thinking','',final); handleUtterance(final); }
    else setVoiceState('hearing');
  };
  rec.onerror=e=>{ if(e.error==='not-allowed'||e.error==='service-not-allowed'){ VOICE.micOn=false; setVoiceState('off'); } else setVoiceState('hearing'); };
  rec.onend=()=>{ if(VOICE.micOn) startListening(); };
  rec.start(); VOICE.rec=rec;
}
function toggleMic(on){
  on=(on===undefined)?!VOICE.micOn:on;
  VOICE.micOn=!!on;
  setTutorLive(on&&VOICE.on);
  if(on && VOICE.on){ setVoiceState('listening'); startListening(); sayOnCardChange(); }
  else{ if(VOICE.rec)VOICE.rec.abort(); VOICE.rec=null; setVoiceState('off'); setTutorLive(false); }
}
function initVoiceUI(){
  const btn=$('#voice-btn'), pill=$('#voice-pill');
  const toggle=()=>toggleMic(!VOICE.micOn);
  if(btn)btn.onclick=toggle; if(pill)pill.onclick=toggle;
  const vq=$('#vq-toggle'); if(vq){ vq.checked=humanVoice.on; vq.onchange=e=>{ humanVoice.on=vq.checked; try{localStorage.setItem('wordCraftHuman',humanVoice.on?'on':'off');}catch(e){} }; }
  const vs=$('#voice-sel'); if(vs){ vs.value=voiceSel; fetch('/api/voices').then(r=>r.ok?r.json():null).then(d=>{ if(!vs)return; vs.innerHTML=d&&d.voices?d.voices.map(v=>'<option value="'+v+'">'+friendlyVoice(v)+'</option>').join(''):vs.innerHTML; vs.value=voiceSel; }).catch(()=>{}); vs.onchange=e=>{ localStorage.setItem('wordCraftVoiceSel',vs.value); voiceSel=vs.value; }; }
  const input=$('#voice-input'); const form=$('#voice-form');
  if(form)form.onsubmit=e=>{e.preventDefault();const v=input.value.trim();if(v){handleUtterance(v);input.value='';}};
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
function markSeen(w){seen[w.word]=(seen[w.word]||0)+1}
function renderReview(){const entries=Object.entries(wrong).sort((a,b)=>b[1]-a[1]);$('#header-review-count').textContent=entries.length||'';$('#review-list').innerHTML=entries.length?entries.map(([word,n])=>{const w=words.find(x=>x.word===word);return w?`<div class="word-row review-row" data-review="${esc(word)}"><b>${esc(word)}</b><span class="miss-count">missed ${n}×</span>${catTag(w)}${lvlBadge(w)}<span>${esc(displayDef(w))}</span></div>`:''}).join(''):'<p class="review-empty">No missed words yet. Keep going ✦</p>'}
function showPage(page){document.body.classList.toggle('reviewing',page==='review');document.body.classList.toggle('browsing',page==='browse');$('#review-page').classList.toggle('active',page==='review');$('#browse-page').classList.toggle('active',page==='browse')}
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
if(which===0){q=`Which meaning best fits <b>${esc(w.word)}</b>?`;opts=shuffle([shortDef(w),...shuffle(words.filter(x=>x.word!==w.word)).slice(0,3).map(shortDef)])}
else if(which===1){let syn=(w.synonyms||[])[0]||null;if(!syn){asked=0;q=`Which meaning best fits <b>${esc(w.word)}</b>?`;opts=shuffle([shortDef(w),...shuffle(words.filter(x=>x.word!==w.word)).slice(0,3).map(shortDef)])}else{q=`Pick the closest <b>SYNONYM</b> of <b>${esc(w.word)}</b>`;opts=shuffle([syn,...shuffle(words.filter(x=>x.word!==w.word)).slice(0,3).map(x=>x.word)])}}
else{let ant=(w.antonyms||[])[0]||null;if(!ant){asked=0;q=`Which meaning best fits <b>${esc(w.word)}</b>?`;opts=shuffle([shortDef(w),...shuffle(words.filter(x=>x.word!==w.word)).slice(0,3).map(shortDef)])}else{q=`Pick the <b>OPPOSITE</b> (antonym) of <b>${esc(w.word)}</b>`;opts=shuffle([ant,...shuffle(words.filter(x=>x.word!==w.word)).slice(0,3).map(x=>x.word)])}}
return `<div class="test-card"><div class="card-top"><div class="test-label">⚡ QUICK TEST</div><span class="top-tags">${catTag(w)}${lvlBadge(w)}</span></div><p class="test-q">${q}</p><div class="options">${opts.map((x,i)=>`<button class="option" data-n="${i+1}" data-a="${esc(x)}">${esc(x)}</button>`).join('')}</div><button class="test-dive" data-dive="${w.word}">✦ Deep Dive</button><div class="answer-note" id="t-ans"></div></div>`}
function correctAnswer(w){if(asked===0)return shortDef(w);if(asked===1)return (w.synonyms||[])[0];return (w.antonyms||[])[0]}
function stackPreviewHtml(item){if(!item||!item.word)return '';const w=item.word;if(item.type==='test')return `<div class="stack-test"><div class="stack-preview-top"><span>⚡ QUICK TEST</span><span>→</span></div><p>Which meaning best fits <b>${esc(w.word)}</b>?</p><div class="stack-options"><i></i><i></i><i></i><i></i></div></div>`;return `<div class="stack-teach"><div class="stack-preview-top"><span>${esc(w.partOfSpeech||'WORD')}</span><span>→</span></div><strong>${esc(w.word)}</strong><small>${esc(displayDef(w))}</small></div>`}
function renderStack(){ensureAhead(3);const previous=$('#stack-prev');if(previous)previous.innerHTML=stackPreviewHtml(feed[fi-1]);const layers=[['#stack-next',1],['#stack-second',2],['#stack-third',3]];layers.forEach(([selector,offset])=>{const el=$(selector);if(el)el.innerHTML=stackPreviewHtml(feed[fi+offset])});$('#stack-prev')?.style.setProperty('--stack-progress','0');$('#stack-next')?.style.setProperty('--stack-progress','0');$('#stack-second')?.style.setProperty('--stack-progress','0');$('#stack-third')?.style.setProperty('--stack-progress','0')}
function commitMove(dir){if(dir<0&&fi===0)return;if(dir>0){fi++;ensureFeed()}else fi=Math.max(0,fi-1);render()}
function springCard(){CARD.classList.add('spring-back');CARD.style.transform='';$('#cardzone')?.classList.remove('dragging-left','dragging-right');$('#stack-prev')?.style.setProperty('--stack-progress','0');$('#stack-next')?.style.setProperty('--stack-progress','0');$('#stack-second')?.style.setProperty('--stack-progress','0');$('#stack-third')?.style.setProperty('--stack-progress','0');setTimeout(()=>CARD.classList.remove('spring-back'),430)}
function syncWordUrl(word){if(!word||document.body.classList.contains('reviewing')||document.body.classList.contains('browsing'))return;const u=new URL(location.href);u.search='';u.searchParams.set('w',word.word);history.replaceState(null,'',u)}
function autoSizeCard(){const zone=$('#cardzone'),c=$('#card');if(!zone||!c)return;let need=0;c.querySelectorAll('.face,.test-card,.relearn-card,.empty-card').forEach(f=>{f.style.height='100%';need=Math.max(need,f.scrollHeight)});need=Math.max(340,Math.min(600,need));zone.style.height=need+'px'}
function render(){let c=cur();if(!c||c.type==='empty'){ const level=mix==='mixed'?'any level':mix, type=cat==='all'?'all categories':cat;$('#card').innerHTML=`<div class="empty-card"><div class="empty-icon">✦</div><h2>No words in this mix</h2><p>There are no ${esc(type)} words at ${esc(level)} level yet.</p><button id="reset-filters" class="dive-main">Show Mixed</button></div>`;$('#reset-filters').onclick=()=>{mix='mixed';cat='all';$$('#mix-chips button').forEach(b=>b.classList.toggle('on',b.dataset.mix==='mixed'));$$('#cat-chips button').forEach(b=>b.classList.toggle('on',b.dataset.cat==='all'));setFilters()};return}curWord=c.word;markSeen(c.word);syncWordUrl(c.word);renderStack();if(c.word&&!c.word.aiDefinition)refreshDefinition(c.word);let html;
if(c.type==='teach'){html=teachHtml(c.word)}else if(c.type==='relearn'){html=relearnHtml(c.word)}else{html=testHtml(c.word)}$('#card').innerHTML=html;$('#card').classList.remove('flipped');
if(!c.word.example)ensureExample(c.word);
$('#card [data-regen]')&&($('#card [data-regen]').onclick=e=>{e.stopPropagation();regenerateExample(cur().word)});
autoSizeCard();$('#gesture').innerHTML=c.type==='test'?'swipe <b>left</b> · next word &nbsp;|&nbsp; <b>right</b> · back &nbsp;|&nbsp; press <b>1-4</b> or tap to answer':(c.type==='relearn'?'swipe <b>left</b> · continue &nbsp;|&nbsp; <b>right</b> · back &nbsp;|&nbsp; <b>tap</b> Deep Dive':'swipe <b>left</b> · next &nbsp;|&nbsp; <b>right</b> · back &nbsp;|&nbsp; <b>tap</b> · reveal');let rb=$('#retry-btn');if(rb)rb.onclick=()=>{delete wrong[c.word];persist();update();move(1)};craftWord=c.word;update()}
function showFlip(){let c=$('#card');if(c.querySelector('.face')&&!c.classList.contains('flipped')&&!c.classList.contains('dragging')&&!c.classList.contains('swiping')){c.style.transform='';c.classList.add('flipping');requestAnimationFrame(()=>{c.classList.add('flipped');setTimeout(()=>c.classList.remove('flipping'),620)});if(tutorLive)narrate('reveal')}}
function move(dir){let c=$('#card');if(c.classList.contains('swiping'))return;if(dir<0&&fi===0){springCard();return}c.classList.add('swiping',dir>0?'moving-left':'moving-right');setTimeout(()=>{c.classList.remove('swiping','moving-left','moving-right');commitMove(dir);sayOnCardChange()},340)}
$('#card').addEventListener('click',e=>{if(suppressClick)return;let d=e.target.closest('[data-dive]');if(d){openCraft(words.find(w=>w.word===d.dataset.dive));return}let opt=e.target.closest('.option');if(opt&&!opt.classList.contains('disabled')){answer(opt);return}if($('#card').querySelector('.face'))showFlip()});
function celebrate(origin,big=false){if(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;const box=document.createElement('div');box.className='confetti';const r=origin?.getBoundingClientRect?.();box.style.left=(r?r.left+r.width/2:innerWidth/2)+'px';box.style.top=(r?r.top+r.height/2:innerHeight/2)+'px';for(let i=0;i<(big?24:12);i++){const p=document.createElement('i');p.style.setProperty('--x',(Math.random()*130-65)+'px');p.style.setProperty('--y',(Math.random()*90+35)+'px');p.style.setProperty('--r',(Math.random()*360)+'deg');p.style.setProperty('--d',(Math.random()*.2)+'s');p.style.background=['#6555d8','#ff785f','#2f9e62','#e8a13a','#7654c7'][i%5];box.appendChild(p)}document.body.appendChild(box);setTimeout(()=>box.remove(),1100)}
function answer(btn){let w=cur().word,right=correctAnswer(w),correct=btn.dataset.a===right;$$('.option').forEach(x=>{x.classList.add('disabled');if(x.dataset.a===right)x.classList.add('correct')});let ans=$('#t-ans');if(!correct){btn.classList.add('wrong','learning-miss');setTimeout(()=>btn.classList.remove('learning-miss'),550);wrong[w.word]=(wrong[w.word]||0)+1;bumpTutor('wrong',w);ans.textContent='↺ Learning moment — this word comes right back for a clearer pass.';ans.className='answer-note bad';const wobj=words.find(x=>x.word===w.word);feed.splice(fi+1,0,{type:'relearn',word:wobj});if(tutorLive)narrate('wrong')}else{score++;delete wrong[w.word];bumpTutor('correct',w);btn.classList.add('locked-in');celebrate(btn,false);ans.textContent='✦ Got it! Swipe left for the next word.';ans.className='answer-note good';if(tutorLive)narrate('correct')}persist();update();autoSizeCard()}
const CARD=$('#card');let drag=null,suppressClick=false;
function dragStart(e){if(e.pointerType&&e.pointerType!=='mouse')return;if(e.button!==undefined&&e.button!==0)return;if(e.target.closest('button,.option'))return;if(CARD.classList.contains('swiping'))return;drag={id:e.pointerId||'mouse',startX:e.clientX,startY:e.clientY,lastX:e.clientX,lastTime:performance.now(),vx:0,moved:false,axisLocked:false};CARD.setPointerCapture?.(e.pointerId);CARD.classList.add('dragging')}
function dragMove(e){const id=e.pointerId??'touch';if(!drag||id!==drag.id)return;const now=performance.now(),dx=e.clientX-drag.startX,dy=e.clientY-drag.startY;if(!drag.axisLocked&&Math.hypot(dx,dy)>8){if(Math.abs(dy)>Math.abs(dx)*1.15){drag.axisLocked='vertical';return}drag.axisLocked='horizontal'}if(drag.axisLocked==='vertical')return;const dt=Math.max(1,now-drag.lastTime);drag.vx=(e.clientX-drag.lastX)/dt;drag.lastX=e.clientX;drag.lastTime=now;if(Math.abs(dx)>6)drag.moved=true;if(!drag.moved)return;const width=CARD.getBoundingClientRect().width||400,clamp=Math.max(-width*1.35,Math.min(width*1.35,dx));const resistance=Math.abs(dx)>width*.55?width*.55+(Math.abs(dx)-width*.55)*.35:Math.abs(dx);const x=Math.sign(dx)*resistance;CARD.style.transform=`translate3d(${x}px,${Math.min(18,Math.abs(x)/width*18)}px,0) rotate(${x/width*11}deg)`;const progress=Math.min(1,Math.abs(x)/(width*.55));CARD.style.setProperty('--swipe-progress',progress);$('#cardzone')?.classList.toggle('dragging-left',dx<0);$('#cardzone')?.classList.toggle('dragging-right',dx>0);$('#stack-prev')?.style.setProperty('--stack-progress',progress);$('#stack-next')?.style.setProperty('--stack-progress',progress);$('#stack-second')?.style.setProperty('--stack-progress',progress);$('#stack-third')?.style.setProperty('--stack-progress',progress);$('#stamp-next')?.classList.toggle('visible',dx<0);$('#stamp-back')?.classList.toggle('visible',dx>0);e.preventDefault()}
function dragEnd(e){const id=e.pointerId??'touch';if(!drag||id!==drag.id)return;const d=drag,dx=e.clientX-d.startX,velocity=d.vx;drag=null;CARD.classList.remove('dragging');$('#cardzone')?.classList.remove('dragging-left','dragging-right');CARD.releasePointerCapture?.(e.pointerId);const width=CARD.getBoundingClientRect().width||400;const fling=Math.abs(dx)>width*(id==='touch'?.24:.32)||Math.abs(velocity)>(id==='touch'?.45:.65);const dir=dx<0?1:-1;if(d.moved){if(dir<0&&fi===0){suppressClick=true;setTimeout(()=>suppressClick=false,350);springCard();return}suppressClick=true;setTimeout(()=>suppressClick=false,350);if(fling){const exitX=dx<0?-width*1.25:width*1.25;CARD.style.transform=`translate3d(${exitX}px,${Math.min(70,Math.abs(dx)*.18)}px,0) rotate(${(dx<0?-1:1)*-10}deg)`;CARD.classList.add('swiping',dx<0?'exiting-left':'exiting-right');setTimeout(()=>{CARD.style.transform='';CARD.classList.remove('swiping','exiting-left','exiting-right');$('#stamp-next')?.classList.remove('visible');$('#stamp-back')?.classList.remove('visible');commitMove(dir)},260)}else springCard()}else{CARD.style.transform=''}}
CARD.addEventListener('pointerdown',dragStart);CARD.addEventListener('pointermove',dragMove,{passive:false});CARD.addEventListener('pointerup',dragEnd);CARD.addEventListener('pointercancel',dragEnd);
CARD.addEventListener('touchstart',e=>{if(e.target.closest('button,.option')||CARD.classList.contains('swiping'))return;const t=e.changedTouches[0];drag={id:'touch',startX:t.clientX,startY:t.clientY,lastX:t.clientX,lastTime:performance.now(),vx:0,moved:false,axisLocked:false};CARD.classList.add('dragging')},{passive:true});
CARD.addEventListener('touchmove',e=>{if(!drag||drag.id!=='touch')return;const t=e.changedTouches[0];const dx=t.clientX-drag.startX,dy=t.clientY-drag.startY;if(!drag.axisLocked&&Math.hypot(dx,dy)>8){if(Math.abs(dy)>Math.abs(dx)*1.15){drag.axisLocked='vertical';return}drag.axisLocked='horizontal'}if(drag.axisLocked==='horizontal'){e.preventDefault();dragMove({pointerId:'touch',clientX:t.clientX,clientY:t.clientY,preventDefault:()=>e.preventDefault()})}},{passive:false});
CARD.addEventListener('touchend',e=>{if(!drag||drag.id!=='touch')return;const t=e.changedTouches[0];dragEnd({pointerId:'touch',clientX:t.clientX,clientY:t.clientY})},{passive:true});
CARD.addEventListener('touchcancel',e=>{if(drag?.id==='touch'){springCard();drag=null;CARD.classList.remove('dragging')}},{passive:true});
document.addEventListener('keydown',e=>{if(['INPUT','TEXTAREA'].includes(document.activeElement.tagName))return;let n=Number(e.key);if(n>=1&&n<=4){let o=$$('.option')[n-1];if(o&&!o.classList.contains('disabled'))o.click();return}if(e.key==='ArrowRight')move(1);if(e.key==='ArrowLeft')move(-1);if(e.key===' '){if($('#card').querySelector('.face'))showFlip();else move(1)}});
function openCraft(x){craftWord=x;let c=$('#craft-panel');c.classList.add('open');$('#craft-sub').textContent=`Exploring “${x.word}”`;$('#craft-body').innerHTML=`<div class="steps"><p class="step-head">Quick questions</p><div class="prompt-chips"><button data-ask="Explain it simply and give a vivid example.">1. Explain</button><button data-ask="Give a fun memory hook.">2. Memory</button><button data-ask="Contrast this word with a near-synonym.">3. Near-syn</button><button data-ask="Ask me two deeper questions.">4. Test me</button><button data-ask="Show this in novels or history.">5. In the wild</button></div><p class="step-head or">OR ask anything</p></div>`;if(tutorLive)narrateOn('dive',x)}
$('#close-craft').onclick=()=>$('#craft-panel').classList.remove('open');
async function askCraft(q){let x=craftWord||words.find(w=>w.word===curWord)||pick();$('#craft-body').innerHTML='<p>✦ thinking…</p>';try{let r=await fetch('/api/genie',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({word:x.word,definition:x.definition,mode:q})});let d=await r.json();if(!r.ok)throw Error(d.error);$('#craft-body').innerHTML=`<div class="answer"><button class="quick-back" id="quick-back">← Quick questions</button><div class="direct-answer"><span class="answer-kicker">ANSWER</span><p>${highlightIn(x.word,d.directAnswer||d.explanation||'')}</p></div><div class="block"><strong>Plain English</strong><br>${highlightIn(x.word,d.explanation||'')}</div><div class="block"><strong>Try it</strong><br><i>${highlightIn(x.word,d.example||'')}</i></div><div class="block"><strong>Memory hook</strong><br>${highlightIn(x.word,d.memoryHook||'')}</div><div class="block"><strong>Think deeper</strong><br>${highlightIn(x.word,d.deeperQuestion||'')}</div><div class="block"><strong>Context</strong><br>${highlightIn(x.word,d.contextNote||'')}</div><div class="block"><strong>Related</strong><br><span class="syn">${esc((d.synonyms||[]).map(s=>'↗ '+s).join('  '))}</span> <span class="ant">${esc((d.antonyms||[]).map(a=>'↘ '+a).join('  '))}</span></div></div>`;document.getElementById('quick-back').onclick=()=>openCraft(x)}catch(e){$('#craft-body').innerHTML=`<p class="bad-q">Deep Dive is taking a tiny break: ${esc(e.message)}</p><p>Your flashcards still work without AI.</p>`}}
$('#craft-form').onsubmit=e=>{e.preventDefault();let q=$('#craft-input').value.trim();if(q){$('#craft-input').value='';askCraft(q)}};document.addEventListener('click',e=>{let b=e.target.closest('[data-ask]');if(b)askCraft(b.dataset.ask)});
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
$('#theme-button').onclick=e=>{$('#theme-menu').classList.toggle('open');e.stopPropagation()};$$('.theme-menu [data-theme]').forEach(b=>b.onclick=()=>{document.body.dataset.theme=b.dataset.theme;localStorage.setItem('satSparkTheme',b.dataset.theme);$('#theme-menu').classList.remove('open')});document.addEventListener('click',e=>{if(!e.target.closest('.header-actions'))$('#theme-menu').classList.remove('open')});
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
function loadMusic(){const piece=CLASSICAL[audioIndex%CLASSICAL.length];audio.src=piece.url;audio.dataset.title=piece.name;$('#sound-menu .music-credit').textContent=`Now: ${piece.name} · ${piece.license} · Wikimedia Commons`;$('#music-now').textContent=`${piece.name} · ${piece.license}`;}
function fadeVolume(from,to,ms,done){const start=performance.now();const step=now=>{const p=Math.max(0,Math.min(1,(now-start)/ms));const next=Math.max(0,Math.min(1,(from+(to-from)*p)/100));audio.volume=next;if(p<1)requestAnimationFrame(step);else if(done)done()};requestAnimationFrame(step)}
function scheduleTrack(){if(trackTimer)clearTimeout(trackTimer);trackTimer=setTimeout(transitionTrack,120000+Math.random()*180000)}
function transitionTrack(){if(!playing)return;const oldVol=volume;fadeVolume(oldVol,0,1800,()=>{audio.pause();if(!playlist.length)shufflePlaylist();audioIndex=playlist.shift();loadMusic();audio.volume=0;audio.play().then(()=>fadeVolume(0,oldVol,1800)).catch(()=>{});scheduleTrack()})}
function playMusic(){if(!playlist.length)shufflePlaylist();loadMusic();audio.volume=0;const p=audio.play();if(p&&p.catch)p.catch(()=>{playing=false;$('#sound-button').textContent='🎵';if($('#music-main'))$('#music-main').textContent='Play'});playing=true;muted=false;fadeVolume(0,volume,1600);scheduleTrack();if(!sessionTimer)sessionTimer=setTimeout(()=>{stopMusic();$('#sound-menu .music-credit').textContent='15-minute study session complete ✦'},15*60*1000);$('#sound-button').textContent='🔊 Music';$('#sound-button').classList.add('on');if($('#music-main'))$('#music-main').textContent='Mute';localStorage.setItem('wordCraftMusic','on')}
function stopMusic(){audio.pause();playing=false;if(sessionTimer){clearTimeout(sessionTimer);sessionTimer=null}if(trackTimer){clearTimeout(trackTimer);trackTimer=null}audio.volume=volume/100;$('#sound-button').textContent='🎵 Music';$('#sound-button').classList.remove('on');if($('#music-main'))$('#music-main').textContent='Play';localStorage.setItem('wordCraftMusic','off')}
audio.addEventListener('ended',()=>{if(playing)transitionTrack()});
function toggleSound(){if(playing)stopMusic();else playMusic()}
function toggleMute(){if(audio.muted||muted){audio.muted=false;muted=false;$('#mute-button').textContent='Mute';if(!playing)playMusic()}else{audio.muted=true;muted=true;$('#mute-button').textContent='Unmute';$('#sound-button').textContent='🔇 Muted';localStorage.setItem('wordCraftMusic','off')}}
$('#sound-button').onclick=e=>{toggleSound();$('#sound-menu').classList.toggle('open');e.stopPropagation()};$('#music-main').onclick=()=>{toggleSound();$('#music-main').textContent=playing?'Mute':'Play'};$('#volume').oninput=e=>{volume=Number(e.target.value);audio.volume=volume/100;$('#volume-main').value=volume;localStorage.setItem('wordCraftVolume',volume)};$('#volume-main').value=volume;$('#volume-main').oninput=e=>{volume=Number(e.target.value);audio.volume=volume/100;$('#volume').value=volume;localStorage.setItem('wordCraftVolume',volume)};$('#mute-button').onclick=toggleMute;document.addEventListener('click',e=>{if(!e.target.closest('.sound-control'))$('#sound-menu').classList.remove('open')});
function activateDefaultMusic(e){if(!e.target.closest('.sound-control')&&musicWanted&&!playing)playMusic();document.removeEventListener('pointerdown',activateDefaultMusic)}
document.addEventListener('pointerdown',activateDefaultMusic,{once:true,passive:true});
function renderList(q=''){let m=words.filter(w=>(w.word+' '+(w.definition||'')+' '+(Array.isArray(w.categories)?w.categories.join(' '):w.category||'')).toLowerCase().includes(q.toLowerCase())).slice(0,120);$('#word-list').innerHTML=m.map(w=>`<div class="word-row" data-w="${esc(w.word)}"><b>${esc(w.word)}</b>${catTag(w)}${lvlBadge(w)}<span>${esc(w.definition)}</span></div>`).join('')}
function editDistance(a,b){a=a.toLowerCase();b=b.toLowerCase();if(a===b)return 0;if(!a.length)return b.length;if(!b.length)return a.length;let prev=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){let row=[i];for(let j=1;j<=b.length;j++)row[j]=Math.min(row[j-1]+1,prev[j]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));prev=row}return prev[b.length]}
function fuzzyResults(q){const query=q.toLowerCase().trim(),tokens=query.split(/\s+/).filter(Boolean);return words.map(w=>{const word=w.word.toLowerCase(),def=(w.definition||'').toLowerCase();let score=0;if(word===query)score+=1000;if(word.startsWith(query))score+=300;if(word.includes(query))score+=180;if(def.includes(query))score+=120;for(const t of tokens){if(def.includes(t))score+=30;const d=editDistance(t,word);if(d<=2)score+=80-d*20}score-=Math.min(editDistance(query,word),12)*3;return {w,score}}).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,80).map(x=>x.w)}
function dbSearch(q){const m=fuzzyResults(q);$('#word-list').innerHTML=m.map(w=>`<div class="word-row" data-w="${esc(w.word)}"><b>${esc(w.word)}</b>${catTag(w)}${lvlBadge(w)}<span>${esc(displayDef(w))}</span></div>`).join('')||'<p class="search-empty">No close matches yet — try a shorter clue.</p>'}
function studyWord(x){if(!x)return;showPage('learn');feed=[{type:'teach',word:x},{type:'test',word:x}];fi=0;render()}
$('#search').oninput=async e=>{let q=e.target.value.trim();if(q.length>=2)dbSearch(q);else renderList()};$('#word-list').onclick=e=>{let r=e.target.closest('[data-w]');if(r)studyWord(words.find(w=>w.word===r.dataset.w))};$('#review-list').onclick=e=>{let r=e.target.closest('[data-review]');if(r)studyWord(words.find(w=>w.word===r.dataset.review))};
(async()=>{let r=await fetch('/api/words');words=(await r.json()).words;hydrateLocal();hydrateDefinitions();wrong=JSON.parse(localStorage.getItem('satSparkWrong')||'{}');seen=JSON.parse(localStorage.getItem('satSparkSeen')||'{}');score=+localStorage.getItem('satSparkScore')||0;mix=localStorage.getItem('satSparkMix')||'mixed';cat=localStorage.getItem('satSparkCat')||'all';document.body.dataset.theme=localStorage.getItem('satSparkTheme')||'sunrise';applyFontSize();if(musicWanted){$('#sound-button').textContent='🔊';$('#sound-button').classList.add('on')}$$('#mix-chips button').forEach(b=>b.classList.toggle('on',b.dataset.mix===mix));$$('#cat-chips button').forEach(b=>b.classList.toggle('on',b.dataset.cat===cat));const requested=new URLSearchParams(location.search).get('w');if(requested){const shared=words.find(w=>w.word.toLowerCase()===requested.toLowerCase());if(shared){feed=[{type:'teach',word:shared},{type:'test',word:shared}];fi=0}}ensureFeed();render();renderList();initVoiceUI()})().catch(e=>console.error(e));