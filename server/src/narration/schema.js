// Strict schemas for the architecture graph and the narration script.
// Everything an LLM returns is validated against these before use.
import { z } from 'zod';

const status = z.enum(['observed', 'inferred', 'unknown']);

export const nodeSchema = z.object({
  id: z.string().min(1).max(120),
  label: z.string().min(1).max(160),
  layer: z.enum(['client', 'edge', 'origin', 'frontend', 'api', 'backend', 'data', 'integrations', 'security']),
  type: z.string().max(40),
  status,
  confidence: z.number().min(0).max(1),
  description: z.string().max(1200),
  evidenceIds: z.array(z.string()).max(40),
  technologies: z.array(z.string()).max(40),
  limitations: z.array(z.string().max(300)).max(10),
  details: z.record(z.string(), z.union([z.string(), z.number()])),
});

export const edgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  label: z.string().max(60),
  explanation: z.string().max(400),
  status,
  evidenceIds: z.array(z.string()).max(20),
});

export const graphSchema = z.object({
  layers: z.array(z.object({ id: z.string(), label: z.string() })),
  nodes: z.array(nodeSchema).min(1).max(80),
  edges: z.array(edgeSchema).max(200),
}).superRefine((g, ctx) => {
  const ids = new Set(g.nodes.map(n => n.id));
  if (ids.size !== g.nodes.length) ctx.addIssue({ code: 'custom', message: 'duplicate node ids' });
  for (const e of g.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) ctx.addIssue({ code: 'custom', message: `edge ${e.id} references a missing node` });
  }
});

export const SCENE_KEYS = ['overview', 'frontend', 'request-flow', 'backend', 'security', 'summary'];

export const sceneSchema = z.object({
  id: z.number().int().min(1).max(6),
  key: z.enum(SCENE_KEYS),
  title: z.string().min(1).max(80),
  subtitle: z.string().max(160),
  narration: z.string().min(20).max(2400),
  focusNodeIds: z.array(z.string()).max(12),
  bullets: z.array(z.object({ text: z.string().max(140), status })).max(6),
  panel: z.object({ title: z.string().max(60), lines: z.array(z.string().max(160)).max(14) }),
  snippet: z.object({ title: z.string().max(80), language: z.string().max(20), code: z.string().max(1600), illustrative: z.boolean() }),
});

export const scriptSchema = z.object({
  provider: z.string(),
  targetDurationSec: z.number().min(30).max(600),
  scenes: z.array(sceneSchema).length(6),
  notes: z.array(z.string()).optional(),
});

/** What the LLM is allowed to return: wording only, keyed by scene. */
export const llmRewriteSchema = z.object({
  scenes: z.array(z.object({
    key: z.enum(SCENE_KEYS),
    subtitle: z.string().max(160),
    narration: z.string().min(20).max(2400),
  })).length(6),
});
