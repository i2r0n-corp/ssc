'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── ZIP read/write ────────────────────────────────────────────────────────────

function readZip(buf) {
  const entries = {};
  let offset = 0;
  while (offset < buf.length - 4) {
    if (buf[offset]===0x50 && buf[offset+1]===0x4B && buf[offset+2]===0x03 && buf[offset+3]===0x04) {
      const compMethod = buf.readUInt16LE(offset + 8);
      const compSize   = buf.readUInt32LE(offset + 18);
      const nameLen    = buf.readUInt16LE(offset + 26);
      const extraLen   = buf.readUInt16LE(offset + 28);
      const name       = buf.slice(offset + 30, offset + 30 + nameLen).toString('utf8');
      const dataStart  = offset + 30 + nameLen + extraLen;
      const compData   = buf.slice(dataStart, dataStart + compSize);
      entries[name] = compMethod === 8 ? zlib.inflateRawSync(compData) : Buffer.from(compData);
      offset = dataStart + compSize;
    } else { offset++; }
  }
  return entries;
}

function writeZipBuffer(files) {
  function crc32(buf) {
    const t = new Uint32Array(256);
    for (let i=0;i<256;i++){let c=i;for(let j=0;j<8;j++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);t[i]=c;}
    let crc=0xFFFFFFFF;
    for(let i=0;i<buf.length;i++) crc=t[(crc^buf[i])&0xFF]^(crc>>>8);
    return (crc^0xFFFFFFFF)>>>0;
  }
  function u16(n){const b=Buffer.alloc(2);b.writeUInt16LE(n>>>0,0);return b;}
  function u32(n){const b=Buffer.alloc(4);b.writeUInt32LE(n>>>0,0);return b;}
  const chunks=[], dir=[];
  let off=0;
  for(const [name,content] of Object.entries(files)){
    const nb=Buffer.from(name,'utf8');
    const db=Buffer.isBuffer(content)?content:Buffer.from(content,'utf8');
    const crc=crc32(db), sz=db.length;
    const lfh=Buffer.concat([Buffer.from([0x50,0x4B,0x03,0x04]),u16(20),u16(0),u16(0),u16(0),u16(0),u32(crc),u32(sz),u32(sz),u16(nb.length),u16(0)]);
    dir.push({nb,crc,sz,off});
    chunks.push(lfh,nb,db);
    off+=lfh.length+nb.length+sz;
  }
  const cdc=[];
  for(const e of dir) cdc.push(Buffer.concat([Buffer.from([0x50,0x4B,0x01,0x02]),u16(20),u16(20),u16(0),u16(0),u16(0),u16(0),u32(e.crc),u32(e.sz),u32(e.sz),u16(e.nb.length),u16(0),u16(0),u16(0),u16(0),u32(0),u32(e.off)]),e.nb);
  const cdBuf=Buffer.concat(cdc);
  const eocd=Buffer.concat([Buffer.from([0x50,0x4B,0x05,0x06]),u16(0),u16(0),u16(dir.length),u16(dir.length),u32(cdBuf.length),u32(off),u16(0)]);
  return Buffer.concat([...chunks,cdBuf,eocd]);
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PHASE_ORDER = ['Prepare','Discover','Explore','Realize','Deploy','Run'];
const ET_ORDER    = ['Max Success Plan','Advanced Success Plan','Enterprise Support','Embedded Launch Activities','Cloud Prepackaged Services'];

// Table layout (EMU) — measured from template
const TABLE_X        = 506781;
const TABLE_Y        = 1080130;
const TABLE_W        = 10765232;  // fixed, never changes
const HEADER_H       = 482208;   // single header row
const SLIDE_H        = 6858000;  // standard widescreen slide height
const AVAIL_H        = Math.round((SLIDE_H - TABLE_Y - HEADER_H) * 0.95);  // −5% safety margin

// Fixed column widths (EMU)
const COL_W = {
  stream:     509736,  // half of template value (1019472 / 2)
  phases:     540000,  // ~2/3 of template value (810822)
  component: 1232132,
  tier:       810822,
  year:       400000,
};

// Cell padding (EMU) — half of 8pt font size (~1.4mm) symmetric on all sides
const PAD_L = 50800, PAD_R = 50800, PAD_T = 50800, PAD_B = 50800;

// Font metrics: 72 Brand 8pt
const FONT_SZ_EMU   = 8 * 12700;          // 101600 EMU
const LINE_H_EMU    = Math.round(FONT_SZ_EMU * 1.2);  // 121920 EMU
const AVG_CHAR_W    = Math.round(FONT_SZ_EMU * 0.50); // 50800 EMU — slightly narrower than 0.55 for safety

// ── XML escape ────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

// ── Run properties ────────────────────────────────────────────────────────────

const RPR_DATA = `<a:rPr lang="en-GB" sz="800" b="0" i="0" u="none" strike="noStrike" dirty="0"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:effectLst/><a:latin typeface="72 Brand" panose="020B0504030603020204" pitchFamily="34" charset="0"/></a:rPr>`;
const RPR_BOLD = `<a:rPr lang="en-GB" sz="1100" b="1" i="0" u="none" strike="noStrike" dirty="0"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:effectLst/><a:latin typeface="72 Brand" panose="020B0504030603020204" pitchFamily="34" charset="0"/></a:rPr>`;
const RPR_HDR  = `<a:rPr lang="en-GB" sz="800" b="1" i="0" u="none" strike="noStrike" dirty="0"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/><a:latin typeface="72 Brand" panose="020B0504030603020204" pitchFamily="34" charset="0"/></a:rPr>`;

// ── Cell builders ─────────────────────────────────────────────────────────────

const TCPR_DATA =
  `<a:tcPr marL="${PAD_L}" marR="${PAD_R}" marT="${PAD_T}" marB="${PAD_B}" anchor="t">` +
  `<a:lnL w="12700" cmpd="sng"><a:noFill/></a:lnL>` +
  `<a:lnR w="12700" cap="flat" cmpd="sng" algn="ctr"><a:noFill/><a:prstDash val="solid"/><a:round/><a:headEnd type="none" w="med" len="med"/><a:tailEnd type="none" w="med" len="med"/></a:lnR>` +
  `<a:lnT w="12700" cap="flat" cmpd="sng" algn="ctr"><a:noFill/><a:prstDash val="solid"/><a:round/><a:headEnd type="none" w="med" len="med"/><a:tailEnd type="none" w="med" len="med"/></a:lnT>` +
  `<a:lnB w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:prstDash val="solid"/><a:round/><a:headEnd type="none" w="med" len="med"/><a:tailEnd type="none" w="med" len="med"/></a:lnB>` +
  `<a:lnTlToBr w="12700" cmpd="sng"><a:noFill/><a:prstDash val="solid"/></a:lnTlToBr>` +
  `<a:lnBlToTr w="12700" cmpd="sng"><a:noFill/><a:prstDash val="solid"/></a:lnBlToTr>` +
  `<a:noFill/></a:tcPr>`;

const TCPR_HDR =
  `<a:tcPr marL="${PAD_L}" marR="${PAD_R}" marT="${PAD_T}" marB="${PAD_B}" anchor="ctr">` +
  `<a:lnL w="12700" cmpd="sng"><a:noFill/></a:lnL>` +
  `<a:lnR w="12700" cap="flat" cmpd="sng" algn="ctr"><a:noFill/><a:prstDash val="solid"/><a:round/><a:headEnd type="none" w="med" len="med"/><a:tailEnd type="none" w="med" len="med"/></a:lnR>` +
  `<a:lnT w="12700" cap="flat" cmpd="sng" algn="ctr"><a:noFill/><a:prstDash val="solid"/><a:round/><a:headEnd type="none" w="med" len="med"/><a:tailEnd type="none" w="med" len="med"/></a:lnT>` +
  `<a:lnB w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:prstDash val="solid"/><a:round/><a:headEnd type="none" w="med" len="med"/><a:tailEnd type="none" w="med" len="med"/></a:lnB>` +
  `<a:lnTlToBr w="12700" cmpd="sng"><a:noFill/><a:prstDash val="solid"/></a:lnTlToBr>` +
  `<a:lnBlToTr w="12700" cmpd="sng"><a:noFill/><a:prstDash val="solid"/></a:lnBlToTr>` +
  `<a:solidFill><a:srgbClr val="003366"/></a:solidFill></a:tcPr>`;

const TCPR_STREAM =
  `<a:tcPr marL="91416" marR="91416" marT="45708" marB="45708" anchor="ctr">` +
  `<a:lnL w="12700" cmpd="sng"><a:noFill/></a:lnL>` +
  `<a:lnR w="12700" cmpd="sng"><a:noFill/></a:lnR>` +
  `<a:lnT w="12700" cap="flat" cmpd="sng" algn="ctr"><a:noFill/><a:prstDash val="solid"/><a:round/><a:headEnd type="none" w="med" len="med"/><a:tailEnd type="none" w="med" len="med"/></a:lnT>` +
  `<a:lnB w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:prstDash val="solid"/><a:round/><a:headEnd type="none" w="med" len="med"/><a:tailEnd type="none" w="med" len="med"/></a:lnB>` +
  `</a:tcPr>`;

const CELL_STREAM_VMERGE =
  `<a:tc vMerge="1"><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-GB"/></a:p></a:txBody>` +
  `<a:tcPr><a:lnT w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:prstDash val="solid"/><a:round/><a:headEnd type="none" w="med" len="med"/><a:tailEnd type="none" w="med" len="med"/></a:lnT></a:tcPr></a:tc>`;

function cellStream(rowSpan) {
  return `<a:tc rowSpan="${rowSpan}">` +
    `<a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-GB"/></a:p></a:txBody>` +
    TCPR_STREAM + `</a:tc>`;
}

function cellData(text, algn) {
  const align = algn || 'l';
  return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>` +
    `<a:p><a:pPr algn="${align}" rtl="0"><a:buNone/></a:pPr>` +
    (text ? `<a:r>${RPR_DATA}<a:t>${esc(text)}</a:t></a:r>` : `<a:endParaRPr lang="en-GB"/>`) +
    `</a:p></a:txBody>${TCPR_DATA}</a:tc>`;
}

function headerCell(text, algn) {
  const align = algn || 'ctr';
  return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>` +
    `<a:p><a:pPr algn="${align}"><a:buNone/></a:pPr>` +
    (text ? `<a:r>${RPR_HDR}<a:t>${esc(text)}</a:t></a:r>` : `<a:endParaRPr lang="en-GB"/>`) +
    `</a:p></a:txBody>${TCPR_HDR}</a:tc>`;
}

const BORDER_LINE_SOLID =
  `<a:solidFill><a:srgbClr val="8696A9"/></a:solidFill>` +
  `<a:prstDash val="solid"/><a:round/>` +
  `<a:headEnd type="none" w="med" len="med"/><a:tailEnd type="none" w="med" len="med"/>`;

function cellYear(text, borderLeft, isHeader) {
  const lnL = borderLeft
    ? `<a:lnL w="19050" cap="flat" cmpd="sng" algn="ctr">${BORDER_LINE_SOLID}</a:lnL>`
    : `<a:lnL w="12700" cmpd="sng"><a:noFill/></a:lnL>`;
  const lnR = `<a:lnR w="12700" cap="flat" cmpd="sng" algn="ctr"><a:noFill/><a:prstDash val="solid"/><a:round/><a:headEnd type="none" w="med" len="med"/><a:tailEnd type="none" w="med" len="med"/></a:lnR>`;
  const fill = isHeader ? `<a:solidFill><a:srgbClr val="003366"/></a:solidFill>` : `<a:noFill/>`;
  const anchor = isHeader ? 'ctr' : 't';
  const rpr = isHeader ? RPR_HDR : RPR_DATA;
  const tcPr =
    `<a:tcPr marL="${PAD_L}" marR="${PAD_R}" marT="${PAD_T}" marB="${PAD_B}" anchor="${anchor}">` +
    lnL + lnR +
    `<a:lnT w="12700" cap="flat" cmpd="sng" algn="ctr"><a:noFill/><a:prstDash val="solid"/><a:round/><a:headEnd type="none" w="med" len="med"/><a:tailEnd type="none" w="med" len="med"/></a:lnT>` +
    `<a:lnB w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:prstDash val="solid"/><a:round/><a:headEnd type="none" w="med" len="med"/><a:tailEnd type="none" w="med" len="med"/></a:lnB>` +
    `<a:lnTlToBr w="12700" cmpd="sng"><a:noFill/><a:prstDash val="solid"/></a:lnTlToBr>` +
    `<a:lnBlToTr w="12700" cmpd="sng"><a:noFill/><a:prstDash val="solid"/></a:lnBlToTr>` +
    fill + `</a:tcPr>`;
  return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>` +
    `<a:p><a:pPr algn="ctr" rtl="0"><a:buNone/></a:pPr>` +
    (text ? `<a:r>${rpr}<a:t>${esc(text)}</a:t></a:r>` : `<a:endParaRPr lang="en-GB"/>`) +
    `</a:p></a:txBody>${tcPr}</a:tc>`;
}

// ── Row height calculation ────────────────────────────────────────────────────

function calcCellHeight(text, colWidth) {
  const textWidth = colWidth - PAD_L - PAD_R;
  const charsPerLine = Math.max(1, Math.floor(textWidth / AVG_CHAR_W));
  const lines = Math.max(1, Math.ceil((text || '').length / charsPerLine));
  return lines * LINE_H_EMU + PAD_T + PAD_B;
}

// ── Stream overlay (rotated floating textbox) ─────────────────────────────────

function buildStreamOverlays(streamBlocks, colW, rowHeights, tableX) {
  const STREAM_CENTER_X = tableX + Math.floor(colW / 2);
  let rowTop = TABLE_Y + HEADER_H;
  return streamBlocks.map((blk, i) => {
    // sum heights of rows in this block
    const blockHeights = rowHeights.slice(blk.rowOffset, blk.rowOffset + blk.rowCount);
    const spanH = blockHeights.reduce((a,b)=>a+b, 0);
    const cx    = spanH;
    const cy    = colW;
    const shapeX  = STREAM_CENTER_X - Math.floor(cx / 2);
    const spanCtrY = rowTop + Math.floor(spanH / 2);
    const shapeY   = spanCtrY - Math.floor(cy / 2);
    rowTop += spanH;
    const id = 200 + i;
    return `<p:sp>` +
      `<p:nvSpPr><p:cNvPr id="${id}" name="StreamLabel${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
      `<p:spPr><a:xfrm rot="16200000"><a:off x="${shapeX}" y="${shapeY}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
      `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
      `<p:txBody>` +
      `<a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0"><a:spAutoFit/></a:bodyPr>` +
      `<a:lstStyle/>` +
      `<a:p><a:pPr algn="ctr"><a:buNone/></a:pPr><a:r>${RPR_BOLD}<a:t>${esc(blk.text)}</a:t></a:r></a:p>` +
      `</p:txBody></p:sp>`;
  }).join('');
}

