/**
 * PPTX routes:
 *   POST /api/pptx/generatePptx    — generate a PowerPoint file from selected services
 *   GET  /api/pptx/download/:fileId — download a previously generated PPTX file
 */

const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const PptxGenJS = require('pptxgenjs');
const snapshot = require('../store/snapshot');

function getJwtPayload(req) {
  try {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return null;
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
  } catch { return null; }
}
const db = require('../store/db');
const { generateListPptxBuffer } = require('../scripts/generate_list_pptx');

const PPTX_TMP = path.join(__dirname, '..', 'data', 'pptx-tmp');
fs.mkdirSync(PPTX_TMP, { recursive: true });

async function _loadFlatIndex() {
  try {
    db.getPool();
    const svcRes = await db.query('SELECT code, name, engagement_type, raw_data FROM catalog_services');
    const flatIndex = {};
    for (const row of svcRes.rows) {
      if (!row.code) continue;
      const obj = row.raw_data || {};
      obj._name           = row.name;
      obj._engagementType = row.engagement_type || '';
      flatIndex[row.code] = obj;
    }
    // Build phases from catalog_classification
    const cfRes = await db.query(
      "SELECT service_code, feature_value FROM catalog_classification WHERE feature_key = 'sapActivateProjectPhase'"
    );
    const phasesMap = {};
    for (const row of cfRes.rows) {
      if (!phasesMap[row.service_code]) phasesMap[row.service_code] = [];
      const vals = row.feature_value.split(',').map(v => v.trim()).filter(Boolean);
      phasesMap[row.service_code].push(...vals);
    }
    for (const [code, phases] of Object.entries(phasesMap)) {
      if (flatIndex[code]) flatIndex[code]._phases = [...new Set(phases)];
    }
    // Build deck names from catalog_bs_naming
    const bsNamingRes = await db.query('SELECT service_code, bs_code, deck_name FROM catalog_bs_naming');
    for (const row of bsNamingRes.rows) {
      if (!flatIndex[row.service_code]) continue;
      if (!flatIndex[row.service_code]._bsNaming) flatIndex[row.service_code]._bsNaming = {};
      flatIndex[row.service_code]._bsNaming[row.bs_code] = row.deck_name;
    }
    return flatIndex;
  } catch(e) {
    const data = snapshot.load();
    if (!data || !data.payload) throw new Error('No catalog data available');
    return JSON.parse(data.payload).flat_index || {};
  }
}

