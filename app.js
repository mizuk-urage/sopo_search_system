/* App logic is intentionally independent of replaceable data.json. */
function normalize(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("ja").replace(/[\s　‐‑‒–—-]/g, "");
}

function searchable(record) {
  return normalize([
    record.projectNumber, record.projectName, record.tentNumber,
    ...(record.keywords || []), record.location, record.organization, record.approvedPower, record.powerDetails, record.region, record.otherText, record.searchText
  ].join(" "));
}

function matchPdfPages(projectName, pageTexts) {
  const term = normalize(projectName);
  if (term.length < 2 || !Array.isArray(pageTexts)) return [];
  return pageTexts.flatMap((text, index) => normalize(text).includes(term) ? [index + 1] : []);
}

function wiringPageSelection(projectName, pageTexts, pageCount) {
  const matchedPages=matchPdfPages(projectName,pageTexts);
  const total=Math.max(1,Number(pageCount)||pageTexts?.length||1);
  return {matchedPages,displayPages:matchedPages.length?matchedPages:Array.from({length:total},(_,index)=>index+1),fallback:matchedPages.length===0};
}

function uniqueProjects(records) {
  const unique = new Map();
  for (const record of records) {
    const number=String(record.projectNumber??"").trim();
    const name=normalize(record.projectName||"");
    const key=`${record.area}|${number||`name:${name||record.id}`}`;
    const previous=unique.get(key);
    if(!previous){unique.set(key,record);continue;}
    const richness=value=>["projectName","organization","tentNumber","location","approvedPower","powerDetails","searchText"].filter(field=>value[field]).length;
    const preferred=richness(record)>richness(previous)?record:previous;
    const other=preferred===record?previous:record;
    const refsByKey=new Map();
    for(const ref of [...(previous.localReferences||[]),...(record.localReferences||[])]){
      const refKey=`${ref.docId||""}|${ref.role||""}|${ref.label||""}`;
      const prior=refsByKey.get(refKey);
      refsByKey.set(refKey,prior?{...prior,pageStart:Math.min(prior.pageStart,ref.pageStart),pageEnd:Math.max(prior.pageEnd,ref.pageEnd)}:ref);
    }
    const merged={...preferred};
    for(const field of ["organization","location","tentNumber","approvedPower","controlRoom","powerDetails","otherText"])if(!merged[field]&&other[field])merged[field]=other[field];
    unique.set(key,{...merged,region:[...new Set([previous.region,record.region].filter(Boolean))].join("・"),searchText:[...new Set([previous.searchText,record.searchText].filter(Boolean))].join(" "),keywords:[...new Set([...(previous.keywords||[]),...(record.keywords||[])])],localReferences:[...refsByKey.values()]});
  }
  return [...unique.values()];
}

