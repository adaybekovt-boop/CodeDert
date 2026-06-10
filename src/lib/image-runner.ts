import { useStore } from '../hooks/useStore';
import { genId } from './utils';

/**
 * Handle the `/image` slash command from the chat.
 * Format: /image <prompt> [--save-as path]
 */
export async function runImageCommand(args: string) {
  const state = useStore.getState();
  const addMessage = state.addMessage;
  const { workspaceRoot } = state;

  // Parse --save-as
  let savePath: string | null = null;
  let prompt = args;
  const saveMatch = args.match(/--save-as\s+(\S+)/);
  if (saveMatch) {
    savePath = saveMatch[1];
    prompt = args.replace(/--save-as\s+\S+/, '').trim();
  }

  if (!prompt) {
    addMessage({
      id: genId(),
      role: 'assistant',
      content: '⚠️ Использование: `/image <описание> [--save-as путь]`',
      timestamp: Date.now(),
    });
    return;
  }

  // Echo user command
  addMessage({
    id: genId(),
    role: 'user',
    content: `/image ${args}`,
    timestamp: Date.now(),
  });

  const statusMsgId = genId();
  addMessage({
    id: statusMsgId,
    role: 'assistant',
    content: '🎨 Проверка Stable Diffusion...',
    timestamp: Date.now(),
    streaming: true,
  });

  const health = await window.api.sd.health();
  if (!health.ok) {
    state.appendToMessage(
      statusMsgId,
      `\n\n❌ **Stable Diffusion недоступен**\n\n${health.error}\n\nЗапустите AUTOMATIC1111 с флагом \`--api\`:\n\`\`\`\nwebui-user.bat --api\n\`\`\``
    );
    state.finishMessage(statusMsgId);
    return;
  }

  state.appendToMessage(statusMsgId, '\n\n⏳ Генерация (15-30 сек)...');

  const result = await window.api.sd.txt2img({
    prompt,
    negative_prompt: 'low quality, blurry, watermark, text, signature',
    width: 1024,
    height: 1024,
    steps: 28,
  });

  if (!result.ok || !result.images || result.images.length === 0) {
    state.appendToMessage(statusMsgId, `\n\n❌ Ошибка: ${result.error}`);
    state.finishMessage(statusMsgId);
    return;
  }

  const base64 = result.images[0];
  let finalContent = `\n\n✅ Готово!\n\n![generated](data:image/png;base64,${base64})`;

  // Save if requested
  if (savePath && workspaceRoot) {
    // Resolve relative path to workspace
    let fullPath = savePath;
    if (!savePath.match(/^([a-zA-Z]:\\|\/)/)) {
      // relative — join with workspaceRoot
      fullPath = `${workspaceRoot}${savePath.startsWith('/') || savePath.startsWith('\\') ? '' : '/'}${savePath}`;
    }
    const saveRes = await window.api.sd.saveImage(base64, fullPath);
    if (saveRes.ok) {
      finalContent += `\n\n💾 Сохранено: \`${saveRes.path}\``;
    } else {
      finalContent += `\n\n⚠️ Не удалось сохранить: ${saveRes.error}`;
    }
  }

  state.appendToMessage(statusMsgId, finalContent);
  state.finishMessage(statusMsgId);
}