// ── Generate PPTX ─────────────────────────────────────────────────────────────
router.post('/generatePptx', async (req, res) => {
  const { serviceCodes, template, listOptions } = req.body;
  const templateName = template || 'short-description';

  try {
    // Validate
    if (!Array.isArray(serviceCodes) || serviceCodes.length === 0) {
      return res.status(400).json({ error: 'serviceCodes must be a non-empty array' });
    }
    if (templateName !== 'list' && serviceCodes.length > 50) {
      return res.status(400).json({ error: 'Maximum 50 services per export' });
    }
    if (!['short-description', 'one-pager', 'list'].includes(templateName)) {
      return res.status(400).json({ error: 'template must be "short-description", "one-pager", or "list"' });
    }

    // Load services from DB
    const flatIndex = await _loadFlatIndex();
    const services = serviceCodes
      .map(code => flatIndex[code])
      .filter(Boolean);

    if (services.length === 0) {
      return res.status(404).json({ error: 'None of the provided service codes were found in the catalog' });
    }

    const fileId  = uuidv4();
    const filename = `catalog-export-${templateName}-${Date.now()}.pptx`;
    const filePath = path.join(PPTX_TMP, `${fileId}.pptx`);

    if (templateName === 'list') {
      const opts = listOptions || {};

      // module name: if UI sent a single selected module name, use it for all services.
      // If null (multiple modules selected), look up each service's module from hierarchy
      // scoped to only the selected module codes so services map to the correct stream label.
      const fixedModuleName = (opts.moduleName != null) ? opts.moduleName : null;
      const selectedModuleCodes = Array.isArray(opts.selectedModuleCodes) && opts.selectedModuleCodes.length > 0
        ? opts.selectedModuleCodes : null;

      // Build per-service module name map when needed
      let svcModuleMap = null;
      let modPositionMap = {};  // mod_code → position for sorting
      if (fixedModuleName === null) {
        let hierQuery, hierParams;
        const svcCodes = services.map(s => s.code);
        if (selectedModuleCodes) {
          // Scope to selected module codes AND only the exported services
          hierQuery = `
            SELECT h.child_code AS svc_code, s.name AS mod_name, s.code AS mod_code,
                   (SELECT hh.position FROM catalog_hierarchy hh WHERE hh.child_code = s.code LIMIT 1) AS mod_pos
            FROM catalog_hierarchy h
            JOIN catalog_services s ON s.code = h.parent_code
            WHERE s.service_object = 'Business Scenario module'
              AND s.code = ANY($1)
              AND h.child_code = ANY($2)
            ORDER BY mod_pos NULLS LAST, s.name
          `;
          hierParams = [selectedModuleCodes, svcCodes];
        } else {
          // No module filter at all — look up across all modules for the exported services
          hierQuery = `
            SELECT h.child_code AS svc_code, s.name AS mod_name, s.code AS mod_code,
                   (SELECT hh.position FROM catalog_hierarchy hh WHERE hh.child_code = s.code LIMIT 1) AS mod_pos
            FROM catalog_hierarchy h
            JOIN catalog_services s ON s.code = h.parent_code
            WHERE s.service_object = 'Business Scenario module'
              AND h.child_code = ANY($1)
            ORDER BY mod_pos NULLS LAST, s.name
          `;
          hierParams = [svcCodes];
        }
        const hierRows = await db.query(hierQuery, hierParams);
        svcModuleMap = {};
        // Also track per-service module position for later sort
        const svcPositionMap = {};
        for (const row of hierRows.rows) {
          if (!svcModuleMap[row.svc_code]) {
            svcModuleMap[row.svc_code] = row.mod_name;
            svcPositionMap[row.svc_code] = row.mod_pos ?? 9999;
            if (row.mod_code) modPositionMap[row.mod_code] = row.mod_pos ?? 9999;
          }
        }
        // Attach position to svcModuleMap lookup for use in sort
        modPositionMap._bySvc = svcPositionMap;
      }

      const svcs = services.map(s => {
        const phases = s._phases || [];
        const et     = s._engagementType || '';
        const parentName = fixedModuleName !== null
          ? fixedModuleName
          : (svcModuleMap[s.code] || '');
        return {
          code:             s.code,
          name:             s._name || s.name,
          short_description: s.shortDescription || '',
          summary:          s.summary || '',
          key_benefits:     s.keyBenefits || '',
          description:      s.description || '',
          engagement_type:  et,
          parent_name:      parentName,
          phases,
          business_scenario_naming: s._bsNaming || {},
        };
      });

      // Sort by module position so generator receives services grouped in correct module order
      if (svcModuleMap && modPositionMap._bySvc) {
        const bySvc = modPositionMap._bySvc;
        svcs.sort((a, b) => (bySvc[a.code] ?? 9999) - (bySvc[b.code] ?? 9999));
      }

      const buf = generateListPptxBuffer(svcs, {
        title:              opts.title || 'Services Description',
        groupByET:          !!opts.groupByET,
        bsCode:             opts.bsCode || null,
        bsName:             opts.bsCode ? (flatIndex[opts.bsCode]?._name || '') : '',
        useDeckName:        !!opts.useDeckName,
        yearFrom:           opts.yearFrom,
        yearTo:             opts.yearTo,
        cols:               opts.cols || null,
        streamMode:         opts.streamMode || null,
        streamCustom:       opts.streamCustom || '',
        truncateObjectives: !!opts.truncateObjectives,
        yearBorders:        !!opts.yearBorders,
      });
      fs.writeFileSync(filePath, buf);

    } else {
      // PptxGenJS templates
      const pptx = new PptxGenJS();
      pptx.layout = 'LAYOUT_WIDE';
      if (templateName === 'short-description') {
        _buildShortDescriptionPptx(pptx, services);
      } else {
        _buildOnePagePptx(pptx, services);
      }
      await pptx.writeFile({ fileName: filePath });
    }

    const stat = fs.statSync(filePath);
    const fileSizeKb = Math.round(stat.size / 1024);

    // Log export event
    const jwtPayload = getJwtPayload(req);
    const opts = listOptions || {};
    db.logExport({
      userId:        jwtPayload?.user_uuid || null,
      logonName:     jwtPayload?.user_name || jwtPayload?.email || null,
      exportType:    templateName,
      serviceCount:  services.length,
      filterBs:      opts.bsCode        || null,
      filterEt:      req.body?.filterEt || null,
      filterModules: Array.isArray(opts.selectedModuleCodes) && opts.selectedModuleCodes.length ? opts.selectedModuleCodes : null,
      filterQuery:   req.body?.filterQuery || null,
    });

    console.log(`[M4.achieved]: PPTX generated — template="${templateName}" service_count=${services.length} file_size_kb=${fileSizeKb}`);

    res.json({
      downloadUrl: `/api/pptx/download/${fileId}`,
      filename,
      serviceCount: services.length,
      fileSizeKb
    });

  } catch (err) {
    console.error(`[M4.missed]: PPTX generation failed — template="${templateName}" error=${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── Download PPTX ─────────────────────────────────────────────────────────────
router.get('/download/:fileId', (req, res) => {
  const { fileId } = req.params;
  // Sanitize: only allow UUID-style fileIds
  if (!/^[0-9a-f-]{36}$/.test(fileId)) {
    return res.status(400).json({ error: 'Invalid fileId' });
  }
  const filePath = path.join(PPTX_TMP, `${fileId}.pptx`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found or expired' });
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  res.setHeader('Content-Disposition', `attachment; filename="catalog-export.pptx"`);
  fs.createReadStream(filePath).pipe(res);
});

// ── Template builders ─────────────────────────────────────────────────────────

function _buildShortDescriptionPptx(pptx, services) {
  // Title slide
  const titleSlide = pptx.addSlide();
  titleSlide.background = { color: '003366' };
  titleSlide.addText('Proposed Services', {
    x: 0.5, y: 1.5, w: 12, h: 1.2,
    fontSize: 36, bold: true, color: 'FFFFFF', align: 'center'
  });
  titleSlide.addText(`Generated: ${new Date().toLocaleDateString('en-GB')} · ${services.length} service(s)`, {
    x: 0.5, y: 3.0, w: 12, h: 0.5,
    fontSize: 14, color: 'AACCEE', align: 'center'
  });

  // Table slide(s) — 10 services per slide
  const ROWS_PER_SLIDE = 10;
  for (let i = 0; i < services.length; i += ROWS_PER_SLIDE) {
    const batch = services.slice(i, i + ROWS_PER_SLIDE);
    const slide = pptx.addSlide();
    slide.addText(`Services Overview (${i + 1}–${Math.min(i + ROWS_PER_SLIDE, services.length)})`, {
      x: 0.3, y: 0.1, w: 12.5, h: 0.5, fontSize: 16, bold: true, color: '003366'
    });

    const tableData = [
      [
        { text: 'Service Name', options: { bold: true, fill: { color: '003366' }, color: 'FFFFFF' } },
        { text: 'Short Description', options: { bold: true, fill: { color: '003366' }, color: 'FFFFFF' } },
        { text: 'Engagement Type', options: { bold: true, fill: { color: '003366' }, color: 'FFFFFF' } },
        { text: 'Module', options: { bold: true, fill: { color: '003366' }, color: 'FFFFFF' } }
      ],
      ...batch.map(svc => [
        svc.name || '',
        (svc.shortDescription || '').substring(0, 150),
        svc.engagementType || '',
        svc.parentCode || ''
      ])
    ];

    slide.addTable(tableData, {
      x: 0.3, y: 0.7, w: 12.5,
      colW: [3.0, 6.0, 2.0, 1.5],
      fontSize: 9,
      border: { pt: 0.5, color: 'CCCCCC' },
      autoPage: false
    });
  }
}

function _buildOnePagePptx(pptx, services) {
  for (const svc of services) {
    const slide = pptx.addSlide();

    // Header bar
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.33, h: 1.0, fill: { color: '003366' } });
    slide.addText(svc.name || 'Service', {
      x: 0.3, y: 0.15, w: 10, h: 0.7,
      fontSize: 20, bold: true, color: 'FFFFFF'
    });
    slide.addText(svc.code || '', {
      x: 10.5, y: 0.25, w: 2.5, h: 0.5,
      fontSize: 10, color: 'AACCEE', align: 'right'
    });

    // Meta row
    const meta = [
      `Engagement: ${svc.engagementType || '—'}`,
      `Module: ${svc.parentCode || '—'}`
    ].join('   |   ');
    slide.addText(meta, {
      x: 0.3, y: 1.1, w: 12.5, h: 0.35,
      fontSize: 10, color: '555555', italic: true
    });

    // Short description
    if (svc.shortDescription) {
      slide.addText('Summary', { x: 0.3, y: 1.6, w: 12.5, h: 0.35, fontSize: 12, bold: true, color: '003366' });
      slide.addText(svc.shortDescription, {
        x: 0.3, y: 2.0, w: 12.5, h: 1.0,
        fontSize: 11, color: '222222', wrap: true
      });
    }

    // Long description
    if (svc.longDescription) {
      slide.addText('Details', { x: 0.3, y: 3.1, w: 12.5, h: 0.35, fontSize: 12, bold: true, color: '003366' });
      slide.addText((svc.longDescription || '').substring(0, 600), {
        x: 0.3, y: 3.5, w: 12.5, h: 3.0,
        fontSize: 10, color: '333333', wrap: true
      });
    }

    // BS naming
    const bsNames = Object.values(svc.business_scenario_naming || {});
    if (bsNames.length > 0) {
      slide.addText('Business Scenarios', { x: 0.3, y: 6.6, w: 12.5, h: 0.3, fontSize: 10, bold: true, color: '003366' });
      slide.addText(bsNames.slice(0, 5).join(', '), {
        x: 0.3, y: 6.9, w: 12.5, h: 0.4,
        fontSize: 9, color: '555555', wrap: true
      });
    }
  }
}

module.exports = router;
