/* Offline PDF text reader. Vendored PDF.js is licensed under Apache-2.0. */
import * as pdfjs from "./vendor/pdfjs/pdf.min.js";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdfjs/pdf.worker.min.js", import.meta.url).href;

function linesOf(items) {
  const rows = [];
  for (const item of items) {
    const value = String(item.str || "").trim();
    if (!value) continue;
    const x = item.transform?.[4] || 0;
    const y = item.transform?.[5] || 0;
    let row = rows.find(candidate => Math.abs(candidate.y - y) <= 2.5);
    if (!row) rows.push(row = { y, items: [] });
    row.items.push({ x, width: item.width || 0, value });
  }
  return rows.map(row => {
    row.items.sort((a, b) => a.x - b.x);
    let text = "", end = null;
    for (const item of row.items) {
      if (end !== null && item.x - end > 2.5) text += " ";
      text += item.value;
      end = item.x + item.width;
    }
    return { y: row.y, items: row.items, text: text.trim() };
  }).sort((a, b) => b.y - a.y);
}

function clean(value) { return String(value || "").replace(/\s+/g, " ").replace(/^[\s:：]+|[\s:：]+$/g, "").trim(); }

function parseProjectPage(pageNumber, rows, fullText) {
  const numberLabel = rows.flatMap(row => row.items).find(item => item.value.includes("企画番号") || item.value === "番号");
  const nameLabel = rows.flatMap(row => row.items).find(item => item.value === "企画名");
  const groupLabelRow = rows.find(row => row.y > (nameLabel ? 500 : 0) && row.items.some(item => item.value === "団体名"));
  const groupLabel = groupLabelRow?.items.find(item => item.value === "団体名");
  if (!numberLabel || !nameLabel || !groupLabel) return null;
  const locationLabel = rows.flatMap(row => row.items).find(item => item.value.includes("企画実施場所"));
  const lowerBoundary = locationLabel ? labelY(rows, locationLabel) : numberLabelY(rows, numberLabel) - 120;
  const valueRows = rows.filter(row => row.y < numberLabelY(rows, numberLabel) - 8 && row.y > lowerBoundary + 8);
  const nameX = nameLabel.x, groupX = groupLabel.x;
  const column = (minX, maxX) => valueRows.map(row => row.items.filter(item => item.x >= minX && item.x < maxX).map(item => item.value).join(" ").trim()).filter(Boolean).join(" ");
  const projectNumber = clean(column(0, nameX));
  const projectName = clean(column(nameX, groupX));
  const organization = clean(column(groupX, 900));
  if (!projectNumber || !projectName) return null;

  const placeRow = locationLabel && rows.filter(row => row.y < locationLabelY(rows, locationLabel) - 8 && row.y > locationLabelY(rows, locationLabel) - 75).sort((a,b) => b.y-a.y)[0];
  const placeText = placeRow?.items.filter(item => item.x < 280).map(item => item.value).join(" ").trim() || "";
  const controlRoom = clean(placeRow?.items.filter(item => item.x >= 280).map(item => item.value).join(" ").trim() || "");
  const powerLabel = rows.flatMap(row => row.items).find(item => item.value.includes("使用許可電力"));
  const powerRow = powerLabel && rows.filter(row => row.y < labelY(rows, powerLabel) - 8 && row.y > labelY(rows, powerLabel) - 75).sort((a,b) => b.y-a.y)[0];
  const powerText = powerRow?.items.filter(item => item.x < 250).map(item => item.value).join(" ").trim() || "";
  const powerDetails = clean(powerRow?.items.filter(item => item.x >= 250).map(item => item.value).join(" ").trim() || "");
  const isOutdoor = fullText.includes("屋外企画用");
  const area = isOutdoor ? "outdoor" : "indoor";
  return {
    id: `power-import-${pageNumber}`,
    projectNumber,
    projectName,
    organization,
    area,
    location: isOutdoor ? "" : placeText,
    tentNumber: isOutdoor ? placeText : "",
    controlRoom: /^(なし|無|-)$/u.test(controlRoom) ? "" : controlRoom,
    approvedPower: clean(powerText || (/0\s*W\s*と申請/.test(fullText) ? "0W" : "")),
    powerDetails,
    keywords: [],
    otherText: "",
    searchText: clean(fullText),
    references: [],
    sourcePage: pageNumber
  };
}

