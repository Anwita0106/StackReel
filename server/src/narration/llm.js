// Optional LLM narration polish. The LLM only rewrites wording of the
// deterministic draft. Its output must pass the strict schema AND a guard
// that rejects any mention of a known technology that was not detected.
// On any failure the deterministic script is used and the reason recorded.
import { llmRewriteSchema } from './schema.js';
import { SIGNATURES, INTEGRATIONS } from '../analysis/signatures.js';

const EXTRA_PRODUCTS = ['PostgreSQL', 'Postgres', 'MySQL', 'MongoDB', 'Redis', 'DynamoDB', 'Cassandra', 'Elasticsearch', 'Kafka', 'RabbitMQ', 'Kubernetes', 'Docker', 'Terraform', 'Lambda', 'EC2', 'GCP', 'Azure', 'AWS', 'Google Cloud', 'Oracle', 'SQL Server', 'Snowflake', 'BigQuery', 'GraphQL', 'gRPC', 'Envoy', 'Istio'];

const AMBIGUOUS = new Set(['Render', 'Segment', 'Drift', 'Crisp', 'Clerk', 'Express', 'Ghost', 'Spring', 'Other', 'Static', 'Java', 'Microsoft', 'Google', 'Amazon', 'Apache']);

function buildPrompt(analysis, draft) {
  const facts = {
    site: analysis.site.host,
    technologies: analysis.technologies.map(t => ({ name: t.name, version: t.version, status: t.status, layer: t.layer })),
    integrations: analysis.integrations.map(i => i.name),
    nodes: analysis.graph.nodes.map(n => ({ label: n.label, layer: n.layer, status: n.status })),
    security: analysis.security.findings.map(f => ({ title: f.title, status: f.status, severity: f.severity })),
  };
  const targetWords = Math.round((draft.targetDurationSec * 150) / 60 / 6);
  return `You are the narrator of a technical documentary about how a website is built.
Rewrite the narration of each of the 6 scenes below so it flows naturally when spoken aloud, explains concepts clearly for a technical audience, and is about ${targetWords} words per scene.

HARD RULES:
- Use ONLY facts present in FACTS or the DRAFT. Do not add any technology, product, vendor, cloud provider, database, number or claim that is not there.
- Preserve the distinction between observed, inferred and unknown exactly as in the draft.
- Never describe a missing security header as a vulnerability.
- Return ONLY JSON matching: {"scenes":[{"key":"overview|frontend|request-flow|backend|security|summary","subtitle":"<=160 chars","narration":"..."}]} with all 6 keys in order.

FACTS:
${JSON.stringify(facts)}

DRAFT:
${JSON.stringify(draft.scenes.map(s => ({ key: s.key, subtitle: s.subtitle, narration: s.narration })))}`;
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('LLM response contained no JSON object');
  return JSON.parse(text.slice(start, end + 1));
}

async function callAnthropic(cfg, prompt, fetchImpl) {
  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(cfg.timeoutMs),
    headers: { 'content-type': 'application/json', 'x-api-key': cfg.anthropicKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: cfg.anthropicModel, max_tokens: 4000, messages: [{ role: 'user', content: prompt }] }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${body?.error?.message || 'request failed'}`);
  return body.content?.map(c => c.text || '').join('') || '';
}

async function callOpenAI(cfg, prompt, fetchImpl) {
  const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(cfg.timeoutMs),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.openaiKey}` },
    body: JSON.stringify({ model: cfg.openaiModel, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt }] }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${body?.error?.message || 'request failed'}`);
  return body.choices?.[0]?.message?.content || '';
}

export function llmStatus(cfg) {
  if (cfg.provider === 'anthropic') return cfg.anthropicKey ? { provider: 'anthropic', ready: true, model: cfg.anthropicModel } : { provider: 'anthropic', ready: false, reason: 'ANTHROPIC_API_KEY is not set' };
  if (cfg.provider === 'openai') return cfg.openaiKey ? { provider: 'openai', ready: true, model: cfg.openaiModel } : { provider: 'openai', ready: false, reason: 'OPENAI_API_KEY is not set' };
  return { provider: 'none', ready: false, reason: 'LLM_PROVIDER=none — deterministic narration is used' };
}

/** Rejects narration that names known products that were never detected. */
export function findUnsupportedMentions(text, analysis) {
  const detected = new Set([...analysis.technologies.map(t => t.name.toLowerCase()), ...analysis.integrations.map(i => i.name.toLowerCase()), ...analysis.graph.nodes.map(n => n.label.toLowerCase())]);
  const haystack = [...detected].join(' | ');
  const vocabulary = [...SIGNATURES.map(s => s.name), ...INTEGRATIONS.map(i => i[1]), ...EXTRA_PRODUCTS];
  const out = [];
  for (const name of vocabulary) {
    const base = name.split(/[ (/]/)[0];
    if (base.length < 3 || AMBIGUOUS.has(base)) continue;
    // Case-sensitive: product names are capitalized; avoids matching ordinary verbs ("react").
    const re = new RegExp(`\\b${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (re.test(text) && !haystack.includes(base.toLowerCase())) out.push(base);
  }
  return [...new Set(out)];
}

export async function refineScriptWithLlm(analysis, draft, cfg, { fetchImpl = fetch, logger } = {}) {
  const status = llmStatus(cfg);
  if (!status.ready) return { script: draft, llm: { used: false, reason: status.reason } };
  try {
    const prompt = buildPrompt(analysis, draft);
    const text = status.provider === 'anthropic' ? await callAnthropic(cfg, prompt, fetchImpl) : await callOpenAI(cfg, prompt, fetchImpl);
    const parsed = llmRewriteSchema.parse(extractJson(text));
    const draftKeys = draft.scenes.map(s => s.key).join(',');
    if (parsed.scenes.map(s => s.key).join(',') !== draftKeys) throw new Error('LLM returned scenes in the wrong order');
    const unsupported = findUnsupportedMentions(parsed.scenes.map(s => s.narration + ' ' + s.subtitle).join(' '), analysis);
    if (unsupported.length) throw new Error(`LLM introduced unsupported technologies: ${unsupported.join(', ')}`);
    const scenes = draft.scenes.map((s, i) => ({ ...s, subtitle: parsed.scenes[i].subtitle || s.subtitle, narration: parsed.scenes[i].narration }));
    return { script: { ...draft, provider: status.provider, scenes }, llm: { used: true, provider: status.provider, model: status.model } };
  } catch (err) {
    logger?.warn?.('LLM narration refinement failed; using deterministic script', { err });
    return { script: draft, llm: { used: false, provider: status.provider, error: err.message.slice(0, 300) } };
  }
}
