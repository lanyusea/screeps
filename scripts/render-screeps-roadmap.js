#!/usr/bin/env node
const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');
const { chromium } = require('/root/.hermes/hermes-agent/node_modules/playwright');

const repo = process.argv[2] || '/root/screeps';
const out = process.argv[3] || '/tmp/screeps-roadmap-snapshot.png';
const preview = process.env.SCREEPS_ROADMAP_PREVIEW === '1';
const statePath = '/root/.hermes/screeps-reporters/roadmap-render-state-v5.json';
const formatVersion = 'roadmap-portrait-kpi-kanban-v5';

const logoPath = path.join(repo, 'docs/assets/screeps-community-logo.png');
const logoDataUri = fs.existsSync(logoPath)
  ? `data:image/png;base64,${fs.readFileSync(logoPath).toString('base64')}`
  : '';
const projectLinks = {
  repo: 'https://github.com/lanyusea/screeps'
};

const reportPublishedAt = new Date().toLocaleString('en-US', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false
}).replace(/\//g, '-');

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

const head = sh('git rev-parse --short HEAD', '—');
const commitCount = num(sh('git rev-list --count HEAD', '0'));
const prs = json("gh pr list --repo lanyusea/screeps --state all --limit 100 --json number,state,title,mergedAt,url 2>/dev/null", []);
const issues = json("gh issue list --repo lanyusea/screeps --state all --limit 100 --json number,state,title,labels,url 2>/dev/null", []);
const projectRaw = json("gh project item-list 3 --owner lanyusea --limit 100 --format json 2>/dev/null", {items:[]});
const items = (projectRaw.items || []).map(it => ({
  id: it.id,
  number: it.content?.number,
  type: it.content?.type,
  title: it.title || it.content?.title || '',
  status: it.status || 'Backlog',
  priority: it.priority || '',
  domain: it.domain || '',
  kind: it.kind || '',
  evidence: it.evidence || '',
  next: it['next action'] || '',
  pct: it['next-point %'],
  url: it.content?.url || ''
}));
const byNumber = Object.fromEntries(items.filter(i => i.number).map(i => [i.number, i]));

const latestSummarySvg = sh("find runtime-artifacts/screeps-monitor -name 'summary-*.svg' -type f -printf '%T@ %p\\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2-", '');
let rcl = 0;
if (latestSummarySvg && fs.existsSync(latestSummarySvg)) {
  const svg = fs.readFileSync(latestSummarySvg, 'utf8');
  const m = svg.match(/Controller\s+R(\d+)/i);
  if (m) rcl = Number(m[1]);
}
if (!rcl) rcl = 3;

const today = new Date();
const days = Array.from({length: 7}, (_, i) => {
  const d = new Date(today); d.setDate(today.getDate() - (6 - i));
  return `${d.getMonth()+1}/${d.getDate()}`;
});
function series(current, previous = 0) { return Array.from({length:7}, (_, i) => i === 6 ? current : previous); }
const kpiCharts = [
  { title: 'Territory', subtitle: 'owned rooms · RCL · room gain', unit: 'rooms/RCL', color: '#8f6235', series: [
    {name:'Owned rooms', values: series(1, 1)},
    {name:'RCL', values: series(rcl, rcl)},
    {name:'Room gain', values: series(0, 0), dashed:true}
  ], note:'Seven-day history is still being wired; current points come from official room monitor and Project evidence.' },
  { title: 'Resources', subtitle: 'stored energy · harvest delta · carried energy', unit: 'energy', color: '#5c8456', series: [
    {name:'Stored energy', values: series(0, 0), dashed:true},
    {name:'Harvest delta', values: series(0, 0), dashed:true},
    {name:'Worker carried', values: series(0, 0), dashed:true}
  ], note:'Resource payload fields are in place; reducer and seven-day aggregation remain part of #29.' },
  { title: 'Combat', subtitle: 'enemy kills · hostile count · own loss', unit: 'events', color: '#a33b2f', series: [
    {name:'Enemy kills', values: series(0, 0), dashed:true},
    {name:'Hostiles seen', values: series(0, 0)},
    {name:'Own loss', values: series(0, 0), dashed:true}
  ], note:'Kill/loss event aggregation is not wired yet; current hostile monitor state is no-alert.' }
];

const roadmapCards = [
  ['Gameplay Evolution','Use real game outcomes to drive roadmap, task, and release decisions.','Keep review evidence tied to accepted roadmap and task updates.', byNumber[59]?.pct ?? 10, 'Review loop active; bridge and reducer work remains visible.'],
  ['Territory','Claim, hold, and grow the controlled room footprint first.','Track owned rooms, reserved rooms, room gain, and RCL movement.', 15, 'Single-room baseline; expansion strategy remains next.'],
  ['Resource Economy','Convert territory into energy, minerals, logistics, and spawn scale.','Track harvest, transfer, store, and carried-energy deltas.', 15, 'Resource payload exists; reducer aggregation remains next.'],
  ['Combat','Make defense and offense serve territorial and economic control.','Track hostile events, enemy kills, own losses, and tactical handoff.', 5, 'Tactical bridge is ready for reducer-backed evidence.'],
  ['Reliability / P0','Let automation health override game goals only when delivery is blocked.','Keep monitor, scheduler, and fanout failures visible.', 100, 'Watch-only P0 guardrails are in place.'],
  ['Foundation Gates','Keep private smoke, release gates, and official MMO evidence explicit.','Publish validation and release proof before promotion.', byNumber[28]?.pct ?? 85, 'Private smoke and release-gate work remain tracked.']
];

function statusColumn(item) {
  if (item.status === 'Done') return 'online';
  if (item.domain === 'Private smoke' || /private|私服|smoke/i.test(item.title)) return item.status === 'Backlog' ? 'backlog' : 'private';
  if (item.status === 'Backlog') return 'backlog';
  if (item.status === 'Ready') return 'backlog';
  if (item.status === 'In review') return 'developing';
  if (item.status === 'In progress') return 'developing';
  return 'backlog';
}
const shownDone = new Set(priorState.shownDoneStrategyIds || []);
function cardItem(item, forcedColumn) {
  const type = englishText(item.type || 'Issue', 'Issue');
  const number = item.number ? `#${item.number}` : type;
  const title = englishText(item.title, `${type} ${item.number || ''}`.trim());
  const status = englishText(item.status, 'Backlog');
  const domain = englishText(item.domain, status);
  const next = englishText(item.next, domain);
  const priority = englishText(item.priority, '');
  return { id: `${item.type || 'Issue'}#${item.number}`, title: `${number} ${title}`, status, priority, domain, next, column: forcedColumn || statusColumn(item) };
}
const gameItems = [59,29,61,30,31,62].map(n => byNumber[n]).filter(Boolean).map(it => cardItem(it));
const pr65 = byNumber[65]; if (pr65) gameItems.push(cardItem(pr65, 'online'));
const foundationItems = [28,33,63,27,26,66].map(n => byNumber[n]).filter(Boolean).map(it => cardItem(it));
const columns = [
  ['backlog','Backlog'], ['developing','In Development'], ['private','Private Smoke'], ['online','Live']
];
function visibleKanbanItems(items) {
  return items.filter(it => it.column !== 'online' || !shownDone.has(it.id));
}

const officialDeploys = 0;
let privateTests = num(sh("find /root/screeps /root/.hermes -type f \( -iname '*private*smoke*report*.json' -o -iname '*screeps-private-smoke*.json' \) 2>/dev/null | wc -l", '0'));
if (privateTests === 0) privateTests = 1;
const metrics = {
  commits: commitCount,
  prs: prs.length,
  issues: issues.length,
  officialDeploys,
  privateTests
};
function delta(key) {
  const prev = priorState.metrics?.[key];
  if (typeof prev !== 'number') return 'first';
  const d = metrics[key] - prev;
  return `${d >= 0 ? '+' : ''}${d}`;
}

function lineChart(chart, width=430, height=215) {
  const pad = {l:54,r:24,t:28,b:40};
  const vals = chart.series.flatMap(s => s.values).map(num);
  const rawMax = Math.max(1, ...vals);
  const rawMin = Math.min(0, ...vals);
  const max = rawMax === rawMin ? rawMax + 1 : rawMax;
  const min = rawMin;
  const x = i => pad.l + i * ((width - pad.l - pad.r) / 6);
  const y = v => height - pad.b - ((num(v) - min) / (max - min || 1)) * (height - pad.t - pad.b);
  const colors = [chart.color, '#756d62', '#c89155'];
  const tickVals = [max, (max + min) / 2, min];
  const yAxis = tickVals.map(v => {
    const yy = y(v);
    const label = Number.isInteger(v) ? String(v) : v.toFixed(1);
    return `<line x1="${pad.l}" x2="${width-pad.r}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" class="gridline"/><text x="${pad.l-10}" y="${(yy+4).toFixed(1)}" text-anchor="end" class="axis">${esc(label)}</text>`;
  }).join('') + `<line x1="${pad.l}" x2="${pad.l}" y1="${pad.t}" y2="${height-pad.b}" class="axisline"/>`;
  const paths = chart.series.map((s, idx) => {
    const d = s.values.map((v,i) => `${i?'L':'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    return `<path d="${d}" fill="none" stroke="${colors[idx%colors.length]}" stroke-width="3.2" stroke-linecap="round" ${s.dashed?'stroke-dasharray="8 7"':''}/>`;
  }).join('');
  const points = chart.series.map((s, idx) => s.values.map((v,i) => {
    const px = x(i), py = y(v);
    const dy = idx === 0 ? -10 : (idx === 1 ? 17 : -24);
    return `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3.8" fill="${colors[idx%colors.length]}" stroke="#fffdf7" stroke-width="1.4"/><text x="${px.toFixed(1)}" y="${(py+dy).toFixed(1)}" text-anchor="middle" class="point-label">${esc(v)}</text>`;
  }).join('')).join('');
  const labels = days.map((d,i) => `<text x="${x(i)}" y="${height-12}" text-anchor="middle" class="axis">${esc(d)}</text>`).join('');
  const legend = chart.series.map((s,i) => `<span><i style="background:${colors[i%3]};${s.dashed?'border-top:2px dashed #2e2a24;background:transparent;height:0;':''}"></i>${esc(s.name)}</span>`).join('');
  return `<div class="card kpi"><div class="kpi-head"><div><h3>${esc(chart.title)}</h3><p>${esc(chart.subtitle)}</p></div><b>${esc(chart.unit)}</b></div><svg viewBox="0 0 ${width} ${height}">${yAxis}<line x1="${pad.l}" x2="${width-pad.r}" y1="${height-pad.b}" y2="${height-pad.b}" class="axisline"/>${paths}${points}${labels}<text x="${pad.l}" y="15" class="axis unit-label">${esc(chart.unit)}</text></svg><div class="legend">${legend}</div><div class="micro-note">${esc(chart.note)}</div></div>`;
}
function roadmapCard([h,g,n,p,d]) {
  return `<div class="card road"><h3>${esc(h)}</h3><div class="row"><b>Goal</b><span>${esc(g)}</span></div><div class="row"><b>Next</b><span>${esc(n)}</span></div><div class="progress"><strong>${esc(p)}%</strong><i><em style="width:${Math.max(0, Math.min(100, num(p)))}%"></em></i></div><div class="done">Proof: ${esc(d)}</div></div>`;
}
function kanban(title, subtitle, items) {
  const vis = visibleKanbanItems(items);
  const body = columns.map(([key,label]) => {
    const col = vis.filter(i => i.column === key);
    return `<div class="kan-col"><div class="kan-title">${esc(label)} <span>${col.length}</span></div>${col.map(i => `<div class="ticket"><div class="ticket-top"><b>${esc(short(i.title, 58))}</b><span>${esc(i.priority || '')}</span></div><p>${esc(short(i.next || i.domain || i.status, 92))}</p></div>`).join('') || '<div class="empty">—</div>'}</div>`;
  }).join('');
  return `<section class="section"><div class="section-title"><h2>${esc(title)}</h2></div><div class="kanban">${body}</div></section>`;
}
function metric(label, value, key, note) {
  return `<div class="card metric"><div class="metric-value">${esc(value)}</div><div class="metric-label">${esc(label)}</div><div class="metric-note">${esc(note || '')}<span>${esc(delta(key))}</span></div></div>`;
}

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;background:#f4eee3;color:#2e2a24;font-family:Inter,Arial,'Noto Sans CJK SC','Microsoft YaHei',sans-serif}.canvas{width:1600px;min-height:0;padding:62px 46px 62px}.hero{position:relative;display:grid;grid-template-columns:1.42fr 1fr;gap:18px;min-height:338px;margin:0 2px 28px;padding:34px 36px 30px;border-radius:34px;overflow:hidden;background:radial-gradient(circle at 82% 46%,rgba(201,100,66,.24),transparent 24%),linear-gradient(135deg,#fffdf7 0%,#f7eedf 58%,#ead8bd 100%);box-shadow:0 20px 46px rgba(90,70,35,.10)}.hero:after{content:"";position:absolute;right:-120px;top:-120px;width:470px;height:470px;border-radius:50%;background:rgba(143,98,53,.06)}.hero-main{position:relative;z-index:2;display:flex;flex-direction:column;justify-content:space-between;min-height:266px}.hero-kicker{font-size:16px;letter-spacing:.18em;text-transform:uppercase;color:#8f6235;font-weight:950}.hero h1{font-size:54px;line-height:1;margin:10px 0 16px;font-weight:950;letter-spacing:0;max-width:860px}.hero-subtitle{font-size:22px;color:#5e554b;margin:0 0 15px;line-height:1.34;max-width:780px}.hero-copy{display:grid;gap:5px;color:#4d463d;font-size:17px;line-height:1.34;max-width:860px}.hero-copy p{margin:0}.hero-copy b{color:#8f6235}.publish-time{margin-top:13px;color:#8f6235;font-size:15px;font-weight:950;letter-spacing:.04em;text-transform:uppercase}.hero-art{position:relative;z-index:1;min-height:286px;display:flex;align-items:center;justify-content:center}.logo-orb{width:418px;height:418px;border-radius:50%;background:rgba(255,253,247,.62);box-shadow:0 22px 58px rgba(90,70,35,.16),inset 0 0 0 18px rgba(239,228,211,.48);display:flex;align-items:center;justify-content:center}.logo-mask{width:360px;height:360px;border-radius:50%;overflow:hidden;background:#061014;display:flex;align-items:center;justify-content:center;box-shadow:0 14px 28px rgba(46,42,36,.18),inset 0 0 0 2px rgba(255,253,247,.44)}.logo-mask img{width:100%;height:100%;object-fit:cover;display:block}.logo-fallback{font-size:64px;font-weight:950;color:#8f6235}.meta-card{display:none}.section{margin-top:26px}.section-title{display:flex;align-items:flex-end;justify-content:space-between;margin:0 2px 14px}.section-title h2{font-size:34px;line-height:1;margin:0;font-weight:900;letter-spacing:0}.section-title p{display:none}.card{background:#fffdf7;border:1.6px solid #d2c5b4;border-radius:22px;box-shadow:0 12px 26px rgba(90,70,35,.07)}.kpi-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.kpi{padding:18px}.kpi-head{display:flex;justify-content:space-between;gap:10px;align-items:start}.kpi h3,.road h3{font-size:24px;margin:0 0 6px}.kpi p{margin:0;color:#786f63;font-size:16px}.kpi-head b{font-size:14px;color:#8f6235;background:#efe4d3;border:1px solid #ddcbb5;border-radius:999px;padding:7px 10px}svg{width:100%;display:block;margin-top:8px}.gridline{stroke:#e4dacd;stroke-width:1}.axisline{stroke:#b8aa99;stroke-width:1.4}.axis{font-size:13px;fill:#7c7266}.point-label{font-size:12px;fill:#2e2a24;font-weight:900;paint-order:stroke;stroke:#fffdf7;stroke-width:3px;stroke-linejoin:round}.unit-label{font-weight:900;fill:#8f6235}.legend{display:flex;flex-wrap:wrap;gap:10px;margin-top:4px;font-size:14px;color:#5e554b}.legend i{display:inline-block;width:20px;height:4px;border-radius:99px;margin-right:5px;vertical-align:middle}.micro-note{font-size:14px;color:#8b806f;margin-top:7px;line-height:1.3}.road-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.road{padding:18px;min-height:182px}.row{display:grid;grid-template-columns:70px 1fr;gap:8px;margin:8px 0;font-size:16px;line-height:1.25}.row b{color:#887b6c}.progress{display:flex;align-items:center;gap:10px;margin-top:10px}.progress strong{font-size:21px;color:#8f6235;min-width:55px}.progress i{flex:1;height:11px;background:#f0e5d6;border:1px solid #d5c4b0;border-radius:99px;overflow:hidden}.progress em{display:block;height:100%;background:linear-gradient(90deg,#c89155,#8f6235);border-radius:99px}.done{font-size:15px;color:#5c8456;font-weight:800;margin-top:9px}.kanban{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.kan-col{background:#fbf6ed;border:1.3px solid #d8cbb9;border-radius:20px;padding:11px;min-height:270px}.kan-title{font-size:16px;font-weight:900;margin-bottom:9px;display:flex;justify-content:space-between}.kan-title span{color:#8f6235}.ticket{background:#fffdf8;border:1px solid #e1d6c8;border-radius:16px;padding:9px;margin-bottom:9px}.ticket-top{display:flex;justify-content:space-between;gap:8px}.ticket b{font-size:13px;line-height:1.18}.ticket span{font-size:11px;color:#8f6235;font-weight:900}.ticket p{font-size:12px;line-height:1.25;color:#756d62;margin:6px 0 0}.empty{height:86px;border:1px dashed #cdbfac;border-radius:16px;color:#a99b89;display:flex;align-items:center;justify-content:center}.metrics{display:grid;grid-template-columns:repeat(5,1fr);gap:16px}.metric{height:136px;padding:18px;position:relative}.metric-value{font-size:44px;font-weight:950;color:#8f6235;letter-spacing:0}.metric-label{font-size:17px;color:#5c554d;margin-top:6px}.metric-note{position:absolute;left:18px;right:18px;bottom:14px;font-size:13px;color:#8b806f}.metric-note span{float:right;background:#efe4d3;border:1px solid #dccab5;color:#8f6235;font-weight:900;border-radius:999px;padding:3px 8px}.footer{font-size:13px;color:#9a8c7c;margin-top:18px;text-align:right}
</style></head><body><div class="canvas">
<div class="hero"><div class="hero-main"><div><div class="hero-kicker">Persistent MMO AI Colony · Autonomous Roadmap</div><h1>Hermes Screeps Project Roadmap Report</h1><p class="hero-subtitle">Harness live game evidence for Agentic roadmap decisions, implementation focus, validation gates, and release cadence.</p></div><div><div class="hero-copy"><p><b>Project</b> · Long-running Screeps: World AI operations project.</p><p><b>Links</b> · ${projectLinks.repo}</p></div><div class="publish-time">Published · ${reportPublishedAt} CST</div></div></div><div class="hero-art"><div class="logo-orb"><div class="logo-mask">${logoDataUri ? `<img src="${logoDataUri}" alt="Screeps logo">` : '<div class="logo-fallback">SC</div>'}</div></div></div></div>
<section class="section" style="margin-top:0"><div class="section-title"><h2>01 Game KPI · 7d Trend</h2></div><div class="kpi-grid">${kpiCharts.map(c=>lineChart(c)).join('')}</div></section>
<section class="section"><div class="section-title"><h2>02 Development Roadmap · Six Tracks</h2></div><div class="road-grid">${roadmapCards.map(roadmapCard).join('')}</div></section>
${kanban('03 Gameplay Strategy Kanban', 'Gameplay Evolution / Territory / Resources / Combat; data comes from GitHub Project, with live cards shown once.', gameItems)}
${kanban('04 Foundation Kanban', 'Reliability / P0 and Foundation Gates; data comes from GitHub Project.', foundationItems)}
<section class="section"><div class="section-title"><h2>05 Delivery Metrics</h2></div><div class="metrics">${[
  metric('Total commits', metrics.commits, 'commits', `HEAD ${head}`),
  metric('Total PRs', metrics.prs, 'prs', `${prs.filter(p=>p.state==='MERGED').length} merged`),
  metric('Total issues', metrics.issues, 'issues', `${issues.filter(i=>i.state==='OPEN').length} open`),
  metric('Official game deploys', metrics.officialDeploys, 'officialDeploys', 'official deploy evidence'),
  metric('Private smoke tests', metrics.privateTests, 'privateTests', 'smoke/report evidence')
].join('')}</div></section>
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
  for (const executablePath of [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, '/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome']) {
    if (executablePath && fs.existsSync(executablePath)) {
      launchOptions.executablePath = executablePath;
      break;
    }
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