if (typeof document !== "undefined") {
const state = { records: [], filter: "all" };
const input = document.querySelector("#query");
const results = document.querySelector("#results");
const status = document.querySelector("#status");
const uploadStatus = document.querySelector("#upload-status");
let installPromptEvent = null;
const installButton = document.querySelector("#install-app");
const installHelp = document.querySelector("#install-help");
const installStatus = document.querySelector("#install-status");
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
if (isStandalone) {
  document.querySelector("#install-title").textContent = "ホーム画面から起動中です";
  installHelp.textContent = "このアイコンから、いつでも企画を検索できます。";
} else if (isIOS) {
  installHelp.textContent = "iPhoneではSafariの共有ボタンから「ホーム画面に追加」を選んでください。";
} else {
  installHelp.textContent = "スマートフォンではホーム画面に追加できます。対応ブラウザーなら下のボタンから進めます。";
}
window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault(); installPromptEvent = event; installButton.hidden = false;
});
installButton.addEventListener("click", async () => {
  if (!installPromptEvent) return;
  await installPromptEvent.prompt();
  const choice = await installPromptEvent.userChoice;
  installStatus.textContent = choice.outcome === "accepted" ? "インストールを開始しました。" : "インストールはキャンセルされました。ブラウザーのメニューからも追加できます。";
  installPromptEvent = null; installButton.hidden = true;
});
window.addEventListener("appinstalled", () => {
  installButton.hidden = true; installPromptEvent = null;
  document.querySelector("#install-title").textContent = "アプリを追加しました";
  installHelp.textContent = "ホーム画面の「企画検索」アイコンから開けます。";
});
document.querySelector("#share-app").addEventListener("click", async () => {
  try {
    if (navigator.share) await navigator.share({ title: document.title, text: "学園祭 企画検索", url: location.href.split("#")[0] });
    else { await navigator.clipboard.writeText(location.href.split("#")[0]); installStatus.textContent = "アプリのリンクをコピーしました。"; }
  } catch (error) { if (error.name !== "AbortError") installStatus.textContent = "リンクを共有できませんでした。ブラウザーのアドレスをコピーしてください。"; }
});
if(location.protocol==="file:"){
  document.querySelectorAll(".slot-file-input").forEach(input=>input.disabled=true);
  uploadStatus.textContent="資料の登録にはGitHub PagesなどHTTPSのURLで開いてください。この単体HTMLは検索・閲覧用です。";
}
const localDocuments = [];
let pendingProjectImport = [];
let pendingDocument = null;
let pendingPowerReading = null;
const generatedStorageKey = "festival-search-generated-projects-v1";
const powerGroups=[
  {id:"indoor",area:"屋内",areaKey:"indoor",items:[["third","第三エリア"],["second","第二エリア"],["first","第一エリア"],["taiiku","体芸エリア"],["other","その他"]]},
  {id:"outdoor",area:"屋外",areaKey:"outdoor",items:[["second-third","第二・第三エリア"],["stone-plaza","石の広場周辺"],["first","第一エリア"],["matsumi","松美池周辺"],["hall","会館エリア"],["taiiku","体芸エリア"]]}
];
const powerSlots=powerGroups.flatMap(group=>[
  ...group.items.map(([key,region])=>({id:`power-${group.id}-${key}`,type:"電力シート",area:group.area,areaKey:group.areaKey,region})),
  {id:`power-${group.id}-all`,legacyId:`power-${group.id}`,type:"電力シート",area:group.area,areaKey:group.areaKey,region:"全体",single:true}
]);
const uploadSlots=[
  {id:"wiring-indoor",type:"配線図",area:"屋内",areaKey:"indoor"},
  {id:"wiring-outdoor",type:"配線図",area:"屋外",areaKey:"outdoor"},
  ...powerSlots
];
const powerModeStorageKey="festival-search-power-mode-v1";

