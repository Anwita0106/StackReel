// File-system persistence behind a small interface (swap for a database
// later without touching routes). Every path is built from a validated ID,
// and writes are atomic (write temp file, then rename).
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { isValidId } from '../lib/ids.js';

async function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data));
  await fs.rename(tmp, file);
}
async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export function projectSummary(p) {
  return {
    id: p.id,
    createdAt: p.createdAt,
    url: p.url,
    finalUrl: p.finalUrl,
    site: p.site,
    title: p.browser?.dom?.title || p.site.host,
    hasScreenshot: Boolean(p.hasScreenshot),
    browserRendered: Boolean(p.browser?.ok),
    counts: {
      technologies: p.technologies.length,
      observed: p.graph.nodes.filter(n => n.status === 'observed').length,
      inferred: p.graph.nodes.filter(n => n.status === 'inferred').length,
      unknown: p.graph.nodes.filter(n => n.status === 'unknown').length,
      concerns: p.security.summary.concerns,
    },
    topTechnologies: p.technologies.filter(t => t.status === 'observed').slice(0, 5).map(t => t.name),
  };
}

export function renderSummary(r) {
  return {
    id: r.id, projectId: r.projectId, host: r.host, createdAt: r.createdAt, durationSec: r.durationSec,
    width: r.width, height: r.height, fps: r.fps, sizeBytes: r.sizeBytes, tts: r.tts,
  };
}

export function createFileStore(dataDir) {
  const projectsDir = path.join(dataDir, 'projects');
  const rendersDir = path.join(dataDir, 'renders');

  const projectDir = (id) => {
    if (!isValidId('project', id)) throw new Error('invalid project id');
    return path.join(projectsDir, id);
  };
  const renderDir = (id) => {
    if (!isValidId('render', id)) throw new Error('invalid render id');
    return path.join(rendersDir, id);
  };

  return {
    dataDir,
    async init() {
      await fs.mkdir(projectsDir, { recursive: true });
      await fs.mkdir(rendersDir, { recursive: true });
      // Remove renders that never completed (e.g. server stopped mid-render).
      let removed = 0;
      for (const name of await fs.readdir(rendersDir)) {
        const dir = path.join(rendersDir, name);
        if (!isValidId('render', name) || !fss.existsSync(path.join(dir, 'render.json'))) {
          await fs.rm(dir, { recursive: true, force: true });
          removed += 1;
        }
      }
      return { removedIncompleteRenders: removed };
    },
    async checkWritable() {
      const probe = path.join(dataDir, `.write-test-${process.pid}`);
      await fs.writeFile(probe, 'ok');
      await fs.rm(probe);
      return true;
    },

    projectDir,
    renderDir,
    async saveProject(project, { screenshot } = {}) {
      const dir = projectDir(project.id);
      await fs.mkdir(dir, { recursive: true });
      if (screenshot) await fs.writeFile(path.join(dir, 'screenshot.jpg'), screenshot);
      await writeJsonAtomic(path.join(dir, 'project.json'), { ...project, hasScreenshot: Boolean(screenshot) });
    },
    async getProject(id) {
      if (!isValidId('project', id)) return null;
      return readJson(path.join(projectDir(id), 'project.json'));
    },
    screenshotPath(id) {
      const file = path.join(projectDir(id), 'screenshot.jpg');
      return fss.existsSync(file) ? file : null;
    },
    async listProjects() {
      const out = [];
      for (const name of await fs.readdir(projectsDir).catch(() => [])) {
        if (!isValidId('project', name)) continue;
        const p = await readJson(path.join(projectsDir, name, 'project.json')).catch(() => null);
        if (p) out.push(projectSummary(p));
      }
      return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async deleteProject(id) {
      if (!isValidId('project', id)) return false;
      const existed = fss.existsSync(projectDir(id));
      for (const r of await this.listRenders({ projectId: id })) await this.deleteRender(r.id);
      await fs.rm(projectDir(id), { recursive: true, force: true });
      return existed;
    },
    async pruneProjects(max) {
      const list = await this.listProjects();
      for (const p of list.slice(max)) await this.deleteProject(p.id);
    },

    async saveRender(record) {
      await writeJsonAtomic(path.join(renderDir(record.id), 'render.json'), record);
    },
    async getRender(id) {
      if (!isValidId('render', id)) return null;
      return readJson(path.join(renderDir(id), 'render.json'));
    },
    async listRenders({ projectId } = {}) {
      const out = [];
      for (const name of await fs.readdir(rendersDir).catch(() => [])) {
        if (!isValidId('render', name)) continue;
        const r = await readJson(path.join(rendersDir, name, 'render.json')).catch(() => null);
        if (r && (!projectId || r.projectId === projectId)) out.push(r);
      }
      return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async deleteRender(id) {
      if (!isValidId('render', id)) return;
      await fs.rm(renderDir(id), { recursive: true, force: true });
    },
    /** Resolves a downloadable file inside a render directory, refusing traversal. */
    renderFilePath(id, fileName) {
      const allowed = /^(video\.mp4|poster\.jpg|captions\.vtt|captions\.srt|narration\.wav|thumb-[1-6]\.jpg)$/;
      if (!isValidId('render', id) || !allowed.test(fileName)) return null;
      const dir = renderDir(id);
      const full = path.resolve(dir, fileName);
      if (path.relative(dir, full).startsWith('..') || path.isAbsolute(path.relative(dir, full))) return null;
      return fss.existsSync(full) ? full : null;
    },
  };
}
