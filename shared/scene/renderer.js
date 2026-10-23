// Deterministic frame renderer: drawFrame(ctx, model, t) paints the video
// frame at time t (seconds). It is a pure function of (model, t), uses only
// the standard Canvas 2D API, and runs identically in the browser (studio
// preview) and in Node via @napi-rs/canvas (MP4 rendering).
import { layoutGraph, LAYER_COLORS, LAYER_LABELS } from '../graphLayout.js';
import { segmentAt, captionAt } from './timeline.js';

const W = 1280;
const H = 720;
const C = {
  bg0: '#060913', bg1: '#0b1024', ink: '#eef2ff', muted: '#9aa4c7', dim: '#5d6790',
  violet: '#8b5cf6', cyan: '#22d3ee', magenta: '#e879f9', indigo: '#6366f1',
  panel: 'rgba(17, 22, 48, 0.78)', panelLine: 'rgba(148, 163, 255, 0.16)',
  observed: '#34d399', inferred: '#fbbf24', unknown: '#94a3b8', concern: '#fb7185',
};
// Base alpha of the segment currently being painted (for cross-fades).
let BA = 1;
const STATUS_COLOR = { observed: C.observed, inferred: C.inferred, unknown: C.unknown };

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const ease = (x) => { const v = clamp(x); return v < 0.5 ? 4 * v * v * v : 1 - Math.pow(-2 * v + 2, 3) / 2; };
const easeOut = (x) => 1 - Math.pow(1 - clamp(x), 3);

export function createVideoModel({ project, script, timeline, width = 1280, height = 720, assets = {}, fonts = {} }) {
  const graph = project.graph;
  const counts = {
    observed: graph.nodes.filter(n => n.status === 'observed').length,
    inferred: graph.nodes.filter(n => n.status === 'inferred').length,
    unknown: graph.nodes.filter(n => n.status === 'unknown').length,
  };
  return {
    width, height, scale: width / W,
    host: project.site.host.replace(/^www\./, ''),
    origin: new URL(project.finalUrl).origin,
    date: new Date(project.createdAt).toISOString().slice(0, 10),
    scenes: script.scenes,
    graph,
    layout: layoutGraph(graph),
    timeline,
    counts,
    assets,
    burnCaptions: true,
    fonts: {
      display: `"${fonts.display || 'Space Grotesk'}", "Segoe UI", Arial, sans-serif`,
      body: `"${fonts.body || 'Plus Jakarta Sans'}", "Segoe UI", Arial, sans-serif`,
      mono: `"${fonts.mono || 'JetBrains Mono'}", Consolas, "Courier New", monospace`,
    },
  };
}

// ── primitives ────────────────────────────────────────────────────────────
function rr(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}
function font(ctx, m, weight, size, family) { ctx.font = `${weight} ${size}px ${m.fonts[family]}`; }
function ellipsize(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}
function wrap(ctx, text, maxW, maxLines = 3) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(test).width > maxW && cur) {
      lines.push(cur);
      cur = w;
      if (lines.length === maxLines) break;
    } else cur = test;
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  if (lines.length === maxLines) {
    const consumed = lines.join(' ').split(/\s+/).length;
    if (consumed < words.length) lines[maxLines - 1] = ellipsize(ctx, lines[maxLines - 1] + ' …', maxW);
  }
  return lines;
}
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
function panel(ctx, x, y, w, h, { radius = 18, fill = C.panel, line = C.panelLine } = {}) {
  ctx.save();
  rr(ctx, x, y, w, h, radius);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = line;
  ctx.stroke();
  ctx.restore();
}

// ── background ────────────────────────────────────────────────────────────
function drawBackground(ctx, t) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, C.bg0);
  g.addColorStop(1, C.bg1);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const glow = (x, y, r, color, a) => {
    const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, hexA(color, a));
    rg.addColorStop(1, hexA(color, 0));
    ctx.fillStyle = rg;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  };
  glow(220 + Math.sin(t / 6) * 80, 140 + Math.cos(t / 7) * 30, 520, C.violet, 0.22);
  glow(1080 + Math.cos(t / 8) * 60, 600 + Math.sin(t / 5) * 40, 480, C.cyan, 0.14);
  glow(700, 380 + Math.sin(t / 9) * 40, 420, C.magenta, 0.05);
  ctx.save();
  ctx.strokeStyle = 'rgba(148, 163, 255, 0.045)';
  ctx.lineWidth = 1;
  const off = (t * 6) % 40;
  ctx.beginPath();
  for (let x = -40 + off; x < W; x += 40) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
  for (let y = -40 + off; y < H; y += 40) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
  ctx.stroke();
  ctx.restore();
}

