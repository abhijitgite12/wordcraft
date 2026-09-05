window.addEventListener('error',e=>{const c=document.querySelector('#card');if(c&&!c.dataset.error){c.dataset.error='1';c.innerHTML='<div class="empty-card"><div class="empty-icon">!</div><h2>Word Craft needs a refresh</h2><p>'+String(e.message||'Please reload the page.').replace(/[<>]/g,'')+'</p><button class="dive-main" onclick="location.reload()">Refresh</button></div>'}});window.addEventListener('unhandledrejection',e=>{console.error(e.reason)});
let words, score=0, wrong={}, seen={}, craftWord=null, feed=[], fi=0, asked=null, curWord=null, mix='mixed', cat='all';
const $=s=>document.querySelector(s),$$=s=>document.querySelectorAll(s);const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const shuffle=a=>[...a].sort(()=>Math.random()-.5);

// ===== Voice layer: tool registry + local fast-path + speech =====
const VOICE = { level: Number(localStorage.getItem('wordCraftVoice')||0), rate: Number(localStorage.getItem('wordCraftRate')||1), on: localStorage.getItem('wordCraftVoiceOn')!=='off' };
let listening=false, voiceTimer=null;
function speak(text,{rate=VOICE.rate,interrupt=true}={}){
  if(!VOICE.on||!window.speechSynthesis||!text)return;
  if(interrupt)window.speechSynthesis.cancel();
  const u=new SpeechSynthesisUtterance(String(text));u.rate=rate;u.pitch=1;window.speechSynthesis.speak(u);
}
function stopSpeak(){if(window.speechSynthesis)window.speechSynthesis.cancel();}
// Local, zero-network fast-path. Returns {tool,option,query} or null.
function localFastpath(text){
  const t=String(text||'').toLowerCase().trim(); if(!t)return null;
  const has=w=>t.includes(w), any=arr=>arr.some(has);
  if(any(['stop','cancel','quiet','shut up']))return {tool:'stop'};
  if(any(['mute','voice off','turn off voice','silence']))return {tool:'mute'};
  if(any(['unmute','voice on','turn on voice']))return {tool:'voice_on'};
  if(any(['help','what can i','what do i','what can you','commands','options list']))return {tool:'help'};
  if(any(['read options','read the options','what are the options','say the options']))return {tool:'options'};
  if(any(['yes','yeah','yep','sure','ok','okay','fine','correct','right','that'])&&!has('no '))return {tool:'yes'};
  if(any(['no','nope','nah','not yet','wait']))return {tool:'no'};
  if(any(['next','go','continue','forward','let it slide','move on','advance','skip it']))return {tool:'next'};
  if(any(['back','previous','go back','return','undo']))return {tool:'back'};
  if(any(['skip','pass','dont know','dunno','dont want']))return {tool:'skip'};
  if(any(['repeat','again','say it again','read again','what','pardon','slower','slow down','one more time','replay']))return {tool:'repeat'};
  if(any(['reveal','show me','show it','show answer','give up','just tell me','i give up','what is it','let me see','show','tell me the answer','answer reveal','flip']))return {tool:'reveal'};
  if(any(['deep dive','deep-dive','explain more','learn more','dive']))return {tool:'deep_dive'};
  if(any(['review','review deck','missed words','my review']))return {tool:'review'};
  if(any(['browse','word bank','search words','find a word']))return {tool:'browse'};
  // option letters / ordinals
  const m=t.match(/\b([abcd])\b/); if(m)return {tool:'answer_option',option:'abcd'.indexOf(m[1])};
  const num=t.match(/\b([1-4])\b/); if(num)return {tool:'answer_option',option:Number(num[1])-1};
  const ord={'first':0,'second':1,'third':2,'fourth':3}; for(const k in ord) if(t.includes(k))return {tool:'answer_option',option:ord[k]};
  return null;
}
// Page toolset (legal actions) from current state.
function currentTools(){
  const c=cur(); const base=['next','back','skip','repeat','slow','fast','options','help','mute','voice_on','stop'];
  if(!c||c.type==='empty')return ['next','back','repeat','help','mute','voice_on','stop'];
  if(c.type==='test')return ['answer_option','answer_meaning','repeat','back','skip','options','help','mute','voice_on','stop'];
  if(c.type==='relearn')return ['next','back','repeat','reveal','deep_dive','options','help','mute','voice_on','stop','yes','no'];
  // teach
  return [...base,'reveal','deep_dive'];
}
// Resolve an utterance to a tool: local first, then free-model intent.
async function resolveIntent(text){
  const local=localFastpath(text); if(local)return local;
  const c=cur(), w=c?.word;
  try{
    const r=await fetch('/api/intent',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({word:w?.word||'',definition:w?(w.aiDefinition||w.definition||''):'',screen:c?.type||'teach',tools:currentTools(),text})});
    if(!r.ok)return null; const d=await r.json();
    return {tool:d.tool==='unknown'?null:d.tool,option:d.option,query:d.query,confidence:d.confidence,model:d.model};
  }catch(e){return null}
}
// Execute a resolved tool against the current page.
async function runTool(tool,params={}){
  if(!tool)return;
  const c=cur(); const legal=currentTools(); if(!legal.includes(tool)){ speak("That's not available here. Say help to hear what you can do."); return; }
  const w=c?.word;
  switch(tool){
    case 'next': move(1); break;
    case 'back': move(-1); break;
    case 'skip': move(1); break;
    case 'repeat': speak(w?w.word+' — '+(w.aiDefinition||w.definition||''):''); break;
    case 'slow': VOICE.rate=Math.max(.5,VOICE.rate-.2);localStorage.setItem('wordCraftRate',VOICE.rate);speak('Slower');break;
    case 'fast': VOICE.rate=Math.min(2,VOICE.rate+.2);localStorage.setItem('wordCraftRate',VOICE.rate);speak('Faster');break;
    case 'reveal': showFlip(); break;
    case 'deep_dive': if(w)openCraft(w); break;
    case 'options': if(c?.type==='test'&&window.$$){speak('Read the options.');}else speak('You can say next, back, skip, reveal, or help.'); break;
    case 'help': speak('You can say: '+legal.slice(0,8).join(', ')+', or help.'); break;
    case 'review': showPage('review'); break;
    case 'browse': showPage('browse'); break;
    case 'mute': VOICE.on=false;localStorage.setItem('wordCraftVoiceOn','off');speak('Voice off');break;
    case 'voice_on': VOICE.on=true;localStorage.setItem('wordCraftVoiceOn','on');speak('Voice on');break;
    case 'stop': stopSpeak(); break;
    case 'answer_option': if(c?.type==='test'&&typeof params.option==='number'){const o=$$('.option')[params.option];if(o&&!o.classList.contains('disabled'))o.click();}break;
    case 'answer_meaning': speak("Say your answer, or pick an option."); break;
    case 'yes': if(c?.type==='relearn'){delete wrong[w.word];persist();update();move(1);}break;
    case 'no': speak('Keep it in review.'); break;
    default: break;
  }
}
async function handleUtterance(text){
  if(!text)return;
  const r=await resolveIntent(text); if(!r||!r.tool){ speak("I didn't catch that. Say help to hear what you can do."); return; }
  await runTool(r.tool,r);
}
// Mic wrapper with graceful fallback to a text box.
function startListening(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){ speak("Voice isn't supported here. Use the buttons."); return; }
  const rec=new SR(); rec.lang='en-US'; rec.interimResults=false; rec.maxAlternatives=1;
  rec.onstart=()=>{listening=true;const el=$('#voice-indicator');if(el)el.classList.add('active');};
  rec.onresult=e=>{const t=e.results[0][0].transcript;handleUtterance(t);};
  rec.onend=()=>{listening=false;const el=$('#voice-indicator');if(el)el.classList.remove('active');};
  rec.onerror=()=>{listening=false;speak("Sorry, I didn't catch that.");};
  rec.start();
}
// A tiny always-available text fallback for testing voice without a mic.
function initVoiceUI(){
  const btn=$('#voice-btn'); if(btn)btn.onclick=()=>{if(listening)return;startListening();};
  const input=$('#voice-input'); const form=$('#voice-form');
  if(form)form.onsubmit=e=>{e.preventDefault();const v=input.value.trim();if(v){handleUtterance(v);input.value='';}};
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
function showFlip(){let c=$('#card');if(c.querySelector('.face')&&!c.classList.contains('flipped')&&!c.classList.contains('dragging')&&!c.classList.contains('swiping')){c.style.transform='';c.classList.add('flipping');requestAnimationFrame(()=>{c.classList.add('flipped');setTimeout(()=>c.classList.remove('flipping'),620)})}}
function move(dir){let c=$('#card');if(c.classList.contains('swiping'))return;if(dir<0&&fi===0){springCard();return}c.classList.add('swiping',dir>0?'moving-left':'moving-right');setTimeout(()=>{c.classList.remove('swiping','moving-left','moving-right');commitMove(dir)},340)}
$('#card').addEventListener('click',e=>{if(suppressClick)return;let d=e.target.closest('[data-dive]');if(d){openCraft(words.find(w=>w.word===d.dataset.dive));return}let opt=e.target.closest('.option');if(opt&&!opt.classList.contains('disabled')){answer(opt);return}if($('#card').querySelector('.face'))showFlip()});
function celebrate(origin,big=false){if(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;const box=document.createElement('div');box.className='confetti';const r=origin?.getBoundingClientRect?.();box.style.left=(r?r.left+r.width/2:innerWidth/2)+'px';box.style.top=(r?r.top+r.height/2:innerHeight/2)+'px';for(let i=0;i<(big?24:12);i++){const p=document.createElement('i');p.style.setProperty('--x',(Math.random()*130-65)+'px');p.style.setProperty('--y',(Math.random()*90+35)+'px');p.style.setProperty('--r',(Math.random()*360)+'deg');p.style.setProperty('--d',(Math.random()*.2)+'s');p.style.background=['#6555d8','#ff785f','#2f9e62','#e8a13a','#7654c7'][i%5];box.appendChild(p)}document.body.appendChild(box);setTimeout(()=>box.remove(),1100)}
function answer(btn){let w=cur().word,right=correctAnswer(w),correct=btn.dataset.a===right;$$('.option').forEach(x=>{x.classList.add('disabled');if(x.dataset.a===right)x.classList.add('correct')});let ans=$('#t-ans');if(!correct){btn.classList.add('wrong','learning-miss');setTimeout(()=>btn.classList.remove('learning-miss'),550);wrong[w.word]=(wrong[w.word]||0)+1;ans.textContent='↺ Learning moment — this word comes right back for a clearer pass.';ans.className='answer-note bad';const wobj=words.find(x=>x.word===w.word);feed.splice(fi+1,0,{type:'relearn',word:wobj});}else{score++;delete wrong[w.word];btn.classList.add('locked-in');celebrate(btn,false);ans.textContent='✦ Got it! Swipe left for the next word.';ans.className='answer-note good'}persist();update();autoSizeCard()}
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
function openCraft(x){craftWord=x;let c=$('#craft-panel');c.classList.add('open');$('#craft-sub').textContent=`Exploring “${x.word}”`;$('#craft-body').innerHTML=`<div class="steps"><p class="step-head">Quick questions</p><div class="prompt-chips"><button data-ask="Explain it simply and give a vivid example.">1. Explain</button><button data-ask="Give a fun memory hook.">2. Memory</button><button data-ask="Contrast this word with a near-synonym.">3. Near-syn</button><button data-ask="Ask me two deeper questions.">4. Test me</button><button data-ask="Show this in novels or history.">5. In the wild</button></div><p class="step-head or">OR ask anything</p></div>`}
$('#close-craft').onclick=()=>$('#craft-panel').classList.remove('open');
async function askCraft(q){let x=craftWord||words.find(w=>w.word===curWord)||pick();$('#craft-body').innerHTML='<p>✦ thinking…</p>';try{let r=await fetch('/api/genie',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({word:x.word,definition:x.definition,mode:q})});let d=await r.json();if(!r.ok)throw Error(d.error);$('#craft-body').innerHTML=`<div class="answer"><button class="quick-back" id="quick-back">← Quick questions</button><div class="direct-answer"><span class="answer-kicker">ANSWER</span><p>${highlightIn(x.word,d.directAnswer||d.explanation||'')}</p></div><div class="block"><strong>Plain English</strong><br>${highlightIn(x.word,d.explanation||'')}</div><div class="block"><strong>Try it</strong><br><i>${highlightIn(x.word,d.example||'')}</i></div><div class="block"><strong>Memory hook</strong><br>${highlightIn(x.word,d.memoryHook||'')}</div><div class="block"><strong>Think deeper</strong><br>${highlightIn(x.word,d.deeperQuestion||'')}</div><div class="block"><strong>Context</strong><br>${highlightIn(x.word,d.contextNote||'')}</div><div class="block"><strong>Related</strong><br><span class="syn">${esc((d.synonyms||[]).map(s=>'↗ '+s).join('  '))}</span> <span class="ant">${esc((d.antonyms||[]).map(a=>'↘ '+a).join('  '))}</span></div></div>`;document.getElementById('quick-back').onclick=()=>openCraft(x)}catch(e){$('#craft-body').innerHTML=`<p class="bad-q">Deep Dive is taking a tiny break: ${esc(e.message)}</p><p>Your flashcards still work without AI.</p>`}}
$('#craft-form').onsubmit=e=>{e.preventDefault();let q=$('#craft-input').value.trim();if(q){$('#craft-input').value='';askCraft(q)}};document.addEventListener('click',e=>{let b=e.target.closest('[data-ask]');if(b)askCraft(b.dataset.ask)});
let fontSize=Number(localStorage.getItem('wordCraftFont')||135);function applyFontSize(){fontSize=Math.max(85,Math.min(140,fontSize));document.documentElement.style.setProperty('--fs',fontSize/100);$('#fs-label').textContent=fontSize+'%';try{localStorage.setItem('wordCraftFont',fontSize)}catch(e){}}$('#fs-minus').onclick=e=>{e.stopPropagation();fontSize-=10;applyFontSize()};$('#fs-plus').onclick=e=>{e.stopPropagation();fontSize+=10;applyFontSize()};
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