#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (error) {
  console.error([
    'Failed to load Playwright for the Screeps roadmap renderer.',
    'Run `npm install` from the repository root, then retry this script.',
    `Original error: ${error.message}`
  ].join('\n'));
  process.exit(1);
}

const repo = path.resolve(process.argv[2] || '/root/screeps');
const out = process.argv[3] || '/tmp/screeps-roadmap-snapshot.png';
const dataPath = path.join(repo, 'docs', 'roadmap-data.json');
const sourceLabel = 'docs/roadmap-data.json';

function readRoadmapData() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to read ${sourceLabel}: ${error.message}`);
  }

  const report = data.report;
  if (!report || typeof report !== 'object') {
    throw new Error(`${sourceLabel} is missing report data`);
  }

  for (const key of ['kpiCards', 'roadmapCards', 'gameplayKanban', 'foundationKanban', 'processCards']) {
    if (!Array.isArray(report[key])) {
      throw new Error(`${sourceLabel} report.${key} must be an array`);
    }
  }

  return data;
}

const roadmapData = readRoadmapData();
const report = roadmapData.report;
const formatVersion = String(roadmapData.format || report.id || 'roadmap-portrait-kpi-kanban-v5');
const reportPublishedAt = String(roadmapData.generatedAtCst || roadmapData.generatedAt || 'unavailable');
const reportGeneratedAt = String(roadmapData.generatedAt || roadmapData.generatedAtCst || 'unavailable');
const reportTitle = String(roadmapData.title || 'Hermes Screeps Project Roadmap Report');
const projectUrl = String(roadmapData.repo?.url || 'https://github.com/lanyusea/screeps');

function assetPath(relativePath) {
  const clean = String(relativePath || 'assets/screeps-community-logo.png').replace(/^docs\//, '');
  return path.join(repo, 'docs', clean);
}

const logoPath = assetPath(roadmapData.assets?.logo);
const logoDataUri = fs.existsSync(logoPath)
  ? `data:image/png;base64,${fs.readFileSync(logoPath).toString('base64')}`
  : '';

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function writeFallbackPng(filePath) {
  const width = 1600;
  const height = 2490;
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);

  function fillRect(x, y, w, h, color) {
    const [r, g, b, a = 255] = color;
    const left = Math.max(0, Math.floor(x));
    const top = Math.max(0, Math.floor(y));
    const right = Math.min(width, Math.ceil(x + w));
    const bottom = Math.min(height, Math.ceil(y + h));
    for (let yy = top; yy < bottom; yy += 1) {
      let offset = yy * stride + 1 + left * 4;
      for (let xx = left; xx < right; xx += 1) {
        raw[offset] = r;
        raw[offset + 1] = g;
        raw[offset + 2] = b;
        raw[offset + 3] = a;
        offset += 4;
      }
    }
  }

  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0;
  }
  fillRect(0, 0, width, height, [244, 238, 227]);
  fillRect(48, 62, 1504, 338, [255, 253, 247]);
  fillRect(1180, 92, 320, 260, [239, 228, 211]);
  fillRect(84, 440, 470, 300, [255, 253, 247]);
  fillRect(566, 440, 470, 300, [255, 253, 247]);
  fillRect(1048, 440, 470, 300, [255, 253, 247]);
  for (let row = 0; row < 2; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      fillRect(84 + col * 482, 825 + row * 216, 470, 182, [255, 253, 247]);
      fillRect(104 + col * 482, 965 + row * 216, 300, 11, [240, 229, 214]);
      fillRect(104 + col * 482, 965 + row * 216, 180 + col * 35, 11, [200, 145, 85]);
    }
  }
  for (let section = 0; section < 2; section += 1) {
    for (let col = 0; col < 4; col += 1) {
      fillRect(84 + col * 360, 1330 + section * 420, 340, 270, [251, 246, 237]);
      fillRect(104 + col * 360, 1374 + section * 420, 300, 72, [255, 253, 248]);
      fillRect(104 + col * 360, 1460 + section * 420, 300, 72, [255, 253, 248]);
    }
  }
  for (let col = 0; col < 5; col += 1) {
    fillRect(84 + col * 290, 2200, 275, 136, [255, 253, 247]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND')
  ]);
  fs.writeFileSync(filePath, png);
}

function esc(v) {
  return String(v ?? 'unavailable').replace(/[&<>"']/g, s => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[s]));
}

function attr(v) {
  return esc(v);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function observedNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function displayValue(v) {
  if (v === null || v === undefined || v === '') return 'unavailable';
  return String(v);
}

function short(s, n = 92) {
  s = String(s || 'unavailable');
  return s.length > n ? s.slice(0, n - 3) + '...' : s;
}

function clampPercent(v) {
  return Math.max(0, Math.min(100, num(v)));
}

function chartTicks(card, observedVals) {
  const ticks = Array.isArray(card.ticks)
    ? card.ticks.map(observedNumber).filter(v => v !== null)
    : [];
  if (ticks.length >= 2) return ticks;
  const max = Math.max(1, num(card.max), ...observedVals);
  return [0, max / 2, max];
}

function lineChart(card, width = 430, height = 215) {
  const pad = { l: 54, r: 24, t: 28, b: 40 };
  const series = Array.isArray(card.series) ? card.series : [];
  const dates = Array.isArray(card.dates) ? card.dates : [];
  const observedVals = series
    .flatMap(s => Array.isArray(s.values) ? s.values : [])
    .map(observedNumber)
    .filter(v => v !== null);
  const hasObserved = observedVals.length > 0;
  const ticks = chartTicks(card, observedVals);
  const max = Math.max(...ticks, ...observedVals, 1);
  const min = Math.min(...ticks, ...observedVals, 0);
  const span = max - min || 1;
  const valueLengths = series.map(s => Array.isArray(s.values) ? s.values.length : 0);
  const pointCount = Math.max(1, dates.length, ...valueLengths);
  const x = i => pad.l + i * ((width - pad.l - pad.r) / Math.max(1, pointCount - 1));
  const y = v => height - pad.b - ((num(v) - min) / span) * (height - pad.t - pad.b);

  const yAxis = ticks.slice().reverse().map(v => {
    const yy = y(v);
    const label = Number.isInteger(v) ? String(v) : String(Number(v.toFixed(2)));
    return `<line x1="${pad.l}" x2="${width - pad.r}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" class="gridline"/><text x="${pad.l - 10}" y="${(yy + 4).toFixed(1)}" text-anchor="end" class="axis">${esc(label)}</text>`;
  }).join('') + `<line x1="${pad.l}" x2="${pad.l}" y1="${pad.t}" y2="${height - pad.b}" class="axisline"/>`;

  const paths = hasObserved ? series.map((s, idx) => {
    const values = Array.isArray(s.values) ? s.values : [];
    const color = s.color || ['#9f6a3a', '#77716a', '#c8945a'][idx % 3];
    const widthValue = observedNumber(s.width) || 3;
    const segments = [];
    let current = [];
    values.forEach((raw, i) => {
      const value = observedNumber(raw);
      if (value === null) {
        if (current.length > 1) segments.push(current);
        current = [];
        return;
      }
      current.push([x(i), y(value)]);
    });
    if (current.length > 1) segments.push(current);
    return segments.map(segment => {
      const d = segment.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
      const dash = s.dash ? ` stroke-dasharray="${attr(s.dash)}"` : '';
      return `<path d="${d}" fill="none" stroke="${attr(color)}" stroke-width="${widthValue}" stroke-linecap="round"${dash}/>`;
    }).join('');
  }).join('') : '';

  const points = hasObserved ? series.map((s, idx) => {
    const values = Array.isArray(s.values) ? s.values : [];
    const statuses = Array.isArray(s.statuses) ? s.statuses : [];
    const color = s.color || ['#9f6a3a', '#77716a', '#c8945a'][idx % 3];
    return values.map((raw, i) => {
      const value = observedNumber(raw);
      if (value === null) return '';
      const px = x(i);
      const py = y(value);
      const dy = idx === 0 ? -10 : (idx === 1 ? 17 : -24);
      return `<g data-kpi-point="true" data-series="${attr(s.label || '')}" data-status="${attr(statuses[i] || '')}" data-value="${attr(value)}"><circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3.8" fill="${attr(color)}" stroke="#fffdf7" stroke-width="1.4"/><text x="${px.toFixed(1)}" y="${(py + dy).toFixed(1)}" text-anchor="middle" class="point-label">${esc(value)}</text></g>`;
    }).join('');
  }).join('') : '';

  const unavailable = hasObserved ? '' : `<g data-kpi-unavailable="true"><rect x="${pad.l + 28}" y="${pad.t + 36}" width="${width - pad.l - pad.r - 56}" height="74" rx="12" fill="#fffdf7" stroke="#dbcbb7"/><text x="${width / 2}" y="${pad.t + 68}" text-anchor="middle" class="no-data-title">No observed KPI data</text><text x="${width / 2}" y="${pad.t + 92}" text-anchor="middle" class="no-data-copy">Pages data marks this chart unavailable.</text></g>`;
  const labels = dates.map((d, i) => `<text x="${x(i)}" y="${height - 12}" text-anchor="middle" class="axis">${esc(d)}</text>`).join('');
  const legend = series.map((s, i) => {
    const color = s.color || ['#9f6a3a', '#77716a', '#c8945a'][i % 3];
    const dashStyle = s.dash ? `border-top:2px dashed ${attr(color)};background:transparent;height:0;` : `background:${attr(color)};`;
    return `<span data-series-label="${attr(s.label || '')}"><i style="${dashStyle}"></i>${esc(s.label)}</span>`;
  }).join('');

  return `<div class="card kpi" data-kpi-key="${attr(card.key || '')}"><div class="kpi-head"><div><h3>${esc(card.title)}</h3><p>${esc(card.subtitle)}</p></div><b>${esc(card.pill)}</b></div><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${attr(card.title)} 7 day trend">${yAxis}<line x1="${pad.l}" x2="${width - pad.r}" y1="${height - pad.b}" y2="${height - pad.b}" class="axisline"/>${paths}${points}${unavailable}${labels}<text x="${pad.l}" y="15" class="axis unit-label">${esc(card.pill)}</text></svg><div class="legend">${legend}</div><div class="micro-note">${esc(card.footer)}</div></div>`;
}

