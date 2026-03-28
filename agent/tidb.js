'use strict';
/**
 * TiDB (MySQL-compatible) connection and guide storage module.
 * Configure via environment variables:
 *   TIDB_HOST, TIDB_PORT, TIDB_USER, TIDB_PASSWORD, TIDB_DATABASE, TIDB_SSL
 */

const mysql = require('mysql2/promise');

const DB_CONFIG = {
  host:     process.env.TIDB_HOST     || '127.0.0.1',
  port:     parseInt(process.env.TIDB_PORT || '4000'),
  user:     process.env.TIDB_USER     || 'root',
  password: process.env.TIDB_PASSWORD || '',
  database: process.env.TIDB_DATABASE || 'openclaw',
  ssl:      process.env.TIDB_SSL === 'true' ? { minVersion: 'TLSv1.2', rejectUnauthorized: true } : undefined,
  waitForConnections: true,
  connectionLimit: 5,
  connectTimeout: 15000,
  charset: 'utf8mb4',
};

let _pool = null;

function getPool() {
  if (!_pool) _pool = mysql.createPool(DB_CONFIG);
  return _pool;
}

/**
 * Create the guides table if it doesn't exist.
 */
async function initDB() {
  const pool = getPool();
  // Create database if not exists (for local TiDB / self-hosted)
  await pool.execute(
    `CREATE DATABASE IF NOT EXISTS \`${DB_CONFIG.database}\` CHARACTER SET utf8mb4`
  ).catch(() => {}); // ignore if no CREATE DATABASE privilege (TiDB Cloud)

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS guides (
      id           INT          AUTO_INCREMENT PRIMARY KEY,
      source       VARCHAR(50)  NOT NULL,
      title        TEXT,
      content      MEDIUMTEXT   NOT NULL,
      url          VARCHAR(1000),
      author       VARCHAR(300),
      tags         VARCHAR(500),
      collected_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_source (source),
      INDEX idx_time   (collected_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  return true;
}

/**
 * Insert a guide. Silently ignores duplicate URLs (same url → skip).
 * @param {{ source, title, content, url, author, tags }} guide
 * @returns {number} insertId (0 if duplicate)
 */
async function insertGuide({ source, title = '', content, url = '', author = '', tags = '' }) {
  const pool = getPool();
  // Deduplicate by url when non-empty
  if (url) {
    const [existing] = await pool.execute('SELECT id FROM guides WHERE url = ? LIMIT 1', [url]);
    if (existing.length > 0) return 0;
  }
  const [result] = await pool.execute(
    'INSERT INTO guides (source, title, content, url, author, tags) VALUES (?, ?, ?, ?, ?, ?)',
    [source, title.slice(0, 500), content.slice(0, 10000), url.slice(0, 1000), author.slice(0, 300), tags.slice(0, 500)]
  );
  return result.insertId;
}

/**
 * Search guides by keyword (LIKE on title + content + tags).
 * @param {string} keyword
 * @param {number} limit
 * @returns {Array}
 */
async function searchGuides(keyword, limit = 5) {
  const pool = getPool();
  const like = `%${keyword.slice(0, 50)}%`;
  const [rows] = await pool.execute(
    `SELECT id, source, title, SUBSTRING(content, 1, 800) AS content, url, author, tags, collected_at
     FROM guides
     WHERE title LIKE ? OR content LIKE ? OR tags LIKE ?
     ORDER BY collected_at DESC
     LIMIT ?`,
    [like, like, like, Math.min(limit, 10)]
  );
  return rows;
}

/**
 * Count guides grouped by source.
 * @returns {Array<{source, cnt}>}
 */
async function countGuides() {
  const pool = getPool();
  const [rows] = await pool.execute(
    'SELECT source, COUNT(*) AS cnt FROM guides GROUP BY source ORDER BY cnt DESC'
  );
  return rows;
}

/**
 * Close the connection pool.
 */
async function close() {
  if (_pool) { await _pool.end(); _pool = null; }
}

module.exports = { initDB, insertGuide, searchGuides, countGuides, close };