// ── Column layout calculator ──────────────────────────────────────────────────

function calcLayout(cols, yearCount) {
  // cols: { stream, phases, component, tier, objectives } — booleans
  // yearCount: 0..6
  let used = 0;
  if (cols.stream)    used += COL_W.stream;
  if (cols.phases)    used += COL_W.phases;
  if (cols.component) used += COL_W.component;
  if (cols.tier)      used += COL_W.tier;
  used += yearCount * COL_W.year;
  const objW = Math.max(500000, TABLE_W - used);  // objectives gets the rest, min 500k EMU
  return { objW, yearCount };
}

// ── Build tblGrid XML ─────────────────────────────────────────────────────────

function buildTblGrid(cols, objW, yearCount) {
  let g = '';
  if (cols.stream)    g += `<a:gridCol w="${COL_W.stream}"/>`;
  if (cols.phases)    g += `<a:gridCol w="${COL_W.phases}"/>`;
  if (cols.component) g += `<a:gridCol w="${COL_W.component}"/>`;
  if (cols.tier)      g += `<a:gridCol w="${COL_W.tier}"/>`;
  g += `<a:gridCol w="${objW}"/>`;
  for (let i=0; i<yearCount; i++) g += `<a:gridCol w="${COL_W.year}"/>`;
  return `<a:tblGrid>${g}</a:tblGrid>`;
}

