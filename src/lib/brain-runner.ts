import { useStore } from '../hooks/useStore';
import { useBrainStore } from './brain-store';
import { genId } from './utils';
import { BRAIN_TYPES, type BrainNode, type BrainNodeType, type ScoredBrainNode } from './brain-types';

/**
 * Renderer-side dispatcher for `/brain …` subcommands.
 *
 * Subcommands:
 *   /brain                            → open Brain tab
 *   /brain add <text>                 → create a manual note (type=memory)
 *   /brain add <type>: <text>         → typed note (idea: …, decision: …, etc.)
 *   /brain search <query>             → echo top hits into chat
 *   /brain related <node-title or id> → echo related nodes
 *   /brain inject <query>             → pin top hits for the next message
 *   /brain review                     → open Brain tab focused on suggestions
 *   /brain forget <query or id>       → archive matching memories
 *
 * Results are surfaced as assistant messages in the current chat. No model call.
 */

export async function runBrain(rawArgs: string): Promise<void> {
  const state = useStore.getState();
  const post = (content: string) =>
    state.addMessage({ id: genId(), role: 'assistant', content, timestamp: Date.now() });
  const echo = (content: string) =>
    state.addMessage({ id: genId(), role: 'user', content, timestamp: Date.now() });

  const args = (rawArgs || '').trim();
  if (!args) {
    state.setActivePanel('brain');
    post('🧠 Brain tab opened.');
    return;
  }

  echo(`/brain ${args}`);
  const [sub, ...rest] = args.split(/\s+/);
  const subArgs = rest.join(' ').trim();

  switch (sub.toLowerCase()) {
    case 'add': {
      if (!subArgs) {
        post('Usage: `/brain add <text>` or `/brain add <type>: <text>`. Types: ' + BRAIN_TYPES.join(', '));
        return;
      }
      let type: BrainNodeType = 'memory';
      let title = subArgs;
      const typed = /^([a-z_]+):\s*(.+)$/i.exec(subArgs);
      if (typed && BRAIN_TYPES.includes(typed[1].toLowerCase() as BrainNodeType)) {
        type = typed[1].toLowerCase() as BrainNodeType;
        title = typed[2];
      }
      const res = await window.api.brain.createNode({
        title,
        type,
        summary: '',
        content: title,
        tags: [],
        source: { kind: 'manual' },
        confidence: 0.95,
        importance: 0.6,
      });
      if (!res.ok) {
        post(`❌ ${res.error || 'failed'}`);
        return;
      }
      post(`✅ Created **${type}**: ${res.node?.title}`);
      return;
    }

    case 'search': {
      if (!subArgs) {
        post('Usage: `/brain search <query>`');
        return;
      }
      const hits = await window.api.brain.search(subArgs, 10) as BrainNode[];
      if (!hits.length) {
        post(`No Brain matches for **${subArgs}**.`);
        return;
      }
      const body = hits
        .map((n: BrainNode) => `- **${n.title}** _(${n.type})_${n.summary ? ` — ${n.summary.slice(0, 120)}` : ''}`)
        .join('\n');
      post(`🧠 Brain matches for **${subArgs}**:\n\n${body}`);
      return;
    }

    case 'related': {
      if (!subArgs) {
        post('Usage: `/brain related <node title or id>`');
        return;
      }
      let seedId = subArgs;
      const nodes = useBrainStore.getState().nodes;
      if (!nodes.find((n) => n.id === seedId)) {
        const candidate = nodes.find(
          (n) => n.title.toLowerCase() === subArgs.toLowerCase()
        ) ||
        nodes.find((n) => n.title.toLowerCase().includes(subArgs.toLowerCase()));
        if (!candidate) {
          post(`No Brain node matches **${subArgs}**.`);
          return;
        }
        seedId = candidate.id;
      }
      const related = await window.api.brain.related(seedId, 10) as BrainNode[];
      if (!related.length) {
        post(`No related nodes found.`);
        return;
      }
      post(
        `🔗 Related to **${nodes.find((n) => n.id === seedId)?.title || seedId}**:\n\n` +
          related.map((n: BrainNode) => `- ${n.title} _(${n.type})_`).join('\n')
      );
      return;
    }

    case 'inject': {
      if (!subArgs) {
        post('Usage: `/brain inject <query>` — pin top relevant memories for the next message.');
        return;
      }
      const results = await window.api.brain.retrieveForPrompt(subArgs, 8) as ScoredBrainNode[];
      const brain = useBrainStore.getState();
      // Pin all retrieved ids so they ride along the next prompt.
      for (const r of results) {
        if (!brain.pinnedIds.includes(r.node.id)) brain.togglePin(r.node.id);
      }
      if (!results.length) {
        post(`No relevant Brain nodes for **${subArgs}**.`);
        return;
      }
      post(
        `📌 Pinned for next message:\n\n` +
          results
            .map(
              (r: ScoredBrainNode) =>
                `- ${r.node.title} _(${r.node.type}, score ${r.score.toFixed(2)})_`
            )
            .join('\n')
      );
      return;
    }

    case 'review': {
      state.setActivePanel('brain');
      const pending = useBrainStore.getState().suggestions.filter((s) => s.status === 'pending');
      post(`🧠 Brain review opened. ${pending.length} pending suggestion${pending.length === 1 ? '' : 's'}.`);
      return;
    }

    case 'forget': {
      if (!subArgs) {
        post('Usage: `/brain forget <query or id>`');
        return;
      }
      const res = await window.api.brain.forget(subArgs);
      post(res.archived > 0 ? `🗑 Forgot ${res.archived} node(s).` : `No matches to forget.`);
      return;
    }

    default:
      post('Unknown Brain subcommand. Try `/brain`, `/brain add`, `/brain search`, `/brain related`, `/brain inject`, `/brain review`, `/brain forget`.');
  }
}
