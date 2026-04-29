#!/usr/bin/env node
const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');
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

const repo = process.argv[2] || '/root/screeps';
const out = process.argv[3] || '/tmp/screeps-roadmap-snapshot.png';
const preview = process.env.SCREEPS_ROADMAP_PREVIEW === '1';
const statePath = process.env.SCREEPS_ROADMAP_STATE_PATH
  || path.join(repo, 'runtime-artifacts', 'roadmap-render-state-v5.json');
const formatVersion = 'roadmap-portrait-kpi-kanban-v5';

const logoPath = path.join(repo, 'docs/assets/screeps-community-logo.png');
const logoDataUri = fs.existsSync(logoPath)
  ? `data:image/png;base64,${fs.readFileSync(logoPath).toString('base64')}`
  : '';

function sh(cmd, fallback = '—') {
  try { return execSync(cmd, { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 120000 }).trim(); }
  catch { return fallback; }
}
function json(cmd, fallback) {
  try {
    const raw = sh(cmd, '');
    return JSON.parse(raw.replace(/[\u0000-\u001F\u007F-\u009F]/g, c => (c === '\n' || c === '\r' || c === '\t') ? c : ''));
  } catch { return fallback; }
}
function esc(v) { return String(v ?? '—').replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s])); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function observedNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function short(s, n=68) { s = String(s || '—'); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function englishText(v, fallback = 'No current evidence available') {
  const text = String(v ?? '')
    .replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, ' ')
    .replace(/[，。；：、？！“”‘’（）《》【】]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text || fallback;
}
function readState() { try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return {}; } }
function writeState(s) { fs.mkdirSync(path.dirname(statePath), {recursive:true}); fs.writeFileSync(statePath, JSON.stringify(s, null, 2)); }
const priorState = readState();

