#!/usr/bin/env node

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PUBMED_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

const SEARCH_QUERIES = [
  `"sleep-related eating disorder"[Title/Abstract] OR "sleep related eating disorder"[Title/Abstract] OR SRED[Title/Abstract] OR "sleep eating"[Title/Abstract] OR "nocturnal sleep-related eating disorder"[Title/Abstract] OR "sleep-related abnormal eating"[Title/Abstract] OR "parasomnia eating"[Title/Abstract]`,

  `("sleep-related eating disorder"[Title/Abstract] OR SRED[Title/Abstract] OR "sleep eating"[Title/Abstract]) AND (parasomnia[Title/Abstract] OR "NREM parasomnia"[Title/Abstract] OR sleepwalking[Title/Abstract] OR somnambulism[Title/Abstract] OR "confusional arousal"[Title/Abstract])`,

  `("sleep-related eating disorder"[Title/Abstract] OR SRED[Title/Abstract] OR "sleep eating"[Title/Abstract] OR "nocturnal eating"[Title/Abstract]) AND (zolpidem[Title/Abstract] OR zopiclone[Title/Abstract] OR eszopiclone[Title/Abstract] OR "Z-drug"[Title/Abstract] OR hypnotic*[Title/Abstract] OR quetiapine[Title/Abstract] OR olanzapine[Title/Abstract] OR mirtazapine[Title/Abstract] OR pramipexole[Title/Abstract] OR ropinirole[Title/Abstract])`,

  `("night eating syndrome"[Title/Abstract] OR "nocturnal eating"[Title/Abstract]) AND (parasomnia[Title/Abstract] OR sleepwalking[Title/Abstract] OR "sleep disorder"[Title/Abstract] OR polysomnography[Title/Abstract] OR "sleep disturbance"[Title/Abstract])`,

  `("sleep-related eating disorder"[Title/Abstract] OR SRED[Title/Abstract] OR "sleep eating"[Title/Abstract]) AND ("obstructive sleep apnea"[Title/Abstract] OR "restless legs syndrome"[Title/Abstract] OR narcolepsy[Title/Abstract] OR insomnia[Title/Abstract] OR "periodic limb movement"[Title/Abstract])`,

  `("sleep-related eating disorder"[Title/Abstract] OR SRED[Title/Abstract] OR "sleep eating"[Title/Abstract] OR "night eating"[Title/Abstract]) AND (obesity[Title/Abstract] OR "metabolic syndrome"[Title/Abstract] OR "weight gain"[Title/Abstract] OR "insulin resistance"[Title/Abstract] OR diabetes[Title/Abstract] OR "body mass index"[Title/Abstract])`,

  `("sleep-related eating disorder"[Title/Abstract] OR SRED[Title/Abstract] OR "sleep eating"[Title/Abstract]) AND (polysomnography[Title/Abstract] OR PSG[Title/Abstract] OR "video-polysomnography"[Title/Abstract] OR EEG[Title/Abstract] OR "sleep architecture"[Title/Abstract])`,

  `("sleep-related eating disorder"[Title/Abstract] OR SRED[Title/Abstract] OR "sleep eating"[Title/Abstract]) AND (topiramate[Title/Abstract] OR clonazepam[Title/Abstract] OR treatment[Title/Abstract] OR management[Title/Abstract] OR "cognitive behavioral therapy"[Title/Abstract] OR CBT[Title/Abstract])`,
];

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { days: 7, maxPapers: 50, output: 'papers.json' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days') opts.days = parseInt(args[++i], 10);
    else if (args[i] === '--max-papers') opts.maxPapers = parseInt(args[++i], 10);
    else if (args[i] === '--output') opts.output = args[++i];
  }
  return opts;
}

function getDateDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}/${m}/${day}`;
}

async function searchPubMed(query, days) {
  const dateFrom = getDateDaysAgo(days);
  const fullQuery = `(${query}) AND "${dateFrom}"[Date - Publication] : "3000"[Date - Publication]`;

  const url = new URL(`${PUBMED_BASE}/esearch.fcgi`);
  url.searchParams.set('db', 'pubmed');
  url.searchParams.set('term', fullQuery);
  url.searchParams.set('retmode', 'json');
  url.searchParams.set('retmax', '100');

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`PubMed esearch failed: ${res.status}`);
  const data = await res.json();
  return (data.esearchresult?.idlist || []).map(String);
}

async function fetchPaperDetails(pmids) {
  if (pmids.length === 0) return [];

  const url = new URL(`${PUBMED_BASE}/efetch.fcgi`);
  url.searchParams.set('db', 'pubmed');
  url.searchParams.set('id', pmids.join(','));
  url.searchParams.set('rettype', 'abstract');
  url.searchParams.set('retmode', 'xml');

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`PubMed efetch failed: ${res.status}`);
  const xml = await res.text();

  return parsePubMedXml(xml);
}

function parsePubMedXml(xml) {
  const articles = [];
  const re = /<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const pmid = xtract(block, 'PMID');
    const title = xtract(block, 'ArticleTitle');
    const journal = between(block, '<Title>', '</Title>')
      || between(block, '<ISOAbbreviation>', '</ISOAbbreviation>')
      || 'Unknown';
    const abstract = extractAbstract(block);
    const doi = block.match(/<ArticleId IdType="doi">([^<]+)<\/ArticleId>/)?.[1] || '';
    const pubDate = extractPubDate(block);
    const authors = extractAuthors(block);
    if (pmid && title) {
      articles.push({
        pmid,
        title: clean(title),
        journal: clean(journal),
        date: pubDate,
        abstract: clean(abstract),
        url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
        doi,
        authors,
      });
    }
  }
  return articles;
}

function xtract(text, tag) {
  const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  return text.match(r)?.[1] || '';
}

function between(text, open, close) {
  const s = text.indexOf(open);
  if (s === -1) return '';
  const e = text.indexOf(close, s + open.length);
  return e === -1 ? '' : text.substring(s + open.length, e);
}

function extractAbstract(block) {
  const parts = [];
  const r = /<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g;
  let m;
  while ((m = r.exec(block)) !== null) {
    const label = m[0].match(/Label="([^"]+)"/)?.[1];
    const txt = m[1].replace(/<[^>]+>/g, '').trim();
    if (txt) parts.push(label ? `${label}: ${txt}` : txt);
  }
  return parts.join(' ');
}

function extractPubDate(block) {
  const y = block.match(/<Year>(\d{4})<\/Year>/)?.[1] || '';
  const mo = block.match(/<Month>([^<]+)<\/Month>/)?.[1] || '';
  const d = block.match(/<Day>(\d+)<\/Day>/)?.[1] || '';
  if (y) return `${y}${mo ? '-' + mo : ''}${d ? '-' + d : ''}`;
  return block.match(/<MedlineDate>([^<]+)<\/MedlineDate>/)?.[1] || '';
}

function extractAuthors(block) {
  const names = [];
  const r = /<Author[^>]*>[\s\S]*?<LastName>([^<]+)<\/LastName>[\s\S]*?<ForeName>([^<]+)<\/ForeName>/g;
  let m;
  while ((m = r.exec(block)) !== null) names.push(`${m[2]} ${m[1]}`);
  return names.length <= 5
    ? names.join(', ')
    : names.slice(0, 5).join(', ') + ' et al.';
}

function clean(t) {
  return t
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function loadSummarizedPmids() {
  const p = resolve(ROOT, 'docs', 'summarized_pmids.json');
  if (!existsSync(p)) return new Set();
  try {
    const d = JSON.parse(readFileSync(p, 'utf-8'));
    return new Set(Object.keys(d.pmids || {}));
  } catch {
    return new Set();
  }
}

async function main() {
  const opts = parseArgs();
  console.log(`Fetching SRED papers from last ${opts.days} days (max ${opts.maxPapers})...`);

  const done = loadSummarizedPmids();
  console.log(`Already summarized: ${done.size} PMIDs`);

  const allPmids = new Set();
  for (let i = 0; i < SEARCH_QUERIES.length; i++) {
    try {
      console.log(`Query ${i + 1}/${SEARCH_QUERIES.length}...`);
      const ids = await searchPubMed(SEARCH_QUERIES[i], opts.days);
      ids.forEach(id => allPmids.add(id));
      console.log(`  → ${ids.length} PMIDs`);
      await new Promise(r => setTimeout(r, 400));
    } catch (e) {
      console.error(`  Query ${i + 1} failed: ${e.message}`);
    }
  }

  const newPmids = [...allPmids].filter(id => !done.has(id));
  console.log(`Total: ${allPmids.size}, New: ${newPmids.length}`);

  if (newPmids.length === 0) {
    writeFileSync(
      resolve(ROOT, opts.output),
      JSON.stringify({ date: new Date().toISOString().split('T')[0], count: 0, papers: [] }, null, 2),
    );
    console.log('No new papers.');
    return;
  }

  const toFetch = newPmids.slice(0, opts.maxPapers);
  const papers = [];
  const batch = 50;
  for (let i = 0; i < toFetch.length; i += batch) {
    const slice = toFetch.slice(i, i + batch);
    console.log(`Fetching batch ${Math.floor(i / batch) + 1} (${slice.length} PMIDs)...`);
    const details = await fetchPaperDetails(slice);
    papers.push(...details);
    await new Promise(r => setTimeout(r, 400));
  }

  const output = {
    date: new Date().toISOString().split('T')[0],
    count: papers.length,
    papers,
  };
  writeFileSync(resolve(ROOT, opts.output), JSON.stringify(output, null, 2));
  console.log(`Saved ${papers.length} papers to ${opts.output}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
