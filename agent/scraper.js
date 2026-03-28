'use strict';
/**
 * Web scraper for collecting Slay the Spire (杀戮尖塔) guides
 * from Baidu Tieba (百度贴吧) and Xiaohongshu (小红书).
 */

const cheerio = require('cheerio');

// ── Shared HTTP helper ─────────────────────────────────────────────────────
let _fetch;
async function getFetch() {
  if (!_fetch) {
    try { _fetch = (await import('node-fetch')).default; } catch (_) { _fetch = global.fetch; }
  }
  return _fetch;
}

const BASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
};

async function httpGet(url, extraHeaders = {}) {
  const fetch = await getFetch();
  const resp = await fetch(url, {
    method: 'GET',
    headers: { ...BASE_HEADERS, ...extraHeaders },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.text();
}

// ── Delay helper (polite scraping) ─────────────────────────────────────────
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// ══════════════════════════════════════════════════════════════════════════
//  百度贴吧 Scraper
// ══════════════════════════════════════════════════════════════════════════

/**
 * Scrape Baidu Tieba search results for a given keyword.
 * @param {string} keyword  e.g. "杀戮尖塔攻略"
 * @param {number} pages    number of search result pages to fetch (each = 10 results)
 * @returns {Array<{source,title,content,url,author,tags}>}
 */
async function scrapeTieba(keyword = '杀戮尖塔攻略', pages = 2) {
  const results = [];

  for (let page = 0; page < pages; page++) {
    const searchUrl = `https://tieba.baidu.com/f/search/res?ie=utf-8&qw=${encodeURIComponent(keyword)}&pn=${page * 10}&sm=1&cl=1&sc=0`;

    let html;
    try {
      html = await httpGet(searchUrl, { Referer: 'https://tieba.baidu.com/' });
    } catch (e) {
      console.warn(`[Tieba] Page ${page} fetch failed:`, e.message);
      break;
    }

    const $ = cheerio.load(html);

    // Each search result is in .s_post
    $('.s_post').each((_, el) => {
      const titleEl = $(el).find('.p_title a').first();
      const title   = titleEl.text().trim();
      const href    = titleEl.attr('href') || '';
      const postUrl = href.startsWith('http') ? href : (href ? `https://tieba.baidu.com${href}` : '');
      const content = $(el).find('.p_content').text().trim();
      const author  = $(el).find('.p_author_name').first().text().trim();

      if (content.length >= 30) {
        results.push({
          source:  'tieba',
          title:   title || keyword,
          content: content.slice(0, 3000),
          url:     postUrl,
          author:  author,
          tags:    keyword,
        });
      }
    });

    // Polite delay between pages
    if (page < pages - 1) await delay(1200 + Math.random() * 800);
  }

  console.log(`[Tieba] Collected ${results.length} items for "${keyword}"`);
  return results;
}

// ══════════════════════════════════════════════════════════════════════════
//  小红书 Scraper
// ══════════════════════════════════════════════════════════════════════════

/**
 * Attempt to scrape Xiaohongshu search results.
 * XHS heavily protects its API; this uses the public search page and
 * tries to extract data from the server-side rendered __INITIAL_STATE__.
 * May return empty results if bot-detection triggers.
 *
 * @param {string} keyword
 * @returns {Array<{source,title,content,url,author,tags}>}
 */
async function scrapeXiaohongshu(keyword = '杀戮尖塔攻略') {
  const results = [];
  const searchUrl = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}&type=51&source=web_search_result_notes`;

  let html;
  try {
    html = await httpGet(searchUrl, {
      Referer: 'https://www.xiaohongshu.com/',
      'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    });
  } catch (e) {
    console.warn('[XHS] Fetch failed:', e.message);
    return results;
  }

  const $ = cheerio.load(html);

  // Strategy 1: parse __INITIAL_STATE__ JSON from a <script> tag
  let parsed = false;
  $('script').each((_, el) => {
    if (parsed) return;
    const src = $(el).html() || '';
    const match = src.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]+?\});?\s*(<\/script>|$)/m);
    if (!match) return;
    try {
      const state = JSON.parse(match[1]);
      // note list can be in several paths depending on XHS version
      const items =
        state?.search?.noteResult?.items ||
        state?.searchResult?.notes ||
        [];
      for (const item of items.slice(0, 15)) {
        const note    = item?.note || item;
        const title   = (note?.title || note?.desc || '').trim();
        const content = (note?.desc  || note?.title || '').trim();
        const noteId  = note?.id || note?.noteId || item?.id || '';
        const author  = note?.user?.nickname || note?.authorUser?.nickname || '';
        const noteUrl = noteId ? `https://www.xiaohongshu.com/explore/${noteId}` : '';

        if (content.length >= 20) {
          results.push({
            source:  'xiaohongshu',
            title:   title || keyword,
            content: content.slice(0, 3000),
            url:     noteUrl,
            author:  author,
            tags:    keyword,
          });
        }
      }
      if (items.length > 0) parsed = true;
    } catch (e) {
      // JSON parse failed — likely minified/encoded; skip
    }
  });

  // Strategy 2: fallback — scrape visible card text (works on some CSR pages)
  if (!parsed) {
    $('[class*="note-card"], [class*="NoteCard"], .note-item').each((_, el) => {
      const title   = $(el).find('[class*="title"]').first().text().trim();
      const content = $(el).text().trim();
      if (content.length >= 30) {
        results.push({
          source:  'xiaohongshu',
          title:   title || keyword,
          content: content.slice(0, 3000),
          url:     '',
          author:  '',
          tags:    keyword,
        });
      }
    });
  }

  console.log(`[XHS] Collected ${results.length} items for "${keyword}"`);
  return results;
}

// ══════════════════════════════════════════════════════════════════════════
//  Combined entry point
// ══════════════════════════════════════════════════════════════════════════

/**
 * Scrape all sources and return combined results.
 * Individual source failures are caught and logged; the other sources proceed.
 *
 * @param {string} keyword  Base game name, e.g. "杀戮尖塔"
 * @returns {Array}
 */
async function scrapeAll(keyword = '杀戮尖塔') {
  const searchKeyword = `${keyword}攻略`;
  const [tiebaResult, xhsResult] = await Promise.allSettled([
    scrapeTieba(searchKeyword),
    scrapeXiaohongshu(searchKeyword),
  ]);

  return [
    ...(tiebaResult.status === 'fulfilled' ? tiebaResult.value : []),
    ...(xhsResult.status  === 'fulfilled' ? xhsResult.value  : []),
  ];
}

module.exports = { scrapeAll, scrapeTieba, scrapeXiaohongshu };