// ── Build header rows XML ─────────────────────────────────────────────────────

function buildHeaderRows(cols, objW, yearCount, yearFrom, yearBorders) {
  const ROW_H = 482208;
  let cells = '';
  if (cols.stream)    cells += headerCell('Stream');
  if (cols.phases)    cells += headerCell('Activate Phase');
  if (cols.component) cells += headerCell('Service Component');
  if (cols.tier)      cells += headerCell('Tier');
  cells += headerCell('Objectives');
  for (let i = 0; i < yearCount; i++) {
    cells += yearBorders
      ? cellYear(String(yearFrom + i), true, true)
      : headerCell(String(yearFrom + i));
  }
  return `<a:tr h="${ROW_H}">${cells}</a:tr>`;
}

// ── Build data rows XML ───────────────────────────────────────────────────────

function buildDataRows(dataRows, cols, objW, yearCount, yearBorders) {
  return dataRows.map(dr => {
    let cells = '';
    if (cols.stream) {
      cells += dr.isStreamStart ? cellStream(dr.streamRowSpan) : CELL_STREAM_VMERGE;
    }
    if (cols.phases)    cells += cellData(dr.phases);
    if (cols.component) cells += cellData(dr.component);
    if (cols.tier)      cells += cellData(dr.tier);
    cells += cellData(dr.objectives);
    for (let i=0; i<yearCount; i++) {
      cells += yearBorders ? cellYear('', true, false) : cellData('', 'ctr');
    }
    return `<a:tr h="${dr.rowH}">${cells}</a:tr>`;
  }).join('');
}