function labelY(rows, target) {
  for (const row of rows) if (row.items.includes(target)) return row.y;
  return 0;
}
const numberLabelY = labelY;
const locationLabelY = labelY;

async function extractPowerSheet(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({
    data: bytes,
    cMapUrl: new URL("./vendor/pdfjs/cmaps/", import.meta.url).href,
    cMapPacked: true,
    standardFontDataUrl: new URL("./vendor/pdfjs/standard_fonts/", import.meta.url).href,
    useWorkerFetch: false
  }).promise;
  const pages = [], allPageText = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const rows = linesOf(content.items);
    const fullText = rows.map(row => row.text).join(" ");
    allPageText[pageNumber] = fullText;
    const hasProjectNumberLabel=rows.some(row=>row.items.some(item=>item.value.includes("企画番号")||item.value==="番号"));
    const hasProjectNameLabel=rows.some(row=>row.items.some(item=>item.value==="企画名"));
    if (!hasProjectNumberLabel || !hasProjectNameLabel) continue;
    const project = parseProjectPage(pageNumber, rows, fullText);
    if (project) pages.push({ project, fullText });
  }
  pages.forEach((entry, index) => {
    const lastPage = (pages[index + 1]?.project.sourcePage || (pdf.numPages + 1)) - 1;
    entry.project.localReferences = [{ pageStart: entry.project.sourcePage, pageEnd: lastPage, label: "電力シート", role: "power" }];
    entry.project.searchText = allPageText.slice(entry.project.sourcePage, lastPage + 1).join(" ").trim();
  });
  const result={ pageCount: pdf.numPages, projects: pages.map(entry => entry.project) };
  await pdf.destroy();
  return result;
}

async function inspectPdf(file) {
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    cMapUrl: new URL("./vendor/pdfjs/cmaps/", import.meta.url).href,
    cMapPacked: true,
    standardFontDataUrl: new URL("./vendor/pdfjs/standard_fonts/", import.meta.url).href,
    useWorkerFetch: false
  }).promise;
  const pages=[];
  for(let pageNumber=1;pageNumber<=pdf.numPages;pageNumber++){
    const page=await pdf.getPage(pageNumber);
    const content=await page.getTextContent();
    pages.push(content.items.map(item=>item.str||"").filter(Boolean).join(" ").replace(/\s+/g," ").trim());
  }
  const result={ pageCount: pdf.numPages, pages, text: pages.join(" ").trim() };
  await pdf.destroy();
  return result;
}

