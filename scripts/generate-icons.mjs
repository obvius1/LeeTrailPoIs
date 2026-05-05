/**
 * Genereert icon-192.png en icon-512.png voor de PWA.
 * Geen externe dependencies — alleen Node.js ingebouwde zlib.
 *
 * Design: donkerblauwe achtergrond, witte bergsilhouet, gouden piek.
 */

import { deflateSync } from 'zlib';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

// ── Minimale PNG-encoder (geen dependencies) ──────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function u32be(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; }

function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  return Buffer.concat([u32be(data.length), t, data, u32be(crc32(Buffer.concat([t, data])))]);
}

function encodePNG(pixels, w, h) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB (geen alpha nodig)

  // Filter byte 0 (geen filter) + RGB per rij
  const rows = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    rows[y * (1 + w * 3)] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const src = (y * w + x) * 4;
      const dst = y * (1 + w * 3) + 1 + x * 3;
      rows[dst] = pixels[src]; rows[dst+1] = pixels[src+1]; rows[dst+2] = pixels[src+2];
    }
  }

  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(rows, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Tekenfuncties ─────────────────────────────────────────────────────────────

function makeIcon(size) {
  const buf = new Uint8Array(size * size * 4);

  function setPixel(x, y, r, g, b) {
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    const i = (y * size + x) * 4;
    buf[i] = r; buf[i+1] = g; buf[i+2] = b; buf[i+3] = 255;
  }

  // Achtergrond: #1a1a2e
  for (let i = 0; i < size * size; i++) {
    buf[i*4] = 0x1a; buf[i*4+1] = 0x1a; buf[i*4+2] = 0x2e; buf[i*4+3] = 255;
  }

  const sc = size / 192; // schaalfactor t.o.v. 192px ontwerp

  function coord(n) { return Math.round(n * sc); }

  // Driehoek vullen
  function sign(px, py, ax, ay, bx, by) {
    return (px - bx) * (ay - by) - (ax - bx) * (py - by);
  }
  function inTri(px, py, ax, ay, bx, by, cx, cy) {
    const d1 = sign(px,py, ax,ay, bx,by);
    const d2 = sign(px,py, bx,by, cx,cy);
    const d3 = sign(px,py, cx,cy, ax,ay);
    return !((d1<0||d2<0||d3<0) && (d1>0||d2>0||d3>0));
  }
  function fillTri(ax, ay, bx, by, cx, cy, r, g, b) {
    [ax, ay, bx, by, cx, cy] = [ax,ay,bx,by,cx,cy].map(coord);
    const x0 = Math.max(0, Math.min(ax,bx,cx));
    const x1 = Math.min(size-1, Math.max(ax,bx,cx));
    const y0 = Math.max(0, Math.min(ay,by,cy));
    const y1 = Math.min(size-1, Math.max(ay,by,cy));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++)
        if (inTri(x, y, ax,ay, bx,by, cx,cy)) setPixel(x, y, r, g, b);
  }

  // Cirkel vullen
  function fillCircle(cx, cy, radius, r, g, b) {
    cx = coord(cx); cy = coord(cy); radius = coord(radius);
    for (let y = cy-radius; y <= cy+radius; y++)
      for (let x = cx-radius; x <= cx+radius; x++)
        if ((x-cx)**2 + (y-cy)**2 <= radius**2) setPixel(x, y, r, g, b);
  }

  // ── Bergsilhouet ──────────────────────────────────────────────────────────

  // Linker piek (iets lager, achtergrond) — lichtgrijs zodat hij diepte geeft
  fillTri( 14, 158,  68,  80, 130, 158,   190, 190, 210);

  // Hoofdpiek (rechts, hoger) — wit
  fillTri( 44, 158, 116,  34, 174, 158,   255, 255, 255);

  // Sneeuwkap op hoofdpiek — zachte blauwwit tint
  fillTri( 90,  68, 116,  34, 142,  68,   210, 220, 255);

  // Gouden stip op de top (het hoogste punt = de "peak")
  fillCircle(116, 34, 9,   0xf4, 0xb9, 0x42);

  return encodePNG(buf, size, size);
}

// ── Wegschrijven ──────────────────────────────────────────────────────────────

writeFileSync(join(WEB_DIR, 'icon-192.png'), makeIcon(192));
writeFileSync(join(WEB_DIR, 'icon-512.png'), makeIcon(512));
console.log('✅  icon-192.png en icon-512.png aangemaakt in web/');