// ── Slide XML builder ─────────────────────────────────────────────────────────

function buildSlideXml(templateSlideXml, dataRows, slideTitle, streamBlocks, cols, objW, yearCount, yearFrom, yearBorders) {
  let xml = templateSlideXml;

  // 1. Replace title — match the title placeholder by ph type="title", then replace its <a:t> text
  xml = xml.replace(
    /(name="Title 3"[\s\S]*?<p:ph type="title"[\s\S]*?<a:t>)([^<]*?)(<\/a:t>)/,
    `$1${esc(slideTitle)}$3`
  );

  // 2. Strip think-cell artifacts
  xml = xml.replace(/<p:graphicFrame>[\s\S]*?think-cell data[\s\S]*?<\/p:graphicFrame>/g, '');
  xml = xml.replace(/<p:sp>[\s\S]*?name="TextBox 2"[\s\S]*?<\/p:sp>/g, '');
  xml = xml.replace(/<p:custDataLst>[\s\S]*?<\/p:custDataLst>/g, '');

  // 3. Replace entire table content (tblGrid + all rows)
  const tblGridStart = xml.indexOf('<a:tblGrid>');
  const tblGridEnd   = xml.indexOf('</a:tblGrid>') + 12;
  const tblEnd       = xml.indexOf('</a:tbl>');

  const rowHeights = dataRows.map(r => r.rowH);
  const totalDataH = rowHeights.reduce((a,b)=>a+b, 0);
  const tableCy    = HEADER_H + totalDataH;

  const newGrid    = buildTblGrid(cols, objW, yearCount);
  const headerRows = buildHeaderRows(cols, objW, yearCount, yearFrom, yearBorders);
  const dataRowXml = buildDataRows(dataRows, cols, objW, yearCount, yearBorders);

  xml = xml.slice(0, tblGridStart) + newGrid + headerRows + dataRowXml + xml.slice(tblEnd);

  // 4. Fix table frame dimensions — width always TABLE_W, height = computed
  xml = xml.replace(
    /(<p:xfrm>[\s\S]*?<a:ext cx=")[^"]*(" cy=")[^"]*(")/,
    `$1${TABLE_W}$2${tableCy}$3`
  );

  // 5. Stream overlays (only if stream column visible)
  if (cols.stream && streamBlocks && streamBlocks.length > 0) {
    const overlays = buildStreamOverlays(streamBlocks, COL_W.stream, rowHeights, TABLE_X);
    xml = xml.replace('</p:spTree>', overlays + '</p:spTree>');
  }

  return xml;
}

