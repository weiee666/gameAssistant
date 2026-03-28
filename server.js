#!/usr/bin/env node
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const WebSocket = require('ws');

// ── Load .env (no extra dependency needed) ────────────────────────────────
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8')
    .split('\n')
    .forEach(line => {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    });
} catch (_) {}

// ── Config ─────────────────────────────────────────────────────────────────
const PORT         = process.env.PORT || 7788;
const ZENMUX_URL   = 'https://zenmux.ai/api/v1/chat/completions';
const ZENMUX_KEY   = 'sk-ai-v1-fea7f2caf8d99ffc59056710b531fc11e7bc8ccd89ae35d7c0d3b6ffb3fad18c';
const ZENMUX_MODEL = 'sapiens-ai/agnes-1.5-pro';

// OpenAI Vision — set OPENAI_API_KEY in .env or environment
const OPENAI_KEY   = process.env.OPENAI_API_KEY  || '';
const OPENAI_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4o';

const SYSTEM_PROMPT = `你是 Agnes，一个智能、友好的 AI 助手。请用中文回答。你擅长分析截图、提供建议、解释技术问题，以及帮助用户完成各种任务。如果用户分享了截图，请仔细分析并给出有价值的建议。回答要简洁清晰，避免不必要的废话。`;

// ── Agent Modules (optional — require mysql2 + cheerio) ───────────────────
let tidb, rag, scraper;
try {
  tidb    = require('./agent/tidb');
  rag     = require('./agent/rag');
  scraper = require('./agent/scraper');
  tidb.initDB()
    .then(() => console.log('✓ TiDB ready'))
    .catch(e  => console.warn('⚠ TiDB init failed:', e.message));
} catch (e) {
  console.warn('⚠ Agent modules unavailable (install mysql2 + cheerio):', e.message);
}

// ── Collection State ───────────────────────────────────────────────────────
const collectionState = {
  running: false, progress: 0, total: 2, found: 0,
  log: [], lastRun: null,
};

async function runCollection(keyword = '杀戮尖塔') {
  if (!scraper || !tidb) throw new Error('Agent modules not available');
  if (collectionState.running) throw new Error('Collection already running');

  collectionState.running  = true;
  collectionState.progress = 0;
  collectionState.total    = 2;
  collectionState.found    = 0;
  collectionState.log      = [`[${new Date().toISOString()}] 开始收集"${keyword}"相关攻略...`];

  try {
    // ── Tieba ──
    collectionState.log.push('▶ 正在抓取百度贴吧...');
    let tiebaItems = [];
    try {
      tiebaItems = await scraper.scrapeTieba(`${keyword}攻略`);
      collectionState.log.push(`  贴吧: 获取 ${tiebaItems.length} 条内容`);
    } catch (e) {
      collectionState.log.push(`  贴吧错误: ${e.message}`);
    }
    collectionState.progress = 1;

    // ── XHS ──
    collectionState.log.push('▶ 正在抓取小红书...');
    let xhsItems = [];
    try {
      xhsItems = await scraper.scrapeXiaohongshu(`${keyword}攻略`);
      collectionState.log.push(`  小红书: 获取 ${xhsItems.length} 条内容`);
    } catch (e) {
      collectionState.log.push(`  小红书错误: ${e.message}`);
    }
    collectionState.progress = 2;

    // ── Save to TiDB ──
    const all = [...tiebaItems, ...xhsItems];
    let saved = 0;
    for (const guide of all) {
      try {
        const id = await tidb.insertGuide(guide);
        if (id > 0) saved++;
      } catch (e) {
        console.warn('[Collection] Insert failed:', e.message);
      }
    }
    collectionState.found   = saved;
    collectionState.lastRun = new Date().toISOString();
    collectionState.log.push(`✓ 成功保存 ${saved} 条攻略到 TiDB（跳过 ${all.length - saved} 条重复）`);
  } finally {
    collectionState.running = false;
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  SKILL SYSTEM — 读取 .claude/commands/*.md，用户输入 /skill-name 触发
// ══════════════════════════════════════════════════════════════════════════

const SKILLS_DIR = path.join(__dirname, '.claude', 'commands');

/**
 * 读取 .claude/commands/ 下所有 .md 文件，返回 skill 列表
 */
function listSkills() {
  try {
    return fs.readdirSync(SKILLS_DIR)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const name = f.replace(/\.md$/, '');
        const lines = fs.readFileSync(path.join(SKILLS_DIR, f), 'utf8').split('\n');
        const desc  = lines.find(l => l.trim() && !l.startsWith('#')) || name;
        return { name, description: desc.slice(0, 120) };
      });
  } catch (_) { return []; }
}