function roadmapCard(card) {
  const progress = displayValue(card.progress);
  const fill = clampPercent(card.progress);
  const body = `<h3>${esc(card.title)}</h3><div class="row"><b>Goal</b><span>${esc(card.goal)}</span></div><div class="row"><b>Next</b><span>${esc(card.next)}</span></div><div class="progress"><strong>${esc(progress)}%</strong><i><em style="width:${fill}%"></em></i></div><div class="done">${esc(card.status)}</div>`;
  if (card.url) {
    return `<a class="card road" href="${attr(card.url)}" data-roadmap-title="${attr(card.title)}">${body}</a>`;
  }
  return `<article class="card road" data-roadmap-title="${attr(card.title)}">${body}</article>`;
}

function kanban(title, columns) {
  const body = columns.map(column => {
    const items = Array.isArray(column.items) ? column.items : [];
    const cards = items.map(item => {
      const top = `<div class="ticket-top"><b>${esc(short(item.title, 58))}</b><span>${esc(item.priority || '')}</span></div><p>${esc(short(item.description || '', 92))}</p>`;
      if (item.url) {
        return `<a class="ticket" href="${attr(item.url)}" data-kanban-title="${attr(item.title || '')}" data-kanban-description="${attr(item.description || '')}">${top}</a>`;
      }
      return `<div class="ticket" data-kanban-title="${attr(item.title || '')}" data-kanban-description="${attr(item.description || '')}">${top}</div>`;
    }).join('');
    return `<div class="kan-col" data-kanban-column="${attr(column.title)}"><div class="kan-title">${esc(column.title)} <span>${items.length}</span></div>${cards || '<div class="empty">No cards</div>'}</div>`;
  }).join('');
  return `<section class="section"><div class="section-title"><h2>${esc(title)}</h2></div><div class="kanban">${body}</div></section>`;
}