// ── Core generator ────────────────────────────────────────────────────────────

/**
 * @param {object[]} services
 * @param {object}   opts
 * @param {string}   opts.templateFile
 * @param {string}   opts.title
 * @param {boolean}  opts.groupByET
 * @param {string}   opts.bsCode
 * @param {boolean}  opts.useDeckName
 * @param {number}   opts.yearFrom    — 0 = no years
 * @param {number}   opts.yearTo
 * @param {object}   opts.cols        — { stream, phases, component, tier, objectives }
 */
function generateListPptxBuffer(services, opts = {}) {
  const templateFile = opts.templateFile || path.join(__dirname, '..', 'data', 'ListTemplate.pptx');
  const title    = opts.title || 'Services Description';
  const groupET  = !!opts.groupByET;
  const bsCode   = opts.bsCode || null;
  const useDeck  = !!opts.useDeckName;
  const streamMode   = opts.streamMode || (bsCode ? 'bsAndModule' : 'moduleOnly');
  const streamCustom = (opts.streamCustom || '').slice(0, 64);
  const truncateObj  = !!opts.truncateObjectives;
  const bsName       = opts.bsName || '';
  const yearBorders  = !!opts.yearBorders;

  // Column visibility — all on by default
  const cols = {
    stream:    opts.cols ? !!opts.cols.stream    : true,
    phases:    opts.cols ? !!opts.cols.phases    : true,
    component: opts.cols ? !!opts.cols.component : true,
    tier:      opts.cols ? !!opts.cols.tier      : false,
    objectives:opts.cols ? !!opts.cols.objectives: true,
  };

  // Year range — 0 yearCount means no year columns
  const yf = parseInt(opts.yearFrom, 10);
  const yt  = parseInt(opts.yearTo, 10);
  const yearFrom  = (yf >= 2000 && yf <= 2050) ? yf : 0;
  const yearTo    = (yt >= 2000 && yt <= 2050) ? yt : 0;
  const yearCount = (yearFrom && yearTo && yearFrom <= yearTo) ? Math.min(6, yearTo - yearFrom + 1) : 0;

  if (!fs.existsSync(templateFile)) throw new Error('ListTemplate.pptx not found: ' + templateFile);

  // Column widths
  const { objW } = calcLayout(cols, yearCount);

  // ── Parse services into modules ───────────────────────────────────────────
  const moduleMap = new Map();
  for (const svc of services) {
    const key = svc.parent_name || svc.parent_code || '__none__';
    if (!moduleMap.has(key)) moduleMap.set(key, { name: key, services: [] });
    moduleMap.get(key).services.push(svc);
  }
  const modules = [...moduleMap.values()];

  if (groupET) {
    for (const mod of modules) {
      mod.services.sort((a,b) => {
        const ai = ET_ORDER.indexOf(a.engagement_type), bi = ET_ORDER.indexOf(b.engagement_type);
        return (ai<0?99:ai) - (bi<0?99:bi);
      });
    }
  }

  function getObjectives(svc) {
    const et = svc.engagement_type || '';
    let text = '';
    if (et.includes('Max'))            text = svc.key_benefits || svc.keyBenefits || svc.short_description || '';
    else if (et.includes('Advanced'))  text = svc.summary      || svc.short_description || '';
    else                               text = svc.description  || svc.short_description || '';
    // Truncate to 3 sentences only for EGI-named Foundational services — applied after stripHtml
    const isFoundational = !et.includes('Max') && !et.includes('Advanced');
    const isEGI = (svc.name || '').toUpperCase().startsWith('EGI');
    if (truncateObj && text && isFoundational && isEGI) {
      const clean = stripHtml(text);
      // Split on sentence-ending punctuation followed by whitespace or end-of-string
      const parts = clean.split(/(?<=[.!?])\s+/);
      text = parts.slice(0, 3).join(' ').trim();
      return text;
    }
    return text;
  }

  function getStreamText(modName, bsName) {
    if (streamMode === 'custom' || streamMode === 'customNoBS') return streamCustom || modName;
    if (streamMode === 'moduleOnly') {
      // Full string format: "BS Name // Module N: Actual Module Name"
      // Extract the part after " // ", then strip the "Module N: " prefix if present
      const sepIdx = modName.indexOf(' // ');
      const afterSep = sepIdx !== -1 ? modName.slice(sepIdx + 4) : modName;
      // Strip leading "Module <digits/chars>: " prefix
      return afterSep.replace(/^Module\s+[^:]+:\s*/i, '');
    }
    // bsAndModule: full string as-is
    return modName;
  }

  function stripHtml(s) {
    return (s||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
  }

  function getSvcRow(svc, streamText, isStreamStart, streamRowSpan) {
    const name = useDeck && bsCode && svc.business_scenario_naming?.[bsCode]
      ? svc.business_scenario_naming[bsCode] : (svc.name || '');
    const phases = (svc.phases||[]).slice().sort((a,b)=>PHASE_ORDER.indexOf(a)-PHASE_ORDER.indexOf(b));
    const allPhases = PHASE_ORDER.every(p => phases.includes(p));
    const phasesText = allPhases ? 'All' : phases.join(', ');
    const objText = cols.objectives ? stripHtml(getObjectives(svc)) : '';
    const tierLabel = (svc.engagement_type || '').includes('Enterprise Support')
      ? 'Foundational'
      : (ET_LABEL[svc.engagement_type] || svc.engagement_type || '');

    // Row height = max across all columns that can wrap
    const minH = LINE_H_EMU + PAD_T + PAD_B;
    let rowH = minH;
    if (cols.phases)    rowH = Math.max(rowH, calcCellHeight(phasesText,  COL_W.phases));
    if (cols.component) rowH = Math.max(rowH, calcCellHeight(name,         COL_W.component));
    if (cols.objectives)rowH = Math.max(rowH, calcCellHeight(objText,      objW));

    return {
      isStreamStart, streamRowSpan, streamText,
      phases:    phasesText,
      component: name,
      tier:      tierLabel,
      objectives: objText,
      rowH,
    };
  }

  // ── Load template ─────────────────────────────────────────────────────────
  const templateBuf   = fs.readFileSync(templateFile);
  const templateFiles = readZip(templateBuf);
  const templateSlide = templateFiles['ppt/slides/slide1.xml'].toString('utf8');

  const outFiles = {};
  const SKIP = new Set(['ppt/presentation.xml','ppt/_rels/presentation.xml.rels','[Content_Types].xml']);

  for (const [name, data] of Object.entries(templateFiles)) {
    if (/^ppt\/slides\//.test(name))       continue;
    if (/^ppt\/notesSlides\//.test(name))  continue;
    if (/^ppt\/notesMasters\//.test(name)) continue;
    if (/^ppt\/changesInfos\//.test(name)) continue;
    if (/^ppt\/tags\//.test(name))         continue;
    if (/^ppt\/embeddings\//.test(name))   continue;
    if (/\.emf$/.test(name))               continue;
    if (SKIP.has(name))                    continue;

    if (name === 'ppt/slideMasters/slideMaster1.xml') {
      let xml = data.toString('utf8');
      xml = xml.replace(/<p:graphicFrame>[\s\S]*?think-cell[\s\S]*?<\/p:graphicFrame>/g, '');
      xml = xml.replace(/<p:custDataLst>[\s\S]*?<\/p:custDataLst>/g, '');
      outFiles[name] = xml; continue;
    }
    if (name === 'ppt/slideMasters/_rels/slideMaster1.xml.rels') {
      let xml = data.toString('utf8');
      xml = xml.replace(/<Relationship [^>]*\/relationships\/tags[^>]*\/>/g, '');
      xml = xml.replace(/<Relationship [^>]*\/relationships\/oleObject[^>]*\/>/g, '');
      xml = xml.replace(/<Relationship [^>]*\/relationships\/image[^>]*\/>/g, '');
      outFiles[name] = xml; continue;
    }
    if (/^ppt\/slideLayouts\/_rels\//.test(name)) {
      let xml = data.toString('utf8');
      xml = xml.replace(/<Relationship [^>]*\/relationships\/tags[^>]*\/>/g, '');
      xml = xml.replace(/<Relationship [^>]*notesMaster[^>]*\/>/g, '');
      xml = xml.replace(/<Relationship [^>]*image6\.png[^>]*\/>/g, '');
      outFiles[name] = xml; continue;
    }
    outFiles[name] = data;
  }

  // ── Paginate and build slides ─────────────────────────────────────────────
  let slideNum = 0;

  for (const mod of modules) {
    // Pack rows onto slides — each module starts a new slide
    let pageRows = [];
    let pageH    = 0;

    function flushSlide(rows) {
      if (rows.length === 0) return;
      slideNum++;
      const streamText = getStreamText(mod.name, bsName);
      // Assign rowSpan for the stream block on this slide
      if (cols.stream) rows[0].isStreamStart = true;
      if (cols.stream) rows[0].streamRowSpan = rows.length;
      const streamBlocks = cols.stream
        ? [{ text: streamText, rowOffset: 0, rowCount: rows.length }]
        : [];
      outFiles[`ppt/slides/slide${slideNum}.xml`] = buildSlideXml(
        templateSlide, rows, title, streamBlocks, cols, objW, yearCount, yearFrom, yearBorders
      );
      outFiles[`ppt/slides/_rels/slide${slideNum}.xml.rels`] =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
        `</Relationships>`;
    }

    for (const svc of mod.services) {
      const streamText = getStreamText(mod.name, bsName);
      const row = getSvcRow(svc, streamText, false, 1);
      if (pageRows.length > 0 && pageH + row.rowH > AVAIL_H) {
        flushSlide(pageRows);
        pageRows = [];
        pageH    = 0;
      }
      pageRows.push(row);
      pageH += row.rowH;
    }
    flushSlide(pageRows);
  }

  const N = slideNum;

  // ── Rebuild presentation.xml ──────────────────────────────────────────────
  const origPres     = templateFiles['ppt/presentation.xml'].toString('utf8');
  const origPresRels = templateFiles['ppt/_rels/presentation.xml.rels'].toString('utf8');

  const keepRels = [];
  let relId = 1;
  for (const m of origPresRels.matchAll(/<Relationship ([^>]+)\/>/g)) {
    const attrs = m[1];
    if (attrs.includes('relationships/slide"')) continue;
    if (attrs.includes('notesMaster'))          continue;
    if (attrs.includes('changesInfo'))          continue;
    keepRels.push(`<Relationship ${attrs.replace(/Id="[^"]*"/, `Id="rId${relId++}"`)}/>`);
  }
  const slideRelIdStart = relId;
  const slideRels = Array.from({length:N},(_,i)=>
    `<Relationship Id="rId${slideRelIdStart+i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i+1}.xml"/>`
  ).join('');

  outFiles['ppt/_rels/presentation.xml.rels'] =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    keepRels.join('') + slideRels + `</Relationships>`;

  const smRel = keepRels.find(r => r.includes('slideMaster'));
  const smRid = smRel && smRel.match(/Id="(rId\d+)"/)[1];
  let presXml = origPres;
  if (smRid) presXml = presXml.replace(/<p:sldMasterId[^>]*r:id="[^"]*"/, m => m.replace(/r:id="[^"]*"/, `r:id="${smRid}"`));
  presXml = presXml.replace(/<p:notesMasterIdLst>[\s\S]*?<\/p:notesMasterIdLst>/g, '');
  const sldIdLst = Array.from({length:N},(_,i)=>`<p:sldId id="${256+i}" r:id="rId${slideRelIdStart+i}"/>`).join('');
  presXml = presXml.replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, `<p:sldIdLst>${sldIdLst}</p:sldIdLst>`);
  outFiles['ppt/presentation.xml'] = presXml;

  // ── Rebuild [Content_Types].xml ───────────────────────────────────────────
  const origCt = templateFiles['[Content_Types].xml'].toString('utf8');
  const slideCtypes = Array.from({length:N},(_,i)=>
    `<Override PartName="/ppt/slides/slide${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
  ).join('');
  outFiles['[Content_Types].xml'] = origCt
    .replace(/<Override PartName="\/ppt\/slides\/[^"]*"[^>]*\/>/g, '')
    .replace(/<Override PartName="\/ppt\/notesSlides\/[^"]*"[^>]*\/>/g, '')
    .replace(/<Override PartName="\/ppt\/notesMasters\/[^"]*"[^>]*\/>/g, '')
    .replace(/<Override PartName="\/ppt\/changesInfos\/[^"]*"[^>]*\/>/g, '')
    .replace(/<Override PartName="\/ppt\/tags\/[^"]*"[^>]*\/>/g, '')
    .replace(/<Override PartName="\/ppt\/embeddings\/[^"]*"[^>]*\/>/g, '')
    .replace(/<Default Extension="bin"[^>]*\/>/g, '')
    .replace(/<Default Extension="emf"[^>]*\/>/g, '')
    .replace('</Types>', slideCtypes + '</Types>');

  return writeZipBuffer(outFiles);
}

const ET_LABEL = {'Max Success Plan':'Max','Advanced Success Plan':'Advanced','Enterprise Support':'Foundational','Embedded Launch Activities':'Foundational','Cloud Prepackaged Services':'Foundational'};

module.exports = { generateListPptxBuffer };

// ── CLI ───────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  function getArg(n) { const i = args.indexOf(n); return i !== -1 ? args[i+1] : null; }
  function hasFlag(n) { return args.includes(n); }

  const templateFile = getArg('--template') || path.join(__dirname, '..', 'data', 'ListTemplate.pptx');
  const dataFile   = getArg('--data')  || path.join(__dirname, 'sample_services.json');
  const outFile    = getArg('--out')   || path.join(__dirname, 'output_list.pptx');
  const title      = getArg('--title') || 'Services Description';
  const groupByET  = hasFlag('--groupByET');
  const bsCode     = getArg('--bsCode') || null;
  const useDeckName = hasFlag('--deckName');
  const yearFrom   = parseInt(getArg('--yearFrom')||'2026', 10);
  const yearTo     = parseInt(getArg('--yearTo')  ||'2030', 10);

  if (!fs.existsSync(dataFile)) { console.error('Data not found:', dataFile); process.exit(1); }
  const services = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  console.log(`Loaded ${services.length} services`);

  const buf = generateListPptxBuffer(services, { templateFile, title, groupByET, bsCode, useDeckName, yearFrom, yearTo });
  fs.writeFileSync(outFile, buf);
  console.log(`Done → ${outFile}`);
}
