/**
 * Shared utilities for the build pipeline.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CACHE_DIR = join(ROOT, 'cache');
export const DATA_DIR = join(ROOT, 'data');
export const WEB_DIR = join(ROOT, 'web');

// ── Cache helpers ─────────────────────────────────────────────────────────────

export function cacheRead(filename) {
  const p = join(CACHE_DIR, filename);
  if (existsSync(p)) {
    return JSON.parse(readFileSync(p, 'utf8'));
  }
  return null;
}

export function cacheWrite(filename, data) {
  const p = join(CACHE_DIR, filename);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

export function cacheExists(filename) {
  return existsSync(join(CACHE_DIR, filename));
}

// ── Logging ──────────────────────────────────────────────────────────────────

export function log(msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] ${msg}`);
}

export function warn(msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.warn(`[${ts}] ⚠️  ${msg}`);
}

export function ok(msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] ✅ ${msg}`);
}

// ── Fetch with retry + rate-limit ────────────────────────────────────────────

const DEFAULT_HEADERS = {
  'User-Agent': 'MapyReviewOfflineViewer/1.0 (personal hiking tool; github.com/LaurenSchouppe)',
  'Accept': 'application/json, text/html, */*',
};

export async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  const opts = { headers: { ...DEFAULT_HEADERS, ...(options.headers || {}) }, ...options };
  delete opts.headers; // rebuild properly
  opts.headers = { ...DEFAULT_HEADERS, ...(options.headers || {}) };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { default: fetch } = await import('node-fetch');
      const res = await fetch(url, opts);

      if (res.status === 429) {
        const wait = Math.pow(2, attempt) * 2000;
        warn(`Rate limited by ${new URL(url).hostname}. Waiting ${wait / 1000}s…`);
        await sleep(wait);
        continue;
      }

      return res;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await sleep(1000 * attempt);
    }
  }
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Geo helpers ───────────────────────────────────────────────────────────────

/** Haversine distance in km */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