const dbReady = typeof indexedDB === "undefined" ? Promise.reject(new Error("このブラウザーでは端末保存を使えません")) : new Promise((resolve, reject) => {
  const request = indexedDB.open("festival-search-local", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("documents", { keyPath: "id" });
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
dbReady.catch(() => {});
function dbAction(mode, action, value) { return dbReady.then(db => new Promise((resolve, reject) => { const tx = db.transaction("documents", mode); const req = action === "getAll" ? tx.objectStore("documents").getAll() : tx.objectStore("documents")[action](value); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); })).catch(error => { throw new Error(error?.message || "端末保存を利用できません。HTTPSのアプリとして開いてください。"); }); }
function slotDocuments(slot){return localDocuments.filter(doc=>doc.type===slot.type&&doc.area===slot.area&&(doc.slotId===slot.id||doc.id===`slot:${slot.id}`||(slot.legacyId&&doc.id===`slot:${slot.legacyId}`)));}
function currentSlotDocument(slot){const documents=slotDocuments(slot);return documents.find(doc=>doc.id===`slot:${slot.id}`)||documents.sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)).at(0)||null;}
function renderUploadSlots(){for(const slot of uploadSlots){const current=currentSlotDocument(slot);const statusNode=document.querySelector(`#slot-status-${slot.id}`);const label=document.querySelector(`label[for="slot-file-${slot.id}"]`);statusNode.textContent=current?`登録中：${current.name}`:"未登録";statusNode.title=current?.name||"この枠には資料が登録されていません";label.textContent=current?"差し替える":"PDFを選ぶ";}powerGroups.forEach(group=>updatePowerModeView(group.id));}
function readPowerMode(groupId){try{return JSON.parse(localStorage.getItem(powerModeStorageKey)||"{}")[groupId]==="single"?"single":"multiple";}catch{return"multiple";}}
function renderPowerSlotGroups(){
  const host=document.querySelector("#power-slot-groups");
  host.innerHTML=powerGroups.map(group=>{
    const mode=readPowerMode(group.id);
    const cards=slots=>slots.map(slot=>`<article class="upload-slot" data-upload-slot="${slot.id}"><h4>${safe(slot.region)}</h4><p class="slot-current" id="slot-status-${slot.id}">読み込み中…</p><input id="slot-file-${slot.id}" class="slot-file-input" type="file" accept=".pdf,application/pdf" data-slot="${slot.id}"><div class="upload-actions"><label class="slot-file-label" for="slot-file-${slot.id}">PDFを選ぶ</label><button class="create-project-pages" data-slot="${slot.id}" type="button" disabled>企画を登録</button></div></article>`).join("");
    const multi=powerSlots.filter(slot=>slot.areaKey===group.areaKey&&!slot.single);
    const single=powerSlots.filter(slot=>slot.areaKey===group.areaKey&&slot.single);
    return `<section class="power-group" data-power-group="${group.id}"><h3>電力シート · ${group.area}</h3><fieldset class="power-mode"><legend>登録方法</legend><label><input type="radio" name="power-mode-${group.id}" value="multiple" ${mode==="multiple"?"checked":""}>エリア別に複数ファイル</label><label><input type="radio" name="power-mode-${group.id}" value="single" ${mode==="single"?"checked":""}>全体を1ファイル</label></fieldset><p class="power-mode-note" data-mode-note></p><div class="power-mode-panel" data-mode-panel="multiple" ${mode!=="multiple"?"hidden":""}><div class="power-slot-grid">${cards(multi)}</div></div><div class="power-mode-panel" data-mode-panel="single" ${mode!=="single"?"hidden":""}><div class="power-slot-grid">${cards(single)}</div></div></section>`;
  }).join("");
  host.addEventListener("change",event=>{
    const radio=event.target.closest('input[type="radio"][name^="power-mode-"]');if(!radio)return;
    const groupId=radio.name.replace("power-mode-","");
    const pendingSlot=powerSlots.find(slot=>slot.id===pendingDocument?.slotId)||powerSlots.find(slot=>slot.id===pendingPowerReading);
    if(pendingSlot?.areaKey===groupId&&Boolean(pendingSlot.single)!==(radio.value==="single")){
      radio.checked=false;rootModeChoice(groupId,pendingSlot.single?"single":"multiple").checked=true;
      uploadStatus.textContent="読み取り済みの企画を登録または取り消してから、登録方法を変更してください。";return;
    }
    try{const modes=JSON.parse(localStorage.getItem(powerModeStorageKey)||"{}");modes[groupId]=radio.value;localStorage.setItem(powerModeStorageKey,JSON.stringify(modes));}catch{}
    updatePowerModeView(groupId);
  });
  powerGroups.forEach(group=>updatePowerModeView(group.id));
}
function rootModeChoice(groupId,mode){return document.querySelector(`[name="power-mode-${groupId}"][value="${mode}"]`);}
function updatePowerModeView(groupId){
  const root=document.querySelector(`[data-power-group="${groupId}"]`);if(!root)return;
  const mode=root.querySelector(`input[name="power-mode-${groupId}"]:checked`)?.value||"multiple";
  root.querySelectorAll("[data-mode-panel]").forEach(panel=>panel.hidden=panel.dataset.modePanel!==mode);
  const inactive=powerSlots.filter(slot=>slot.areaKey===groupId&&(mode==="single"?!slot.single:slot.single)).map(slot=>({slot,doc:currentSlotDocument(slot)})).filter(item=>item.doc);
  root.querySelector("[data-mode-note]").textContent=inactive.length?`別の登録方法にも資料があります（${inactive.map(item=>`${item.slot.region}：${item.doc.name}`).join("、")}).これらの資料も企画検索の対象です。`:"登録したファイル名は各項目に表示されます。";
}
renderPowerSlotGroups();
function withoutDocumentReferences(record,ids){const removed=new Set(ids);const oldRefs=record.localReferences||[];const localReferences=oldRefs.filter(ref=>!removed.has(ref.docId));return{record:{...record,localReferences},keep:!oldRefs.length||localReferences.length>0};}
async function removeObsoleteSlotDocuments(ids){if(!ids.length)return;for(const id of ids)await dbAction("readwrite","delete",id);const saved=JSON.parse(localStorage.getItem(generatedStorageKey)||"[]").map(record=>withoutDocumentReferences(record,ids)).filter(item=>item.keep).map(item=>item.record);localStorage.setItem(generatedStorageKey,JSON.stringify(saved));state.records=uniqueProjects(state.records.map(record=>withoutDocumentReferences(record,ids)).filter(item=>item.keep).map(item=>item.record));}
function removeOrphanedProjectPages(){
  const sourceIds=new Set(localDocuments.map(doc=>doc.id));
  try{
    const saved=JSON.parse(localStorage.getItem(generatedStorageKey)||"[]");
    const kept=saved.map(record=>{const oldRefs=record.localReferences||[];const localReferences=oldRefs.filter(ref=>sourceIds.has(ref.docId));return{record:{...record,localReferences},keep:!oldRefs.length||localReferences.length>0};}).filter(item=>item.keep).map(item=>item.record);
    if(kept.length!==saved.length)localStorage.setItem(generatedStorageKey,JSON.stringify(kept));
    const keptIds=new Set(kept.map(record=>record.id));
    state.records=uniqueProjects(state.records.map(record=>{const oldRefs=record.localReferences||[];const localReferences=oldRefs.filter(ref=>sourceIds.has(ref.docId));return{record:{...record,localReferences},keep:!oldRefs.length||localReferences.length>0};}).filter(item=>item.keep).map(item=>item.record).filter(record=>!(record.localReferences||[]).length||keptIds.has(record.id)));
  }catch(error){console.warn("保存済み企画ページを確認できませんでした",error);}
}
async function indexUnindexedWiringPdfs(){
  const parser=await window.FestivalPdfImportReady;
  for(const doc of localDocuments.filter(item=>item.type==="配線図"&&!Array.isArray(item.pageTexts))){
    try{
      const info=await parser.inspectPdf(doc.blob);
      doc.pageCount=info.pageCount;doc.pageTexts=info.pages;doc.terms=info.text;
      const {url,local,...saved}=doc;
      await dbAction("readwrite","put",saved);
    }catch(error){console.warn(`配線図「${doc.name}」の再読み取りに失敗しました`,error);}
  }
}
async function loadLocalDocuments() { let loaded=false;try { localDocuments.forEach(d=>d.url&&URL.revokeObjectURL(d.url)); localDocuments.splice(0,localDocuments.length,...(await dbAction("readonly","getAll")).map(d=>({...d,local:true,url:URL.createObjectURL(d.blob)}))); await indexUnindexedWiringPdfs(); loaded=true; } catch(e) { uploadStatus.textContent="端末保存を使えません。HTTPSで配布したアプリをインストールして開いてください。"; console.warn(e); } if(loaded)removeOrphanedProjectPages();renderUploadSlots();if(loaded)render(); }
function mergeGeneratedRecords(baseRecords) {
  try {
    const original=JSON.parse(localStorage.getItem(generatedStorageKey)||"[]");
    const saved=uniqueProjects(original);
    if(saved.length!==original.length)localStorage.setItem(generatedStorageKey,JSON.stringify(saved));
    const replaced=new Set(saved.map(record=>`${record.area}|${record.projectNumber}`));
    const byId=new Map(saved.map(record=>[record.id,record]));
    state.records=uniqueProjects([...baseRecords.filter(record=>!replaced.has(`${record.area}|${record.projectNumber}`)),...byId.values()]);
  } catch { state.records=baseRecords; }
}
document.querySelector("#projects-tab").addEventListener("click",()=>{document.querySelector("#project-search").hidden=false;document.querySelector("#document-search").hidden=true;document.querySelector("#results").hidden=false;document.querySelector("#projects-tab").classList.add("active");document.querySelector("#documents-tab").classList.remove("active");});
document.querySelector("#documents-tab").addEventListener("click",()=>{document.querySelector("#project-search").hidden=true;document.querySelector("#document-search").hidden=false;document.querySelector("#results").hidden=true;document.querySelector("#documents-tab").classList.add("active");document.querySelector("#projects-tab").classList.remove("active");loadLocalDocuments();});
function renderImportReview(projects) {
  pendingProjectImport = projects;
  const review = document.querySelector("#import-review");
  document.querySelector("#import-preview").innerHTML = projects.map((record,index)=>`<article class="import-card" data-project-index="${index}"><h3>PDF ${record.sourcePage}ページから検出 · ${record.area === "indoor" ? "屋内" : "屋外"}</h3><label>企画番号<input data-field="projectNumber" value="${safe(record.projectNumber)}"></label><label>企画名<input data-field="projectName" value="${safe(record.projectName)}"></label><label>団体名<input data-field="organization" value="${safe(record.organization)}"></label><label>${record.area === "indoor" ? "実施場所" : "テント番号"}<input data-field="place" value="${safe(record.location || record.tentNumber)}"></label><label>控室<input data-field="controlRoom" value="${safe(record.controlRoom)}"></label><label>許可電力<input data-field="approvedPower" value="${safe(record.approvedPower)}"></label><label>${record.area === "indoor" ? "使用系統" : "電ドラ情報"}<input data-field="powerDetails" value="${safe(record.powerDetails)}"></label><p class="meta">この企画の電力シート：${record.localReferences[0].pageStart}〜${record.localReferences[0].pageEnd}ページ</p></article>`).join("");
  document.querySelectorAll(".create-project-pages").forEach(button=>{
    const selected=button.dataset.slot===pendingDocument?.slotId;
    button.disabled=!selected||projects.length===0;
    button.textContent=selected?(pendingDocument?.replacing?"確認して差し替える":"企画を登録") : "企画を登録";
  });
  review.hidden = projects.length === 0;
}
document.querySelectorAll(".slot-file-input").forEach(input=>input.addEventListener("change",async event=>{
  const file=event.target.files[0];if(!file)return;
  const slot=uploadSlots.find(item=>item.id===event.target.dataset.slot);if(!slot)return;
  if(slot.type==="電力シート"){pendingDocument=null;pendingPowerReading=slot.id;renderImportReview([]);}
  const existing=currentSlotDocument(slot);
  const slotId=`slot:${slot.id}`;
  const oldIds=slotDocuments(slot).filter(doc=>doc.id!==slotId).map(doc=>doc.id);
  const item={id:slotId,slotId:slot.id,name:file.name,type:slot.type,area:slot.area,region:slot.region||"",terms:"",blob:file,local:true,updatedAt:Date.now()};
  try{
    if(!/\.pdf$/i.test(file.name))throw new Error("PDFファイルを選んでください。");
    uploadStatus.textContent=`${slot.type}（${slot.area}）を読み取っています…`;
    const parser=await window.FestivalPdfImportReady;
    if(!parser)throw new Error("PDFの読み取りにはHTTPSで開いたアプリが必要です。");
    const info=await parser.inspectPdf(file);item.pageCount=info.pageCount;item.terms=info.text;if(slot.type==="配線図")item.pageTexts=info.pages;
    if(slot.type==="電力シート"){
      const extracted=await parser.extractPowerSheet(file);
      if(!extracted.projects.length)throw new Error("企画情報のあるページが見つかりません。文字情報のある電力シートPDFを選んでください。");
      if(extracted.projects.some(project=>project.area!==slot.areaKey))throw new Error(`このPDFには${slot.area}以外の企画も含まれています。該当する屋内／屋外の電力シートを選んでください。`);
      item.terms=[item.terms,...extracted.projects.map(project=>`${project.projectNumber} ${project.projectName} ${project.organization}`)].join(" ").trim();
      extracted.projects.forEach(project=>{project.localReferences[0].docId=item.id;project.region=slot.region;});
      pendingDocument={item,slotId:slot.id,replacing:Boolean(existing),removeIds:oldIds};
      renderImportReview(extracted.projects);
      uploadStatus.textContent=`${extracted.projects.length}件の企画候補です。内容を確認し、上のボタンで登録してください。`;
    }else{
      if(existing&&!window.confirm(`「${existing.name}」を「${file.name}」に差し替えます。よろしいですか？`))return;
      await dbAction("readwrite","put",item);await removeObsoleteSlotDocuments(oldIds);await loadLocalDocuments();
      uploadStatus.textContent=`${slot.type}（${slot.area}）に「${file.name}」を${existing?"差し替えました":"登録しました"}。`;
    }
  }catch(error){uploadStatus.textContent=`登録できませんでした：${error.message||"端末の保存領域を確認してください"}`;console.error(error);}
  finally{if(slot.type==="電力シート")pendingPowerReading=null;event.target.value="";}
}));async function saveProjectPages(){
  if(!pendingDocument){uploadStatus.textContent="先に電力シートを選んでください。";return;}
  if(pendingDocument.replacing&&!window.confirm(`「${localDocuments.find(doc=>doc.id===pendingDocument.item.id)?.name||"登録済み資料"}」を選んだ電力シートに差し替え、企画ページを更新します。よろしいですか？`))return;
  const cards=[...document.querySelectorAll(".import-card")];
  const records=cards.map(card=>{
    const project={...pendingProjectImport[Number(card.dataset.projectIndex)]};
    const value=name=>card.querySelector(`[data-field="${name}"]`)?.value.trim()||"";
    project.projectNumber=value("projectNumber"); project.projectName=value("projectName"); project.organization=value("organization"); project.approvedPower=value("approvedPower");
    project.controlRoom=value("controlRoom"); project.powerDetails=value("powerDetails");
    if(project.area==="indoor") project.location=value("place"); else project.tentNumber=value("place");
    project.id=`${project.localReferences[0].docId}-page-${project.sourcePage}`;
    return project;
  }).filter(project=>project.projectNumber&&project.projectName);
  try {
    const existing=JSON.parse(localStorage.getItem(generatedStorageKey)||"[]");
    const docId=pendingDocument.item.id,obsoleteIds=new Set([docId,...pendingDocument.removeIds]);
    const retained=existing.map(record=>withoutDocumentReferences(record,[...obsoleteIds])).filter(item=>item.keep).map(item=>item.record);
    const byId=new Map([...retained,...records].map(record=>[record.id,record]));
    const saved=uniqueProjects([...byId.values()]);
    await dbAction("readwrite","put",pendingDocument.item);
    await removeObsoleteSlotDocuments(pendingDocument.removeIds);
    localStorage.setItem(generatedStorageKey,JSON.stringify(saved));
    state.records=uniqueProjects([...state.records.map(record=>withoutDocumentReferences(record,[...obsoleteIds])).filter(item=>item.keep).map(item=>item.record),...records]);
    pendingDocument=null; pendingProjectImport=[];
    document.querySelector("#import-review").hidden=true;
    renderImportReview([]);
    uploadStatus.textContent=`${records.length}件の企画ページを作成しました。引き続き資料の登録状況を確認できます。`;
    await loadLocalDocuments();
    render();
  } catch(e) { uploadStatus.textContent="企画ページを保存できませんでした。端末の保存領域を確認してください。"; }
}
document.querySelectorAll(".create-project-pages").forEach(button=>button.addEventListener("click",saveProjectPages));
document.querySelector("#cancel-project-pages").addEventListener("click",()=>{pendingDocument=null;pendingProjectImport=[];renderImportReview([]);uploadStatus.textContent="登録を取り消しました。端末内の資料は変更されていません。";});

