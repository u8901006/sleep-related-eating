#!/usr/bin/env node

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const API_BASE = 'https://open.bigmodel.cn/api/coding/paas/v4';
const MODELS = ['GLM-5-Turbo', 'GLM-4.7', 'GLM-4.7-Flash'];
const MAX_TOKENS = 50000;
const TIMEOUT_MS = 480_000;
const MAX_RETRIES = 3;

const TOPIC_TAGS = [
  '睡眠相關飲食障礙(SRED)', '夜食症候群(NES)', '夢遊/睡眠行走',
  'NREM異睡症', '藥物誘發', 'Z藥物', '多項睡眠檢查(PSG)',
  '肥胖與代謝', '鑑別診斷', '治療與管理', '神經生物學',
  '睡眠呼吸中止症(OSA)', '不寧腿症候群(RLS)', '食慾調節',
  '睡眠架構', '週期性肢體運動', '認知行為治療', '營養與代謝',
  '精神科共病', '兒童/青少年睡眠', '食慾激素', 'HPA軸與壓力',
  '神經影像學', '藥理學', '病例報告', '系統性回顧',
];

const SYSTEM_PROMPT = `你是睡眠醫學與飲食障礙領域的專業研究分析師，專精於睡眠相關飲食障礙（Sleep-Related Eating Disorder, SRED）及其相關研究。
你需要閱讀每日最新的 PubMed 文獻，進行深度分析、分類和總結。

請嚴格按照以下 JSON 結構輸出，不要輸出任何 JSON 以外的內容：
{
  "market_summary": "1-2句話的今日SRED研究概覽，包含研究趨勢和亮點",
  "top_picks": [
    {
      "rank": 1,
      "title": "論文標題",
      "journal": "期刊名",
      "emoji": "相關emoji",
      "clinical_utility": "高|中|低",
      "pico": {
        "population": "研究對象",
        "intervention": "介入/暴露",
        "comparison": "對照組",
        "outcome": "結果"
      },
      "summary": "2-3句話的詳細中文摘要",
      "tags": ["標籤1", "標籤2"]
    }
  ],
  "all_papers": [
    {
      "title": "論文標題",
      "journal": "期刊名",
      "emoji": "相關emoji",
      "clinical_utility": "高|中|低",
      "summary": "1-2句話的中文摘要",
      "tags": ["標籤1"]
    }
  ],
  "keywords": ["關鍵字1", "關鍵字2"],
  "topic_distribution": [
    {"topic": "主題名稱", "count": 數量}
  ]
}

重要規則：
1. top_picks 選出 3-8 篇最重要/最相關的論文，其餘放入 all_papers
2. clinical_utility 只能是「高」「中」「低」三選一
3. tags 必須從以下清單中選擇：${TOPIC_TAGS.join('、')}
4. topic_distribution 統計各主題的論文分布
5. 所有摘要必須使用繁體中文撰寫
6. keywords 提取 10-15 個關鍵字
7. 請確保輸出合法的 JSON 格式`;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { input: 'papers.json', output: '', date: '' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input') opts.input = args[++i];
    else if (args[i] === '--output') opts.output = args[++i];
    else if (args[i] === '--date') opts.date = args[++i];
  }
  return opts;
}

function loadPapers(path) {
  if (!existsSync(path)) return [];
  const data = JSON.parse(readFileSync(path, 'utf-8'));
  return data.papers || [];
}

function buildUserPrompt(papers) {
  const papersText = papers.map((p, i) =>
    `【論文 ${i + 1}】\n標題: ${p.title}\n期刊: ${p.journal}\n日期: ${p.date}\nPMID: ${p.pmid}\n作者: ${p.authors}\n摘要: ${p.abstract || '無摘要'}\nDOI: ${p.doi || 'N/A'}`
  ).join('\n\n');

  return `以下是今日從 PubMed 抓取的 ${papers.length} 篇與睡眠相關飲食障礙（SRED）相關的最新文獻。
請分析這些文獻，選出最重要的 3-8 篇作為 TOP Picks（附 PICO 分析），其餘列入「其他重要文獻」。
請按照系統提示中的 JSON 格式嚴格輸出。

${papersText}`;
}

