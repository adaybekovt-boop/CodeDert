# CodeDert

Локальный AI-IDE в стиле Cursor / VSCode, но работающий с локальными моделями через **Ollama** + опционально с **Claude API**.

## Что внутри

- 🗂 **Файловый менеджер + Monaco editor** — открыл папку, редактируй код
- 💬 **AI-чат справа** со стримингом ответа
- 🤖 **Автоподбор моделей** — приложение определяет железо и предлагает оптимальные модели из Ollama
- 🎨 **Режим `/design`** — дизайн-критик для UX/UI ревью
- 🎬 **Команда `/cdesign`** — cinematic landing генератор (Next.js 15 + GSAP + R3F)
- 🧠 **Opus Plan (`/plan`)** — Claude Opus 4.7 планирует, локальная модель исполняет
- 🖼 **Генерация картинок** через AUTOMATIC1111 (Stable Diffusion API)
- 🔐 API ключи хранятся в Windows Credential Manager (через keytar)

## Требования

- **Windows 10/11** (Linux/macOS не тестировались, но должно работать)
- **Node.js 20+**
- **Ollama** — https://ollama.com/download (для локальных моделей)
- **AUTOMATIC1111 Stable Diffusion WebUI** — опционально, для генерации картинок ([гитхаб](https://github.com/AUTOMATIC1111/stable-diffusion-webui)). Запускать с флагом `--api`.
- **Anthropic API key** — опционально, для команд `/cdesign`, `/plan` и улучшенного `/design` (https://console.anthropic.com/settings/keys)

## Установка и запуск

```bash
# 1. Клонировать / открыть папку
cd CodeDert

# 2. Установить зависимости (это займёт минуту-две — keytar требует rebuild под Electron)
npm install

# 3. Dev-режим (с hot reload)
npm run dev

# 4. Сборка production .exe
npm run dist
```

После `npm run dist` exe будет в `release/`.

## Первый запуск

При первом запуске откроется onboarding:
1. **Welcome** — приветствие
2. **Ollama check** — проверка что Ollama запущен на localhost:11434
3. **Hardware probe** — определение железа и tier (`extreme` / `high` / `medium` / `low`)
4. **Models** — рекомендации моделей под твоё железо, кнопка [Скачать]
5. **API key** — опционально, ввод Anthropic API key

Onboarding можно перезапустить из Settings → "Запустить onboarding заново".

## Slash-команды

| Команда | Что делает |
|---|---|
| `/help` | Список всех команд |
| `/clear` | Очистить историю чата |
| `/design` | Включить режим дизайн-критика |
| `/cdesign <бриф>` | Создать cinematic landing page |
| `/plan <задача>` | Opus Plan: Claude API планирует, локалка исполняет |
| `/image <prompt> [--save-as путь]` | Сгенерировать картинку |
| `/model <имя>` | Переключить активную модель |

## Архитектура

```
codedert/
├── electron/                     # Main process (Node)
│   ├── main.ts                   # Окно, IPC роутер
│   ├── preload.ts                # contextBridge → window.api
│   ├── ipc-handlers.ts           # ipcMain.handle для всех сервисов
│   └── services/
│       ├── ollama.ts             # localhost:11434 (chat, list, pull)
│       ├── anthropic.ts          # @anthropic-ai/sdk wrapper
│       ├── stable-diffusion.ts   # localhost:7860 (AUTOMATIC1111)
│       ├── hardware-probe.ts     # systeminformation → tier
│       ├── model-recommender.ts  # курированный список Ollama моделей
│       ├── keystore.ts           # keytar (Windows Credential Manager)
│       ├── workspace.ts          # чтение/запись файлов
│       └── opus-plan.ts          # гибрид-оркестратор
├── src/                          # Renderer (React)
│   ├── App.tsx
│   ├── components/
│   │   ├── Sidebar.tsx           # переключатель панелей
│   │   ├── FileTreePanel.tsx     # дерево файлов
│   │   ├── EditorArea.tsx        # Monaco + табы
│   │   ├── ChatPanel.tsx         # чат + slash autocomplete
│   │   ├── ModelSelectorBar.tsx  # модель + /design /cdesign toggle
│   │   ├── ImageGenPanel.tsx     # SD UI
│   │   ├── SettingsPanel.tsx     # API key + установка моделей
│   │   └── OnboardingDialog.tsx  # 5-шаговый onboarding
│   ├── hooks/
│   │   ├── useStore.ts           # zustand store (workspace + chat + model)
│   │   └── useChat.ts            # стриминг от Ollama / Claude
│   └── lib/
│       ├── slash-commands.ts     # реестр /команд
│       ├── prompts.ts            # system prompts для CODE / DESIGN / CDESIGN
│       ├── image-runner.ts       # обработчик /image
│       └── opus-plan-runner.ts   # обработчик /plan
└── package.json
```

## Как работает Opus Plan (`/plan`)

Гибридный flow — самая интересная фишка:

1. **Шаг A — Claude API планирует.** Claude Opus 4.7 (adaptive thinking, effort=`xhigh`) получает задачу + структуру проекта и возвращает строго структурированный JSON с 3-8 атомарными шагами.
2. **Шаг B — локальная модель исполняет.** Для каждого шага локальная Ollama модель (qwen2.5-coder, deepseek и т.п.) пишет конкретный код / изменения файлов.
3. **Прогресс стримится в чат** — видишь и план, и исполнение каждого шага в реальном времени.

Если Claude API ключ не задан — `/plan` работает только на локалке (качество ниже, без структурированного планирования).

## Как работает `/cdesign`

В режиме `/cdesign` используется специальный system prompt с правилами cdesign-skill:
- Стек: Next.js 15 + Motion + GSAP + Lenis + R3F
- Анти-AI-slop: запрет на Inter/Roboto, фиолетовые градиенты, generic карточки
- Director's Roll: модель предлагает 4 визуальных направления, прежде чем писать код

Лучше работает с Claude API (более сильная художественная steerability), но и локальные модели справляются на базовом уровне.

## Безопасность

- API ключи хранятся в **Windows Credential Manager** через `keytar` — не в файлах, не в логах
- Electron настроен с `contextIsolation: true`, `nodeIntegration: false`
- CSP в HTML ограничивает internet-доступ только до `localhost:*` и `api.anthropic.com`
- AI-предложенные изменения файлов **не применяются автоматически** — только через ручное копирование/Edit

## Известные ограничения первой версии

- Нет inline autocomplete (только chat-based) — может появиться в v2
- Git integration отсутствует
- Built-in terminal не реализован
- Multi-window не поддерживается
- macOS / Linux не тестировались

## Лицензия

Personal-use, без явной лицензии.

---

🎨 Made with Claude Opus 4.7
