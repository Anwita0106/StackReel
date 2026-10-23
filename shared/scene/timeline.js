// Shared timeline: scene start/end times, narration windows and caption cues.
// The server builds it from REAL audio durations; the browser preview uses
// estimated durations (≈150 words/minute) and says so.

export const TIMING = { intro: 4.5, outro: 5.5, leadIn: 0.6, tail: 1.0, transition: 0.6 };

export function estimateSpeechSeconds(text) {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(3, words / 2.5);
}

/** Splits narration into readable caption chunks (≤ ~84 chars). */
export function chunkCaptions(text) {
  // Split at sentence ends only (". " followed by a capital/quote), so "Next.js" or "1.25.3" stay intact.
  const sentences = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?]["')\]]?)\s+(?=[A-Z0-9"'(])/);
  const chunks = [];
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (sentence.length <= 84) { chunks.push(sentence); continue; }
    const words = sentence.split(' ');
    let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > 84 && cur) {
        // prefer breaking after commas when close
        chunks.push(cur.trim());
        cur = w;
      } else cur = (cur + ' ' + w).trim();
    }
    if (cur) chunks.push(cur.trim());
  }
  return chunks;
}

export function buildTimeline(scenes, speechDurations, timing = TIMING) {
  let t = timing.intro;
  const outScenes = [];
  const captions = [];
  scenes.forEach((scene, i) => {
    const speech = Math.max(0.5, speechDurations[i]);
    const start = t;
    const speechStart = start + timing.leadIn;
    const speechEnd = speechStart + speech;
    const end = speechEnd + timing.tail;
    outScenes.push({ index: i, id: scene.id, key: scene.key, title: scene.title, start, end, speechStart, speechEnd });
    const chunks = chunkCaptions(scene.narration);
    const weights = chunks.map(c => c.length + 8);
    const total = weights.reduce((a, b) => a + b, 0);
    let c0 = speechStart;
    chunks.forEach((text, j) => {
      const dur = (speech * weights[j]) / total;
      captions.push({ start: round(c0), end: round(c0 + dur), text, sceneIndex: i });
      c0 += dur;
    });
    t = end;
  });
  const outro = { start: t, end: t + timing.outro };
  return { duration: round(outro.end), intro: { start: 0, end: timing.intro }, scenes: outScenes, outro, captions, transition: timing.transition };
}

const round = (n) => Math.round(n * 1000) / 1000;

export function toVtt(captions) {
  const ts = (s) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = (s % 60).toFixed(3).padStart(6, '0');
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec}`;
  };
  return 'WEBVTT\n\n' + captions.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}\n`).join('\n');
}

export function toSrt(captions) {
  const ts = (s) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60), ms = Math.round((s % 1) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(Math.min(ms, 999)).padStart(3, '0')}`;
  };
  return captions.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}\n`).join('\n');
}

/** Which segment is on screen at time t, plus transition blending info. */
export function segmentAt(timeline, t) {
  if (t < timeline.intro.end) return { kind: 'intro', local: t, duration: timeline.intro.end };
  for (const s of timeline.scenes) {
    if (t < s.end) return { kind: 'scene', index: s.index, local: t - s.start, duration: s.end - s.start, scene: s };
  }
  return { kind: 'outro', local: t - timeline.outro.start, duration: timeline.outro.end - timeline.outro.start };
}

export function captionAt(timeline, t) {
  return timeline.captions.find(c => t >= c.start && t < c.end) || null;
}