function robustJSONParse(content) {
  const attempts = [
    () => JSON.parse(content),
    () => {
      const m = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      return m ? JSON.parse(m[1]) : null;
    },
    () => {
      const m = content.match(/\{[\s\S]*\}/);
      if (!m) return null;
      let fixed = m[0]
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/\\n/g, ' ')
        .replace(/\t/g, '  ')
        .replace(/[\x00-\x1f]/g, ' ');
      return JSON.parse(fixed);
    },
    () => {
      let text = content;
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return null;
      let s = m[0];
      s = s.replace(/\/\/.*$/gm, '');
      s = s.replace(/,\s*([}\]])/g, '$1');
      s = s.replace(/'/g, '"');
      s = s.replace(/(\w+)\s*:/g, '"$1":');
      return JSON.parse(s);
    },
  ];
  for (const fn of attempts) {
    try {
      const r = fn();
      if (r && typeof r === 'object') return r;
    } catch { /* next attempt */ }
  }
  throw new Error('All JSON parse attempts failed');
}

async function callZhipuAPI(apiKey, papers) {
  const userPrompt = buildUserPrompt(papers);
  for (const model of MODELS) {
    console.log(`Trying model: ${model}`);
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(`${API_BASE}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: userPrompt },
            ],
            temperature: 0.3,
            max_tokens: MAX_TOKENS,
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });

        if (res.status === 429) {
          const delay = Math.pow(2, attempt) * 2000;
          console.log(`  Rate limited, retry ${attempt + 1} in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          console.error(`  ${model} error ${res.status}: ${body.slice(0, 200)}`);
          break;
        }

        const data = await res.json();
        const content = data.choices?.[0]?.message?.content;
        if (!content) { console.error('  Empty content'); break; }

        console.log(`  ${model} responded (${content.length} chars), parsing...`);
        const analysis = robustJSONParse(content);
        analysis._model = model;
        return analysis;
      } catch (e) {
        if (e.name === 'TimeoutError') {
          console.error(`  ${model} timed out`);
          break;
        }
        console.error(`  ${model} attempt ${attempt + 1} error: ${e.message}`);
      }
    }
  }
  throw new Error('All models failed');
}

