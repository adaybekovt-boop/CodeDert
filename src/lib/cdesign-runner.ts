import { useStore } from '../hooks/useStore';
import { genId } from './utils';
import { useChatExternal } from './cdesign-send';

/**
 * Renderer-side driver for the /cdesign skill.
 *
 * The heavy lifting (loading SKILL.md + references, scaffolding) lives in
 * the main process under `electron/services/cdesign.ts`. This module:
 *   1) parses the user input (brief + flags),
 *   2) optionally scaffolds the cdesign-starter into the workspace,
 *   3) sends the brief to the model with the cdesign system prompt
 *      (and through the agent loop if a workspace is open, so the model can
 *      use create_file/edit_file/read_recipe on demand).
 *
 * Flag syntax (loose, all optional):
 *   /cdesign <brief>
 *   /cdesign --scaffold <dir> [<brief>]
 *   /cdesign --research <brief>      (the SKILL.md notices the word)
 *   /cdesign --shotlist <brief>      (forces ScrollFilm phase)
 *   /cdesign --recipes               (list all bundled recipes)
 *   /cdesign --paths                 (debug: where do resources resolve)
 */

interface ParsedArgs {
  brief: string;
  scaffoldDir: string | null;
  research: boolean;
  shotlist: boolean;
  showRecipes: boolean;
  showPaths: boolean;
}

function parseArgs(raw: string): ParsedArgs {
  const tokens = (raw || '').match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  const out: ParsedArgs = {
    brief: '',
    scaffoldDir: null,
    research: false,
    shotlist: false,
    showRecipes: false,
    showPaths: false,
  };
  const briefParts: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--research') {
      out.research = true;
    } else if (t === '--shotlist') {
      out.shotlist = true;
    } else if (t === '--recipes') {
      out.showRecipes = true;
    } else if (t === '--paths') {
      out.showPaths = true;
    } else if (t === '--scaffold') {
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

export async function runCdesign(rawArgs: string) {
  const state = useStore.getState();
  const { workspaceRoot, addMessage, selectedModel } = state;
  const args = parseArgs(rawArgs);

  // ── Diagnostic shortcuts ─────────────────────────────────
  if (args.showPaths) {
    addMessage({ id: genId(), role: 'user', content: '/cdesign --paths', timestamp: Date.now() });
    const paths = await window.api.cdesign.paths();
    addMessage({
      id: genId(),
      role: 'assistant',
      content: `**cdesign resource paths**\n\n- resources: \`${paths.resources}\`\n- skill dir: \`${paths.cdesign}\`\n- starter zip: \`${paths.starterZip}\``,
      timestamp: Date.now(),
    });
    return;
  }

  if (args.showRecipes) {
    addMessage({ id: genId(), role: 'user', content: '/cdesign --recipes', timestamp: Date.now() });
    const recipes = await window.api.cdesign.listRecipes();
    if (!recipes.length) {
      addMessage({
        id: genId(),
        role: 'assistant',
        content: '⚠️ No cdesign recipes found. The bundled resources may not be installed.',
        timestamp: Date.now(),
      });
      return;
    }
    const list = recipes.map((r) => `- **${r.name}** — ${r.description}`).join('\n');
    addMessage({
      id: genId(),
      role: 'assistant',
      content: `**cdesign recipes (${recipes.length})**\n\nThe AI can pull any of these on demand via the \`read_recipe\` tool.\n\n${list}`,
      timestamp: Date.now(),
    });
    return;
  }

  // ── Scaffold ─────────────────────────────────────────────
  if (args.scaffoldDir) {
    if (!workspaceRoot) {
      addMessage({
        id: genId(),
        role: 'assistant',
        content: '⚠️ Open a project folder first — `--scaffold` extracts the starter into it.',
        timestamp: Date.now(),
      });
      return;
    }
    addMessage({
      id: genId(),
      role: 'user',
      content: `/cdesign --scaffold ${args.scaffoldDir} ${args.brief}`.trim(),
      timestamp: Date.now(),
    });
    const target = resolveAgainstWorkspace(args.scaffoldDir, workspaceRoot);
    const res = await window.api.cdesign.scaffold(target);
    if (!res.ok) {
      addMessage({
        id: genId(),
        role: 'assistant',
        content: `❌ Scaffold failed: ${res.error}`,
        timestamp: Date.now(),
      });
      return;
    }
    addMessage({
      id: genId(),
      role: 'assistant',
      content: `✅ cdesign-starter extracted to \`${res.path}\`.\n\nNext: \`cd\` into it and run \`npm install\`. The brief continues below if provided.`,
      timestamp: Date.now(),
    });
    await state.refreshFileTree();
    if (!args.brief) return;
  }

  // ── Brief required from here on ──────────────────────────
  if (!args.brief) {
    addMessage({
      id: genId(),
      role: 'assistant',
      content:
        'Usage:\n```\n/cdesign <brief>\n/cdesign --scaffold <dir> [brief]\n/cdesign --research <brief>\n/cdesign --shotlist <brief>\n/cdesign --recipes\n/cdesign --paths\n```\n\nThe skill picks a Director\'s Roll vibe and either streams a plan + the 4 vibes (when no workspace) or composes files using the bundled starter components (when a workspace is open).',
      timestamp: Date.now(),
    });
    return;
  }

  if (!selectedModel) {
    addMessage({
      id: genId(),
      role: 'assistant',
      content: '⚠️ Select a model before running /cdesign.',
      timestamp: Date.now(),
    });
    return;
  }

  // Echo the command (so the user sees it).
  addMessage({
    id: genId(),
    role: 'user',
    content: `/cdesign ${rawArgs}`.trim(),
    timestamp: Date.now(),
  });

  // Build the cdesign system prompt + caller flags suffix.
  let systemPrompt: string;
  try {
    systemPrompt = await window.api.cdesign.getSystemPrompt();
  } catch (err: any) {
    addMessage({
      id: genId(),
      role: 'assistant',
      content: `❌ Could not load cdesign skill: ${err?.message || err}`,
      timestamp: Date.now(),
    });
    return;
  }

  const userFlags: string[] = [];
  if (args.research) userFlags.push('Flag `--research` is ON: prefer concrete references; you may mention you would WebSearch but cannot from this env.');
  if (args.shotlist) userFlags.push('Flag `--shotlist` is ON: enter ScrollFilm mode (Phase 2.5) regardless of trigger words.');

  // The cdesign command always uses the cinematic/design system prompt — it
  // routes through `useChatExternal` (a non-hook driver) with a system
  // override so the normal CODE prompt + tool primer is replaced. Agent mode
  // kicks in automatically when a workspace is open (file-tool loop),
  // otherwise plain ollama.chat.
  await useChatExternal({
    text: args.brief,
    echoText: `(cdesign) ${args.brief}`,
    systemOverride: systemPrompt,
    systemSuffix: userFlags.length ? `\n\n## Runtime flags\n${userFlags.join('\n')}` : undefined,
    // Force chat (no agent) when no workspace — there is nothing to write into.
    forceChat: !workspaceRoot,
  });
}

function resolveAgainstWorkspace(target: string, workspaceRoot: string): string {
  const cleaned = target.trim().replace(/^["']|["']$/g, '');
  if (!cleaned || cleaned === '.' || cleaned === './') return workspaceRoot;
  if (/^[a-zA-Z]:[\\/]/.test(cleaned) || cleaned.startsWith('/')) return cleaned;
  const sep = workspaceRoot.includes('\\') ? '\\' : '/';
  return workspaceRoot.replace(/[\\/]+$/, '') + sep + cleaned.replace(/^[\\/]+/, '');
}
