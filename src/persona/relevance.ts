/** Bounded local topic matching. Alias groups are explicit, not a general semantic model. */
import type { FactRow, MessageRow } from '../memory/store.js';
import type { Persona } from '../core/types.js';

const GENERIC = new Set(['用户','喜欢','偏好','兴趣','聊天','大家','今天','现在','什么','怎么','你好','谢谢','知道','问题','东西']);
const ALIASES = [
  ['编程','写代码','coding','programming'], ['向量化','文本嵌入','embedding'],
  ['人工智能','ai'], ['大语言模型','大模型','llm'], ['猫咪','小猫','猫猫'],
  ['无糖','零糖','不含糖'], ['摄影','拍照'], ['健身','锻炼'],
];
const normalize = (text: string) => text.normalize('NFKC').toLowerCase().trim();
function useful(term: string): boolean {
  return term.length >= 2 && term.length <= 100 && !GENERIC.has(term) && /[\p{L}]/u.test(term);
}
function contains(text: string, term: string): boolean {
  if (!useful(term)) return false;
  if (/^[a-z0-9_.+ -]+$/.test(term)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(?<![a-z0-9_])' + escaped + '(?![a-z0-9_])', 'u').test(text);
  }
  return text.includes(term);
}
function match(text: string, term: string): number {
  if (contains(text, term)) return 1;
  const family = ALIASES.find(group => group.includes(term));
  return family?.some(alias => contains(text, alias)) ? 0.85 : 0;
}

function evidenceSpans(text: string, terms: string[]): Array<{start: number; end: number; strength: number}> {
  const spans = terms.flatMap(term => {
    const alternatives = [term, ...(ALIASES.find(group => group.includes(term)) ?? [])];
    const matched = alternatives.find(alias => contains(text, alias));
    if (!matched) return [];
    const start = text.indexOf(matched);
    return [{start, end: start + matched.length, strength: matched === term ? 1 : 0.85}];
  }).sort((a, b) => a.start - b.start || b.end - a.end);
  const clusters: typeof spans = [];
  for (const span of spans) {
    const last = clusters.at(-1);
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
      last.strength = Math.min(last.strength, span.strength);
    } else clusters.push({...span});
  }
  return clusters;
}

export interface RelevanceResult {
  score: number;
  source: 'persona' | 'memory' | 'none';
  factIds: number[];
  inherited: boolean;
}

function scoreText(text: string, persona: Persona | undefined, facts: FactRow[]): RelevanceResult {
  const query = normalize(text.slice(-2000));
  let personaScore = 0;
  // Never derive interests from arbitrary identity/style/rules prose.
  for (const topic of persona?.proactiveTopics ?? []) {
    const strength = Math.max(0, ...topic.split(/[|｜]/).slice(0, 12).map(t => match(query, normalize(t))));
    personaScore = Math.max(personaScore, 0.85 * strength);
  }
  // Existing explicit keywords remain a weaker compatibility signal.
  for (const term of (persona?.triggers.keywords ?? []).slice(0, 32)) {
    personaScore = Math.max(personaScore, 0.65 * match(query, normalize(term)));
  }
  let memoryScore = 0;
  const factIds: number[] = [];
  for (const fact of facts.slice(0, 200)) {
    if (!fact.active || fact.private || fact.confidence < 0.6) continue;
    const terms = [...new Set(normalize(fact.keywords).split(/[\s,，;；|｜]+/).filter(useful))].slice(0, 32);
    const independent = evidenceSpans(query, terms);
    if (!independent.length) continue;
    // Overlapping Chinese bigrams form one phrase, not several independent hits.
    const specific = independent.some(h => h.end - h.start >= 4);
    const base = independent.length >= 2 ? 0.8 : specific ? 0.72 : 0.5;
    const strength = Math.max(...independent.map(h => h.strength));
    const score = base * strength * (0.8 + 0.2 * fact.confidence);
    memoryScore = Math.max(memoryScore, score);
    factIds.push(fact.id);
  }
  const best = Math.max(personaScore, memoryScore);
  return {score: Math.min(1, best + (personaScore > 0 && memoryScore > 0 ? 0.06 : 0)),
    source: best === 0 ? 'none' : personaScore >= memoryScore ? 'persona' : 'memory',
    factIds: factIds.slice(0, 8), inherited: false};
}

/** Current message dominates; old unrelated topic cannot independently cross the default threshold. */
export function assessRelevance(messages: Pick<MessageRow, 'content' | 'created_at'>[], persona: Persona | undefined, facts: FactRow[], now = Date.now()): RelevanceResult {
  const fresh = messages.filter(m => now - m.created_at <= 120_000 && m.created_at <= now + 5000).slice(-6);
  const latest = fresh.at(-1);
  if (!latest) return {score: 0, source: 'none', factIds: [], inherited: false};
  const current = scoreText(latest.content, persona, facts);
  const continuation = /^(?:那(?:要|该|怎么|如何)|这(?:个|种)(?:怎么|如何|能|有|要)|具体(?:怎么|如何)|然后呢|为什么[?？]?$)/.test(normalize(latest.content));
  let best = current;
  for (const previous of fresh.slice(-3, -1)) {
    const candidate = scoreText(previous.content, persona, facts);
    const age = Math.max(0, now - previous.created_at);
    const factor = (continuation ? 0.85 : 0.35) * Math.max(0, 1 - age / 120_000);
    if (candidate.score * factor > best.score) best = {...candidate, score: candidate.score * factor, inherited: true};
  }
  return best;
}