// ── architecture diagram ──────────────────────────────────────────────────
function drawDiagram(ctx, m, rect, { focus = [], t = 0, local = 0, build = false, alpha = 1, flow = false }) {
  const { x, y, w, h } = rect;
  const { layout, graph } = m;
  const focusSet = new Set(focus);
  const cols = Math.max(1, layout.columns.length);
  const nodeW = Math.min(150, (w / cols) * 0.86);
  const nodeH = nodeW < 110 ? 50 : 54;
  const P = (id) => { const p = layout.positions[id]; return p ? { x: x + p.x * w, y: y + p.y * h } : null; };
  const order = graph.nodes.map(n => n.id);
  const appear = (id) => build ? easeOut((local - 0.4 - order.indexOf(id) * 0.12) / 0.5) : 1;

  ctx.save();
  ctx.globalAlpha = BA * (alpha);
  // layer labels
  font(ctx, m, 600, 10, 'mono');
  ctx.textAlign = 'center';
  for (const col of layout.columns) {
    ctx.fillStyle = hexA(LAYER_COLORS[col.layer], 0.75);
    ctx.fillText(col.label.toUpperCase(), x + col.x * w, y + h * (layout.labelY ?? 0.2));
  }
  for (const b of layout.bands) {
    ctx.fillStyle = hexA(LAYER_COLORS[b.layer], 0.7);
    ctx.textAlign = 'left';
    ctx.fillText(b.label.toUpperCase(), x + 4, y + b.y * h - nodeH / 2 - 8);
    ctx.textAlign = 'center';
  }

  // edges
  for (const e of graph.edges) {
    const a = P(e.source), b = P(e.target);
    if (!a || !b) continue;
    const vis = Math.min(appear(e.source), appear(e.target));
    if (vis <= 0) continue;
    const active = focusSet.size === 0 || focusSet.has(e.source) || focusSet.has(e.target);
    const horizontal = Math.abs(a.y - b.y) < h * 0.3 || Math.abs(a.x - b.x) > nodeW;
    const sx = horizontal && b.x > a.x ? a.x + nodeW / 2 : a.x;
    const sy = horizontal && b.x > a.x ? a.y : a.y + (b.y > a.y ? nodeH / 2 : -nodeH / 2);
    const ex = horizontal && b.x > a.x ? b.x - nodeW / 2 : b.x;
    const ey = horizontal && b.x > a.x ? b.y : b.y + (b.y > a.y ? -nodeH / 2 : nodeH / 2);
    const c1x = horizontal ? sx + (ex - sx) * 0.5 : sx;
    const c1y = horizontal ? sy : sy + (ey - sy) * 0.5;
    const c2x = horizontal ? sx + (ex - sx) * 0.5 : ex;
    const c2y = horizontal ? ey : sy + (ey - sy) * 0.5;
    ctx.save();
    ctx.globalAlpha = BA * (alpha * vis * (active ? 0.9 : 0.18));
    ctx.strokeStyle = e.status === 'observed' ? hexA(C.cyan, 0.8) : e.status === 'inferred' ? hexA(C.inferred, 0.7) : hexA(C.unknown, 0.6);
    ctx.lineWidth = active ? 1.8 : 1.2;
    ctx.setLineDash(e.status === 'observed' ? [] : e.status === 'inferred' ? [6, 5] : [2, 5]);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.bezierCurveTo(c1x, c1y, c2x, c2y, ex, ey);
    ctx.stroke();
    ctx.setLineDash([]);
    if (active && (flow || focusSet.size) && e.status !== 'unknown') {
      // travelling request packets
      for (let k = 0; k < 2; k += 1) {
        const p = ((t * 0.45 + k * 0.5 + (e.id.length % 7) * 0.07) % 1);
        const it = 1 - p;
        const bx = it ** 3 * sx + 3 * it * it * p * c1x + 3 * it * p * p * c2x + p ** 3 * ex;
        const by = it ** 3 * sy + 3 * it * it * p * c1y + 3 * it * p * p * c2y + p ** 3 * ey;
        ctx.globalAlpha = BA * (alpha * vis * Math.sin(Math.PI * p));
        ctx.fillStyle = e.status === 'observed' ? C.cyan : C.inferred;
        ctx.beginPath();
        ctx.arc(bx, by, 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // nodes
  for (const n of graph.nodes) {
    const p = P(n.id);
    if (!p) continue;
    const vis = appear(n.id);
    if (vis <= 0) continue;
    const isFocus = focusSet.size === 0 || focusSet.has(n.id);
    const color = LAYER_COLORS[n.layer] || C.violet;
    const pulse = isFocus && focusSet.size ? 1 + Math.sin(t * 3) * 0.015 : 1;
    const sw = nodeW * (0.85 + 0.15 * vis) * pulse;
    const sh = nodeH * (0.85 + 0.15 * vis) * pulse;
    const nx = p.x - sw / 2, ny = p.y - sh / 2;
    ctx.save();
    ctx.globalAlpha = BA * (alpha * vis * (isFocus ? 1 : 0.32));
    if (isFocus && focusSet.size) {
      ctx.shadowColor = hexA(color, 0.75);
      ctx.shadowBlur = 22;
    }
    rr(ctx, nx, ny, sw, sh, 12);
    const fill = ctx.createLinearGradient(nx, ny, nx, ny + sh);
    fill.addColorStop(0, n.status === 'unknown' ? 'rgba(30, 36, 60, 0.92)' : 'rgba(26, 32, 70, 0.95)');
    fill.addColorStop(1, 'rgba(14, 18, 42, 0.95)');
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = isFocus && focusSet.size ? 2 : 1.3;
    ctx.strokeStyle = n.status === 'unknown' ? hexA(C.unknown, 0.7) : hexA(color, 0.85);
    ctx.setLineDash(n.status === 'observed' ? [] : n.status === 'inferred' ? [5, 4] : [2, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    // status dot
    ctx.fillStyle = STATUS_COLOR[n.status];
    ctx.beginPath();
    ctx.arc(nx + 11, ny + 12, 3.5, 0, Math.PI * 2);
    ctx.fill();
    // label
    ctx.fillStyle = n.status === 'unknown' ? C.muted : C.ink;
    const fs = sw < 105 ? 10.5 : 12;
    font(ctx, m, 600, fs, 'body');
    ctx.textAlign = 'left';
    const label = n.status === 'unknown' ? `? ${n.label}` : n.label;
    const lines = wrap(ctx, label, sw - 26, 2);
    lines.forEach((ln, i) => ctx.fillText(ln, nx + 19, ny + 16 + (lines.length === 1 ? 6 : 0) + i * (fs + 3)));
    font(ctx, m, 500, 8.5, 'mono');
    ctx.fillStyle = hexA(STATUS_COLOR[n.status], 0.9);
    ctx.fillText(n.status.toUpperCase(), nx + 19, ny + sh - 8);
    ctx.restore();
  }
  ctx.restore();
}

// ── panels ────────────────────────────────────────────────────────────────
function drawTerminal(ctx, m, x, y, w, h, title, lines, local, { speed = 70 } = {}) {
  panel(ctx, x, y, w, h, { fill: 'rgba(8, 11, 26, 0.9)' });
  ctx.save();
  ['#ff5f57', '#febc2e', '#28c840'].forEach((c, i) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x + 18 + i * 14, y + 17, 4.5, 0, Math.PI * 2); ctx.fill(); });
  font(ctx, m, 500, 11, 'mono');
  ctx.fillStyle = C.muted;
  ctx.textAlign = 'left';
  ctx.fillText(title, x + 66, y + 21);
  ctx.strokeStyle = C.panelLine;
  ctx.beginPath(); ctx.moveTo(x, y + 34); ctx.lineTo(x + w, y + 34); ctx.stroke();
  let budget = Math.max(0, (local - 0.6) * speed);
  const lh = 17;
  const maxLines = Math.floor((h - 46) / lh);
  font(ctx, m, 400, 11.5, 'mono');
  for (let i = 0; i < Math.min(lines.length, maxLines); i += 1) {
    const full = ellipsize(ctx, lines[i], w - 40);
    const shown = full.slice(0, Math.max(0, Math.floor(budget)));
    budget -= full.length;
    const ly = y + 52 + i * lh;
    ctx.fillStyle = C.cyan;
    ctx.fillText('›', x + 14, ly);
    ctx.fillStyle = /^\[(HIGH|MEDIUM)\]/.test(full) ? C.concern : /^\[PASS\]|OBSERVED/.test(full) ? C.observed : /INFERRED|^\[LOW\]/.test(full) ? C.inferred : /UNKNOWN|^\[INFO\]|^\[NOTE\]/.test(full) ? C.unknown : '#c7d2fe';
    ctx.fillText(shown, x + 28, ly);
    if (budget < 0 || (budget >= 0 && i === Math.min(lines.length, maxLines) - 1)) {
      if (Math.floor(local * 2) % 2 === 0) {
        ctx.fillStyle = C.cyan;
        ctx.fillRect(x + 28 + ctx.measureText(shown).width + 2, ly - 10, 7, 13);
      }
      if (budget < 0) break;
    }
  }
  ctx.restore();
}

const KEYWORDS = /\b(const|let|await|async|function|return|new|true|false|null|GET|POST|PUT|PATCH|DELETE|HTTP\/[\d.]+|curl)\b/;
function tokenize(line, language) {
  const out = [];
  const re = /(\/\/.*$|#.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_][\w-]*\b(?=\s*:))|([A-Za-z_][\w./-]*)|(\s+)|(.)/g;
  let mm;
  while ((mm = re.exec(line))) {
    if (mm[1] && (language !== 'http' || mm[1].startsWith('#'))) out.push([mm[1], '#64748b']);
    else if (mm[2]) out.push([mm[2], '#86efac']);
    else if (mm[3]) out.push([mm[3], '#fcd34d']);
    else if (mm[4]) out.push([mm[4], '#c4b5fd']);
    else if (mm[5]) out.push([mm[5], KEYWORDS.test(mm[5]) ? '#67e8f9' : '#e2e8f0']);
    else out.push([mm[0], '#cbd5e1']);
    if (mm[0] === '') re.lastIndex += 1;
  }
  return out;
}
function drawSnippet(ctx, m, x, y, w, h, snippet, local) {
  panel(ctx, x, y, w, h, { fill: 'rgba(10, 13, 32, 0.92)' });
  ctx.save();
  font(ctx, m, 600, 11, 'mono');
  ctx.textAlign = 'left';
  ctx.fillStyle = C.muted;
  ctx.fillText(ellipsize(ctx, snippet.title, w - 130), x + 16, y + 22);
  const tag = snippet.illustrative ? 'ILLUSTRATIVE' : 'FROM EVIDENCE';
  const tw = ctx.measureText(tag).width + 14;
  rr(ctx, x + w - tw - 12, y + 9, tw, 19, 9);
  ctx.fillStyle = snippet.illustrative ? hexA(C.inferred, 0.16) : hexA(C.observed, 0.16);
  ctx.fill();
  ctx.fillStyle = snippet.illustrative ? C.inferred : C.observed;
  ctx.fillText(tag, x + w - tw - 5, y + 22);
  const reveal = easeOut((local - 1) / 1.2);
  const lines = snippet.code.split('\n');
  const lh = 16.5;
  const maxLines = Math.floor((h - 44) / lh);
  font(ctx, m, 400, 11.5, 'mono');
  for (let i = 0; i < Math.min(lines.length, maxLines); i += 1) {
    const ly = y + 48 + i * lh;
    ctx.globalAlpha = BA * (clamp(reveal * lines.length - i));
    ctx.fillStyle = '#475569';
    ctx.fillText(String(i + 1).padStart(2, ' '), x + 12, ly);
    let cx = x + 36;
    for (const [tok, color] of tokenize(lines[i], snippet.language)) {
      const tw2 = ctx.measureText(tok).width;
      if (cx + tw2 > x + w - 14) { ctx.fillStyle = '#64748b'; ctx.fillText('…', cx, ly); break; }
      ctx.fillStyle = color;
      ctx.fillText(tok, cx, ly);
      cx += tw2;
    }
  }
  ctx.restore();
}
function drawBullets(ctx, m, x, y, w, bullets, local) {
  ctx.save();
  let cy = y;
  bullets.forEach((b, i) => {
    const a = easeOut((local - 0.5 - i * 0.35) / 0.5);
    if (a <= 0) return;
    ctx.globalAlpha = BA * (a);
    const bx = x + (1 - a) * 24;
    panel(ctx, bx, cy, w, 40, { radius: 12, fill: 'rgba(20, 25, 56, 0.82)' });
    ctx.fillStyle = STATUS_COLOR[b.status] || C.cyan;
    rr(ctx, bx, cy, 4, 40, 2); ctx.fill();
    font(ctx, m, 600, 13, 'body');
    ctx.fillStyle = C.ink;
    ctx.textAlign = 'left';
    ctx.fillText(ellipsize(ctx, b.text, w - 110), bx + 16, cy + 25);
    font(ctx, m, 600, 9, 'mono');
    ctx.fillStyle = STATUS_COLOR[b.status] || C.cyan;
    ctx.textAlign = 'right';
    ctx.fillText(b.status.toUpperCase(), bx + w - 12, cy + 24);
    cy += 48;
  });
  ctx.restore();
  return cy;
}
function drawScreenshot(ctx, m, x, y, w, h, local) {
  const img = m.assets.screenshot;
  const a = easeOut((local - 0.3) / 0.8);
  ctx.save();
  ctx.globalAlpha = BA * (a);
  panel(ctx, x, y, w, h, { radius: 14, fill: 'rgba(12, 16, 36, 0.95)' });
  ['#ff5f57', '#febc2e', '#28c840'].forEach((c, i) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x + 16 + i * 13, y + 15, 4, 0, Math.PI * 2); ctx.fill(); });
  rr(ctx, x + 60, y + 7, w - 76, 17, 8);
  ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fill();
  font(ctx, m, 500, 10, 'mono');
  ctx.fillStyle = C.muted;
  ctx.textAlign = 'left';
  ctx.fillText(ellipsize(ctx, m.origin, w - 96), x + 70, y + 19);
  const ix = x + 8, iy = y + 30, iw = w - 16, ih = h - 38;
  ctx.save();
  rr(ctx, ix, iy, iw, ih, 8);
  ctx.clip();
  if (img) {
    const ratio = Math.max(iw / img.width, ih / img.height);
    const dw = img.width * ratio, dh = img.height * ratio;
    ctx.drawImage(img, ix, iy, dw, dh);
  } else {
    ctx.fillStyle = 'rgba(30, 36, 70, 0.8)';
    ctx.fillRect(ix, iy, iw, ih);
    font(ctx, m, 500, 13, 'body');
    ctx.fillStyle = C.muted;
    ctx.textAlign = 'center';
    ctx.fillText('No screenshot (browser rendering unavailable)', ix + iw / 2, iy + ih / 2);
  }
  ctx.restore();
  ctx.restore();
}
function drawStatCounters(ctx, m, x, y, w, local) {
  const items = [['OBSERVED', m.counts.observed, C.observed], ['INFERRED', m.counts.inferred, C.inferred], ['UNKNOWN', m.counts.unknown, C.unknown]];
  const bw = (w - 24) / 3;
  items.forEach(([label, value, color], i) => {
    const a = easeOut((local - 0.4 - i * 0.25) / 0.6);
    const bx = x + i * (bw + 12);
    ctx.save();
    ctx.globalAlpha = BA * (a);
    panel(ctx, bx, y, bw, 96, { radius: 16, fill: hexA(color, 0.08), line: hexA(color, 0.35) });
    font(ctx, m, 700, 40, 'display');
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(String(Math.round(value * easeOut((local - 0.4) / 1.2))), bx + bw / 2, y + 54);
    font(ctx, m, 600, 10, 'mono');
    ctx.fillStyle = C.muted;
    ctx.fillText(label, bx + bw / 2, y + 80);
    ctx.restore();
  });
}

// ── segments ──────────────────────────────────────────────────────────────
function drawHeader(ctx, m, scene, index, local) {
  const a = easeOut(local / 0.7);
  ctx.save();
  ctx.globalAlpha = BA * (a);
  ctx.textAlign = 'left';
  font(ctx, m, 600, 12, 'mono');
  ctx.fillStyle = C.cyan;
  ctx.fillText(`${String(index + 1).padStart(2, '0')} / 06  ·  ${scene.key.replace('-', ' ').toUpperCase()}`, 48, 52);
  font(ctx, m, 700, 32, 'display');
  ctx.fillStyle = C.ink;
  ctx.fillText(ellipsize(ctx, scene.title, 1180), 48 - (1 - a) * 20, 92);
  font(ctx, m, 500, 15, 'body');
  ctx.fillStyle = C.muted;
  ctx.fillText(ellipsize(ctx, scene.subtitle, 1180), 48, 120);
  ctx.restore();
}

function drawScene(ctx, m, index, local, t) {
  const scene = m.scenes[index];
  drawHeader(ctx, m, scene, index, local);
  const key = scene.key;
  const fullWidth = key === 'summary';
  const diagramRect = fullWidth ? { x: 36, y: 140, w: 760, h: 450 } : { x: 36, y: 140, w: 740, h: 455 };
  panel(ctx, diagramRect.x, diagramRect.y, diagramRect.w, diagramRect.h, { radius: 22, fill: 'rgba(12, 16, 38, 0.55)' });
  drawDiagram(ctx, m, { x: diagramRect.x + 12, y: diagramRect.y + 6, w: diagramRect.w - 24, h: diagramRect.h - 12 }, {
    focus: key === 'summary' ? [] : scene.focusNodeIds, t, local, build: index === 0, flow: key === 'request-flow',
  });
  const px = 800, py = 140, pw = 444;
  if (key === 'overview') {
    drawScreenshot(ctx, m, px, py, pw, 250, local);
    drawTerminal(ctx, m, px, py + 262, pw, 193, scene.panel.title, scene.panel.lines, local - 1);
  } else if (key === 'frontend' || key === 'backend') {
    const end = drawBullets(ctx, m, px, py, pw, scene.bullets.slice(0, 4), local);
    const top = Math.max(end + 4, py + 120);
    drawSnippet(ctx, m, px, top, pw, py + 455 - top, scene.snippet, local);
  } else if (key === 'request-flow') {
    drawTerminal(ctx, m, px, py, pw, 220, scene.panel.title, scene.panel.lines, local);
    drawSnippet(ctx, m, px, py + 232, pw, 223, scene.snippet, local - 1.5);
  } else if (key === 'security') {
    drawTerminal(ctx, m, px, py, pw, 270, scene.panel.title, scene.panel.lines, local, { speed: 90 });
    drawSnippet(ctx, m, px, py + 282, pw, 173, scene.snippet, local - 1.5);
  } else {
    drawStatCounters(ctx, m, px, py, pw, local);
    drawTerminal(ctx, m, px, py + 110, pw, 345, scene.panel.title, scene.panel.lines, local - 0.8);
  }
}

function drawIntro(ctx, m, local) {
  const a = easeOut(local / 0.9);
  ctx.save();
  ctx.globalAlpha = BA * (a);
  ctx.textAlign = 'left';
  font(ctx, m, 600, 13, 'mono');
  ctx.fillStyle = C.cyan;
  ctx.fillText('STACKREEL  ·  ARCHITECTURE REEL', 72, 220);
  font(ctx, m, 700, m.host.length > 22 ? 48 : 62, 'display');
  const g = ctx.createLinearGradient(72, 0, 640, 0);
  g.addColorStop(0, '#f5f3ff'); g.addColorStop(0.55, '#c4b5fd'); g.addColorStop(1, '#67e8f9');
  ctx.fillStyle = g;
  ctx.fillText(ellipsize(ctx, m.host, 600), 72, 300 + (1 - a) * 24);
  font(ctx, m, 500, 18, 'body');
  ctx.fillStyle = C.muted;
  ctx.fillText('How this website is likely built — from public evidence', 72, 342);
  font(ctx, m, 500, 12, 'mono');
  ctx.fillStyle = C.dim;
  ctx.fillText(`Analyzed ${m.date}  ·  passive inspection  ·  ${m.graph.nodes.length} components`, 72, 372);
  // legend
  const legend = [['Observed', C.observed, []], ['Inferred', C.inferred, [5, 4]], ['Unknown', C.unknown, [2, 4]]];
  legend.forEach(([label, color, dash], i) => {
    const la = easeOut((local - 0.8 - i * 0.2) / 0.5);
    ctx.globalAlpha = BA * (a * la);
    const lx = 72 + i * 150;
    rr(ctx, lx, 404, 136, 34, 17);
    ctx.fillStyle = hexA(color, 0.1); ctx.fill();
    ctx.setLineDash(dash); ctx.strokeStyle = hexA(color, 0.7); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(lx + 18, 421, 4, 0, Math.PI * 2); ctx.fill();
    font(ctx, m, 600, 13, 'body'); ctx.fillStyle = C.ink; ctx.fillText(label, lx + 30, 426);
  });
  ctx.restore();
  const sa = easeOut((local - 0.5) / 1);
  ctx.save();
  ctx.globalAlpha = BA * (sa);
  drawScreenshot(ctx, m, 700 + (1 - sa) * 40, 170, 510, 320, local);
  ctx.restore();
}

function drawOutro(ctx, m, local, t) {
  const a = easeOut(local / 0.8);
  ctx.save();
  ctx.globalAlpha = BA * (a);
  ctx.textAlign = 'left';
  font(ctx, m, 600, 12, 'mono');
  ctx.fillStyle = C.cyan;
  ctx.fillText('FINAL ARCHITECTURE MAP', 48, 52);
  font(ctx, m, 700, 30, 'display');
  ctx.fillStyle = C.ink;
  ctx.fillText(`${m.host}`, 48, 90);
  ctx.restore();
  panel(ctx, 36, 112, 1208, 470, { radius: 22, fill: 'rgba(12, 16, 38, 0.55)' });
  drawDiagram(ctx, m, { x: 60, y: 118, w: 1160, h: 458 }, { focus: [], t, local, alpha: a, flow: true });
  ctx.save();
  ctx.globalAlpha = BA * (easeOut((local - 1) / 0.8));
  font(ctx, m, 500, 13, 'body');
  ctx.fillStyle = C.muted;
  ctx.textAlign = 'center';
  ctx.fillText(`${m.counts.observed} observed  ·  ${m.counts.inferred} inferred  ·  ${m.counts.unknown} unknown   —   generated by StackReel from passive public observations`, W / 2, 612);
  ctx.restore();
}

function drawCaption(ctx, m, t) {
  const cue = captionAt(m.timeline, t);
  if (!cue) return;
  const fadeIn = clamp((t - cue.start) / 0.15);
  const fadeOut = clamp((cue.end - t) / 0.15);
  ctx.save();
  ctx.globalAlpha = BA * (Math.min(fadeIn, fadeOut));
  font(ctx, m, 600, 21, 'body');
  const lines = wrap(ctx, cue.text, 1040, 2);
  const bw = Math.min(1100, Math.max(...lines.map(l => ctx.measureText(l).width)) + 48);
  const bh = 22 + lines.length * 28;
  const bx = (W - bw) / 2, by = 700 - bh - 10;
  rr(ctx, bx, by, bw, bh, 14);
  ctx.fillStyle = 'rgba(4, 6, 16, 0.78)';
  ctx.fill();
  ctx.fillStyle = '#f8fafc';
  ctx.textAlign = 'center';
  lines.forEach((l, i) => ctx.fillText(l, W / 2, by + 34 + i * 28));
  ctx.restore();
}

function drawChrome(ctx, m, t) {
  const p = clamp(t / m.timeline.duration);
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(0, H - 3, W, 3);
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, C.violet); g.addColorStop(1, C.cyan);
  ctx.fillStyle = g;
  ctx.fillRect(0, H - 3, W * p, 3);
  font(ctx, m, 600, 11, 'mono');
  ctx.fillStyle = 'rgba(203, 213, 255, 0.45)';
  ctx.textAlign = 'right';
  ctx.fillText('STACKREEL', W - 40, 52);
  ctx.restore();
}

/** Paints the frame at time `t` (seconds). */
export function drawFrame(ctx, m, t) {
  ctx.save();
  ctx.setTransform(m.scale, 0, 0, m.scale, 0, 0);
  ctx.textBaseline = 'alphabetic';
  drawBackground(ctx, t);
  const seg = segmentAt(m.timeline, t);
  const tr = m.timeline.transition;
  const paint = (s, alpha) => {
    if (alpha <= 0) return;
    ctx.save();
    BA = alpha;
    ctx.globalAlpha = alpha;
    if (s.kind === 'intro') drawIntro(ctx, m, s.local);
    else if (s.kind === 'outro') drawOutro(ctx, m, s.local, t);
    else drawScene(ctx, m, s.index, s.local, t);
    ctx.restore();
    BA = 1;
  };
  // Cross-fade: the incoming segment fades in over the first `tr` seconds
  // while the previous segment (frozen at its end) fades out.
  if (seg.local < tr && t > tr) {
    const prev = segmentAt(m.timeline, t - seg.local - 0.001);
    const k = ease(seg.local / tr);
    paint(prev, 1 - k);
    paint(seg, k);
  } else {
    paint(seg, 1);
  }
  if (m.burnCaptions) drawCaption(ctx, m, t);
  drawChrome(ctx, m, t);
  ctx.restore();
}

export { LAYER_LABELS };
