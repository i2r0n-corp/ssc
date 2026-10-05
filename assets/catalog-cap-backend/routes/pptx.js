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
const db = require('../store/db');

const PPTX_TMP = path.join(__dirname, '..', 'data', 'pptx-tmp');
fs.mkdirSync(PPTX_TMP, { recursive: true });

async function _loadFlatIndex() {
  try {
    db.getPool();
    const svcRes = await db.query('SELECT code, raw_data FROM catalog_services');
    const flatIndex = {};
    for (const row of svcRes.rows) {
      if (row.raw_data && row.code) flatIndex[row.code] = row.raw_data;
    }
    const hierRes = await db.query('SELECT parent_code, child_code FROM catalog_hierarchy ORDER BY position');
    for (const row of hierRes.rows) {
      if (flatIndex[row.parent_code]) {
        if (!flatIndex[row.parent_code].childServices) flatIndex[row.parent_code].childServices = [];
        flatIndex[row.parent_code].childServices.push(row.child_code);
      }
    }
    return flatIndex;
  } catch(e) {
    // Fall back to snapshot payload for local dev
    const data = snapshot.load();
    if (!data || !data.payload) throw new Error('No catalog data available');
    return JSON.parse(data.payload).flat_index || {};
  }
}

// ── Generate PPTX ─────────────────────────────────────────────────────────────
router.post('/generatePptx', async (req, res) => {
  const { serviceCodes, template } = req.body;
  const templateName = template || 'short-description';

  try {
    // Validate
    if (!Array.isArray(serviceCodes) || serviceCodes.length === 0) {
      return res.status(400).json({ error: 'serviceCodes must be a non-empty array' });
    }
    if (serviceCodes.length > 50) {
      return res.status(400).json({ error: 'Maximum 50 services per export' });
    }
    if (!['short-description', 'one-pager'].includes(templateName)) {
      return res.status(400).json({ error: 'template must be "short-description" or "one-pager"' });
    }

    // Load services from DB
    const flatIndex = await _loadFlatIndex();
    const services = serviceCodes
      .map(code => flatIndex[code])
      .filter(Boolean);

    if (services.length === 0) {
      return res.status(404).json({ error: 'None of the provided service codes were found in the catalog' });
    }

    // Generate PPTX
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE';

    if (templateName === 'short-description') {
      _buildShortDescriptionPptx(pptx, services);
    } else {
      _buildOnePagePptx(pptx, services);
    }

    // Save to temp file
    const fileId = uuidv4();
    const filename = `catalog-export-${templateName}-${Date.now()}.pptx`;
    const filePath = path.join(PPTX_TMP, `${fileId}.pptx`);

    await pptx.writeFile({ fileName: filePath });

    const stat = fs.statSync(filePath);
    const fileSizeKb = Math.round(stat.size / 1024);

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
