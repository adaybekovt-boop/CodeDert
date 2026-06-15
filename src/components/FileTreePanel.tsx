import { useState } from 'react';
import { FolderOpen, FolderPlus, ChevronRight, ChevronDown, File, Folder, RefreshCw } from 'lucide-react';
import { useStore } from '../hooks/useStore';
import type { FileNode } from '../types';
import { cn } from '../lib/utils';

export function FileTreePanel() {
  const { workspaceRoot, fileTree, openFile, setWorkspace, refreshFileTree, fileError, clearFileError } = useStore();

  async function handleOpenFolder() {
    const result = await window.api.workspace.openFolder();
    if (result) {
      setWorkspace(result.root, result.tree);
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-2 border-b border-bg-border flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
          Проект
        </h2>
        <div className="flex gap-0.5">
          <button
            onClick={refreshFileTree}
            title="Обновить"
            className="p-1 text-text-secondary hover:text-text-primary rounded hover:bg-bg-elevated"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleOpenFolder}
            title="Открыть папку"
            className="p-1 text-text-secondary hover:text-text-primary rounded hover:bg-bg-elevated"
          >
            <FolderOpen className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* File open/save error — surfaced so a failed click is never silent */}
      {fileError && (
        <button
          onClick={clearFileError}
          title="Скрыть"
          className="mx-2 mt-2 px-2 py-1.5 text-left text-xs rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 break-words"
        >
          {fileError}
        </button>
      )}

      {/* Tree */}
      <div className="flex-1 overflow-auto px-1 py-1">
        {!workspaceRoot && (
          <button
            onClick={handleOpenFolder}
            className="w-full mt-4 mx-auto flex flex-col items-center gap-2 p-6 text-text-secondary hover:text-text-primary"
          >
            <FolderPlus className="w-8 h-8" strokeWidth={1.5} />
            <span className="text-sm">Открыть папку</span>
          </button>
        )}
        {fileTree && (
          <div className="text-sm">
            <FileNodeView node={fileTree} depth={0} onFileClick={openFile} initialExpanded />
          </div>
        )}
      </div>
    </div>
  );
}

interface FileNodeViewProps {
  node: FileNode;
  depth: number;
  onFileClick: (path: string) => void;
  initialExpanded?: boolean;
}

function FileNodeView({ node, depth, onFileClick, initialExpanded }: FileNodeViewProps) {
  const [expanded, setExpanded] = useState(!!initialExpanded);
  const activeFilePath = useStore((s) => s.activeFilePath);
  const isActive = !node.isDir && activeFilePath === node.path;

  if (node.isDir) {
    return (
      <div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center gap-1 px-1 py-0.5 rounded hover:bg-bg-elevated text-text-secondary"
          style={{ paddingLeft: `${depth * 8 + 4}px` }}
        >
          {expanded ? (
            <ChevronDown className="w-3 h-3 shrink-0" />
          ) : (
            <ChevronRight className="w-3 h-3 shrink-0" />
          )}
          <Folder className="w-3.5 h-3.5 shrink-0 text-accent/70" />
          <span className="truncate text-left">{node.name}</span>
        </button>
        {expanded && node.children?.map((child) => (
          <FileNodeView key={child.id} node={child} depth={depth + 1} onFileClick={onFileClick} />
        ))}
      </div>
    );
  }
  return (
    <button
      onClick={() => onFileClick(node.path)}
      className={cn(
        'w-full flex items-center gap-1 px-1 py-0.5 rounded text-left',
        isActive ? 'bg-accent/15 text-text-primary' : 'text-text-secondary hover:bg-bg-elevated hover:text-text-primary'
      )}
      style={{ paddingLeft: `${depth * 8 + 18}px` }}
    >
      <File className="w-3.5 h-3.5 shrink-0 opacity-70" />
      <span className="truncate">{node.name}</span>
    </button>
  );
}
