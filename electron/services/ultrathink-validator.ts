export const ULTRATHINK_REQUIRED_SECTIONS = [
  'Short Answer',
  'Main Finding',
  'Root Cause Analysis',
  'Evidence',
  'Affected Files',
  'Affected Functions/Classes',
  'Dependency Analysis',
  'Architecture Risks',
  'Edge Cases',
  'Security Concerns',
  'Performance Concerns',
  'Recommended Fix',
  'Detailed Implementation Plan',
  'Tests To Run',
  'Unknowns / Missing Context',
  'Confidence Level',
];

export interface UltrathinkValidationResult {
  ok: boolean;
  issues: string[];
  confidence?: number;
}

export function validateUltrathinkReport(
  report: string,
  confidenceThreshold: number
): UltrathinkValidationResult {
  const issues: string[] = [];
  const normalized = report.toLowerCase();

  if (!report.trim()) issues.push('empty output');

  for (const section of ULTRATHINK_REQUIRED_SECTIONS) {
    if (!normalized.includes(section.toLowerCase())) {
      issues.push(`missing section: ${section}`);
    }
  }

  const hasPath = /(?:^|\s|`)(?:[\w.-]+[\\/])+[\w.-]+\.(?:ts|tsx|js|jsx|json|css|scss|html|md|cjs|mjs|py|go|rs|java|yml|yaml)(?:`|\s|$)/im.test(
    report
  );
  if (!hasPath) issues.push('missing concrete repository file path');

  const evidence = getSection(report, 'Evidence');
  if (!evidence || !/[\\/]|src|electron|package\.json|tsconfig|vite/i.test(evidence)) {
    issues.push('evidence section does not reference repository files');
  }

  const plan = getSection(report, 'Detailed Implementation Plan');
  if (!plan || !/(^|\n)\s*(?:[-*]|\d+\.)\s+\S+/m.test(plan)) {
    issues.push('implementation plan is not actionable');
  }

  const confidence = extractConfidence(report);
  if (confidence == null) {
    issues.push('missing parseable confidence level');
  } else if (confidence < confidenceThreshold) {
    issues.push(`confidence below threshold: ${confidence}`);
  }

  return { ok: issues.length === 0, issues, confidence };
}

function getSection(report: string, title: string): string | undefined {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `(?:^|\\n)\\s*(?:#{1,3}\\s*|\\d+\\.\\s*)${escaped}\\s*\\n([\\s\\S]*?)(?=\\n\\s*(?:#{1,3}\\s*|\\d+\\.\\s*)[A-Z][^\\n]{2,80}\\n|$)`,
    'i'
  );
  return report.match(re)?.[1];
}

export function buildRepairPrompt(report: string, issues: string[]): string {
  return `The previous ULTRATHINK report failed validation.

Validation issues:
${issues.map((issue) => `- ${issue}`).join('\n')}

Repair the report. Keep the same facts, do not add unsupported claims, and return a complete report with exactly these sections:
${ULTRATHINK_REQUIRED_SECTIONS.map((section, i) => `${i + 1}. ${section}`).join('\n')}

Previous report:
${report}`;
}

function extractConfidence(report: string): number | undefined {
  const section = report.match(/Confidence Level[\s\S]{0,400}/i)?.[0] || '';
  const percent = section.match(/(\d{1,3})\s*%/);
  if (percent) return Math.min(1, Math.max(0, Number(percent[1]) / 100));

  const decimal = section.match(/\b(0(?:\.\d+)?|1(?:\.0+)?)\b/);
  if (decimal) return Number(decimal[1]);

  const outOfTen = section.match(/\b(\d(?:\.\d+)?)\s*\/\s*10\b/);
  if (outOfTen) return Math.min(1, Math.max(0, Number(outOfTen[1]) / 10));

  return undefined;
}