/**
 * Skill handlers — 每个 key 对应 .claude/commands/{key}.md 文件名
 * 新增 skill 只需：① 放一个 .md 文件 ② 在这里注册处理函数
 */
const SKILL_HANDLERS = {
  'collect-spire-guides': async (send, _args) => {
    await runCollectionAsSkill('杀戮尖塔', send);
  },
};

/**
 * 检测用户消息是否为 slash command，并调度对应 skill
 * @returns {boolean} true 表示已处理，不再走 AI 路由
 */
async function dispatchSkill(text, send) {
  if (!text.trim().startsWith('/')) return false;
  const [cmd, ...args] = text.trim().slice(1).split(/\s+/);
  const handler = SKILL_HANDLERS[cmd.toLowerCase()];
  if (!handler) return false;
  console.log('[Skill] Dispatching:', cmd);
  await handler(send, args);
  return true;
}

/**
 * Run guide collection and stream real-time progress back as chat deltas.
 * This is the in-chat version of runCollection() — output goes to the
 * WebSocket client instead of collectionState.log only.
 */
async function runCollectionAsSkill(keyword, send) {
  // Guard
  if (!scraper || !tidb) {
    send({ type: 'delta', text: '⚠ 攻略收集模块未启用。\n请确认已安装依赖：`npm install mysql2 cheerio`\n并配置好 TiDB 连接环境变量。' });
    send({ type: 'done' });
    return;
  }
  if (collectionState.running) {
    send({ type: 'delta', text: `⚠ 已有收集任务正在进行中（进度 ${collectionState.progress}/${collectionState.total}），请稍后再试。` });
    send({ type: 'done' });
    return;
  }

  // Init state
  collectionState.running  = true;
  collectionState.progress = 0;
  collectionState.total    = 2;
  collectionState.found    = 0;
  collectionState.log      = [`[${new Date().toISOString()}] Skill 触发收集 "${keyword}"`];

  send({ type: 'skill.start', skill: 'collect-guides' });
  send({ type: 'delta', text: `◈ **INTEL AGENT 已激活**\n\n搜索目标：「${keyword}」\n来源：百度贴吧 + 小红书\n\n` });

  let tiebaItems = [];
  let xhsItems   = [];

  // ── 百度贴吧 ──
  send({ type: 'delta', text: '▶ 正在抓取**百度贴吧**...\n' });
  try {
    tiebaItems = await scraper.scrapeTieba(`${keyword}攻略`);
    send({ type: 'delta', text: `  ✓ 获取 ${tiebaItems.length} 条内容\n` });
    collectionState.log.push(`贴吧: ${tiebaItems.length} 条`);
  } catch (e) {
    send({ type: 'delta', text: `  ✗ 抓取失败: ${e.message}\n` });
    collectionState.log.push(`贴吧错误: ${e.message}`);
  }
  collectionState.progress = 1;

  // ── 小红书 ──
  send({ type: 'delta', text: '▶ 正在抓取**小红书**...\n' });
  try {
    xhsItems = await scraper.scrapeXiaohongshu(`${keyword}攻略`);
    send({ type: 'delta', text: `  ✓ 获取 ${xhsItems.length} 条内容\n` });
    collectionState.log.push(`小红书: ${xhsItems.length} 条`);
  } catch (e) {
    send({ type: 'delta', text: `  ✗ 抓取失败: ${e.message}\n` });
    collectionState.log.push(`小红书错误: ${e.message}`);
  }
  collectionState.progress = 2;

  // ── 保存到 TiDB ──
  const all = [...tiebaItems, ...xhsItems];
  send({ type: 'delta', text: `\n▶ 正在保存到 TiDB（共 ${all.length} 条）...\n` });
  let saved = 0;
  for (const guide of all) {
    try {
      const id = await tidb.insertGuide(guide);
      if (id > 0) saved++;
    } catch (e) { /* duplicate or error, skip */ }
  }

  collectionState.found   = saved;
  collectionState.running = false;
  collectionState.lastRun = new Date().toISOString();
  collectionState.log.push(`✓ 保存 ${saved} 条`);

  // ── 汇报结果 ──
  const counts = await tidb.countGuides().catch(() => []);
  const total  = counts.reduce((s, c) => s + parseInt(c.cnt), 0);
  const breakdown = counts.map(c => {
    const src = c.source === 'tieba' ? '百度贴吧' : c.source === 'xiaohongshu' ? '小红书' : c.source;
    return `${src} ${c.cnt} 条`;
  }).join(' / ');

  send({ type: 'delta', text: `  ✓ 新增 **${saved}** 条（跳过 ${all.length - saved} 条重复）\n` });
  send({ type: 'delta', text: `\n---\n📚 **知识库现状**：共 **${total}** 条攻略（${breakdown || '暂无数据'}）\n\n` });
  send({ type: 'delta', text: `RAG 已就绪 — 现在直接问我关于「${keyword}」的问题，我会参考这些攻略来回答！` });
  send({ type: 'skill.done', skill: 'collect-guides', saved, total });
  send({ type: 'done' });
}

