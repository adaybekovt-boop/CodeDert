import fs from 'node:fs/promises';
import path from 'node:path';
import { rankFiles, taskKeywords, type RankedFile } from './ultrathink-ranking.js';

export interface UltrathinkConfig {
  enabled: boolean;
  defaultModel: string;
  allowModelOverride: boolean;
  sequentialExecutionOnly: boolean;
  maxFiles: number;
  maxFileBytes: number;
  maxContextTokens: number;
  includeTests: boolean;
  includeConfigs: boolean;
  autoUnloadModels: boolean;
  ignoredFolders: string[];
  confidenceThreshold: number;
  models: {
    deepseek: string;
    gemma: string;
  };
}

export interface UltrathinkContextPackage {
  text: string;
  analyzedFiles: number;
  totalFiles: number;
  repositorySummary: string;
  selectedFiles: RankedFile[];
}

const DEFAULT_IGNORES = new Set([
  'node_modules',
  'dist',
  'dist-electron',
  'build',
  '.git',
  'coverage',
  '.next',
  'vendor',
  '.cache',
  'cache',
  '.turbo',
  'release',
]);

const TEXT_EXTENSIONS = new Set([
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
  '.toml',
  '.log',
  '.env',
]);

export async function buildUltrathinkContext(
  workspaceRoot: string,
  task: string,
  config: UltrathinkConfig,
  emit: (data: any) => void,
  shouldCancel: () => boolean = () => false
): Promise<UltrathinkContextPackage> {
  emit({ phase: 'scan', message: 'Scanning repository...' });
  const ignored = new Set([...DEFAULT_IGNORES, ...config.ignoredFolders]);
  const files = await collectFiles(workspaceRoot, ignored, config.maxFileBytes, shouldCancel);
  if (shouldCancel()) throw new Error('aborted');
  const ranked = rankFiles(files, task);
  const selectable = ranked.filter((file) => {
    if (!config.includeTests && /(?:test|spec|__tests__)/i.test(file.relativePath)) return false;
    if (
      !config.includeConfigs &&
      /(?:package|lock|config|tsconfig|vite|webpack|eslint|tailwind|postcss)/i.test(file.relativePath)
    ) {
      return false;
    }
    return true;
  });
  const selected = selectable.slice(0, config.maxFiles);

  emit({
    phase: 'scan-progress',
    message: 'Building dependency graph...',
    analyzedFiles: selected.length,
    totalFiles: files.length,
  });

  let budget = Math.max(8_000, config.maxContextTokens * 4);
  const chunks: string[] = [];
  const imports: string[] = [];
  const keywordHits: string[] = [];
  const patterns: string[] = [];
  const keywords = taskKeywords(task);

  for (const file of selected) {
    if (shouldCancel()) throw new Error('aborted');
    if (budget <= 0) break;
    const content = await readLimited(file.absolutePath, Math.min(config.maxFileBytes, budget));
    if (!content) continue;
    budget -= content.length;

    const fileImports = extractImports(content, file.relativePath);
    imports.push(...fileImports);

    const hits = findKeywordHits(content, file.relativePath, keywords);
    keywordHits.push(...hits);

    if (/(service|controller|router|store|hook|component|agent|ipc|api)/i.test(file.relativePath)) {
      patterns.push(`${file.relativePath} (${file.reasons.join(', ')})`);
    }

    chunks.push(`### ${file.relativePath}
Score: ${file.score}
Reasons: ${file.reasons.join(', ') || 'ranked'}
\`\`\`
${content}
\`\`\``);
  }

  const summary = summarize(files, selected);
  const text = `# ULTRATHINK REPOSITORY CONTEXT

## Task
${task}

## Repository Summary
${summary}

## File Tree Summary
${treeSummary(files)}

## Relevant Source Files
${selected.map((file) => `- ${file.relativePath} (${file.size} bytes, score ${file.score})`).join('\n')}

## Related Tests
${selected.filter((file) => /(?:test|spec|__tests__)/i.test(file.relativePath)).map((file) => `- ${file.relativePath}`).join('\n') || '- None found in selected context'}

## Config And Dependency Files
${selected.filter((file) => /(?:package|lock|config|tsconfig|vite|webpack|eslint|tailwind|postcss)/i.test(file.relativePath)).map((file) => `- ${file.relativePath}`).join('\n') || '- None found in selected context'}

## Import Graph Hints
${imports.slice(0, 200).join('\n') || '- No imports detected in selected context'}

## Dependency Graph Hints
${dependencyHints(chunks.join('\n')).join('\n') || '- No dependency hints detected'}

## Similar Implementations / Existing Patterns
${patterns.slice(0, 80).map((item) => `- ${item}`).join('\n') || '- No similar patterns detected'}

## Search Results For Task Keywords
${keywordHits.slice(0, 120).join('\n') || '- No keyword hits found'}

## Error Logs If Available
${selected.filter((file) => /\.log$/i.test(file.relativePath)).map((file) => `- ${file.relativePath}`).join('\n') || '- No log files selected'}

## API Boundaries And Data Flow Hints
${apiBoundaryHints(selected, imports).join('\n') || '- No API boundary hints detected'}

## Selected File Contents
${chunks.join('\n\n')}`;

  return {
    text,
    analyzedFiles: selected.length,
    totalFiles: files.length,
    repositorySummary: summary,
    selectedFiles: selected,
  };
}

