'use strict';
/**
 * RAG (Retrieval-Augmented Generation) module.
 * Searches TiDB for relevant Slay the Spire guides and injects them
 * as additional context into the LLM system prompt.
 */

const tidb = require('./tidb');

// Keywords that indicate the user is asking about Slay the Spire
const TRIGGER_KEYWORDS = [
  '杀戮尖塔', 'slay the spire', 'slaythespire',
  // Characters
  '战士', '铁甲战士', 'ironclad',
  '静默猎手', '静默', 'silent',
  '缺陷', 'defect',
  '观察者', 'watcher',
  // Game concepts
  '遗物', 'relic', '卡牌', '牌组', 'deck',
  '能量', '血量', '攻击', '格挡', '药水',
  '精英', 'elite', '地图', 'boss',
  '咒击', '诅咒', '能力', '异能',
  '攀塔', '攻略', '打法', '流派', '卡组',
  '焰心', '时之眼', '沉默猎手',
];

/**
 * Extract the most relevant search keyword from the user message.
 */
function extractKeyword(text) {
  const lower = text.toLowerCase();
  // Return the first matching trigger keyword
  for (const kw of TRIGGER_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) return kw;
  }
  return null;
}

/**
 * Check whether the message is related to Slay the Spire.
 */
function isRelevant(text) {
  return extractKeyword(text) !== null;
}

/**
 * Retrieve relevant guide context for a user message.
 * Returns a formatted string to inject as extra system context,
 * or null if the message is not relevant / no guides found.
 *
 * @param {string} userMessage
 * @param {number} maxDocs       Maximum number of guide snippets to include
 * @returns {Promise<string|null>}
 */
async function retrieveContext(userMessage, maxDocs = 4) {
  if (!isRelevant(userMessage)) return null;

  // Try multiple keywords to cast a wider net
  const primary = extractKeyword(userMessage);
  const secondary = '杀戮尖塔';  // always broaden with the game name
  let guides = [];

  try {
    const [primaryResults, secondaryResults] = await Promise.all([
      tidb.searchGuides(primary, maxDocs),
      primary !== secondary ? tidb.searchGuides(secondary, maxDocs) : Promise.resolve([]),
    ]);

    // Merge and deduplicate by id
    const seen = new Set();
    for (const g of [...primaryResults, ...secondaryResults]) {
      if (!seen.has(g.id)) { seen.add(g.id); guides.push(g); }
    }
    guides = guides.slice(0, maxDocs);
  } catch (e) {
    console.warn('[RAG] TiDB search failed:', e.message);
    return null;
  }

  if (guides.length === 0) return null;

  const header = `以下是从玩家社区（百度贴吧/小红书）收集的《杀戮尖塔》相关攻略，请在回答时参考这些内容：`;
  const body = guides.map((g, i) => {
    const src    = g.source === 'tieba' ? '百度贴吧' : '小红书';
    const title  = g.title ? `《${g.title}》` : '';
    const author = g.author ? `（作者：${g.author}）` : '';
    const snippet = (g.content || '').slice(0, 600).replace(/\s+/g, ' ').trim();
    return `[攻略${i + 1}｜${src}${author}] ${title}\n${snippet}`;
  }).join('\n\n---\n\n');

  return `${header}\n\n${body}`;
}

module.exports = { retrieveContext, isRelevant, extractKeyword };