// ── Shared fetch helper ───────────────────────────────────────────────────
let _fetchFn;
async function getFetch() {
  if (!_fetchFn) {
    try { _fetchFn = (await import('node-fetch')).default; } catch (_) { _fetchFn = global.fetch; }
  }
  return _fetchFn;
}

// ── OpenAI Vision ──────────────────────────────────────────────────────────
/**
 * Analyze an image using OpenAI GPT-4o vision.
 * @param {string} imageDataUrl  base64 data URL (data:image/...;base64,...)
 * @returns {Promise<string|null>}
 */
async function openaiVisionAnalyze(imageDataUrl) {
  if (!OPENAI_KEY) return null;
  const fetch = await getFetch();
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: '请详细描述并分析这张图片中的所有可见信息。如果是游戏截图，请识别并列出：当前场景、角色状态（血量/能量/格挡）、手牌内容、遗物列表、地图位置、战斗敌人信息等所有细节。请用中文回答，尽量完整详细。',
          },
          {
            type: 'image_url',
            image_url: { url: imageDataUrl, detail: 'high' },
          },
        ],
      }],
      max_tokens: 1500,
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`OpenAI vision ${resp.status}: ${txt.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || null;
}

// ── OpenAI Chat Streaming (multimodal) ────────────────────────────────────
/**
 * Stream a chat completion via OpenAI API.
 * Supports image_url content blocks natively (GPT-4o vision).
 *
 * @param {Array}       messages      Full message list — may include image_url blocks
 * @param {Function}    onContent     Called with each streamed text chunk
 * @param {Function}    onDone        Called when stream ends
 * @param {Function}    onError       Called with error message string
 * @param {string|null} extraSysCtx   Optional RAG context appended to system prompt
 */
async function openaiChatStream(messages, onContent, onDone, onError, extraSysCtx = null) {
  const fetch = await getFetch();
  const sysContent = extraSysCtx ? `${SYSTEM_PROMPT}\n\n${extraSysCtx}` : SYSTEM_PROMPT;

  let resp;
  try {
    resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: 'system', content: sysContent }, ...messages],
        stream: true,
        max_tokens: 4096,
      }),
    });
  } catch (e) {
    onError(e.message);
    return;
  }

  if (!resp.ok) {
    const txt = await resp.text();
    onError(`OpenAI ${resp.status}: ${txt.slice(0, 200)}`);
    return;
  }

  let buffer = '';
  for await (const chunk of resp.body) {
    const lines = (buffer + chunk.toString()).split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') { onDone(); return; }
      try {
        const obj     = JSON.parse(data);
        const content = obj.choices?.[0]?.delta?.content;
        if (content) onContent(content);
      } catch (_) {}
    }
  }
  onDone();
}

// ── ZenMux Streaming ──────────────────────────────────────────────────────
/**
 * @param {Array}    messages        Chat history (user/assistant roles)
 * @param {Function} onContent       Called with each streamed text chunk
 * @param {Function} onDone          Called when stream ends
 * @param {Function} onError         Called with error message string
 * @param {string|null} extraSysCtx  Optional extra context to append to system prompt (RAG)
 */
async function zenmuxStream(messages, onContent, onDone, onError, extraSysCtx = null) {
  const fetch = await getFetch();
  const sysContent = extraSysCtx ? `${SYSTEM_PROMPT}\n\n${extraSysCtx}` : SYSTEM_PROMPT;

  let resp;
  try {
    resp = await fetch(ZENMUX_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ZENMUX_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: ZENMUX_MODEL,
        messages: [{ role: 'system', content: sysContent }, ...messages],
        stream: true,
        max_tokens: 4096,
        temperature: 0.7,
      }),
    });
  } catch (e) {
    onError(e.message);
    return;
  }

  if (!resp.ok) {
    const txt = await resp.text();
    onError(`ZenMux ${resp.status}: ${txt.slice(0, 200)}`);
    return;
  }

  let inContent = false;
  let buffer = '';
  for await (const chunk of resp.body) {
    const lines = (buffer + chunk.toString()).split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') { onDone(); return; }
      try {
        const obj   = JSON.parse(data);
        const delta = obj.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content != null) {
          inContent = true;
          if (delta.content) onContent(delta.content);
        }
      } catch (_) {}
    }
  }
  onDone();
}

// ── Message normalizer (for ZenMux — text only) ───────────────────────────
/**
 * Strip image_url blocks and convert to plain text.
 * Used for ZenMux (text-only backend).
 */
function normalizeMessages(rawMsgs) {
  return rawMsgs.map(m => {
    if (Array.isArray(m.content)) {
      const texts = m.content.filter(b => b.type === 'text').map(b => b.text);
      const imgs  = m.content.filter(b => b.type === 'image_url').length;
      let content = texts.join('\n');
      if (imgs > 0) content += (content ? '\n' : '') + `[附件：${imgs} 张图片]`;
      return { role: m.role, content };
    }
    return { role: m.role, content: m.content || '' };
  }).filter(m => m.content);
}

/**
 * Prepare messages for OpenAI — preserve image_url blocks as-is.
 * Ensures image_url has the correct nested format OpenAI expects.
 */
function prepareOpenAIMessages(rawMsgs) {
  return rawMsgs.map(m => {
    if (Array.isArray(m.content)) {
      const blocks = m.content
        .map(b => {
          if (b.type === 'text') return b;
          if (b.type === 'image_url') {
            // Normalise: {image_url: url_string} → {image_url: {url, detail}}
            const raw = b.image_url;
            const url = typeof raw === 'string' ? raw : raw?.url || '';
            return { type: 'image_url', image_url: { url, detail: 'high' } };
          }
          return null;
        })
        .filter(Boolean);
      return blocks.length > 0 ? { role: m.role, content: blocks } : null;
    }
    return m.content ? { role: m.role, content: m.content } : null;
  }).filter(Boolean);
}

// ── Path helper ───────────────────────────────────────────────────────────
function normPath(p) {
  if (p === '/chat' || p === '/chat/') return '/';
  if (p.startsWith('/chat/')) return p.slice(5);
  return p;
}

// ── Body reader ───────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// ══════════════════════════════════════════════════════════════════════════
//  HTTP Server
// ══════════════════════════════════════════════════════════════════════════
const server = http.createServer(async (req, res) => {
  const raw = new URL(req.url, `http://localhost:${PORT}`);
  const url = { pathname: normPath(raw.pathname) };

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Static ──
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) { res.writeHead(500); res.end('Cannot read index.html'); }
    return;
  }

  // ── Status ──
  if (url.pathname === '/api/status') {
    const counts = tidb ? await tidb.countGuides().catch(() => []) : [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      backend: 'ZenMux Agnes 1.5 Pro',
      model: ZENMUX_MODEL,
      vision: !!OPENAI_KEY,
      visionModel: OPENAI_KEY ? OPENAI_MODEL : null,
      rag: !!tidb,
      guideCounts: counts,
    }));
    return;
  }

  // ── Skills list ──
  if (url.pathname === '/api/skills') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ skills: listSkills() }));
    return;
  }

  // ── Vision: direct image analysis endpoint ──
  if (url.pathname === '/api/vision' && req.method === 'POST') {
    const body = await readBody(req);
    let parsed;
    try { parsed = JSON.parse(body); } catch (_) { res.writeHead(400); res.end('bad json'); return; }

    if (!parsed.image) { res.writeHead(400); res.end(JSON.stringify({ error: 'missing image field' })); return; }
    if (!OPENAI_KEY) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: 'OPENAI_API_KEY not configured on server' }));
      return;
    }

    try {
      const description = await openaiVisionAnalyze(parsed.image);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, description }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Agent: start guide collection ──
  if (url.pathname === '/api/agent/collect' && req.method === 'POST') {
    if (!scraper || !tidb) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: 'Agent modules unavailable. Run: npm install mysql2 cheerio' }));
      return;
    }
    if (collectionState.running) {
      res.writeHead(409);
      res.end(JSON.stringify({ error: 'Collection already running', state: collectionState }));
      return;
    }
    const body = await readBody(req);
    let parsed = {};
    try { parsed = JSON.parse(body); } catch (_) {}
    const keyword = (parsed.keyword || '杀戮尖塔').slice(0, 100);

    // Fire-and-forget
    runCollection(keyword).catch(e => {
      collectionState.log.push(`[ERROR] ${e.message}`);
      collectionState.running = false;
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, started: true, keyword }));
    return;
  }

  // ── Agent: collection status ──
  if (url.pathname === '/api/agent/status') {
    const counts = tidb ? await tidb.countGuides().catch(() => []) : [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...collectionState, counts }));
    return;
  }

  // ── Chat (HTTP SSE) ──
  if (url.pathname === '/api/chat' && req.method === 'POST') {
    const body = await readBody(req);
    let parsed;
    try { parsed = JSON.parse(body); } catch (_) { res.writeHead(400); res.end('bad json'); return; }

    const messages = normalizeMessages(parsed.messages || []);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    const send = (obj) => { if (!res.destroyed) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

    await zenmuxStream(
      messages,
      text => send({ type: 'delta', text }),
      ()   => { send({ type: 'done' }); res.end(); },
      msg  => { send({ type: 'error', message: msg }); res.end(); }
    );
    return;
  }

  res.writeHead(404); res.end('not found');
});

