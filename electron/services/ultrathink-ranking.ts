import path from 'node:path';

export interface RankedFile {
  absolutePath: string;
  relativePath: string;
  size: number;
  score: number;
  reasons: string[];
}

const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.cjs',
  '.mjs',
  '.json',
  '.css',
  '.scss',
  '.html',
  '.md',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.yml',
  '.yaml',
  '.log',
]);

const CONFIG_NAMES = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'tsconfig.json',
  'vite.config.ts',
  'vite.config.js',
  'webpack.config.js',
  'eslint.config.js',
  '.eslintrc',
  '.prettierrc',
  'tailwind.config.js',
  'postcss.config.js',
  'electron-builder.json',
]);

export function rankFiles(
  files: { absolutePath: string; relativePath: string; size: number }[],
  task: string
): RankedFile[] {
  const keywords = task
    .toLowerCase()
    .split(/[^a-z0-9_/-]+/i)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3);

  return files
    .map((file) => {
      const lower = file.relativePath.toLowerCase();
      const name = path.basename(lower);
      const ext = path.extname(lower);
      let score = 0;
      const reasons: string[] = [];

      if (SOURCE_EXTENSIONS.has(ext)) {
        score += 2;
        reasons.push('source/config extension');
      }
      if (CONFIG_NAMES.has(name)) {
        score += 5;
        reasons.push('project config');
      }
      if (/\b(test|spec|__tests__)\b/i.test(lower)) {
        score += 2;
        reasons.push('related test');
      }
      if (/\.log$/i.test(lower)) {
        score += 3;
        reasons.push('error log');
      }
      if (/(src|electron|app|lib|services|components|hooks)\//i.test(lower.replace(/\\/g, '/'))) {
        score += 2;
        reasons.push('core source path');
      }
      for (const keyword of keywords) {
        if (lower.includes(keyword)) {
          score += 4;
          reasons.push(`path matches "${keyword}"`);
        }
      }

      return { ...file, score, reasons };
    })
    .filter((file) => file.score > 0)
    .sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath));
}

export function taskKeywords(task: string): string[] {
  return Array.from(
    new Set(
      task
        .toLowerCase()
        .split(/[^a-z0-9_/-]+/i)
        .map((part) => part.trim())
        .filter((part) => part.length >= 3)
    )
  ).slice(0, 24);
}
