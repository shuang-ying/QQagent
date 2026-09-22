/**
 * 情绪提取
 *
 * 三种模式：
 *   rule   —— 中文情绪词典 + 规则打分，零成本、零延迟
 *   llm    —— 用小模型分析，准确但耗 token
 *   hybrid —— 规则先跑，置信度低时才调用 LLM（默认，平衡成本与准确度）
 *
 * 输出 5 个维度：标签 + 效价/唤醒/支配/强度
 */
import type { Logger } from '../core/logger.js';
import type { EmotionScore } from '../core/types.js';
import type { ProviderManager } from '../llm/manager.js';

// ============================================================
// 中文情绪词典
// 每个词带 [效价, 唤醒, 支配, 强度]，效价 -1~1，其余 0~1
// ============================================================

type LexEntry = [string, number, number, number, number];

const LEXICON: LexEntry[] = [
  // ---- 喜悦 ----
  ['开心', 0.8, 0.6, 0.6, 0.7], ['高兴', 0.8, 0.6, 0.6, 0.7], ['快乐', 0.8, 0.6, 0.6, 0.7],
  ['太好了', 0.9, 0.8, 0.6, 0.8], ['哈哈', 0.7, 0.7, 0.6, 0.6], ['嘿嘿', 0.7, 0.6, 0.6, 0.5],
  ['爽', 0.8, 0.7, 0.7, 0.7], ['舒服', 0.7, 0.3, 0.6, 0.5], ['幸福', 0.9, 0.5, 0.6, 0.8],
  ['喜欢', 0.8, 0.5, 0.6, 0.6], ['爱', 0.9, 0.6, 0.5, 0.8], ['好耶', 0.9, 0.8, 0.6, 0.7],
  ['谢谢', 0.6, 0.4, 0.5, 0.5], ['感谢', 0.6, 0.4, 0.5, 0.5], ['牛逼', 0.8, 0.8, 0.6, 0.7],
  ['厉害', 0.7, 0.6, 0.5, 0.6], ['棒', 0.8, 0.6, 0.6, 0.6], ['期待', 0.6, 0.6, 0.5, 0.6],

  // ---- 悲伤 ----
  ['难过', -0.7, 0.3, 0.2, 0.7], ['伤心', -0.8, 0.4, 0.2, 0.8], ['哭', -0.7, 0.5, 0.2, 0.7],
  ['呜呜', -0.6, 0.4, 0.2, 0.6], ['难受', -0.6, 0.4, 0.3, 0.6], ['委屈', -0.7, 0.5, 0.2, 0.7],
  ['失落', -0.6, 0.2, 0.3, 0.6], ['沮丧', -0.7, 0.3, 0.2, 0.7], ['绝望', -0.9, 0.5, 0.1, 0.9],
  ['孤独', -0.7, 0.2, 0.2, 0.7], ['寂寞', -0.6, 0.2, 0.3, 0.6], ['心疼', -0.6, 0.4, 0.3, 0.6],
  ['emo', -0.6, 0.2, 0.3, 0.6], ['想哭', -0.7, 0.5, 0.2, 0.7], ['累了', -0.5, 0.2, 0.3, 0.5],
  ['好累', -0.5, 0.2, 0.3, 0.5], ['心碎', -0.9, 0.6, 0.1, 0.9],

  // ---- 愤怒 ----
  // 愤怒的关键特征是「高唤醒 + 高支配」（我要采取行动），支配度必须给高，
  // 否则会被误判成焦虑/恐惧（同样是高唤醒负效价，但支配度低）。
  ['生气', -0.7, 0.8, 0.7, 0.8], ['愤怒', -0.8, 0.9, 0.75, 0.9], ['烦', -0.6, 0.6, 0.6, 0.6],
  ['讨厌', -0.7, 0.6, 0.65, 0.7], ['可恶', -0.7, 0.7, 0.7, 0.7], ['滚', -0.8, 0.9, 0.8, 0.8],
  ['气死', -0.8, 0.9, 0.7, 0.9], ['无语', -0.5, 0.4, 0.6, 0.5], ['受不了', -0.7, 0.7, 0.6, 0.7],
  ['妈的', -0.7, 0.8, 0.7, 0.7], ['靠', -0.5, 0.7, 0.65, 0.5], ['哼', -0.3, 0.5, 0.65, 0.4],

  // ---- 焦虑 ----
  // 焦虑的关键特征是「高唤醒 + 低支配」（我无力应对），支配度给低。
  ['焦虑', -0.6, 0.7, 0.2, 0.7], ['担心', -0.5, 0.6, 0.3, 0.6], ['害怕', -0.7, 0.8, 0.15, 0.8],
  ['紧张', -0.5, 0.8, 0.25, 0.7], ['慌', -0.6, 0.8, 0.15, 0.7], ['压力', -0.5, 0.6, 0.3, 0.6],
  ['怎么办', -0.5, 0.7, 0.15, 0.6], ['急', -0.5, 0.8, 0.3, 0.6], ['不安', -0.6, 0.6, 0.2, 0.6],
  ['睡不着', -0.5, 0.5, 0.3, 0.6], ['崩溃', -0.8, 0.9, 0.1, 0.9],

  // ---- 惊讶 ----
  ['震惊', 0.1, 0.9, 0.4, 0.8], ['天啊', 0.1, 0.8, 0.4, 0.7], ['卧槽', 0.0, 0.9, 0.4, 0.7],
  ['居然', 0.1, 0.7, 0.4, 0.6], ['真的假的', 0.1, 0.8, 0.4, 0.7], ['哇', 0.5, 0.8, 0.5, 0.6],
  ['诶', 0.1, 0.6, 0.4, 0.4],

  // ---- 正面平静 ----
  ['嗯', 0.1, 0.2, 0.5, 0.3], ['好', 0.2, 0.2, 0.6, 0.3], ['收到', 0.1, 0.2, 0.6, 0.3],
  ['懂了', 0.1, 0.3, 0.6, 0.4], ['明白', 0.1, 0.3, 0.6, 0.4], ['可以', 0.2, 0.2, 0.6, 0.3],
];

