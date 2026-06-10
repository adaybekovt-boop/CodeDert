import { describe, expect, it, vi } from 'vitest';

/**
 * cdesign service is electron-dependent (imports `electron`) so we can't load
 * it whole. Instead we verify:
 *   - the bundled resources actually exist on disk (skill + starter zip),
 *   - SKILL.md contains the workflow phases we depend on,
 *   - the recipe directory has at least the recipes the system prompt names.
 *
 * This guards against accidentally dropping the bundle from the build.
 */

import fs from 'node:fs';
import path from 'node:path';

const RESOURCES = path.join(process.cwd(), 'electron', 'resources');
const SKILL_DIR = path.join(RESOURCES, 'cdesign');

describe('cdesign skill bundle', () => {
  it('resources directory exists', () => {
    expect(fs.existsSync(RESOURCES)).toBe(true);
  });

  it('SKILL.md is present and substantial', () => {
    const p = path.join(SKILL_DIR, 'SKILL.md');
    expect(fs.existsSync(p)).toBe(true);
    const content = fs.readFileSync(p, 'utf-8');
    expect(content.length).toBeGreaterThan(5000);
    expect(content).toMatch(/Director'?s Roll/i);
    expect(content).toMatch(/Anti[-\s]?slop|anti-slop/i);
  });

  it('core references exist', () => {
    for (const rel of ['references/anti-slop.md', 'references/director-roll.md', 'references/content-system.md']) {
      expect(fs.existsSync(path.join(SKILL_DIR, rel)), rel).toBe(true);
    }
  });

  it('recipes directory has the canonical recipes', () => {
    const recipesDir = path.join(SKILL_DIR, 'references', 'recipes');
    expect(fs.existsSync(recipesDir)).toBe(true);
    const names = fs.readdirSync(recipesDir).map((n) => n.replace(/\.md$/, ''));
    for (const required of [
      'pinned-scrub',
      'lenis-gsap-sync',
      'split-reveal',
      'multi-layer-parallax',
      'liquid-glass',
      'scroll-film',
    ]) {
      expect(names, required).toContain(required);
    }
  });

  it('starter zip is bundled', () => {
    expect(fs.existsSync(path.join(RESOURCES, 'cdesign-starter.zip'))).toBe(true);
  });
});

describe('cdesign-runner argument parsing', () => {
  // Re-implement the local parser logic to test it without importing the full
  // module (which pulls in useStore and IPC bindings via window.api).
  // Mirrors src/lib/cdesign-runner.ts parseArgs exactly.
  function parseArgs(raw: string) {
    const tokens = (raw || '').match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    const out = {
      brief: '',
      scaffoldDir: null as string | null,
      research: false,
      shotlist: false,
      showRecipes: false,
      showPaths: false,
    };
    const briefParts: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === '--research') out.research = true;
      else if (t === '--shotlist') out.shotlist = true;
      else if (t === '--recipes') out.showRecipes = true;
      else if (t === '--paths') out.showPaths = true;
      else if (t === '--scaffold') {
        const next = tokens[i + 1];
        if (next && !next.startsWith('--')) {
          out.scaffoldDir = next.replace(/^["']|["']$/g, '');
          i += 1;
        } else {
          out.scaffoldDir = '.';
        }
      } else {
        briefParts.push(t.replace(/^["']|["']$/g, ''));
      }
    }
    out.brief = briefParts.join(' ').trim();
    return out;
  }

  it('parses plain brief', () => {
    expect(parseArgs('landing for a coffee shop').brief).toBe('landing for a coffee shop');
  });

  it('parses --scaffold with a path', () => {
    const a = parseArgs('--scaffold ./web landing for X');
    expect(a.scaffoldDir).toBe('./web');
    expect(a.brief).toBe('landing for X');
  });

  it('parses --scaffold without a path (defaults to .)', () => {
    const a = parseArgs('--scaffold --research portfolio site');
    expect(a.scaffoldDir).toBe('.');
    expect(a.research).toBe(true);
    expect(a.brief).toBe('portfolio site');
  });

  it('parses --recipes alone', () => {
    const a = parseArgs('--recipes');
    expect(a.showRecipes).toBe(true);
    expect(a.brief).toBe('');
  });

  it('keeps quoted segments together', () => {
    const a = parseArgs('"landing for the studio" --shotlist');
    expect(a.brief).toBe('landing for the studio');
    expect(a.shotlist).toBe(true);
  });
});

// Suppress vi unused warning when not stubbing.
void vi;
