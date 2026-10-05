/**
 * PPTX List generator — clones template slide, replaces table rows with service data.
 * No external dependencies.
 *
 * Usage:
 *   node generate_list_pptx.js [options]
 *
 * Options:
 *   --template <path>    Path to ListTemplate.pptx (default: OneDrive path)
 *   --data <path>        Path to services JSON (default: ./sample_services.json)
 *   --out <path>         Output path (default: ./output_list.pptx)
 *   --title <text>       Slide title (default: "Services Description")
 *   --groupByET          Sort within module: Max→Advanced→Foundational
 *   --bsCode <code>      BS code for deck name lookup
 *   --deckName           Use deck names in Service Component column
 */

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

function writeZip(files, outPath) {
  fs.writeFileSync(outPath, writeZipBuffer(files));
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
    const nb  = Buffer.from(name,'utf8');
    const db  = Buffer.isBuffer(content) ? content : Buffer.from(content,'utf8');
    const crc = crc32(db);
    const sz  = db.length;
    const lfh = Buffer.concat([Buffer.from([0x50,0x4B,0x03,0x04]),u16(20),u16(0),u16(0),u16(0),u16(0),u32(crc),u32(sz),u32(sz),u16(nb.length),u16(0)]);
    dir.push({nb,crc,sz,off});
    chunks.push(lfh,nb,db);
    off += lfh.length+nb.length+sz;
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
const ET_LABEL    = {'Max Success Plan':'Max','Advanced Success Plan':'Advanced','Enterprise Support':'Foundational','Embedded Launch Activities':'Foundational','Cloud Prepackaged Services':'Foundational'};
const ROWS_PER_SLIDE = 8;

// Table layout constants (EMU) — measured from template
const TABLE_X          = 506781;
const TABLE_Y          = 1080130;
const STREAM_COL_W     = 1019472;
const HEADER_H         = 893048;  // row0 (410840) + row1 (482208)
const DATA_ROW_H       = 368094;  // height matching template data rows

// ── XML escape ────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

// ── Cell builders — exact XML cloned from template ────────────────────────────
// Every tcPr, every ln element, every attribute is copied verbatim from the
// extracted template cells. Only text content and rowSpan numbers change.

const RPR_DATA = `<a:rPr lang="en-GB" sz="800" b="0" i="0" u="none" strike="noStrike" dirty="0"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:effectLst/><a:latin typeface="72 Brand" panose="020B0504030603020204" pitchFamily="34" charset="0"/></a:rPr>`;
const RPR_DATA_BOLD = `<a:rPr lang="en-GB" sz="1100" b="1" i="0" u="none" strike="noStrike" dirty="0"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:effectLst/><a:latin typeface="72 Brand" panose="020B0504030603020204" pitchFamily="34" charset="0"/></a:rPr>`;

// tcPr for data cell — exact from template
const TCPR_DATA =
  `<a:tcPr marL="9523" marR="9523" marT="9523" marB="0" anchor="ctr">` +
  `<a:lnL w="12700" cmpd="sng"><a:noFill/></a:lnL>` +
  `<a:lnR w="12700" cap="flat" cmpd="sng" algn="ctr"><a:noFill/><a:prstDash val="solid"/><a:round/><a:headEnd type="none" w="med" len="med"/><a:tailEnd type="none" w="med" len="med"/></a:lnR>` +
  `<a:lnT w="12700" cap="flat" cmpd="sng" algn="ctr"><a:noFill/><a:prstDash val="solid"/><a:round/><a:headEnd type="none" w="med" len="med"/><a:tailEnd type="none" w="med" len="med"/></a:lnT>` +
  `<a:lnB w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:prstDash val="solid"/><a:round/><a:headEnd type="none" w="med" len="med"/><a:tailEnd type="none" w="med" len="med"/></a:lnB>` +
  `<a:lnTlToBr w="12700" cmpd="sng"><a:noFill/><a:prstDash val="solid"/></a:lnTlToBr>` +
  `<a:lnBlToTr w="12700" cmpd="sng"><a:noFill/><a:prstDash val="solid"/></a:lnBlToTr>` +
  `<a:noFill/></a:tcPr>`;

// tcPr for stream rowSpan cell — exact from template + anchor="ctr" for vertical centering
const TCPR_STREAM =
  `<a:tcPr marL="91416" marR="91416" marT="45708" marB="45708" anchor="ctr">` +
  `<a:lnL w="12700" cmpd="sng"><a:noFill/></a:lnL>` +
  `<a:lnR w="12700" cmpd="sng"><a:noFill/></a:lnR>` +
  `<a:lnT w="12700" cap="flat" cmpd="sng" algn="ctr"><a:noFill/><a:prstDash val="solid"/><a:round/><a:headEnd type="none" w="med" len="med"/><a:tailEnd type="none" w="med" len="med"/></a:lnT>` +
  `<a:lnB w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:prstDash val="solid"/><a:round/><a:headEnd type="none" w="med" len="med"/><a:tailEnd type="none" w="med" len="med"/></a:lnB>` +
  `</a:tcPr>`;

// vMerge cell for stream continuation — exact from template
const CELL_STREAM_VMERGE =
  `<a:tc vMerge="1"><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-GB"/></a:p></a:txBody>` +
  `<a:tcPr><a:lnT w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:prstDash val="solid"/><a:round/><a:headEnd type="none" w="med" len="med"/><a:tailEnd type="none" w="med" len="med"/></a:lnT></a:tcPr></a:tc>`;

function cellStream(rowSpan) {
  // Stream column: empty cell, borders only — text is overlaid as a rotated floating textbox
  return `<a:tc rowSpan="${rowSpan}">` +
    `<a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-GB"/></a:p></a:txBody>` +
    TCPR_STREAM + `</a:tc>`;
}

function cellData(text) {
  return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>` +
    `<a:p><a:pPr algn="l" rtl="0" fontAlgn="ctr"><a:buNone/></a:pPr>` +
    (text ? `<a:r>${RPR_DATA}<a:t>${esc(text)}</a:t></a:r>` : `<a:endParaRPr lang="en-GB"/>`) +
    `</a:p></a:txBody>${TCPR_DATA}</a:tc>`;
}

// ── Row builder ───────────────────────────────────────────────────────────────

function buildRows(dataRows, yearCount) {
  const nYears = yearCount || 5;
  return dataRows.map(dr => {
    const streamCell = dr.isStreamStart
      ? cellStream(dr.streamRowSpan)
      : CELL_STREAM_VMERGE;
    return `<a:tr h="${DATA_ROW_H}">` +
      streamCell +
      cellData(dr.phases) +
      cellData(dr.component) +
      cellData(dr.objectives) +
      Array(nYears).fill(cellData('')).join('') +
      `</a:tr>`;
  }).join('');
}

// Helper: build a year header cell matching template style
function headerYearCell(yearText) {
  return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>` +
    `<a:p><a:pPr algn="ctr"><a:buNone/></a:pPr>` +
    (yearText ? `<a:r>${RPR_DATA}<a:t>${esc(yearText)}</a:t></a:r>` : `<a:endParaRPr lang="en-GB"/>`) +
    `</a:p></a:txBody>${TCPR_DATA}</a:tc>`;
}

// ── Stream overlay: rotated floating textbox for module label ─────────────────
// Since vert="vert270" is ignored in table cells, we place a separate shape
// rotated 270° (rot=16200000) overlapping the stream column area.
// The shape pivot = shape center, so:
//   cx (unrotated) = visual height of the span = rowCount * DATA_ROW_H
//   cy (unrotated) = visual width = STREAM_COL_W
//   x = center_x_of_stream_col - cx/2
//   y = top_of_span - cy/2 + span_height/2
// Stream column center x ≈ TABLE_X + STREAM_COL_W/2 = 506781 + 509736 = 1016517
// After rotation the visual width becomes cy and visual height becomes cx.

function buildStreamOverlays(streamBlocks) {
  // streamBlocks: [{ text, rowOffset, rowCount }]
  // rowOffset = number of data rows above this block on this slide
  const STREAM_CENTER_X = TABLE_X + Math.floor(STREAM_COL_W / 2); // 1016517
  return streamBlocks.map((blk, i) => {
    const spanH = blk.rowCount * DATA_ROW_H;                    // visual height
    const cx    = spanH;                                         // unrotated cx = visual height
    const cy    = STREAM_COL_W;                                  // unrotated cy = visual width
    const shapeX = STREAM_CENTER_X - Math.floor(cx / 2);
    const spanTopY = TABLE_Y + HEADER_H + blk.rowOffset * DATA_ROW_H;
    const spanCtrY = spanTopY + Math.floor(spanH / 2);
    const shapeY  = spanCtrY - Math.floor(cy / 2);
    const id = 200 + i;
    return `<p:sp>` +
      `<p:nvSpPr>` +
      `<p:cNvPr id="${id}" name="StreamLabel${id}"/>` +
      `<p:cNvSpPr txBox="1"/>` +
      `<p:nvPr/>` +
      `</p:nvSpPr>` +
      `<p:spPr>` +
      `<a:xfrm rot="16200000">` +
      `<a:off x="${shapeX}" y="${shapeY}"/>` +
      `<a:ext cx="${cx}" cy="${cy}"/>` +
      `</a:xfrm>` +
      `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
      `<a:noFill/>` +
      `</p:spPr>` +
      `<p:txBody>` +
      `<a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0"><a:spAutoFit/></a:bodyPr>` +
      `<a:lstStyle/>` +
      `<a:p>` +
      `<a:pPr algn="ctr"><a:buNone/></a:pPr>` +
      `<a:r>${RPR_DATA_BOLD}<a:t>${esc(blk.text)}</a:t></a:r>` +
      `</a:p>` +
      `</p:txBody>` +
      `</p:sp>`;
  }).join('');
}

// ── Slide XML: replace rows in template slide ─────────────────────────────────

function buildSlideXml(templateSlideXml, dataRows, slideTitle, streamBlocks, yearRange) {
  const [yearFrom, yearTo] = yearRange || [2026, 2030];
  const yearCount   = yearTo - yearFrom + 1;    // total year cols we want
  const extraCols   = Math.max(0, yearCount - 3); // template has 3 year cols (2027/2028/2029)
  let xml = templateSlideXml;

  // 1. Replace title text
  xml = xml.replace(
    /(<p:cNvPr[^>]*name="Title 3"[^>]*\/>[\s\S]*?<a:t>)([^<]*)(<\/a:t>)/,
    `$1${esc(slideTitle)}$3`
  );

  // 2. Replace all rows (after </a:tblGrid>) with our generated rows
  //    Keep header rows 0 and 1 from template, replace rows 2+ with our data
  const gridEnd = xml.indexOf('</a:tblGrid>') + 12;
  const tblEnd  = xml.indexOf('</a:tbl>');

  // Extract header rows (first 2 <a:tr> blocks)
  let pos = gridEnd, headerRows = '';
  for (let i = 0; i < 2; i++) {
    const rs = xml.indexOf('<a:tr ', pos);
    if (rs < 0) break;
    const re = xml.indexOf('</a:tr>', rs) + 7;
    headerRows += xml.slice(rs, re);
    pos = re;
  }

  // Rebuild: everything before rows + header rows + our data rows + close
  xml = xml.slice(0, gridEnd) + headerRows + buildRows(dataRows, yearCount) + xml.slice(tblEnd);

  // 3. Expand year columns: template has 3 (2027/2028/2029)
  //    3a. Add extra gridCol entries
  if (extraCols > 0) {
    const extra = Array(extraCols).fill('<a:gridCol w="516700"/>').join('');
    xml = xml.replace(/(<\/a:tblGrid>)/, extra + '$1');
  }

  // 3b. Relabel template year cells to start from yearFrom
  xml = xml.replace(/>2027</g, `>${yearFrom}<`)
           .replace(/>2028</g, `>${yearFrom+1}<`)
           .replace(/>2029</g, `>${yearFrom+2}<`);

  // 3c. Add remaining year cells to header row 1
  if (extraCols > 0) {
    const extraYearCells = Array.from({length:extraCols},(_,i) => headerYearCell(String(yearFrom+3+i))).join('');
    xml = xml.replace(/((?:>${yearFrom}<|>${yearFrom+1}<|>${yearFrom+2}<)[\s\S]*?<\/a:tr>)/, m =>
      m.replace('</a:tr>', extraYearCells + '</a:tr>')
    );
  }

  // 3d. Add extra blank cells to header row 0
  if (extraCols > 0) {
    let p = xml.indexOf('</a:tblGrid>') + 12;
    const r0s = xml.indexOf('<a:tr ', p);
    const r0e = xml.indexOf('</a:tr>', r0s) + 7;
    const blanks = Array(extraCols).fill(headerYearCell('')).join('');
    const patchedR0 = xml.slice(r0s, r0e).replace('</a:tr>', blanks + '</a:tr>');
    xml = xml.slice(0, r0s) + patchedR0 + xml.slice(r0e);
  }

  // 4. Fix table graphicFrame dimensions
  const actualTableCx = 10765232 + extraCols * 516700;
  const actualTableCy = HEADER_H + dataRows.length * DATA_ROW_H;
  xml = xml.replace(/(<p:xfrm>[\s\S]*?<a:ext cx=")10765232(" cy=")[^"]*(")/,
    `$1${actualTableCx}$2${actualTableCy}$3`);

  // 4. Remove think-cell graphicFrame
  xml = xml.replace(/<p:graphicFrame>[\s\S]*?think-cell data[\s\S]*?<\/p:graphicFrame>/g, '');

  // 4. Remove "Business as usual" textbox (TextBox 2) and any custDataLst on shapes
  xml = xml.replace(/<p:sp>[\s\S]*?name="TextBox 2"[\s\S]*?<\/p:sp>/g, '');
  xml = xml.replace(/<p:custDataLst>[\s\S]*?<\/p:custDataLst>/g, '');

  // 5. Inject stream overlay textboxes before </p:spTree>
  if (streamBlocks && streamBlocks.length > 0) {
    const overlays = buildStreamOverlays(streamBlocks);
    xml = xml.replace('</p:spTree>', overlays + '</p:spTree>');
  }

  return xml;
}

// ── Core generator (usable as library) ───────────────────────────────────────

/**
 * Generate a PPTX list from service data and return the file as a Buffer.
 *
 * @param {object[]} services  - Array of service objects (same shape as the JSON data file)
 * @param {object}   opts      - Options (all optional)
 * @param {string}   opts.templateFile - Path to ListTemplate.pptx
 * @param {string}   opts.title        - Slide title
 * @param {boolean}  opts.groupByET    - Sort within module by ET order
 * @param {string}   opts.bsCode       - BS code for deck name lookup
 * @param {boolean}  opts.useDeckName  - Use deck names in component column
 * @param {number[]} opts.yearRange    - [fromYear, toYear] — override default 2026-2030
 * @returns {Buffer} PPTX file buffer
 */
function generateListPptxBuffer(services, opts = {}) {
  const templateFile = opts.templateFile ||
    'C:/Users/I306380/OneDrive - SAP SE/_SC/Manuals&Processes/Skills/SSCI/ListTemplate.pptx';
  const title    = opts.title || 'Services Description';
  const groupET  = !!opts.groupByET;
  const bsCode   = opts.bsCode || null;
  const useDeck  = !!opts.useDeckName;
  const yearRange = opts.yearRange || [2026, 2030];

  if (!fs.existsSync(templateFile)) throw new Error('ListTemplate.pptx not found: ' + templateFile);

  // Group by module
  const moduleMap = new Map();
  for (const svc of services) {
    const key = svc.parent_code || '__none__';
    if (!moduleMap.has(key)) moduleMap.set(key, { name: svc.parent_name || key, services: [] });
    moduleMap.get(key).services.push(svc);
  }
  const modules = [...moduleMap.values()];

  if (groupET) {
    for (const mod of modules) {
      mod.services.sort((a,b) => {
        const ai = ET_ORDER.indexOf(a.engagement_type), bi = ET_ORDER.indexOf(b.engagement_type);
        return (ai<0?99:ai)-(bi<0?99:bi);
      });
    }
  }

  function getSvcRow(svc, streamText, isStreamStart, streamRowSpan) {
    const name = useDeck && bsCode && svc.business_scenario_naming?.[bsCode]
      ? svc.business_scenario_naming[bsCode] : svc.name;
    const phases = (svc.phases||[]).sort((a,b)=>PHASE_ORDER.indexOf(a)-PHASE_ORDER.indexOf(b));
    const allPhases = phases.length === PHASE_ORDER.length;
    return {
      isStreamStart,
      streamRowSpan,
      streamText,
      phases:     allPhases ? 'All' : phases.join(', '),
      component:  name,
      objectives: svc.short_description || '',
    };
  }

  // Build slides
  const templateBuf   = fs.readFileSync(templateFile);
  const templateFiles = readZip(templateBuf);
  const templateSlide = templateFiles['ppt/slides/slide1.xml'].toString('utf8');

  const outFiles = {};
  const SKIP = new Set(['ppt/presentation.xml','ppt/_rels/presentation.xml.rels','[Content_Types].xml']);
  for (const [name, data] of Object.entries(templateFiles)) {
    if (/^ppt\/slides\//.test(name)) continue;
    if (/^ppt\/notesSlides\//.test(name)) continue;
    if (/^ppt\/notesMasters\//.test(name)) continue;
    if (/^ppt\/changesInfos\//.test(name)) continue;
    if (/^ppt\/tags\//.test(name)) continue;
    if (/^ppt\/embeddings\//.test(name)) continue;
    if (/\.emf$/.test(name)) continue;
    if (SKIP.has(name)) continue;

    if (name === 'ppt/slideMasters/slideMaster1.xml') {
      let xml = data.toString('utf8');
      xml = xml.replace(/<p:graphicFrame>[\s\S]*?think-cell[\s\S]*?<\/p:graphicFrame>/g, '');
      xml = xml.replace(/<p:custDataLst>[\s\S]*?<\/p:custDataLst>/g, '');
      outFiles[name] = xml;
      continue;
    }

    if (name === 'ppt/slideMasters/_rels/slideMaster1.xml.rels') {
      let xml = data.toString('utf8');
      xml = xml.replace(/<Relationship [^>]*\/relationships\/tags[^>]*\/>/g, '');
      xml = xml.replace(/<Relationship [^>]*\/relationships\/oleObject[^>]*\/>/g, '');
      xml = xml.replace(/<Relationship [^>]*\/relationships\/image[^>]*\/>/g, '');
      outFiles[name] = xml;
      continue;
    }

    if (/^ppt\/slideLayouts\/_rels\//.test(name)) {
      let xml = data.toString('utf8');
      xml = xml.replace(/<Relationship [^>]*\/relationships\/tags[^>]*\/>/g, '');
      xml = xml.replace(/<Relationship [^>]*notesMaster[^>]*\/>/g, '');
      xml = xml.replace(/<Relationship [^>]*image6\.png[^>]*\/>/g, '');
      outFiles[name] = xml;
      continue;
    }

    outFiles[name] = data;
  }

  // Generate one slide per module page
  const slideCount = { n: 0 };
  for (const mod of modules) {
    for (let i = 0; i < mod.services.length; i += ROWS_PER_SLIDE) {
      const page = mod.services.slice(i, i + ROWS_PER_SLIDE);
      const dataRows = page.map((svc, idx) =>
        getSvcRow(svc, mod.name, idx === 0, page.length)
      );
      const streamBlocks = [{ text: mod.name, rowOffset: 0, rowCount: page.length }];
      const slideNum = ++slideCount.n;
      outFiles[`ppt/slides/slide${slideNum}.xml`] = buildSlideXml(templateSlide, dataRows, title, streamBlocks, yearRange);
      outFiles[`ppt/slides/_rels/slide${slideNum}.xml.rels`] =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
        `</Relationships>`;
    }
  }

  const N = slideCount.n;

  // Rebuild presentation.xml — keep template's master/theme/props rels, replace slide list
  const origPres     = templateFiles['ppt/presentation.xml'].toString('utf8');
  const origPresRels = templateFiles['ppt/_rels/presentation.xml.rels'].toString('utf8');

  const keepRels = [];
  let relId = 1;
  for (const m of origPresRels.matchAll(/<Relationship ([^>]+)\/>/g)) {
    const attrs = m[1];
    if (attrs.includes('relationships/slide"')) continue;
    if (attrs.includes('notesMaster')) continue;
    if (attrs.includes('changesInfo')) continue;
    keepRels.push(`<Relationship ${attrs.replace(/Id="[^"]*"/, `Id="rId${relId++}"`)}/>`);
  }
  const slideRelIdStart = relId;
  const slideRels = Array.from({length:N},(_,i)=>
    `<Relationship Id="rId${slideRelIdStart+i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i+1}.xml"/>`
  ).join('');

  outFiles['ppt/_rels/presentation.xml.rels'] =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    keepRels.join('') + slideRels +
    `</Relationships>`;

  const smRel = keepRels.find(r => r.includes('slideMaster'));
  const smRid = smRel && smRel.match(/Id="(rId\d+)"/)[1];

  let presXml = origPres;
  if (smRid) {
    presXml = presXml.replace(/<p:sldMasterId[^>]*r:id="[^"]*"/, m => m.replace(/r:id="[^"]*"/, `r:id="${smRid}"`));
  }
  presXml = presXml.replace(/<p:notesMasterIdLst>[\s\S]*?<\/p:notesMasterIdLst>/g, '');
  const sldIdLst = Array.from({length:N},(_,i)=>
    `<p:sldId id="${256+i}" r:id="rId${slideRelIdStart+i}"/>`
  ).join('');
  presXml = presXml.replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, `<p:sldIdLst>${sldIdLst}</p:sldIdLst>`);
  outFiles['ppt/presentation.xml'] = presXml;

  // Rebuild [Content_Types].xml
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

module.exports = { generateListPptxBuffer };

// ── CLI (only when run directly) ──────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  function getArg(n) { const i = args.indexOf(n); return i !== -1 ? args[i+1] : null; }
  function hasFlag(n) { return args.includes(n); }

  const templateFile = getArg('--template') ||
    'C:/Users/I306380/OneDrive - SAP SE/_SC/Manuals&Processes/Skills/SSCI/ListTemplate.pptx';
  const dataFile  = getArg('--data')  || path.join(__dirname, 'sample_services.json');
  const outFile   = getArg('--out')   || path.join(__dirname, 'output_list.pptx');
  const title     = getArg('--title') || 'Services Description';
  const groupByET = hasFlag('--groupByET');
  const bsCode    = getArg('--bsCode') || null;
  const useDeckName = hasFlag('--deckName');

  if (!fs.existsSync(dataFile)) { console.error('Data not found:', dataFile); process.exit(1); }
  const services = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  console.log(`Loaded ${services.length} services`);

  const buf = generateListPptxBuffer(services, { templateFile, title, groupByET, bsCode, useDeckName });
  fs.writeFileSync(outFile, buf);
  console.log(`Done → ${outFile}`);
}