function safe(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

async function renderPdfViews() {
  const parser=await window.FestivalPdfImportReady;
  for(const container of document.querySelectorAll(".pdf-page-list")){
    const pages=container.dataset.pages.split(",").map(Number).filter(Number.isFinite);
    const hitPages=container.dataset.hitPages.split(",").map(Number).filter(Number.isFinite);
    try{await parser.renderPdfPages(container.dataset.pdfSrc,pages,container,{allPages:container.dataset.allPages==="true",hitPages,viewerId:container.dataset.viewerId});}
    catch(error){container.textContent="このPDFをページ表示できませんでした。PDFファイルを登録し直してみてください。";console.warn(error);}
  }
  document.querySelectorAll(".pdf-page-jump").forEach(button=>button.addEventListener("click",()=>document.getElementById(button.dataset.target)?.scrollIntoView({behavior:"smooth",block:"start"})));
}

function render() {
  const detailId = new URLSearchParams(location.search).get("project") || location.hash.match(/^#project=(.*)$/)?.[1] || location.hash.match(/^#\/project\/([^/?#]+)$/)?.[1];
  if (detailId) { renderDetail(decodeURIComponent(detailId)); return; }
  renderList();
}

function renderList() {
  const q = normalize(input.value);
  const found = uniqueProjects(state.records).filter(record =>
    (state.filter === "all" || record.area === state.filter) && (!q || searchable(record).includes(q))
  );
  status.textContent = q ? `${found.length}件見つかりました` : `${uniqueProjects(state.records).length}件を登録しています。語句を入力して検索してください。`;
  if (!found.length) {
    results.innerHTML = '<div class="empty">一致する企画はありません。番号やキーワードを変えてみてください。</div>';
    return;
  }
  results.innerHTML = found.map(record => {
    const areaLabel = record.area === "indoor" ? "屋内" : "屋外";
    const heading = record.projectName || "名称未確認の資料";
    const meta = [record.projectNumber ? `企画番号：${safe(record.projectNumber)}` : "企画番号：未登録", record.region ? `資料エリア：${safe(record.region)}` : "", record.tentNumber ? `テント：${safe(record.tentNumber)}` : "", record.location ? `場所：${safe(record.location)}` : "", record.organization ? `団体：${safe(record.organization)}` : "", record.approvedPower ? `許可電力：${safe(record.approvedPower)}` : ""].filter(Boolean).join("　 ·  ");
    return `<article class="card"><h2><span class="badge ${record.area === "outdoor" ? "outdoor" : ""}">${areaLabel}</span><a class="title-link" href="project.html#project=${encodeURIComponent(record.id)}">${safe(heading)}</a></h2><p class="meta">${meta}</p><a class="detail-link" href="project.html#project=${encodeURIComponent(record.id)}">企画ページを開く →</a></article>`;
  }).join("");
}

function renderDetail(id) {
  const record = state.records.find(item => item.id === id);
  if (!record) { results.innerHTML = '<div class="empty">企画が見つかりませんでした。</div><a class="back-link" href="#/">← 一覧に戻る</a>'; status.textContent = ""; return; }
  status.textContent = "企画ページ";
  const areaLabel = record.area === "indoor" ? "屋内" : "屋外";
  const controlRoom=record.controlRoom||String(record.otherText||"").match(/控室\s*([^。\n]+)/)?.[1]||"";
  const fields = [
    ["企画番号", record.projectNumber], ["資料エリア", record.region], ["団体", record.organization],
    [record.area === "indoor" ? "実施場所" : "テント番号", record.location || record.tentNumber],
    ["控室", /^(なし|無|-)$/u.test(controlRoom.trim())?"":controlRoom],
    ["許可電力", record.approvedPower], [record.area === "indoor" ? "使用系統" : "電ドラ情報", record.powerDetails]
  ].filter(([, value]) => value);
  const docs = new Map();
  for (const ref of record.references || []) {
    const key = `${ref.label}|${ref.file}`;
    if (!docs.has(key)) docs.set(key, { label: ref.label, file: ref.file, pages: [], isWiring:String(ref.label||"").includes("配線図"), allPages:String(ref.label||"").includes("配線図") });
    if (!docs.get(key).pages.includes(Number(ref.page) || 1)) docs.get(key).pages.push(Number(ref.page) || 1);
  }
  for (const ref of record.localReferences || []) {
    const source=localDocuments.find(doc=>doc.id===ref.docId);
    if(!source) continue;
    const key=`${ref.label}|local:${ref.docId}`;
    if(!docs.has(key)) docs.set(key,{label:ref.label,local:true,url:source.url,pages:[],pageStart:ref.pageStart,pageEnd:ref.pageEnd,pageCount:source.pageCount||ref.pageEnd});
    for(let page=ref.pageStart;page<=ref.pageEnd;page++) docs.get(key).pages.push(page);
  }
  const outdoorHasRoom=record.area==="outdoor"&&Boolean(controlRoom.trim())&&!/^(なし|無|-)$/u.test(controlRoom.trim());
  const expectedWiringAreas=outdoorHasRoom?["屋外","屋内"]:[record.area==="indoor"?"屋内":"屋外"];
  const localWires=localDocuments.filter(doc=>doc.type==="配線図"&&["全エリア",...expectedWiringAreas].includes(doc.area));
  const staticWiring=(record.references||[]).filter(ref=>String(ref.label||"").includes("配線図"));
  const missingWiringAreas=expectedWiringAreas.filter(area=>!localWires.some(doc=>doc.area===area||doc.area==="全エリア")&&!staticWiring.some(ref=>String(ref.label||"").includes(area)||!String(ref.label||"").match(/屋内|屋外/)));
  const wireNotice=missingWiringAreas.length?`<p class="empty">${safe(missingWiringAreas.join("・"))}の配線図PDFが登録されていません。</p>`:"";
  for(const wire of localWires){
    const selection=wiringPageSelection(record.projectName,wire.pageTexts||[],wire.pageCount);
    const key=`配線図|local:${wire.id}`;
    if(!docs.has(key))docs.set(key,{label:`配線図 · ${wire.area}`,local:true,url:wire.url,pages:selection.displayPages,matchedPages:selection.matchedPages,pageCount:wire.pageCount||1,allPages:true,isWiring:true,searchFailed:!(wire.pageTexts||[]).length,unmatched:selection.fallback});
  }
  const fieldHtml = fields.map(([label, value]) => `<div class="detail-field"><dt>${safe(label)}</dt><dd>${safe(value)}</dd></div>`).join("");
  const docHtml = [...docs.values()].map((doc, index) => {
    const first = doc.pages.length ? Math.min(...doc.pages) : 1;
    const matchedPages=doc.matchedPages||[];
    const pages = doc.isWiring ? doc.searchFailed ? "企画名を検索できませんでした。配線図全体を下へスクロールして確認できます。" : matchedPages.length ? `企画名が見つかったページ：${matchedPages.join("、")}。配線図全体を下へスクロールして確認できます。` : `企画名は見つかりませんでした。配線図全体（${doc.pageCount||"全"}ページ）を表示します。` : doc.pages.length ? `参照ページ：${doc.pages.sort((a,b) => a-b).join("、")}` : "";
    const href=doc.local?doc.url:`data/${safe(doc.file)}`;
    const viewerId=`pdf-viewer-${index}`;
    const jumpPages=doc.isWiring?matchedPages:doc.pages;
    const jumpNav=jumpPages.length?`<nav class="pdf-page-jumps" aria-label="該当ページへ移動">${jumpPages.map(page=>`<button class="pdf-page-jump" type="button" data-target="${viewerId}-page-${page}">${page}ページへ</button>`).join("")}</nav>`:"";
    return `<section class="document-panel"><h3>${safe(doc.label)}</h3><p class="page-links">${pages}</p><p class="pdf-scroll-hint">左右にスワイプしてページを切り替えられます。</p>${jumpNav}<div class="pdf-page-list" data-pdf-src="${safe(href)}" data-pages="${doc.allPages?"":doc.pages.join(",")}" data-all-pages="${doc.allPages?"true":"false"}" data-hit-pages="${matchedPages.join(",")}" data-viewer-id="${viewerId}"></div></section>`;
  }).join("") || '<p class="empty">この企画の関連PDFはまだ登録されていません。</p>';
  results.innerHTML = `<a class="back-link" href="index.html">← 検索一覧に戻る</a><article class="card detail-card"><p class="eyebrow">${areaLabel} · 企画詳細</p><h2>${safe(record.projectName || "名称未確認の企画")}</h2><dl class="detail-fields">${fieldHtml}</dl>${record.otherText ? `<p class="detail-note">${safe(record.otherText)}</p>` : ""}</article><h2 class="section-heading">関連資料</h2>${wireNotice}${docHtml}`;
  renderPdfViews();
}

input.addEventListener("input", render);
document.querySelector("#clear").addEventListener("click", () => { input.value = ""; input.focus(); render(); });
document.querySelectorAll(".filter").forEach(button => button.addEventListener("click", () => {
  state.filter = button.dataset.filter;
  document.querySelectorAll(".filter").forEach(b => { const active = b === button; b.classList.toggle("active", active); b.setAttribute("aria-pressed", String(active)); });
  render();
}));
window.addEventListener("hashchange", render);

if (window.FESTIVAL_DATA) {
  mergeGeneratedRecords(window.FESTIVAL_DATA.records);
  loadLocalDocuments().then(render);
} else {
  fetch("data/data.json").then(response => { if (!response.ok) throw new Error("data.json を読めません"); return response.json(); })
    .then(data => { mergeGeneratedRecords(data.records); return loadLocalDocuments(); })
    .then(render)
    .catch(error => { status.textContent = "検索データを読み込めません。READMEの起動方法を確認してください。"; console.error(error); });
}

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => navigator.serviceWorker.register("service-worker.js").catch(console.warn));
}
}

if (typeof module !== "undefined") module.exports = { normalize, searchable, matchPdfPages, wiringPageSelection, uniqueProjects };
