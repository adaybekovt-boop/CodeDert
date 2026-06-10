# Security-аудит CodeDert — 2026-06-10

## Вердикт
Базовая архитектура безопасности выстроена правильно. В ходе аудита найдено и исправлено 4 проблемы, ещё 2 зафиксированы как принятый риск.

## Что уже было сделано правильно (без изменений)
- `contextIsolation: true`, `nodeIntegration: false` — renderer изолирован от Node.
- Весь IPC идёт через whitelisted preload-мост (`window.api`), произвольных каналов нет.
- Path traversal: `safeResolveInWorkspace` через `path.relative` (корректно отсекает `../` и префикс-коллизии), защищённые глобы для `.env`, `*.pem`, `id_rsa`, `secrets.*`.
- Терминал: opt-out по умолчанию, per-command approval, hard-denylist (rm -rf /, format, mkfs, fork bomb, curl|bash, Remove-Item -Recurse -Force на корни дисков, iex/iwr), ограничение cwd воркспейсом, таймаут и лимит вывода.
- API-ключи — только в OS keychain (keytar / Windows Credential Manager), не в electron-store.
- CSP в index.html, `setWindowOpenHandler` + `will-navigate` запрещают навигацию, `openExternal` пропускает только http/https/mailto.
- Legacy-настройки ограничены whitelist'ом ключей.

## Исправлено в этом аудите
1. **`anthropic.testKey()` тратил деньги.** Проверка ключа выполняла реальный `messages.create`. Заменено на `GET /v1/models` — ноль токенов. Все новые провайдеры валидируются так же.
2. **`workspace:set-root` принимал произвольный путь из renderer.** Скомпрометированный renderer мог указать `C:\` и получить файловый доступ ко всему диску через workspace-API. Теперь main-процесс хранит свой эталон выбранной папки (записывается только диалогом `open-folder`) и отклоняет несовпадающие пути.
3. **`workspaceRoot` в `agent:chat` / `multyplan:start` / `ultrathink:start` / `opus-plan:run` доверялся renderer'у.** Теперь перезаписывается значением из main-процесса (единый источник истины).
4. **ReDoS в `workspace.search`.** Regex приходит из вывода модели; катастрофический backtracking мог заморозить main-процесс. Введены: лимит длины паттерна 256 символов и обрезка строк до 2000 символов перед матчингом.

## Принятый риск (зафиксировано)
- **`sandbox: false`** в webPreferences — причина задокументирована в коде (preload-бандл vite-plugin-electron несовместим с sandboxed-loader). Компенсируется contextIsolation + отсутствием nodeIntegration. При обновлении тулчейна — включить.
- **`console-message` пишется в debug.log** — потенциальная утечка, если renderer залогирует чувствительное. Ключи в логи не попадают (вводятся в password-поле, ошибки провайдеров проходят redact()).

## Новые поверхности (введены осознанно)
- **MCP-серверы**: запускаются только если пользователь явно добавил И включил сервер в настройках (enabled=false по умолчанию). Тот же уровень доверия, что и терминал. stderr не исполняется, все запросы с таймаутами, процессы убиваются при выходе.
- **Слой провайдеров**: ключи в keychain; сообщения об ошибках проходят redact() (ключ вырезается); base URL принимает только http(s).