function readRoadmapData() {
  const dataPath = path.join(repo, 'docs', 'roadmap-data.json');
  try {
    return JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  } catch (error) {
    console.error(`Failed to read Pages roadmap data from ${dataPath}: ${error.message}`);
    process.exit(1);
  }
}
const roadmapData = readRoadmapData();
const report = roadmapData.report || {};
const head = sh('git rev-parse --short HEAD', '—');
const pagesUrl = roadmapData.repo?.pagesUrl || 'https://lanyusea.github.io/screeps/';
const projectLinks = { repo: roadmapData.repo?.url || 'https://github.com/lanyusea/screeps' };
const reportPublishedAt = roadmapData.generatedAtCst || new Date().toLocaleString('en-US', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false
}).replace(/\//g, '-');

function seriesHasObservedValues(series) {
  return Array.isArray(series?.values) && series.values.some(observedNumberIsPresent);
}
function observedNumberIsPresent(v) {
  return observedNumber(v) !== null;
}
function pageKpiCardToChart(card) {
  const series = (card.series || []).map(s => ({
    name: s.label || s.metric || 'Metric',
    values: Array.isArray(s.values) ? s.values : [],
    statuses: Array.isArray(s.statuses) ? s.statuses : [],
    dashed: Boolean(s.dash),
    color: s.color || null
  }));
  const hasObserved = series.some(seriesHasObservedValues);
  return {
    title: card.title || 'KPI',
    subtitle: card.subtitle || '',
    unit: card.pill || '',
    color: series[0]?.color || '#8f6235',
    unavailable: !hasObserved,
    dates: Array.isArray(card.dates) ? card.dates : [],
    ticks: Array.isArray(card.ticks) ? card.ticks : null,
    max: Number.isFinite(Number(card.max)) ? Number(card.max) : null,
    series,
    note: hasObserved
      ? (card.footer || 'Series values come from Pages roadmap data.')
      : 'No observed KPI data in Pages roadmap data; chart intentionally blank.'
  };
}
const kpiCharts = (report.kpiCards || []).map(pageKpiCardToChart);
const days = kpiCharts.find(chart => chart.dates.length)?.dates || [];

const roadmapCards = (report.roadmapCards || []).map(card => [
  card.title || 'Roadmap',
  card.goal || 'No goal evidence available.',
  card.next || 'No current evidence available.',
  Number.isFinite(Number(card.progress)) ? Number(card.progress) : 0,
  card.status || card.url || 'Pages roadmap data'
]);

const processCards = Array.isArray(report.processCards) ? report.processCards : [];
const metrics = Object.fromEntries(processCards.map(card => [card.label, card.value]));

const columns = [
  ['Backlog','Backlog'], ['Active','In Development'], ['Private Smoke','Private Smoke'], ['Done','Live']
];
function pageKanbanItems(section) {
  const source = Array.isArray(section) ? section : [];
  return source.flatMap(column => (column.items || []).map(item => ({
    id: `${column.title || 'column'}#${item.number || item.title}`,
    title: englishText(item.title, `#${item.number || ''}`.trim() || 'Issue'),
    priority: englishText(item.priority, ''),
    next: englishText(item.description, 'No current evidence available'),
    column: column.title || 'Backlog'
  })));
}
const gameItems = pageKanbanItems(report.gameplayKanban);
const foundationItems = pageKanbanItems(report.foundationKanban);
function visibleKanbanItems(items) {
  return items;
}

function lineChart(chart, width=430, height=215) {
  const pad = {l:54,r:24,t:28,b:40};
  const observedVals = chart.series.flatMap(s => s.values).map(observedNumber).filter(v => v !== null);
  const hasObserved = observedVals.length > 0 && !chart.unavailable;
  const rawMax = hasObserved ? Math.max(1, ...observedVals) : 1;
  const rawMin = hasObserved ? Math.min(0, ...observedVals) : 0;
  const max = rawMax === rawMin ? rawMax + 1 : rawMax;
  const min = rawMin;
  const xDenominator = Math.max(1, (chart.dates?.length || days.length || 7) - 1);
  const x = i => pad.l + i * ((width - pad.l - pad.r) / xDenominator);
  const y = v => height - pad.b - ((num(v) - min) / (max - min || 1)) * (height - pad.t - pad.b);
  const colors = chart.series.map((s, idx) => s.color || [chart.color, '#756d62', '#c89155'][idx % 3]);
  const tickVals = chart.ticks || [max, (max + min) / 2, min];
  const yAxis = tickVals.map(v => {
    const yy = y(v);
    const label = Number.isInteger(v) ? String(v) : v.toFixed(1);
    return `<line x1="${pad.l}" x2="${width-pad.r}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" class="gridline"/><text x="${pad.l-10}" y="${(yy+4).toFixed(1)}" text-anchor="end" class="axis">${esc(label)}</text>`;
  }).join('') + `<line x1="${pad.l}" x2="${pad.l}" y1="${pad.t}" y2="${height-pad.b}" class="axisline"/>`;
  const paths = hasObserved ? chart.series.map((s, idx) => {
    const segments = [];
    let current = [];
    s.values.forEach((raw, i) => {
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
      const d = segment.map(([px, py], i) => `${i?'L':'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
      return `<path d="${d}" fill="none" stroke="${colors[idx%colors.length]}" stroke-width="3.2" stroke-linecap="round" ${s.dashed?'stroke-dasharray="8 7"':''}/>`;
    }).join('');
  }).join('') : '';
  const points = hasObserved ? chart.series.map((s, idx) => s.values.map((raw,i) => {
    const value = observedNumber(raw);
    if (value === null) return '';
    const px = x(i), py = y(value);
    const dy = idx === 0 ? -10 : (idx === 1 ? 17 : -24);
    return `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3.8" fill="${colors[idx%colors.length]}" stroke="#fffdf7" stroke-width="1.4"/><text x="${px.toFixed(1)}" y="${(py+dy).toFixed(1)}" text-anchor="middle" class="point-label">${esc(value)}</text>`;
  }).join('')).join('') : '';
  const unavailable = hasObserved ? '' : `<g data-kpi-unavailable="true"><rect x="${pad.l+28}" y="${pad.t+36}" width="${width-pad.l-pad.r-56}" height="74" rx="12" fill="#fffdf7" stroke="#dbcbb7"/><text x="${width/2}" y="${pad.t+68}" text-anchor="middle" class="no-data-title">No observed KPI data</text><text x="${width/2}" y="${pad.t+92}" text-anchor="middle" class="no-data-copy">Real reducer history unavailable; chart intentionally blank.</text></g>`;
  const labels = (chart.dates?.length ? chart.dates : days).map((d,i) => `<text x="${x(i)}" y="${height-12}" text-anchor="middle" class="axis">${esc(d)}</text>`).join('');
  const legend = chart.series.map((s,i) => `<span><i style="background:${colors[i%3]};${s.dashed?'border-top:2px dashed #2e2a24;background:transparent;height:0;':''}"></i>${esc(s.name)}</span>`).join('');
  return `<div class="card kpi"><div class="kpi-head"><div><h3>${esc(chart.title)}</h3><p>${esc(chart.subtitle)}</p></div><b>${esc(chart.unit)}</b></div><svg viewBox="0 0 ${width} ${height}">${yAxis}<line x1="${pad.l}" x2="${width-pad.r}" y1="${height-pad.b}" y2="${height-pad.b}" class="axisline"/>${paths}${points}${unavailable}${labels}<text x="${pad.l}" y="15" class="axis unit-label">${esc(chart.unit)}</text></svg><div class="legend">${legend}</div><div class="micro-note">${esc(chart.note)}</div></div>`;
}
function roadmapCard([h,g,n,p,d]) {
  return `<div class="card road"><h3>${esc(h)}</h3><div class="row"><b>Goal</b><span>${esc(g)}</span></div><div class="row"><b>Next</b><span>${esc(n)}</span></div><div class="progress"><strong>${esc(p)}%</strong><i><em style="width:${Math.max(0, Math.min(100, num(p)))}%"></em></i></div><div class="done">Proof: ${esc(d)}</div></div>`;
}
function kanban(title, subtitle, items) {
  const vis = visibleKanbanItems(items);
  const body = columns.map(([key,label]) => {
    const col = vis.filter(i => i.column === key);
    return `<div class="kan-col"><div class="kan-title">${esc(label)} <span>${col.length}</span></div>${col.map(i => `<div class="ticket"><div class="ticket-top"><b>${esc(short(i.title, 58))}</b><span>${esc(i.priority || '')}</span></div><p>${esc(short(i.next || i.domain || i.status, 92))}</p></div>`).join('') || `<div class="empty">No ${esc(label)} cards</div>`}</div>`;
  }).join('');
  return `<section class="section"><div class="section-title"><h2>${esc(title)}</h2></div><div class="kanban">${body}</div></section>`;
}
function metric(label, value, key, note) {
  const valueStyle = typeof value === 'number' ? '' : ' style="font-size:34px;line-height:1.05"';
  return `<div class="card metric"><div class="metric-value"${valueStyle}>${esc(value)}</div><div class="metric-label">${esc(label)}</div><div class="metric-note">${esc(note || '')}</div></div>`;
}

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;background:#f4eee3;color:#2e2a24;font-family:Inter,Arial,'Noto Sans CJK SC','Microsoft YaHei',sans-serif}.canvas{width:1600px;min-height:0;padding:62px 46px 62px}.hero{position:relative;display:grid;grid-template-columns:1.42fr 1fr;gap:18px;min-height:338px;margin:0 2px 28px;padding:34px 36px 30px;border-radius:34px;overflow:hidden;background:radial-gradient(circle at 82% 46%,rgba(201,100,66,.24),transparent 24%),linear-gradient(135deg,#fffdf7 0%,#f7eedf 58%,#ead8bd 100%);box-shadow:0 20px 46px rgba(90,70,35,.10)}.hero:after{content:"";position:absolute;right:-120px;top:-120px;width:470px;height:470px;border-radius:50%;background:rgba(143,98,53,.06)}.hero-main{position:relative;z-index:2;display:flex;flex-direction:column;justify-content:space-between;min-height:266px}.hero-kicker{font-size:16px;letter-spacing:.18em;text-transform:uppercase;color:#8f6235;font-weight:950}.hero h1{font-size:54px;line-height:1;margin:10px 0 16px;font-weight:950;letter-spacing:0;max-width:860px}.hero-subtitle{font-size:22px;color:#5e554b;margin:0 0 15px;line-height:1.34;max-width:780px}.hero-copy{display:grid;gap:5px;color:#4d463d;font-size:17px;line-height:1.34;max-width:860px}.hero-copy p{margin:0}.hero-copy b{color:#8f6235}.publish-time{margin-top:13px;color:#8f6235;font-size:15px;font-weight:950;letter-spacing:.04em;text-transform:uppercase}.hero-art{position:relative;z-index:1;min-height:286px;display:flex;align-items:center;justify-content:center}.logo-orb{width:418px;height:418px;border-radius:50%;background:rgba(255,253,247,.62);box-shadow:0 22px 58px rgba(90,70,35,.16),inset 0 0 0 18px rgba(239,228,211,.48);display:flex;align-items:center;justify-content:center}.logo-mask{width:360px;height:360px;border-radius:50%;overflow:hidden;background:#061014;display:flex;align-items:center;justify-content:center;box-shadow:0 14px 28px rgba(46,42,36,.18),inset 0 0 0 2px rgba(255,253,247,.44)}.logo-mask img{width:100%;height:100%;object-fit:cover;display:block}.logo-fallback{font-size:64px;font-weight:950;color:#8f6235}.meta-card{display:none}.section{margin-top:26px}.section-title{display:flex;align-items:flex-end;justify-content:space-between;margin:0 2px 14px}.section-title h2{font-size:34px;line-height:1;margin:0;font-weight:900;letter-spacing:0}.section-title p{display:none}.card{background:#fffdf7;border:1.6px solid #d2c5b4;border-radius:22px;box-shadow:0 12px 26px rgba(90,70,35,.07)}.kpi-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.kpi{padding:18px}.kpi-head{display:flex;justify-content:space-between;gap:10px;align-items:start}.kpi h3,.road h3{font-size:24px;margin:0 0 6px}.kpi p{margin:0;color:#786f63;font-size:16px}.kpi-head b{font-size:14px;color:#8f6235;background:#efe4d3;border:1px solid #ddcbb5;border-radius:999px;padding:7px 10px}svg{width:100%;display:block;margin-top:8px}.gridline{stroke:#e4dacd;stroke-width:1}.axisline{stroke:#b8aa99;stroke-width:1.4}.axis{font-size:13px;fill:#7c7266}.point-label{font-size:12px;fill:#2e2a24;font-weight:900;paint-order:stroke;stroke:#fffdf7;stroke-width:3px;stroke-linejoin:round}.unit-label{font-weight:900;fill:#8f6235}.legend{display:flex;flex-wrap:wrap;gap:10px;margin-top:4px;font-size:14px;color:#5e554b}.legend i{display:inline-block;width:20px;height:4px;border-radius:99px;margin-right:5px;vertical-align:middle}.micro-note{font-size:14px;color:#8b806f;margin-top:7px;line-height:1.3}.road-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.road{padding:18px;min-height:182px}.row{display:grid;grid-template-columns:70px 1fr;gap:8px;margin:8px 0;font-size:16px;line-height:1.25}.row b{color:#887b6c}.progress{display:flex;align-items:center;gap:10px;margin-top:10px}.progress strong{font-size:21px;color:#8f6235;min-width:55px}.progress i{flex:1;height:11px;background:#f0e5d6;border:1px solid #d5c4b0;border-radius:99px;overflow:hidden}.progress em{display:block;height:100%;background:linear-gradient(90deg,#c89155,#8f6235);border-radius:99px}.done{font-size:15px;color:#5c8456;font-weight:800;margin-top:9px}.kanban{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.kan-col{background:#fbf6ed;border:1.3px solid #d8cbb9;border-radius:20px;padding:11px;min-height:270px}.kan-title{font-size:16px;font-weight:900;margin-bottom:9px;display:flex;justify-content:space-between}.kan-title span{color:#8f6235}.ticket{background:#fffdf8;border:1px solid #e1d6c8;border-radius:16px;padding:9px;margin-bottom:9px}.ticket-top{display:flex;justify-content:space-between;gap:8px}.ticket b{font-size:13px;line-height:1.18}.ticket span{font-size:11px;color:#8f6235;font-weight:900}.ticket p{font-size:12px;line-height:1.25;color:#756d62;margin:6px 0 0}.empty{height:86px;border:1px dashed #cdbfac;border-radius:16px;color:#a99b89;display:flex;align-items:center;justify-content:center}.metrics{display:grid;grid-template-columns:repeat(5,1fr);gap:16px}.metric{height:136px;padding:18px;position:relative}.metric-value{font-size:44px;font-weight:950;color:#8f6235;letter-spacing:0}.metric-label{font-size:17px;color:#5c554d;margin-top:6px}.metric-note{position:absolute;left:18px;right:18px;bottom:14px;font-size:13px;color:#8b806f}.metric-note span{float:right;background:#efe4d3;border:1px solid #dccab5;color:#8f6235;font-weight:900;border-radius:999px;padding:3px 8px}.footer{font-size:13px;color:#9a8c7c;margin-top:18px;text-align:right}
</style></head><body><div class="canvas">
<div class="hero"><div class="hero-main"><div><div class="hero-kicker">Persistent MMO AI Colony · Autonomous Roadmap</div><h1>Hermes Screeps Project Roadmap Report</h1><p class="hero-subtitle">Harness live game evidence for Agentic roadmap decisions, implementation focus, validation gates, and release cadence.</p></div><div><div class="hero-copy"><p><b>Project</b> · Long-running Screeps: World AI operations project.</p><p><b>Links</b> · ${projectLinks.repo}</p></div><div class="publish-time">Published · ${reportPublishedAt} CST</div></div></div><div class="hero-art"><div class="logo-orb"><div class="logo-mask">${logoDataUri ? `<img src="${logoDataUri}" alt="Screeps logo">` : '<div class="logo-fallback">SC</div>'}</div></div></div></div>
<section class="section" style="margin-top:0"><div class="section-title"><h2>01 Game KPI · 7d Trend</h2></div><div class="kpi-grid">${kpiCharts.map(c=>lineChart(c)).join('')}</div></section>
<section class="section"><div class="section-title"><h2>02 Development Roadmap · Six Tracks</h2></div><div class="road-grid">${roadmapCards.map(roadmapCard).join('')}</div></section>
${kanban('03 Gameplay Strategy Kanban', 'Gameplay Evolution / Territory / Resources / Combat; data comes from GitHub Project, with live cards shown once.', gameItems)}
${kanban('04 Foundation Kanban', 'Reliability / P0 and Foundation Gates; data comes from GitHub Project.', foundationItems)}
<section class="section"><div class="section-title"><h2>05 Delivery Metrics</h2></div><div class="metrics">${processCards.map(card => metric(
  card.label || 'Metric',
  card.value ?? 'not observed',
  card.label || 'metric',
  card.detail || card.source || 'Pages roadmap data'
)).join('')}</div></section>
<div class="footer">format ${formatVersion} · repo ${head} · generated ${new Date().toISOString()}</div>
</div></body></html>`;

(async()=>{
  fs.mkdirSync(path.dirname(out), {recursive:true});
  const htmlPath = out.replace(/\.png$/, '.html');
  fs.writeFileSync(htmlPath, html);
  const launchOptions = {
    headless: true,
    chromiumSandbox: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  };
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
    if (!fs.existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE)) {
      throw new Error(`PLAYWRIGHT_CHROMIUM_EXECUTABLE does not exist: ${process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}`);
    }
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  }
  const browser = await chromium.launch(launchOptions);
  const page = await browser.newPage({viewport:{width:1600,height:2490}, deviceScaleFactor:1});
  await page.goto('file://' + htmlPath);
  await page.screenshot({path:out, fullPage:true});
  await browser.close();
  if (!preview) {
    const nowShown = new Set(priorState.shownDoneStrategyIds || []);
    [...gameItems, ...foundationItems].filter(i => i.column === 'online').forEach(i => nowShown.add(i.id));
    writeState({format_version: formatVersion, updated_at: new Date().toISOString(), head, metrics, shownDoneStrategyIds: [...nowShown]});
  }
  console.log(out);
})();