// ══════════════════════════════════════════════════════════════════════════
//  WebSocket Server
// ══════════════════════════════════════════════════════════════════════════
const wss = new WebSocket.Server({ server });

wss.on('connection', (client) => {
  const send = (obj) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(obj));
  };

  // Send initial handshake with capability flags
  send({
    type: 'status', ok: true,
    backend: 'ZenMux Agnes 1.5 Pro',
    vision: !!OPENAI_KEY,
    rag: !!tidb,
  });

  client.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch (_) { return; }

    if (msg.type !== 'chat.send') return;

    const rawMsgs   = msg.history || [];
    const imageUrls = msg.images  || [];

    // ────────────────────────────────────────────────────────────────────
    // SKILL — slash command 优先，/skill-name 触发对应 .claude/commands/*.md
    // ────────────────────────────────────────────────────────────────────
    const lastUser     = rawMsgs.filter(m => m.role === 'user').slice(-1)[0];
    const lastUserText = Array.isArray(lastUser?.content)
      ? lastUser.content.filter(b => b.type === 'text').map(b => b.text).join(' ')
      : (lastUser?.content || msg.text || '');

    if (await dispatchSkill(lastUserText, send)) return;

    // ────────────────────────────────────────────────────────────────────
    // RAG — retrieve guides regardless of routing path
    // ────────────────────────────────────────────────────────────────────
    let ragCtx = null;
    if (rag) {
      ragCtx = await rag.retrieveContext(lastUserText).catch(e => {
        console.warn('[RAG] Retrieval failed:', e.message);
        return null;
      });
      if (ragCtx) send({ type: 'rag.context', message: '已从攻略库检索到相关内容，正在参考...' });
    }

    if (imageUrls.length > 0 && OPENAI_KEY) {
      // ──────────────────────────────────────────────────────────────────
      // 有图片 → 直接调用 OpenAI（原生多模态，image_url 原样传入）
      // ──────────────────────────────────────────────────────────────────
      send({ type: 'vision.analyzing', count: imageUrls.length });

      const messages = prepareOpenAIMessages(rawMsgs);
      if (messages.length === 0) {
        messages.push({ role: 'user', content: msg.text || '请分析图片' });
      }

      await openaiChatStream(
        messages,
        text => send({ type: 'delta', text }),
        ()   => send({ type: 'done' }),
        err  => send({ type: 'error', message: err }),
        ragCtx
      );

    } else {
      // ──────────────────────────────────────────────────────────────────
      // 无图片 → ZenMux（文字对话，性能优先）
      // ──────────────────────────────────────────────────────────────────
      const messages = normalizeMessages(rawMsgs);
      if (messages.length === 0) {
        messages.push({ role: 'user', content: msg.text || '你好' });
      }

      // No OpenAI key but images attached — add plain note
      if (imageUrls.length > 0) {
        const last = messages[messages.length - 1];
        if (last && last.role === 'user') {
          last.content += `\n[用户附加了 ${imageUrls.length} 张截图，请基于上下文给出建议]`;
        }
      }

      await zenmuxStream(
        messages,
        text => send({ type: 'delta', text }),
        ()   => send({ type: 'done' }),
        err  => send({ type: 'error', message: err }),
        ragCtx
      );
    }
  });
});

// ── Start ──────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✓ OpenClaw Chat Server  →  http://localhost:${PORT}`);
  console.log(`  Backend : ${ZENMUX_MODEL} via ZenMux`);
  console.log(`  Vision  : ${OPENAI_KEY ? `OpenAI ${OPENAI_MODEL} ✓` : 'disabled  (set OPENAI_API_KEY to enable)'}`);
  console.log(`  TiDB/RAG: ${tidb ? 'enabled ✓' : 'disabled  (install mysql2 + cheerio)'}`);
});