/** 强否定词：出现在情绪词前会翻转效价 */
const NEGATIONS = ['不', '没', '别', '无', '非', '未'];

/** 程度副词：放大或缩小强度 */
const INTENSIFIERS: Array<[string, number]> = [
  ['非常', 1.5], ['特别', 1.5], ['超级', 1.6], ['巨', 1.5], ['超', 1.4],
  ['好', 1.2], ['很', 1.3], ['太', 1.4], ['真', 1.3], ['有点', 0.7], ['稍微', 0.6], ['一点点', 0.5],
];

/** 标点/表情强化信号 */
const EXCITED_PUNCT = /[!！]{2,}/;
const QUESTION_PUNCT = /[?？]{2,}/;
const LAUGH = /(哈哈|hhh|233|😂|🤣|笑死)/i;
const CRY = /(呜呜|555|😭|🥺|QAQ|T_T)/i;

export interface RuleResult extends EmotionScore {
  /** 命中的词，便于调试 */
  matched: string[];
}

/**
 * 规则情绪分析
 */
export function analyzeByRule(text: string): RuleResult {
  if (!text.trim()) {
    return { label: 'neutral', confidence: 0.3, valence: 0, arousal: 0.2, dominance: 0.5, intensity: 0.1, matched: [] };
  }

  let vSum = 0;
  let aSum = 0;
  let dSum = 0;
  let iSum = 0;
  let weightSum = 0;
  /** 程度副词的整体放大系数（用于强度，不参与权重归一化） */
  let intensifierSum = 0;
  let intensifierCount = 0;
  const matched: string[] = [];

  const lower = text.toLowerCase();

  for (const [word, v, a, d, i] of LEXICON) {
    const idx = lower.indexOf(word.toLowerCase());
    if (idx === -1) continue;

    let weight = 1;
    // 检查词前 2 个字符是否有否定词
    const before = lower.slice(Math.max(0, idx - 2), idx);
    const negated = NEGATIONS.some((n) => before.endsWith(n));
    // 检查词前是否有程度副词
    let mult = 1;
    for (const [adv, m] of INTENSIFIERS) {
      if (before.endsWith(adv)) {
        mult = m;
        break;
      }
    }
    weight *= mult;

    const sign = negated ? -1 : 1;
    vSum += v * sign * weight;
    aSum += a * weight;
    dSum += d * weight;
    // 强度用未归一化的累加，最后单独平均，这样程度副词才能真正放大强度
    iSum += i * mult;
    weightSum += weight;
    intensifierSum += mult;
    intensifierCount++;
    matched.push(negated ? `不${word}` : word);
  }

  // 标点与网络用语信号
  if (EXCITED_PUNCT.test(text)) {
    aSum += 0.4;
    iSum += 0.3;
    weightSum += 0.3;
  }
  if (QUESTION_PUNCT.test(text)) {
    aSum += 0.2;
    weightSum += 0.2;
  }
  if (LAUGH.test(text)) {
    vSum += 0.5;
    aSum += 0.3;
    iSum += 0.3;
    weightSum += 0.4;
    matched.push('笑声');
  }
  if (CRY.test(text)) {
    vSum -= 0.5;
    iSum += 0.3;
    weightSum += 0.4;
    matched.push('哭泣');
  }

  if (weightSum === 0) {
    // 没有任何信号：中性
    // 但如果句子较长且带问号，可能是在求助/疑惑
    const arousal = QUESTION_PUNCT.test(text) ? 0.45 : 0.25;
    return {
      label: 'neutral',
      confidence: 0.35,
      valence: 0,
      arousal,
      dominance: 0.5,
      intensity: 0.1,
      matched: [],
    };
  }

  const valence = clamp(vSum / weightSum, -1, 1);
  const arousal = clamp(aSum / weightSum, 0, 1);
  const dominance = clamp(dSum / weightSum, 0, 1);
  // 强度：情绪词自身强度 × 程度副词的平均放大系数
  const avgIntensifier = intensifierCount > 0 ? intensifierSum / intensifierCount : 1;
  const baseIntensity = intensifierCount > 0 ? iSum / intensifierCount : 0;
  const intensity = clamp(baseIntensity * avgIntensifier, 0, 1);

  const label = classify(valence, arousal, dominance, intensity);
  // 命中词越多越可信
  const confidence = clamp(0.4 + Math.min(matched.length, 4) * 0.13 + intensity * 0.2, 0, 0.95);

  return { label, confidence, valence, arousal, dominance, intensity, matched };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/** 由维度判定情绪标签 */
export function classify(valence: number, arousal: number, dominance: number, intensity: number): string {
  if (intensity < 0.25 && Math.abs(valence) < 0.25) return 'neutral';

  if (valence > 0.25) {
    if (arousal > 0.6) return 'joy';
    return 'calm-happy';
  }
  if (valence < -0.25) {
    if (arousal > 0.6) {
      // 高唤醒的负面情绪：支配度高是愤怒，低是焦虑/恐惧。
      // 阈值取 0.5 偏保守——混合文本里愤怒与焦虑常同时出现，取中间值更稳。
      return dominance >= 0.5 ? 'anger' : 'anxiety';
    }
    return 'sadness';
  }
  if (arousal > 0.65) return 'surprise';
  return 'neutral';
}

// ============================================================
// LLM 情绪分析
// ============================================================

const EMOTION_PROMPT = `你是一个情绪分析器。分析用户消息中体现的情绪。

只输出一个 JSON 对象，不要任何其他文字、不要代码块标记：
{"label":"情绪标签","valence":效价,"arousal":唤醒度,"dominance":支配度,"intensity":强度,"confidence":置信度}

字段说明：
- label: 从这些中选最贴切的一个: joy(喜悦) sadness(悲伤) anger(愤怒) anxiety(焦虑) surprise(惊讶) calm-happy(平静愉悦) neutral(中性)
- valence: -1 到 1，负面到正面
- arousal: 0 到 1，平静到激动
- dominance: 0 到 1，无力到掌控
- intensity: 0 到 1，情绪强度
- confidence: 0 到 1，你的判断置信度

注意：分析的是"发消息的人"的情绪，不是你的。讽刺、反话要识别出来。`;

export class EmotionAnalyzer {
  constructor(
    private mode: 'rule' | 'llm' | 'hybrid',
    private manager: ProviderManager | null,
    private providerKey: string,
    private modelId: string,
    private readonly log: Logger,
    /** hybrid 模式下规则置信度低于此值才调 LLM */
    private readonly llmThreshold = 0.6,
  ) {}

  /**
   * 热更新配置（面板切换情绪开关 / 方式 / 模型时调用）。
   * 注意：是否启用的总开关由 pipeline 直接读 cfg.emotion.enabled 判断。
   */
  configure(patch: {
    mode?: 'rule' | 'llm' | 'hybrid';
    manager?: ProviderManager | null;
    providerKey?: string;
    modelId?: string;
  }): void {
    if (patch.mode !== undefined) this.mode = patch.mode;
    if (patch.manager !== undefined) this.manager = patch.manager;
    if (patch.providerKey !== undefined) this.providerKey = patch.providerKey;
    if (patch.modelId !== undefined) this.modelId = patch.modelId;
  }

  /** 当前生效的配置（面板展示用） */
  describe(): { mode: string; providerKey: string; modelId: string } {
    return { mode: this.mode, providerKey: this.providerKey, modelId: this.modelId };
  }

  /**
   * 分析一条消息的情绪。
   * 永不抛异常——失败时回退到规则结果，保证主流程不受影响。
   */
  async analyze(text: string, signal?: AbortSignal): Promise<EmotionScore> {
    const rule = analyzeByRule(text);

    if (this.mode === 'rule' || !this.manager) {
      return stripMatched(rule);
    }

    if (this.mode === 'hybrid' && rule.confidence >= this.llmThreshold) {
      // 规则已经很确定了，省钱
      return stripMatched(rule);
    }

    try {
      const res = await this.manager.chat(
        [
          { role: 'system', content: EMOTION_PROMPT },
          { role: 'user', content: text.slice(0, 800) },
        ],
        this.providerKey,
        this.modelId || undefined,
        { temperature: 0, maxTokens: 200, ...(signal ? { signal } : {}) },
      );
      const parsed = parseEmotionJson(res.content);
      if (parsed) {
        this.log.debug({ label: parsed.label, mode: this.mode, ruleLabel: rule.label }, 'LLM 情绪分析完成');
        return parsed;
      }
      this.log.debug({ raw: res.content.slice(0, 120) }, 'LLM 情绪返回格式异常，回退规则结果');
    } catch (e) {
      this.log.debug({ err: (e as Error).message }, 'LLM 情绪分析失败，回退规则结果');
    }

    return stripMatched(rule);
  }

  /**
   * 批量分析（用于摘要历史消息）
   */
  analyzeBatch(texts: string[]): EmotionScore[] {
    return texts.map((t) => stripMatched(analyzeByRule(t)));
  }
}

function stripMatched(r: RuleResult): EmotionScore {
  return {
    label: r.label,
    confidence: r.confidence,
    valence: r.valence,
    arousal: r.arousal,
    dominance: r.dominance,
    intensity: r.intensity,
  };
}

/** 从 LLM 输出中稳健地解析情绪 JSON（容忍代码块包裹等） */
export function parseEmotionJson(raw: string): EmotionScore | null {
  let s = raw.trim();
  // 去掉可能的 ```json 包裹
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  s = s.slice(start, end + 1);

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }

  const num = (v: unknown, dflt: number, lo: number, hi: number): number => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? clamp(n, lo, hi) : dflt;
  };

  const label = String(obj['label'] ?? 'neutral').trim().toLowerCase();
  const validLabels = ['joy', 'sadness', 'anger', 'anxiety', 'surprise', 'calm-happy', 'neutral'];
  const finalLabel = validLabels.includes(label) ? label : 'neutral';

  return {
    label: finalLabel,
    confidence: num(obj['confidence'], 0.7, 0, 1),
    valence: num(obj['valence'], 0, -1, 1),
    arousal: num(obj['arousal'], 0.3, 0, 1),
    dominance: num(obj['dominance'], 0.5, 0, 1),
    intensity: num(obj['intensity'], 0.4, 0, 1),
  };
}

/** 情绪标签的中文名，用于面板与提示词 */
export const EMOTION_LABELS_CN: Record<string, string> = {
  joy: '喜悦',
  sadness: '悲伤',
  anger: '愤怒',
  anxiety: '焦虑',
  surprise: '惊讶',
  'calm-happy': '平静愉悦',
  neutral: '中性',
};
