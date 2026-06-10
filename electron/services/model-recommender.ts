import type { HardwareTier } from './hardware-probe.js';

export interface ModelRecommendation {
  name: string;           // Ollama tag, e.g. "qwen3-coder:30b"
  displayName: string;    // human readable
  sizeGB: number;         // approx download size
  tier: HardwareTier;     // minimum tier
  category: 'code' | 'general' | 'reasoning' | 'small';
  description: string;
  recommended: boolean;   // top pick for that tier
  libraryUrl: string;     // Ollama library page; download still happens in-app
}

// Curated Ollama models for local coding. We keep this list picky: strong coding,
// agentic, or frontier-ish general models only. No fake tags, no random junk.
const ALL_MODELS: ModelRecommendation[] = [
  // EXTREME tier
  {
    name: 'deepseek-v3',
    displayName: 'DeepSeek V3 671B',
    sizeGB: 404,
    tier: 'extreme',
    category: 'reasoning',
    description: 'Фронтирная MoE-модель уровня сильных закрытых LLM, но очень тяжёлая: только для машин/серверов с сотнями GB памяти.',
    recommended: false,
    libraryUrl: 'https://ollama.com/library/deepseek-v3',
  },
  {
    name: 'qwen3-coder:30b',
    displayName: 'Qwen3 Coder 30B',
    sizeGB: 19,
    tier: 'extreme',
    category: 'code',
    description: 'Один из лучших локальных coding-agent вариантов: длинный контекст, сильная работа по репозиториям и многошаговым правкам.',
    recommended: true,
    libraryUrl: 'https://ollama.com/library/qwen3-coder',
  },
  {
    name: 'gemma4:31b',
    displayName: 'Gemma 4 31B',
    sizeGB: 20,
    tier: 'extreme',
    category: 'general',
    description: 'Сильная dense-модель Google DeepMind: хороша для reasoning, инструкций и кода, когда нужен универсальный локальный мозг.',
    recommended: false,
    libraryUrl: 'https://ollama.com/library/gemma4',
  },
  {
    name: 'gemma4:26b',
    displayName: 'Gemma 4 26B MoE',
    sizeGB: 18,
    tier: 'extreme',
    category: 'general',
    description: 'MoE-вариант Gemma 4 с меньшим числом активных параметров; хороший баланс качества и скорости для тяжёлого локального режима.',
    recommended: false,
    libraryUrl: 'https://ollama.com/library/gemma4',
  },
  {
    name: 'qwen2.5-coder:32b',
    displayName: 'Qwen 2.5 Coder 32B',
    sizeGB: 20,
    tier: 'extreme',
    category: 'code',
    description: 'Проверенная тяжёлая coding-модель. Хорошо держит большие правки, рефакторинг и TypeScript/Python задачи.',
    recommended: false,
    libraryUrl: 'https://ollama.com/library/qwen2.5-coder',
  },
  {
    name: 'deepseek-coder:33b',
    displayName: 'DeepSeek Coder 33B',
    sizeGB: 19,
    tier: 'extreme',
    category: 'code',
    description: 'Старшая DeepSeek Coder модель: не новая, но всё ещё сильная для генерации и разбора кода.',
    recommended: false,
    libraryUrl: 'https://ollama.com/library/deepseek-coder',
  },
  {
    name: 'wizardcoder:33b',
    displayName: 'WizardCoder 33B',
    sizeGB: 19,
    tier: 'extreme',
    category: 'code',
    description: 'Сильный классический кодер на базе DeepSeek/Code Llama lineage. Полезен как альтернативный стиль генерации.',
    recommended: false,
    libraryUrl: 'https://ollama.com/library/wizardcoder',
  },

  // HIGH tier
  {
    name: 'devstral',
    displayName: 'Devstral 24B',
    sizeGB: 14,
    tier: 'high',
    category: 'code',
    description: 'Агентная модель для software engineering: исследует кодовую базу, пишет многофайловые правки, хороша для Cursor/Codex-like сценариев.',
    recommended: true,
    libraryUrl: 'https://ollama.com/library/devstral',
  },
  {
    name: 'codestral',
    displayName: 'Codestral 22B',
    sizeGB: 13,
    tier: 'high',
    category: 'code',
    description: 'Mistral code model для генерации, тестов и completion/FIM. Хороший выбор, если нужен именно “кодовый мотор”.',
    recommended: false,
    libraryUrl: 'https://ollama.com/library/codestral',
  },
  {
    name: 'deepseek-coder-v2:16b',
    displayName: 'DeepSeek Coder V2 16B',
    sizeGB: 8.9,
    tier: 'high',
    category: 'code',
    description: 'MoE-кодер DeepSeek, сравнимый с сильными закрытыми моделями на code-specific задачах при адекватном размере.',
    recommended: false,
    libraryUrl: 'https://ollama.com/library/deepseek-coder-v2',
  },
  {
    name: 'qwen2.5-coder:14b',
    displayName: 'Qwen 2.5 Coder 14B',
    sizeGB: 9,
    tier: 'high',
    category: 'code',
    description: 'Очень крепкий локальный кодер для среднего железа. Быстрее больших 30B+, но всё ещё качественный.',
    recommended: false,
    libraryUrl: 'https://ollama.com/library/qwen2.5-coder',
  },
  {
    name: 'starcoder2:15b',
    displayName: 'StarCoder2 15B',
    sizeGB: 9.1,
    tier: 'high',
    category: 'code',
    description: 'Прозрачно обученная open code модель, сильная в генерации и completion по множеству языков.',
    recommended: false,
    libraryUrl: 'https://ollama.com/library/starcoder2',
  },
  {
    name: 'deepseek-r1:14b',
    displayName: 'DeepSeek R1 14B',
    sizeGB: 9,
    tier: 'high',
    category: 'reasoning',
    description: 'Reasoning-модель для сложной логики и архитектурных вопросов; не чистый кодер, но полезна рядом с coding-моделью.',
    recommended: false,
    libraryUrl: 'https://ollama.com/library/deepseek-r1',
  },

  // MEDIUM tier
  {
    name: 'qwen2.5-coder:7b',
    displayName: 'Qwen 2.5 Coder 7B',
    sizeGB: 4.7,
    tier: 'medium',
    category: 'code',
    description: 'Лучший практичный дефолт для большинства ноутбуков: быстрый, компактный, хорошо пишет TypeScript/Python.',
    recommended: true,
    libraryUrl: 'https://ollama.com/library/qwen2.5-coder',
  },
  {
    name: 'codegemma:7b',
    displayName: 'CodeGemma 7B',
    sizeGB: 5,
    tier: 'medium',
    category: 'code',
    description: 'Лёгкий Google code model для генерации, инструкций и FIM/completion задач.',
    recommended: false,
    libraryUrl: 'https://ollama.com/library/codegemma',
  },
  {
    name: 'starcoder2:7b',
    displayName: 'StarCoder2 7B',
    sizeGB: 4,
    tier: 'medium',
    category: 'code',
    description: 'Хороший открытый кодер для локального completion и небольших правок, особенно если нужна скорость.',
    recommended: false,
    libraryUrl: 'https://ollama.com/library/starcoder2',
  },
  {
    name: 'deepseek-coder:6.7b',
    displayName: 'DeepSeek Coder 6.7B',
    sizeGB: 3.8,
    tier: 'medium',
    category: 'code',
    description: 'Компактный DeepSeek-кодер: старый, но всё ещё нормальный fallback для слабее железа.',
    recommended: false,
    libraryUrl: 'https://ollama.com/library/deepseek-coder',
  },
  {
    name: 'gemma4:e4b',
    displayName: 'Gemma 4 E4B',
    sizeGB: 9.6,
    tier: 'medium',
    category: 'general',
    description: 'Небольшая Gemma 4 с длинным контекстом; полезна как универсальная модель, не только для кода.',
    recommended: false,
    libraryUrl: 'https://ollama.com/library/gemma4',
  },

  // LOW tier
  {
    name: 'qwen2.5-coder:3b',
    displayName: 'Qwen 2.5 Coder 3B',
    sizeGB: 1.9,
    tier: 'low',
    category: 'small',
    description: 'Минимальный вменяемый кодер для слабого железа: быстрее 7B, заметно лучше совсем игрушечных моделей.',
    recommended: true,
    libraryUrl: 'https://ollama.com/library/qwen2.5-coder',
  },
  {
    name: 'qwen2.5-coder:1.5b',
    displayName: 'Qwen 2.5 Coder 1.5B',
    sizeGB: 1,
    tier: 'low',
    category: 'small',
    description: 'Очень лёгкий вариант для базовых задач и проверки интерфейса. Не ждать магии, но работает быстро.',
    recommended: false,
    libraryUrl: 'https://ollama.com/library/qwen2.5-coder',
  },
  {
    name: 'codegemma:2b',
    displayName: 'CodeGemma 2B',
    sizeGB: 1.6,
    tier: 'low',
    category: 'small',
    description: 'Маленькая модель для code completion и простых генераций, когда железо совсем ограничено.',
    recommended: false,
    libraryUrl: 'https://ollama.com/library/codegemma',
  },
  {
    name: 'starcoder2:3b',
    displayName: 'StarCoder2 3B',
    sizeGB: 1.7,
    tier: 'low',
    category: 'small',
    description: 'Лёгкий open code вариант для быстрых локальных подсказок и простого completion.',
    recommended: false,
    libraryUrl: 'https://ollama.com/library/starcoder2',
  },
];

const TIER_ORDER: HardwareTier[] = ['low', 'medium', 'high', 'extreme'];

export function recommendModels(tier: HardwareTier): ModelRecommendation[] {
  const tierIdx = TIER_ORDER.indexOf(tier);
  return ALL_MODELS.filter((m) => TIER_ORDER.indexOf(m.tier) <= tierIdx).sort((a, b) => {
    if (a.recommended && !b.recommended) return -1;
    if (!a.recommended && b.recommended) return 1;
    return TIER_ORDER.indexOf(b.tier) - TIER_ORDER.indexOf(a.tier);
  });
}
