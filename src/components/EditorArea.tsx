import { useEffect } from 'react';
import Editor from '@monaco-editor/react';
import { X, Circle, Code2 } from 'lucide-react';
import { useStore } from '../hooks/useStore';
import { cn } from '../lib/utils';

export function EditorArea() {
  const { openFiles, activeFilePath, setActiveFile, closeFile, updateFileContent, saveFile } = useStore();
  const activeFile = openFiles.find((f) => f.path === activeFilePath);

  // Ctrl+S save
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (activeFilePath) saveFile(activeFilePath);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeFilePath, saveFile]);

  if (openFiles.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-text-secondary bg-bg">
        <Code2 className="w-16 h-16 mb-4 text-bg-border" strokeWidth={1} />
        <h3 className="text-lg font-display mb-2">CodeDert</h3>
        <p className="text-sm">Откройте папку и выберите файл для редактирования</p>
        <p className="text-xs mt-4 text-text-muted">
          Чат справа работает и без открытого файла
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-bg">
      {/* Tabs */}
      <div className="flex border-b border-bg-border bg-bg-panel overflow-x-auto">
        {openFiles.map((file) => (
          <div
            key={file.path}
            className={cn(
              'flex items-center gap-2 px-3 py-1.5 text-sm border-r border-bg-border cursor-pointer group',
              activeFilePath === file.path
                ? 'bg-bg text-text-primary'
                : 'text-text-secondary hover:bg-bg-elevated'
            )}
            onClick={() => setActiveFile(file.path)}
          >
            <span className="truncate max-w-[200px]">{file.name}</span>
            {file.dirty && <Circle className="w-2 h-2 fill-accent text-accent" />}
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeFile(file.path);
              }}
              className="opacity-0 group-hover:opacity-100 hover:bg-bg-border rounded p-0.5"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        ))}
      </div>

      {/* Editor */}
      <div className="flex-1 min-h-0">
        {activeFile && (
          <Editor
            key={activeFile.path}
            height="100%"
            language={activeFile.language}
            value={activeFile.content}
            onChange={(value) => {
              if (value !== undefined) updateFileContent(activeFile.path, value);
            }}
            theme="vs-dark"
            options={{
              fontSize: 14,
              fontFamily: 'JetBrains Mono, Consolas, monospace',
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              renderLineHighlight: 'gutter',
              smoothScrolling: true,
              cursorBlinking: 'smooth',
              cursorSmoothCaretAnimation: 'on',
              padding: { top: 12 },
              tabSize: 2,
              wordWrap: 'on',
            }}
          />
        )}
      </div>
    </div>
  );
}