function esc(s) {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const CSS = `:root{--bg:#f6f1e8;--surface:#fffaf2;--line:#d8c5ab;--text:#2b2118;--muted:#766453;--accent:#8c4f2b;--accent-soft:#ead2bf}*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Noto Sans TC',sans-serif;background:var(--bg);color:var(--text);line-height:1.7;padding:20px}.container{max-width:820px;margin:0 auto}header{text-align:center;padding:40px 20px 24px}header h1{font-size:26px;color:var(--accent);margin-bottom:6px}header .subtitle{color:var(--muted);font-size:15px;margin-bottom:14px}.meta{display:flex;justify-content:center;gap:10px;flex-wrap:wrap}.badge{background:var(--surface);border:1px solid var(--line);border-radius:20px;padding:4px 16px;font-size:13px;color:var(--muted)}.badge strong{color:var(--accent)}.summary-card{background:var(--surface);border:1px solid var(--line);border-radius:24px;padding:24px;margin-bottom:24px}.summary-card h2{font-size:17px;color:var(--accent);margin-bottom:10px}.summary-card p{line-height:1.8;font-size:15px}.section{margin-bottom:24px}.section h2{font-size:20px;color:var(--accent);margin-bottom:16px;padding-bottom:8px;border-bottom:2px solid var(--accent-soft)}.featured-card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:20px;margin-bottom:18px;position:relative}.rank-badge{position:absolute;top:-10px;left:16px;background:var(--accent);color:#fff;border-radius:12px;padding:2px 14px;font-size:12px;font-weight:700}.card-header{display:flex;align-items:flex-start;gap:8px;margin-bottom:6px}.card-emoji{font-size:22px;flex-shrink:0}.card-title{font-size:16px;font-weight:600;line-height:1.5}.card-title a{color:var(--text);text-decoration:none}.card-title a:hover{color:var(--accent)}.card-meta{font-size:12px;color:var(--muted);margin-bottom:10px;display:flex;flex-wrap:wrap;gap:6px;align-items:center}.utility-badge{display:inline-block;padding:2px 10px;border-radius:10px;font-size:11px;font-weight:700}.utility-high{background:#e8f5e9;color:#2e7d32}.utility-medium{background:#fff3e0;color:#e65100}.utility-low{background:#f5f5f5;color:#757575}.pico-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:12px 0}.pico-item{background:var(--bg);border-radius:12px;padding:12px}.pico-label{font-size:10px;font-weight:700;color:var(--accent);text-transform:uppercase;margin-bottom:3px;letter-spacing:.5px}.pico-value{font-size:13px;line-height:1.5}.card-summary{font-size:14px;line-height:1.7;margin:8px 0}.card-tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:10px}.tag{background:var(--accent-soft);color:var(--accent);padding:2px 10px;border-radius:10px;font-size:11px;font-weight:500}.paper-card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:12px}.paper-card .card-title{font-size:15px}.paper-card .card-summary{font-size:13px}.topic-section{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:20px;margin-bottom:24px}.topic-section h2{font-size:18px;color:var(--accent);margin-bottom:14px}.topic-bar{display:flex;align-items:center;margin-bottom:8px}.topic-label{width:160px;font-size:12px;color:var(--muted);text-align:right;padding-right:12px;flex-shrink:0}.topic-fill-wrap{flex:1;height:22px;background:var(--bg);border-radius:11px;overflow:hidden}.topic-fill{height:100%;background:var(--accent);border-radius:11px;display:flex;align-items:center;justify-content:flex-end;padding-right:8px;color:#fff;font-size:11px;font-weight:600;min-width:28px;transition:width .3s}.keywords-section{margin-bottom:24px}.keywords-section h2{font-size:18px;color:var(--accent);margin-bottom:12px}.keyword-tags{display:flex;flex-wrap:wrap;gap:8px}.keyword-tag{background:var(--surface);border:1px solid var(--line);padding:4px 14px;border-radius:20px;font-size:12px;color:var(--accent)}.clinic-banner{background:var(--surface);border:2px solid var(--accent);border-radius:16px;padding:28px 24px;text-align:center;margin:32px 0 24px}.clinic-banner h3{color:var(--accent);font-size:19px;margin-bottom:16px}.clinic-links{display:flex;justify-content:center;gap:12px;flex-wrap:wrap}.clinic-links a{display:inline-block;padding:8px 22px;border-radius:20px;text-decoration:none;font-size:14px;font-weight:600;transition:transform .2s,box-shadow .2s}.clinic-links a:hover{transform:translateY(-2px);box-shadow:0 4px 12px rgba(140,79,43,.2)}.btn-primary{background:var(--accent);color:#fff}.btn-secondary{background:var(--accent-soft);color:var(--accent)}.footer-nav{text-align:center;margin:24px 0 8px}.footer-nav a{color:var(--accent);text-decoration:none;font-size:14px;font-weight:600;padding:8px 20px;border:1px solid var(--line);border-radius:20px;background:var(--surface);transition:background .2s}.footer-nav a:hover{background:var(--accent-soft)}footer{text-align:center;padding:24px;color:var(--muted);font-size:12px;line-height:1.8}footer a{color:var(--accent);text-decoration:none}@media(max-width:600px){body{padding:12px}header h1{font-size:21px}.pico-grid{grid-template-columns:1fr}.topic-label{width:100px;font-size:11px}.clinic-links{flex-direction:column;align-items:center}}`;

function featuredCardHTML(p) {
  const uClass = p.clinical_utility === '高' ? 'high' : p.clinical_utility === '中' ? 'medium' : 'low';
  const pico = p.pico || {};
  const tagsHTML = (p.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('');
  const picoHTML = (pico.population || pico.intervention || pico.comparison || pico.outcome)
    ? `<div class="pico-grid">
        <div class="pico-item"><div class="pico-label">Population 研究對象</div><div class="pico-value">${esc(pico.population || '—')}</div></div>
        <div class="pico-item"><div class="pico-label">Intervention 介入</div><div class="pico-value">${esc(pico.intervention || '—')}</div></div>
        <div class="pico-item"><div class="pico-label">Comparison 對照</div><div class="pico-value">${esc(pico.comparison || '—')}</div></div>
        <div class="pico-item"><div class="pico-label">Outcome 結果</div><div class="pico-value">${esc(pico.outcome || '—')}</div></div>
      </div>` : '';

  return `<div class="featured-card">
  <span class="rank-badge">#${p.rank || 1}</span>
  <div class="card-header"><span class="card-emoji">${p.emoji || '📄'}</span>
    <div class="card-title">${esc(p.title)}</div></div>
  <div class="card-meta"><span>${esc(p.journal)}</span>
    <span class="utility-badge utility-${uClass}">臨床價值：${esc(p.clinical_utility)}</span></div>
  ${picoHTML}
  <p class="card-summary">${esc(p.summary)}</p>
  <div class="card-tags">${tagsHTML}</div>
</div>`;
}

function paperCardHTML(p) {
  const uClass = p.clinical_utility === '高' ? 'high' : p.clinical_utility === '中' ? 'medium' : 'low';
  const tagsHTML = (p.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('');
  return `<div class="paper-card">
  <div class="card-header"><span class="card-emoji">${p.emoji || '📄'}</span>
    <div class="card-title">${esc(p.title)}</div></div>
  <div class="card-meta"><span>${esc(p.journal)}</span>
    <span class="utility-badge utility-${uClass}">臨床價值：${esc(p.clinical_utility)}</span></div>
  <p class="card-summary">${esc(p.summary)}</p>
  <div class="card-tags">${tagsHTML}</div>
</div>`;
}

function topicChartHTML(topics) {
  if (!topics || !topics.length) return '';
  const maxCount = Math.max(...topics.map(t => t.count), 1);
  const bars = topics.map(t => {
    const pct = Math.round((t.count / maxCount) * 100);
    return `<div class="topic-bar">
      <span class="topic-label">${esc(t.topic)}</span>
      <div class="topic-fill-wrap"><div class="topic-fill" style="width:${Math.max(pct, 8)}%">${t.count}</div></div>
    </div>`;
  }).join('');
  return `<div class="topic-section"><h2>📊 主題分布</h2>${bars}</div>`;
}

function keywordsHTML(kws) {
  if (!kws || !kws.length) return '';
  const tags = kws.map(k => `<span class="keyword-tag">${esc(k)}</span>`).join('');
  return `<div class="keywords-section"><h2>🏷️ 關鍵字</h2><div class="keyword-tags">${tags}</div></div>`;
}

function generateHTML(analysis, date, paperCount, model) {
  const summary = analysis.market_summary || '今日無新文獻。';
  const topPicks = (analysis.top_picks || []).map(featuredCardHTML).join('\n');
  const allPapers = (analysis.all_papers || []).map(paperCardHTML).join('\n');
  const topics = topicChartHTML(analysis.topic_distribution);
  const kws = keywordsHTML(analysis.keywords);

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>🌙 SRED 每日研究簡報 | ${esc(date)}</title>
<meta name="description" content="睡眠相關飲食障礙 (SRED) 每日研究文獻簡報 - ${esc(date)}">
<meta name="robots" content="index, follow">
<link rel="canonical" href="https://u8901006.github.io/sleep-related-eating/sred-${esc(date)}.html">
<style>${CSS}</style>
</head>
<body>
<div class="container">
  <header>
    <h1>🌙 睡眠相關飲食障礙 (SRED) 每日研究簡報</h1>
    <p class="subtitle">Sleep-Related Eating Disorder Research Daily Briefing</p>
    <div class="meta">
      <span class="badge">📅 ${esc(date)}</span>
      <span class="badge">📄 今日新文獻 <strong>${paperCount}</strong> 篇</span>
    </div>
  </header>

  <main>
    <div class="summary-card">
      <h2>📊 今日概覽</h2>
      <p>${esc(summary)}</p>
    </div>

    ${topPicks ? `<div class="section"><h2>⭐ TOP Picks 精選文獻</h2>${topPicks}</div>` : ''}
    ${allPapers ? `<div class="section"><h2>📚 其他重要文獻</h2>${allPapers}</div>` : ''}
    ${topics}
    ${kws}
  </main>

  <div class="clinic-banner">
    <h3>🏥 李政洋身心診所</h3>
    <div class="clinic-links">
      <a href="https://www.leepsyclinic.com/" class="btn-primary" target="_blank" rel="noopener">診所首頁</a>
      <a href="https://blog.leepsyclinic.com/" class="btn-secondary" target="_blank" rel="noopener">訂閱電子報</a>
      <a href="https://buymeacoffee.com/CYlee" class="btn-secondary" target="_blank" rel="noopener">☕ Buy me a coffee</a>
    </div>
  </div>

  <div class="footer-nav">
    <a href="index.html">📊 歷史報告列表</a>
  </div>

  <footer>
    <p>資料來源：<a href="https://pubmed.ncbi.nlm.nih.gov/" target="_blank" rel="noopener">PubMed</a> &nbsp;|&nbsp; AI 分析：${esc(model || 'GLM-5-Turbo')}</p>
    <p>本簡報由自動化系統生成，僅供學術參考，不構成醫療建議</p>
    <p>© ${new Date().getFullYear()} <a href="https://www.leepsyclinic.com/" target="_blank" rel="noopener">李政洋身心診所</a></p>
  </footer>
</div>
</body>
</html>`;
}

function generateNoPapersHTML(date) {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>🌙 SRED 每日研究簡報 | ${esc(date)}</title>
<meta name="description" content="睡眠相關飲食障礙 (SRED) 每日研究文獻簡報 - ${esc(date)} - 今日無新文獻">
<style>${CSS}</style>
</head>
<body>
<div class="container">
  <header>
    <h1>🌙 睡眠相關飲食障礙 (SRED) 每日研究簡報</h1>
    <p class="subtitle">Sleep-Related Eating Disorder Research Daily Briefing</p>
    <div class="meta">
      <span class="badge">📅 ${esc(date)}</span>
      <span class="badge">📄 今日新文獻 <strong>0</strong> 篇</span>
    </div>
  </header>

  <div class="summary-card">
    <h2>📊 今日概覽</h2>
    <p>今日在 PubMed 上未檢索到新的 SRED 相關文獻。這在 SRED 這類小眾研究領域中屬於正常現象。請持續關注本簡報，有新文獻發表時將立即為您分析。</p>
  </div>

  <div class="clinic-banner">
    <h3>🏥 李政洋身心診所</h3>
    <div class="clinic-links">
      <a href="https://www.leepsyclinic.com/" class="btn-primary" target="_blank" rel="noopener">診所首頁</a>
      <a href="https://blog.leepsyclinic.com/" class="btn-secondary" target="_blank" rel="noopener">訂閱電子報</a>
      <a href="https://buymeacoffee.com/CYlee" class="btn-secondary" target="_blank" rel="noopener">☕ Buy me a coffee</a>
    </div>
  </div>

  <div class="footer-nav">
    <a href="index.html">📊 歷史報告列表</a>
  </div>

  <footer>
    <p>資料來源：<a href="https://pubmed.ncbi.nlm.nih.gov/" target="_blank" rel="noopener">PubMed</a></p>
    <p>本簡報由自動化系統生成，僅供學術參考</p>
    <p>© ${new Date().getFullYear()} <a href="https://www.leepsyclinic.com/" target="_blank" rel="noopener">李政洋身心診所</a></p>
  </footer>
</div>
</body>
</html>`;
}

function updateSummarizedPmids(papers, date) {
  const p = resolve(ROOT, 'docs', 'summarized_pmids.json');
  let data = { lastUpdated: date, pmids: {} };
  if (existsSync(p)) {
    try { data = JSON.parse(readFileSync(p, 'utf-8')); } catch { /* keep default */ }
  }
  for (const paper of papers) {
    if (paper.pmid) data.pmids[paper.pmid] = date;
  }
  data.lastUpdated = date;
  writeFileSync(p, JSON.stringify(data, null, 2));
}

async function main() {
  const opts = parseArgs();
  if (!opts.output) throw new Error('--output is required');
  if (!opts.date) opts.date = new Date().toISOString().split('T')[0];

  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) throw new Error('ZHIPU_API_KEY environment variable is required');

  const papers = loadPapers(resolve(ROOT, opts.input));
  console.log(`Loaded ${papers.length} papers`);

  if (papers.length === 0) {
    writeFileSync(opts.output, generateNoPapersHTML(opts.date));
    console.log('No papers → generated empty report');
    return;
  }

  console.log('Calling Zhipu API...');
  const analysis = await callZhipuAPI(apiKey, papers);
  const model = analysis._model || 'GLM-5-Turbo';
  delete analysis._model;

  const html = generateHTML(analysis, opts.date, papers.length, model);
  writeFileSync(opts.output, html);
  console.log(`Report saved to ${opts.output} (${html.length} chars)`);

  updateSummarizedPmids(papers, opts.date);
  console.log(`Updated summarized PMIDs tracking`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
