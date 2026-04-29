#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repo = path.resolve(process.argv[2] || process.cwd());
const renderer = path.join(repo, 'scripts', 'render-screeps-roadmap.js');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadmap-renderer-check-'));
const pngPath = path.join(tmpDir, 'roadmap.png');
const htmlPath = pngPath.replace(/\.png$/, '.html');
const repoUrl = 'https://github.com/lanyusea/screeps';
const failures = [];

function fail(message) {
  failures.push(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function decodeEntities(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function tagText(fragment) {
  return decodeEntities(fragment.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function visibleText(html) {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : html;
  return tagText(body);
}

function pngLooksValid(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const stat = fs.statSync(filePath);
  if (stat.size < 1000) return false;
  const signature = fs.readFileSync(filePath).subarray(0, 8);
  return signature.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

const run = spawnSync(process.execPath, [renderer, repo, pngPath], {
  cwd: repo,
  env: { ...process.env, SCREEPS_ROADMAP_PREVIEW: '1' },
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 120000
});

assert(run.status === 0, `renderer exited with status ${run.status}: ${run.stderr || run.stdout}`);
assert(fs.existsSync(htmlPath), `renderer did not write HTML next to PNG: ${htmlPath}`);
assert(pngLooksValid(pngPath), `renderer did not write a valid PNG: ${pngPath}`);

if (fs.existsSync(htmlPath)) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : html;
  const text = visibleText(html);

  const oldMarkers = [
    { name: 'old Chinese KPI summary', value: '\u7528\u771f\u5b9e\u6e38\u620f KPI' },
    { name: 'Target line', value: 'Target' },
    { name: 'old Chinese KPI heading', value: '\u6e38\u620f\u5185\u90e8' },
    { name: 'old developing label', value: '\u5f00\u53d1\u4e2d' },
    { name: 'old private-smoke label', value: '\u79c1\u670d\u9a8c\u8bc1\u4e2d' },
    { name: 'old online label', value: '\u5df2\u4e0a\u7ebf' },
    { name: 'old badge', value: 'KPI/Kanban' }
  ];

  for (const marker of oldMarkers) {
    assert(!text.includes(marker.value), `visible text still contains ${marker.name}: ${marker.value}`);
  }

  assert(!/https:\/\/screeps\.com\/?/i.test(text), 'visible text still contains the Screeps game link');
  assert(!/\bshardX\s*\/\s*E48S28\b|\bE48S28\b/.test(text), 'visible text still contains the room target');
  assert(!/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text), 'visible text still contains CJK characters');

  const linksMatch = body.match(/<p>\s*<b>Links<\/b>([\s\S]*?)<\/p>/i);
  assert(Boolean(linksMatch), 'Links line is missing from hero copy');
  if (linksMatch) {
    const linksText = tagText(linksMatch[0]);
    const urls = linksText.match(/https?:\/\/[^\s]+/g) || [];
    assert(urls.length === 1 && urls[0] === repoUrl, `Links line should contain only ${repoUrl}; saw ${urls.join(', ') || 'none'}`);
  }

  assert(
    /<div class="logo-orb">\s*<div class="logo-mask">[\s\S]*?<img\b[^>]*alt="Screeps logo"/.test(body),
    'hero logo should be centered inside the circular logo mask'
  );

  const kpiTitles = [...body.matchAll(/<div class="card kpi">[\s\S]*?<h3>([\s\S]*?)<\/h3>/g)].map(match => tagText(match[1]));
  assert(
    JSON.stringify(kpiTitles) === JSON.stringify(['Territory', 'Resources', 'Combat']),
    `KPI chart titles should be Territory, Resources, Combat; saw ${JSON.stringify(kpiTitles)}`
  );

  const latestSummaryDir = path.join(repo, 'runtime-artifacts', 'screeps-monitor');
  const hasMonitorSummary = fs.existsSync(latestSummaryDir)
    && fs.readdirSync(latestSummaryDir).some(name => /^summary-.*\.svg$/.test(name));
  const territoryCard = body.match(/<div class="card kpi">[\s\S]*?<h3>Territory<\/h3>[\s\S]*?<\/div><\/div>/);
  assert(Boolean(territoryCard), 'Territory KPI card is missing');
  if (territoryCard && !hasMonitorSummary) {
    const territoryText = tagText(territoryCard[0]);
    assert(!territoryText.includes('Latest monitor RCL: 3'), 'Territory KPI must not use fallback RCL 3 when no monitor evidence exists');
  }

  const roadmapData = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(repo, 'docs', 'roadmap-data.json'), 'utf8'));
    } catch {
      return null;
    }
  })();

  const resourcesCard = body.match(/<div class="card kpi">[\s\S]*?<h3>Resources<\/h3>[\s\S]*?<\/div><\/div>/);
  assert(Boolean(resourcesCard), 'Resources KPI card is missing');

  if (roadmapData) {
    const pageKpis = roadmapData.report?.kpiCards || [];
    for (const pageCard of pageKpis) {
      const renderedCard = body.match(new RegExp(`<div class="card kpi">[\\s\\S]*?<h3>${pageCard.title}<\\/h3>[\\s\\S]*?<\\/div><\\/div>`));
      assert(Boolean(renderedCard), `KPI card from Pages data is missing: ${pageCard.title}`);
      if (!renderedCard) continue;
      const cardHtml = renderedCard[0];
      const observedValues = (pageCard.series || []).flatMap(series => series.values || []).filter(value => Number.isFinite(Number(value)));
      if (observedValues.length > 0) {
        assert(!cardHtml.includes('data-kpi-unavailable="true"'), `${pageCard.title} has observed Pages values but rendered as unavailable`);
        for (const value of new Set(observedValues.map(value => String(Number(value))))) {
          assert(cardHtml.includes(`class="point-label">${value}</text>`), `${pageCard.title} should render observed Pages KPI value ${value}`);
        }
      } else {
        assert(cardHtml.includes('data-kpi-unavailable="true"'), `${pageCard.title} has no observed Pages values and must render explicit unavailable state`);
      }
      for (const series of pageCard.series || []) {
        assert(cardHtml.includes(`>${series.label}</span>`), `${pageCard.title} should render Pages series label ${series.label}`);
      }
    }

    for (const processCard of roadmapData.report?.processCards || []) {
      assert(text.includes(`${processCard.value} ${processCard.label}`), `Process metric should match Pages data: ${processCard.value} ${processCard.label}`);
    }
  }

  assert(!body.includes('No observed resource KPI history is available'), 'renderer should not use the old image-only resource placeholder copy');
  assert(!body.includes('Latest monitor RCL'), 'renderer should not use the old image-only monitor RCL fallback copy');
}

if (failures.length > 0) {
  console.error(`Roadmap renderer check failed for ${htmlPath}`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('Roadmap renderer check passed.');
