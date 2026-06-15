/**
 * Local Monaco bootstrap.
 *
 * By default `@monaco-editor/react` lazy-loads the Monaco runtime from a public
 * CDN (jsdelivr). In this Electron app the renderer runs under a strict CSP
 * (`script-src 'self'`, `connect-src` without jsdelivr) and, when packaged,
 * from `file://` with no guaranteed network — so the CDN fetch never resolves
 * and the editor is stuck on "Loading..." forever.
 *
 * Fix: point the loader at the locally bundled `monaco-editor` package and wire
 * the language workers through Vite's `?worker` imports (allowed by the existing
 * `worker-src 'self' blob:` CSP). This makes the editor initialise immediately,
 * fully offline, with working syntax/intellisense.
 *
 * Imported for its side effects from `main.tsx` before the app renders.
 */
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';

import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

// Tell Monaco how to spawn its language workers from the local bundle.
(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') return new jsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};

// Use the bundled Monaco instead of the CDN loader.
loader.config({ monaco });
