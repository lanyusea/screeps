#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repo = path.resolve(process.argv[2] || process.cwd());
const renderer = path.join(repo, 'scripts', 'render-screeps-roadmap.js');
const dataPath = path.join(repo, 'docs', 'roadmap-data.json');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadmap-renderer-check-'));
const pngPath = path.join(tmpDir, 'roadmap.png');
const htmlPath = pngPath.replace(/\.png$/, '.html');
const failures = [];
const EXPECTED_PROJECT_DOMAINS = [
  'Agent OS',
  'Change-control',
  'Runtime monitor',
  'Release/deploy',
  'Bot capability',
  'Combat',
  'Territory/Economy',
  'Gameplay Evolution',
  'RL flywheel',
  'Docs/process'
];
const EXPECTED_ROADMAP_DOMAINS = EXPECTED_PROJECT_DOMAINS.filter(domain => domain !== 'Docs/process');

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

function esc(v) {
  return String(v ?? 'unavailable').replace(/[&<>"']/g, s => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[s]));
}

function displayValue(v) {
  if (v === null || v === undefined || v === '') return 'unavailable';
  return String(v);
}

function pngLooksValid(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const stat = fs.statSync(filePath);
  if (stat.size < 1000) return false;
  const signature = fs.readFileSync(filePath).subarray(0, 8);
  return signature.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

function readRoadmapData() {
  try {
    return JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  } catch (error) {
    fail(`failed to read docs/roadmap-data.json: ${error.message}`);
    return {};
  }
}

function findBlockByToken(html, token, nextTokens) {
  const start = html.indexOf(token);
  if (start === -1) return '';
  const ends = nextTokens
    .map(next => html.indexOf(next, start + token.length))
    .filter(index => index !== -1);
  const end = ends.length > 0 ? Math.min(...ends) : html.length;
  return html.slice(start, end);
}

function findSectionByHeading(html, heading) {
  const headingToken = `<h2>${esc(heading)}</h2>`;
  const headingStart = html.indexOf(headingToken);
  if (headingStart === -1) return '';
  const sectionStart = html.lastIndexOf('<section', headingStart);
  const nextSection = html.indexOf('<section', headingStart + headingToken.length);
  const start = sectionStart === -1 ? headingStart : sectionStart;
  const end = nextSection === -1 ? html.length : nextSection;
  return html.slice(start, end);
}

function assertRendererDoesNotRebuildReportData() {
  const source = fs.readFileSync(renderer, 'utf8');
  const bannedSourceMarkers = [
    'gh pr list',
    'gh issue list',
    'gh project item-list',
    'runtime-artifacts/screeps-monitor',
    'roadmap-render-state',
    'Latest monitor RCL',
    'explicitOfficialDeployEvidence',
    'explicitPrivateSmokeEvidence',
    'projectOfficialDeploys',
    'privateTests'
  ];
  for (const marker of bannedSourceMarkers) {
    assert(!source.includes(marker), `renderer still contains image-only data path marker: ${marker}`);
  }
}

function assertDomainKanbanFiveColumnCss(html) {
  const compact = String(html).replace(/\s+/g, '');
  assert(
    compact.includes('.kanban{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));'),
    'domain board renderer CSS must use five kanban columns'
  );
  assert(
    !/\.kanban\{[^}]*grid-template-columns:repeat\(7,/s.test(compact),
    'domain board renderer CSS must not use the old seven-column layout'
  );
}

function assertNoOldVisibleFallbacks(text) {
  const oldMarkers = [
    { name: 'old Chinese KPI summary', value: '\u7528\u771f\u5b9e\u6e38\u620f KPI' },
    { name: 'Target line', value: 'Target' },
    { name: 'old Chinese KPI heading', value: '\u6e38\u620f\u5185\u90e8' },
    { name: 'old developing label', value: '\u5f00\u53d1\u4e2d' },
    { name: 'old private-smoke label', value: '\u79c1\u670d\u9a8c\u8bc1\u4e2d' },
    { name: 'old online label', value: '\u5df2\u4e0a\u7ebf' },
    { name: 'old badge', value: 'KPI/Kanban' },
    { name: 'old monitor fallback', value: 'Latest monitor RCL' },
    { name: 'old territory no-data copy', value: 'No observed seven-day territory KPI history' },
    { name: 'old resource no-data copy', value: 'No observed resource KPI history' },
    { name: 'old combat no-data copy', value: 'No observed combat KPI history' },
    { name: 'old hard-coded territory proof', value: 'Single-room baseline' },
    { name: 'old hard-coded resource proof', value: 'Resource payload exists' },
    { name: 'old hard-coded combat proof', value: 'Tactical bridge is ready' },
    { name: 'old hard-coded foundation proof', value: 'Private smoke and release-gate work remain tracked' },
    { name: 'old official deploy label', value: 'Official game deploys' },
    { name: 'old project-source copy', value: 'data comes from GitHub Project' },
    { name: 'old roadmap section heading', value: '02 Development Roadmap - Six Tracks' },
    { name: 'old gameplay kanban heading', value: '03 Gameplay Strategy Kanban' },
    { name: 'old foundation kanban heading', value: '04 Foundation Delivery Kanban' },
    { name: 'old resource track', value: 'Resource Economy' },
    { name: 'old reliability track', value: 'Reliability / P0' },
    { name: 'old foundation track', value: 'Foundation Gates' }
  ];

  for (const marker of oldMarkers) {
    assert(!text.includes(marker.value), `visible text still contains ${marker.name}: ${marker.value}`);
  }

  assert(!/https:\/\/screeps\.com\/?/i.test(text), 'visible text still contains the Screeps game link');
  assert(!/\bshardX\s*\/\s*E48S29\b|\bE48S29\b/.test(text), 'visible text still contains the room target');
  assert(!/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text), 'visible text still contains CJK characters');
}

function assertDomainClassification(report, text) {
  const roadmapTitles = (report.roadmapCards || []).map(card => String(card.title || ''));
  assert(
    JSON.stringify(roadmapTitles) === JSON.stringify(EXPECTED_ROADMAP_DOMAINS),
    `roadmap cards should be current Project Domain categories; saw ${JSON.stringify(roadmapTitles)}`
  );

  const kanbanTitles = (report.domainKanban || []).map(column => String(column.title || ''));
  assert(
    JSON.stringify(kanbanTitles) === JSON.stringify(EXPECTED_PROJECT_DOMAINS),
    `domain board columns should be current Project Domain categories; saw ${JSON.stringify(kanbanTitles)}`
  );

  assert(text.includes('02 Project Domains'), 'Domain roadmap heading is missing');
  assert(text.includes('03 Project Domain Board'), 'Domain board heading is missing');
  for (const domain of EXPECTED_PROJECT_DOMAINS) {
    assert(text.includes(domain), `visible report is missing Project Domain category: ${domain}`);
  }
}

function assertProjectDomainSectionSplit(body) {
  const roadmapSection = findSectionByHeading(body, '02 Project Domains');
  const kanbanSection = findSectionByHeading(body, '03 Project Domain Board');
  assert(Boolean(roadmapSection), 'Project Domains section is missing');
  assert(Boolean(kanbanSection), 'Project Domain Board section is missing');
  assert(!tagText(roadmapSection).includes('Docs/process'), 'Project Domains section should exclude Docs/process');
  assert(tagText(kanbanSection).includes('Docs/process'), 'Project Domain Board should include Docs/process');
}

function assertKpiCardsMatchPagesData(body, text, cards) {
  const kpiTitles = [...body.matchAll(/<div class="card kpi"[^>]*>[\s\S]*?<h3>([\s\S]*?)<\/h3>/g)]
    .map(match => tagText(match[1]));
  assert(
    JSON.stringify(kpiTitles) === JSON.stringify(cards.map(card => String(card.title))),
    `KPI chart titles should match docs/roadmap-data.json; saw ${JSON.stringify(kpiTitles)}`
  );

  for (const card of cards) {
    const key = esc(card.key || '');
    const block = findBlockByToken(body, `<div class="card kpi" data-kpi-key="${key}"`, [
      '<div class="card kpi" data-kpi-key=',
      '<section class="section"><div class="section-title"><h2>02'
    ]);
    assert(Boolean(block), `KPI card ${card.title} is missing`);
    assert(block.includes(`<h3>${esc(card.title)}</h3>`), `KPI card title does not match JSON: ${card.title}`);
    assert(block.includes(`<p>${esc(card.subtitle)}</p>`), `KPI subtitle does not match JSON for ${card.title}`);
    assert(block.includes(`<b>${esc(card.pill)}</b>`), `KPI pill does not match JSON for ${card.title}`);
    assert(block.includes(esc(card.footer)), `KPI footer does not match JSON for ${card.title}`);

    for (const date of card.dates || []) {
      assert(block.includes(`>${esc(date)}</text>`), `KPI date ${date} missing for ${card.title}`);
    }

    for (const series of card.series || []) {
      assert(block.includes(`data-series-label="${esc(series.label)}"`), `KPI series label missing for ${card.title}: ${series.label}`);
      const values = Array.isArray(series.values) ? series.values : [];
      const statuses = Array.isArray(series.statuses) ? series.statuses : [];
      const observedValues = values
        .map((value, index) => ({ value, status: statuses[index] || '' }))
        .filter(item => item.value !== null && item.value !== undefined && item.value !== '' && Number.isFinite(Number(item.value)));
      for (const item of observedValues) {
        const expected = `data-series="${esc(series.label)}" data-status="${esc(item.status)}" data-value="${esc(Number(item.value))}"`;
        assert(block.includes(expected), `KPI observed value mismatch for ${card.title}/${series.label}: ${item.value}`);
      }
      if (observedValues.length === 0) {
        const fakeZero = `data-series="${esc(series.label)}"`;
        const zeroValue = `data-value="0"`;
        assert(!(block.includes(fakeZero) && block.includes(zeroValue)), `KPI series ${series.label} appears to render a fake zero`);
      }
    }

    const hasObserved = (card.series || []).some(series => (series.values || []).some(value => (
      value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
    )));
    if (hasObserved) {
      assert(!block.includes('data-kpi-unavailable="true"'), `KPI card ${card.title} is marked unavailable despite observed Pages data`);
    } else {
      assert(block.includes('data-kpi-unavailable="true"'), `KPI card ${card.title} must explicitly mark unavailable Pages data`);
      assert(text.includes('No observed KPI data'), `KPI card ${card.title} must state unavailable data explicitly`);
    }
  }
}

function assertRoadmapCardsMatchPagesData(body, cards) {
  for (const card of cards) {
    const token = `data-roadmap-title="${esc(card.title)}"`;
    const block = findBlockByToken(body, token, ['data-roadmap-title="', '<section class="section"><div class="section-title"><h2>03']);
    assert(Boolean(block), `roadmap card missing for ${card.title}`);
    assert(block.includes(`<h3>${esc(card.title)}</h3>`), `roadmap title mismatch for ${card.title}`);
    assert(block.includes(esc(card.goal)), `roadmap goal mismatch for ${card.title}`);
    assert(block.includes(esc(card.next)), `roadmap next action mismatch for ${card.title}`);
    assert(block.includes(`<strong>${esc(displayValue(card.progress))}%</strong>`), `roadmap progress mismatch for ${card.title}`);
    assert(block.includes(esc(card.status)), `roadmap status mismatch for ${card.title}`);
  }
}

function assertKanbanMatchesPagesData(body, columns, sectionTitle) {
  const sectionBlock = findSectionByHeading(body, sectionTitle);
  assert(Boolean(sectionBlock), `kanban section missing: ${sectionTitle}`);
  for (const column of columns) {
    const token = `data-kanban-column="${esc(column.title)}"`;
    const block = findBlockByToken(sectionBlock, token, ['data-kanban-column="']);
    const items = Array.isArray(column.items) ? column.items : [];
    assert(Boolean(block), `kanban column missing: ${sectionTitle}/${column.title}`);
    assert(block.includes(`${esc(column.title)} <span>${items.length}</span>`), `kanban count mismatch for ${sectionTitle}/${column.title}`);
    for (const item of items) {
      assert(block.includes(`data-kanban-title="${esc(item.title)}"`), `kanban title mismatch for ${sectionTitle}/${column.title}: ${item.title}`);
      assert(block.includes(`data-kanban-description="${esc(item.description || '')}"`), `kanban description mismatch for ${sectionTitle}/${column.title}: ${item.title}`);
      assert(block.includes(`<span>${esc(item.priority || '')}</span>`), `kanban priority mismatch for ${sectionTitle}/${column.title}: ${item.title}`);
    }
  }
}

function assertProcessCardsMatchPagesData(body, cards) {
  for (const card of cards) {
    const value = displayValue(card.value);
    const token = `data-process-label="${esc(card.label)}" data-process-value="${esc(value)}"`;
    const block = findBlockByToken(body, token, ['data-process-label="', '<div class="footer">']);
    assert(Boolean(block), `process card missing for ${card.label}`);
    assert(block.includes(`<div class="metric-value"`), `process value element missing for ${card.label}`);
    assert(block.includes(`>${esc(value)}</div>`), `process value mismatch for ${card.label}`);
    assert(block.includes(`<div class="metric-label">${esc(card.label)}</div>`), `process label mismatch for ${card.label}`);
    assert(block.includes(esc(card.detail || '')), `process detail mismatch for ${card.label}`);
    if (card.delta) {
      assert(block.includes(`<span>${esc(card.delta)}</span>`), `process delta mismatch for ${card.label}`);
    }
  }
}

assertRendererDoesNotRebuildReportData();

const roadmapData = readRoadmapData();
const report = roadmapData.report || {};
const run = spawnSync(process.execPath, [renderer, repo, pngPath], {
  cwd: repo,
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
  const repoUrl = String(roadmapData.repo?.url || 'https://github.com/lanyusea/screeps');

  assertNoOldVisibleFallbacks(text);
  assert(body.includes('data-roadmap-source="docs/roadmap-data.json"'), 'rendered HTML should identify docs/roadmap-data.json as the source');
  assert(text.includes(String(roadmapData.title || 'Hermes Screeps Project Roadmap Report')), 'report title should come from docs/roadmap-data.json');
  assert(text.includes(String(roadmapData.generatedAtCst || roadmapData.generatedAt || 'unavailable')), 'published time should come from docs/roadmap-data.json');

  const linksMatch = body.match(/<p>\s*<b>Links<\/b>[\s\S]*?<\/p>/i);
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

  assertDomainKanbanFiveColumnCss(html);
  assertKpiCardsMatchPagesData(body, text, report.kpiCards || []);
  assertDomainClassification(report, text);
  assertProjectDomainSectionSplit(body);
  assertRoadmapCardsMatchPagesData(body, report.roadmapCards || []);
  assertKanbanMatchesPagesData(body, report.domainKanban || [], '03 Project Domain Board');
  assertProcessCardsMatchPagesData(body, report.processCards || []);
}

if (failures.length > 0) {
  console.error(`Roadmap renderer check failed for ${htmlPath}`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('Roadmap renderer check passed.');