function metric(card) {
  const value = displayValue(card.value);
  const valueStyle = String(value).length > 7 ? ' style="font-size:34px;line-height:1.05"' : '';
  const delta = card.delta ? `<span>${esc(card.delta)}</span>` : '';
  return `<div class="card metric" data-process-label="${attr(card.label)}" data-process-value="${attr(value)}"><div class="metric-value"${valueStyle}>${esc(value)}</div><div class="metric-label">${esc(card.label)}</div><div class="metric-note">${esc(card.detail || '')}${delta}</div></div>`;
}

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;background:#f4eee3;color:#2e2a24;font-family:Inter,Arial,'Noto Sans CJK SC','Microsoft YaHei',sans-serif}.canvas{width:1600px;min-height:0;padding:62px 46px 62px}.hero{position:relative;display:grid;grid-template-columns:1.42fr 1fr;gap:18px;min-height:338px;margin:0 2px 28px;padding:34px 36px 30px;border-radius:34px;overflow:hidden;background:radial-gradient(circle at 82% 46%,rgba(201,100,66,.24),transparent 24%),linear-gradient(135deg,#fffdf7 0%,#f7eedf 58%,#ead8bd 100%);box-shadow:0 20px 46px rgba(90,70,35,.10)}.hero:after{content:"";position:absolute;right:-120px;top:-120px;width:470px;height:470px;border-radius:50%;background:rgba(143,98,53,.06)}.hero-main{position:relative;z-index:2;display:flex;flex-direction:column;justify-content:space-between;min-height:266px}.hero-kicker{font-size:16px;letter-spacing:.18em;text-transform:uppercase;color:#8f6235;font-weight:950}.hero h1{font-size:54px;line-height:1;margin:10px 0 16px;font-weight:950;letter-spacing:0;max-width:860px}.hero-subtitle{font-size:22px;color:#5e554b;margin:0 0 15px;line-height:1.34;max-width:780px}.hero-copy{display:grid;gap:5px;color:#4d463d;font-size:17px;line-height:1.34;max-width:860px}.hero-copy p{margin:0}.hero-copy b{color:#8f6235}.publish-time{margin-top:13px;color:#8f6235;font-size:15px;font-weight:950;letter-spacing:.04em;text-transform:uppercase}.hero-art{position:relative;z-index:1;min-height:286px;display:flex;align-items:center;justify-content:center}.logo-orb{width:418px;height:418px;border-radius:50%;background:rgba(255,253,247,.62);box-shadow:0 22px 58px rgba(90,70,35,.16),inset 0 0 0 18px rgba(239,228,211,.48);display:flex;align-items:center;justify-content:center}.logo-mask{width:360px;height:360px;border-radius:50%;overflow:hidden;background:#061014;display:flex;align-items:center;justify-content:center;box-shadow:0 14px 28px rgba(46,42,36,.18),inset 0 0 0 2px rgba(255,253,247,.44)}.logo-mask img{width:100%;height:100%;object-fit:cover;display:block}.logo-fallback{font-size:64px;font-weight:950;color:#8f6235}.section{margin-top:26px}.section-title{display:flex;align-items:flex-end;justify-content:space-between;margin:0 2px 14px}.section-title h2{font-size:34px;line-height:1;margin:0;font-weight:900;letter-spacing:0}.card{background:#fffdf7;border:1.6px solid #d2c5b4;border-radius:22px;box-shadow:0 12px 26px rgba(90,70,35,.07)}.kpi-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.kpi{padding:18px}.kpi-head{display:flex;justify-content:space-between;gap:10px;align-items:start}.kpi h3,.road h3{font-size:24px;margin:0 0 6px}.kpi p{margin:0;color:#786f63;font-size:16px}.kpi-head b{font-size:14px;color:#8f6235;background:#efe4d3;border:1px solid #ddcbb5;border-radius:999px;padding:7px 10px}svg{width:100%;display:block;margin-top:8px}.gridline{stroke:#e4dacd;stroke-width:1}.axisline{stroke:#b8aa99;stroke-width:1.4}.axis{font-size:13px;fill:#7c7266}.point-label{font-size:12px;fill:#2e2a24;font-weight:900;paint-order:stroke;stroke:#fffdf7;stroke-width:3px;stroke-linejoin:round}.unit-label{font-weight:900;fill:#8f6235}.legend{display:flex;flex-wrap:wrap;gap:10px;margin-top:4px;font-size:14px;color:#5e554b}.legend i{display:inline-block;width:20px;height:4px;border-radius:99px;margin-right:5px;vertical-align:middle}.micro-note{font-size:14px;color:#8b806f;margin-top:7px;line-height:1.3}.road-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.road{display:block;text-decoration:none;color:inherit;padding:18px;min-height:182px}.row{display:grid;grid-template-columns:70px 1fr;gap:8px;margin:8px 0;font-size:16px;line-height:1.25}.row b{color:#887b6c}.progress{display:flex;align-items:center;gap:10px;margin-top:10px}.progress strong{font-size:21px;color:#8f6235;min-width:55px}.progress i{flex:1;height:11px;background:#f0e5d6;border:1px solid #d5c4b0;border-radius:99px;overflow:hidden}.progress em{display:block;height:100%;background:linear-gradient(90deg,#c89155,#8f6235);border-radius:99px}.done{font-size:15px;color:#5c8456;font-weight:800;margin-top:9px}.kanban{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.kan-col{background:#fbf6ed;border:1.3px solid #d8cbb9;border-radius:20px;padding:11px;min-height:270px}.kan-title{font-size:16px;font-weight:900;margin-bottom:9px;display:flex;justify-content:space-between}.kan-title span{color:#8f6235}.ticket{display:block;text-decoration:none;color:inherit;background:#fffdf8;border:1px solid #e1d6c8;border-radius:16px;padding:9px;margin-bottom:9px}.ticket-top{display:flex;justify-content:space-between;gap:8px}.ticket b{font-size:13px;line-height:1.18}.ticket span{font-size:11px;color:#8f6235;font-weight:900}.ticket p{font-size:12px;line-height:1.25;color:#756d62;margin:6px 0 0}.empty{height:86px;border:1px dashed #cdbfac;border-radius:16px;color:#a99b89;display:flex;align-items:center;justify-content:center}.metrics{display:grid;grid-template-columns:repeat(5,1fr);gap:16px}.metric{height:136px;padding:18px;position:relative}.metric-value{font-size:44px;font-weight:950;color:#8f6235;letter-spacing:0}.metric-label{font-size:17px;color:#5c554d;margin-top:6px}.metric-note{position:absolute;left:18px;right:18px;bottom:14px;font-size:13px;color:#8b806f}.metric-note span{float:right;background:#efe4d3;border:1px solid #dccab5;color:#8f6235;font-weight:900;border-radius:999px;padding:3px 8px}.footer{font-size:13px;color:#9a8c7c;margin-top:18px;text-align:right}
</style></head><body><div class="canvas" data-roadmap-source="${attr(sourceLabel)}">
<div class="hero"><div class="hero-main"><div><div class="hero-kicker">Persistent MMO AI Colony - Autonomous Roadmap</div><h1>${esc(reportTitle)}</h1><p class="hero-subtitle">Harness live game evidence for Agentic roadmap decisions, implementation focus, validation gates, and release cadence.</p></div><div><div class="hero-copy"><p><b>Project</b> - Long-running Screeps: World AI operations project.</p><p><b>Links</b> - ${esc(projectUrl)}</p></div><div class="publish-time">Published - ${esc(reportPublishedAt)}</div></div></div><div class="hero-art"><div class="logo-orb"><div class="logo-mask">${logoDataUri ? `<img src="${logoDataUri}" alt="Screeps logo">` : '<div class="logo-fallback">SC</div>'}</div></div></div></div>
<section class="section" style="margin-top:0"><div class="section-title"><h2>01 Game KPI - 7d Trend</h2></div><div class="kpi-grid">${report.kpiCards.map(c => lineChart(c)).join('')}</div></section>
<section class="section"><div class="section-title"><h2>02 Development Roadmap - Six Tracks</h2></div><div class="road-grid">${report.roadmapCards.map(roadmapCard).join('')}</div></section>
${kanban('03 Gameplay Strategy Kanban', report.gameplayKanban)}
${kanban('04 Foundation Delivery Kanban', report.foundationKanban)}
<section class="section"><div class="section-title"><h2>05 Delivery Metrics</h2></div><div class="metrics">${report.processCards.map(metric).join('')}</div></section>
<div class="footer">format ${esc(formatVersion)} - source ${esc(sourceLabel)} - generated ${esc(reportGeneratedAt)}</div>
</div></body></html>`;

(async () => {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const htmlPath = out.replace(/\.png$/, '.html');
  fs.writeFileSync(htmlPath, html);
  const launchOptions = {
    headless: true,
    chromiumSandbox: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-crash-reporter',
      '--disable-crashpad',
      '--no-zygote'
    ]
  };
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
    if (!fs.existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE)) {
      throw new Error(`PLAYWRIGHT_CHROMIUM_EXECUTABLE does not exist: ${process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}`);
    }
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  } else {
    const systemChromium = '/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome';
    if (fs.existsSync(systemChromium)) {
      launchOptions.executablePath = systemChromium;
    }
  }
  try {
    const browser = await chromium.launch(launchOptions);
    const page = await browser.newPage({ viewport: { width: 1600, height: 2490 }, deviceScaleFactor: 1 });
    await page.goto('file://' + htmlPath);
    await page.screenshot({ path: out, fullPage: true });
    await browser.close();
  } catch (error) {
    const reason = String(error && error.message ? error.message : error).split('\n')[0];
    console.error(`Playwright screenshot failed (${reason}); wrote a degraded PNG fallback after generating ${htmlPath}.`);
    writeFallbackPng(out);
  }
  console.log(out);
})();