async function renderPdfPages(source, pageNumbers, container, options = {}) {
  await container.__pdfCleanup?.();
  const pdf = await pdfjs.getDocument({
    url: new URL(source, location.href).href,
    cMapUrl: new URL("./vendor/pdfjs/cmaps/", import.meta.url).href,
    cMapPacked: true,
    standardFontDataUrl: new URL("./vendor/pdfjs/standard_fonts/", import.meta.url).href,
    useWorkerFetch: false
  }).promise;
  let pageNumbersToShow=options.allPages?Array.from({length:pdf.numPages},(_,index)=>index+1):pageNumbers;
  pageNumbersToShow=[...new Set(pageNumbersToShow)].filter(number=>Number.isInteger(number)&&number>=1&&number<=pdf.numPages);
  const hits=new Set(options.hitPages||[]),viewerId=options.viewerId||`pdf-${Date.now()}`;
  const pageNodes=[];
  for(const pageNumber of pageNumbersToShow){
    const page=await pdf.getPage(pageNumber);
    const base=page.getViewport({scale:1});
    const width=Math.max(180,(container.clientWidth||600)-22);
    const cssScale=Math.min(1.5,width/base.width);
    const viewport=page.getViewport({scale:cssScale});
    const wrapper=document.createElement("section");
    wrapper.className=`pdf-page-item${hits.has(pageNumber)?" is-hit":""}`;
    wrapper.id=`${viewerId}-page-${pageNumber}`;
    wrapper.dataset.page=String(pageNumber);
    wrapper.dataset.aspectRatio=`${viewport.width} / ${viewport.height}`;
    const label=document.createElement("p");label.className="pdf-page-label";
    label.textContent=hits.has(pageNumber)?`${pageNumber}ページ · 企画名ヒット`: `${pageNumber}ページ`;
    const placeholder=document.createElement("div");placeholder.className="pdf-page-placeholder";
      placeholder.style.aspectRatio=wrapper.dataset.aspectRatio;
    placeholder.textContent="ページを表示します";
    wrapper.append(label,placeholder);container.append(wrapper);pageNodes.push(wrapper);
  }
  let disposed=false;
  const tasks=new Map();
  const renderPage=async wrapper=>{
    if(disposed||wrapper.dataset.rendered==="true"||tasks.has(wrapper))return;
    const page=await pdf.getPage(Number(wrapper.dataset.page));
    if(disposed||wrapper.dataset.visible!=="true")return;
    const width=Math.max(180,(container.clientWidth||600)-22);
    const base=page.getViewport({scale:1});
    const cssScale=Math.min(1.5,width/base.width);
    const viewport=page.getViewport({scale:cssScale});
    const outputScale=Math.min(window.devicePixelRatio||1,1.75);
    const canvas=document.createElement("canvas");canvas.className="pdf-page-canvas";
    canvas.width=Math.ceil(viewport.width*outputScale);canvas.height=Math.ceil(viewport.height*outputScale);
    canvas.style.width=`${viewport.width}px`;canvas.style.height=`${viewport.height}px`;
    const task=page.render({canvasContext:canvas.getContext("2d"),viewport,transform:[outputScale,0,0,outputScale,0,0]});
    tasks.set(wrapper,task);
    try{
      await task.promise;
      if(!disposed&&wrapper.isConnected&&wrapper.dataset.visible==="true"){
        wrapper.querySelector(".pdf-page-placeholder")?.remove();wrapper.append(canvas);wrapper.dataset.rendered="true";
      }else{canvas.width=0;canvas.height=0;}
    }catch(error){
      if(error?.name!=="RenderingCancelledException")throw error;
      if(!disposed&&wrapper.dataset.visible==="true")queueMicrotask(()=>renderPage(wrapper).catch(console.warn));
    }finally{tasks.delete(wrapper);}
  };
  const releasePage=wrapper=>{
    tasks.get(wrapper)?.cancel();
    if(wrapper.dataset.rendered==="true"){
      const canvas=wrapper.querySelector("canvas");if(canvas){canvas.width=0;canvas.height=0;canvas.remove();}
      wrapper.dataset.rendered="false";
      const placeholder=document.createElement("div");placeholder.className="pdf-page-placeholder";
      placeholder.style.aspectRatio=wrapper.dataset.aspectRatio;placeholder.textContent="ページを表示します";wrapper.append(placeholder);
    }
  };
  let observer;
  if("IntersectionObserver" in window){
    observer=new IntersectionObserver(entries=>entries.forEach(entry=>{
      const wrapper=entry.target;wrapper.dataset.visible=String(entry.isIntersecting);
      if(entry.isIntersecting)renderPage(wrapper).catch(error=>{wrapper.querySelector(".pdf-page-placeholder")?.replaceChildren(document.createTextNode("このページを表示できませんでした"));console.warn(error);});
      else releasePage(wrapper);
    }),{root:null,rootMargin:"0px 900px"});
    pageNodes.forEach(node=>observer.observe(node));
  }else{
    for(const node of pageNodes){node.dataset.visible="true";await renderPage(node);}
  }
  const cleanup=async()=>{disposed=true;observer?.disconnect();tasks.forEach(task=>task.cancel());container.querySelectorAll("canvas").forEach(canvas=>{canvas.width=0;canvas.height=0;});await pdf.destroy();};
  container.__pdfCleanup=cleanup;
  return cleanup;
}

window.FestivalPdfImportReady = Promise.resolve({ extractPowerSheet, inspectPdf, renderPdfPages });