async function collectFiles(
  root: string,
  ignored: Set<string>,
  maxFileBytes: number,
  shouldCancel: () => boolean
): Promise<{ absolutePath: string; relativePath: string; size: number }[]> {
  const out: { absolutePath: string; relativePath: string; size: number }[] = [];

  async function walk(dir: string) {
    if (shouldCancel()) throw new Error('aborted');
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (shouldCancel()) throw new Error('aborted');
      if (ignored.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.env' && entry.name !== '.env.local') continue;
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!TEXT_EXTENSIONS.has(ext) && !entry.name.includes('config')) continue;
      const stat = await fs.stat(absolutePath);
      if (stat.size > maxFileBytes) continue;
      out.push({
        absolutePath,
        relativePath: path.relative(root, absolutePath).replace(/\\/g, '/'),
        size: stat.size,
      });
    }
  }

  await walk(root);
  return out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function readLimited(filePath: string, maxBytes: number): Promise<string> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return content.length > maxBytes ? content.slice(0, maxBytes) + '\n[truncated]' : content;
  } catch {
    return '';
  }
}

function extractImports(content: string, relativePath: string): string[] {
  const lines: string[] = [];
  const regexes = [
    /import\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /require\(['"]([^'"]+)['"]\)/g,
    /from\s+['"]([^'"]+)['"]/g,
  ];
  for (const regex of regexes) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content))) {
      lines.push(`- ${relativePath} -> ${match[1]}`);
    }
  }
  return lines;
}

function findKeywordHits(content: string, relativePath: string, keywords: string[]): string[] {
  if (!keywords.length) return [];
  const lines = content.split(/\r?\n/);
  const hits: string[] = [];
  lines.forEach((line, index) => {
    const lower = line.toLowerCase();
    if (keywords.some((keyword) => lower.includes(keyword))) {
      hits.push(`- ${relativePath}:${index + 1}: ${line.trim().slice(0, 180)}`);
    }
  });
  return hits.slice(0, 12);
}

function summarize(
  files: { relativePath: string; size: number }[],
  selected: { relativePath: string }[]
): string {
  const byExt = new Map<string, number>();
  for (const file of files) {
    const ext = path.extname(file.relativePath) || '(none)';
    byExt.set(ext, (byExt.get(ext) || 0) + 1);
  }
  const extSummary = Array.from(byExt.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([ext, count]) => `${ext}: ${count}`)
    .join(', ');
  return `${files.length} text/config files discovered; ${selected.length} selected for analysis. Extensions: ${extSummary}`;
}

function treeSummary(files: { relativePath: string }[]): string {
  const top = new Map<string, number>();
  for (const file of files) {
    const first = file.relativePath.split('/')[0] || file.relativePath;
    top.set(first, (top.get(first) || 0) + 1);
  }
  return Array.from(top.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([dir, count]) => `- ${dir}: ${count} files`)
    .join('\n');
}

function dependencyHints(context: string): string[] {
  const hints: string[] = [];
  const packageJson = context.match(/"dependencies"\s*:\s*\{[\s\S]*?\}/);
  const devDependencies = context.match(/"devDependencies"\s*:\s*\{[\s\S]*?\}/);
  if (packageJson) hints.push(`- dependencies detected: ${packageJson[0].slice(0, 600)}`);
  if (devDependencies) hints.push(`- devDependencies detected: ${devDependencies[0].slice(0, 600)}`);
  return hints;
}

function apiBoundaryHints(files: { relativePath: string }[], imports: string[]): string[] {
  const hints = new Set<string>();
  for (const file of files) {
    if (/ipc|preload|api|router|controller|service|store|hook/i.test(file.relativePath)) {
      hints.add(`- boundary file: ${file.relativePath}`);
    }
  }
  for (const imp of imports) {
    if (/ipc|preload|api|service|store|hook|agent/i.test(imp)) hints.add(imp);
  }
  return Array.from(hints).slice(0, 120);
}
