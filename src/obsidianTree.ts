import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';

export type ObsidianNode = {
  resourceUri: vscode.Uri;
  isDirectory: boolean;
};

export class ObsidianTreeProvider implements vscode.TreeDataProvider<ObsidianNode> {
  private _onDidChangeTreeData: vscode.EventEmitter<ObsidianNode | undefined | void> = new vscode.EventEmitter<ObsidianNode | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<ObsidianNode | undefined | void> = this._onDidChangeTreeData.event;

  private cache: Map<string, ObsidianNode[]> = new Map();
  private taskCache: Map<string, {completed: number, total: number, lastModified: number}> = new Map();
  private rootPath: string | undefined;
  private preloadPromise: Promise<void> | undefined;

  constructor(private context: vscode.ExtensionContext) {
    // Kick off a background preload of the vault
    this.preloadVault().catch(() => { /* ignore preload errors */ });

    // Re-preload when configuration changes
        vscode.workspace.onDidChangeConfiguration(e => {
          if (e.affectsConfiguration('obsidianManager.vault')) {
          this.preloadVault().catch(() => {});
          this.refresh();
        }
      });
  }

  refresh(): void {
    // Clear task cache when refreshing to ensure task counts are updated
    this.taskCache.clear();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ObsidianNode): vscode.TreeItem {
    let label = path.basename(element.resourceUri.fsPath);
    
    // Add task count for markdown files
    if (!element.isDirectory && element.resourceUri.fsPath.toLowerCase().endsWith('.md')) {
      const taskCount = this.getTaskCount(element.resourceUri.fsPath);
      if (taskCount.total > 0) {
        label = `${label} [${taskCount.completed}/${taskCount.total}]`;
      }
    }
    
	// Respect user setting whether folders should be expanded on load
    const cfg = vscode.workspace.getConfiguration('obsidianManager');
	const expandOnLoad = cfg.get<boolean>('expandFoldersOnLoad', true);
	const treeItem = new vscode.TreeItem(
    label,
    element.isDirectory
      ? (expandOnLoad ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
      : vscode.TreeItemCollapsibleState.None
  );
    treeItem.resourceUri = element.resourceUri;

    // Settings for tree view visual icons
    const showFolderTreeIcons = cfg.get<boolean>('showFolderTreeIcons', true);
    const showFileTreeIcons = cfg.get<boolean>('showFileTreeIcons', true);
    
    if (element.isDirectory) {
      treeItem.contextValue = 'obsidianFolder';
      if (showFolderTreeIcons) {
        // Use VS Code's ThemeIcon for folders so the icon follows theme colors and
        // file-icon settings. `symbol-folder` is a suitable symbol for a folder container.
        treeItem.iconPath = new vscode.ThemeIcon('symbol-folder');
      }
    } else {
      // Open with custom command that respects openFileMode setting
      treeItem.command = {
        command: 'obsidianManager.openFileWithMode',
        title: 'Open',
        arguments: [element.resourceUri]
      };
      treeItem.contextValue = 'obsidianFile';
      if (showFileTreeIcons) treeItem.iconPath = this.getIconForFile(element.resourceUri.fsPath);
    }

    return treeItem;
  }

  async getChildren(element?: ObsidianNode): Promise<ObsidianNode[]> {
  const cfg = vscode.workspace.getConfiguration('obsidianManager');
       const configuredVault = ((cfg.get<string>('vault') || '')).trim();
    if (!configuredVault) {
      return [];
    }

    const root = this.normalizeToFsPath(configuredVault);
    if (!root) return [];

    // support two view modes: 'folders' (hierarchical) and 'list' (flat list of .md files)
    const viewMode = (cfg.get<string>('viewMode') || 'folders').trim();

    if (!element) {
      if (viewMode === 'list') {
        // return a flat list of all .md files found in the cache (preloaded)
        const seen = new Set<string>();
        const files: ObsidianNode[] = [];
        for (const nodes of this.cache.values()) {
          for (const n of nodes) {
            if (!n.isDirectory && !seen.has(n.resourceUri.fsPath)) {
              seen.add(n.resourceUri.fsPath);
              files.push(n);
            }
          }
        }
        files.sort((a, b) => a.resourceUri.fsPath.localeCompare(b.resourceUri.fsPath));
        return files;
      }

      const cached = this.cache.get(root);
      if (cached) return cached;
      await this.scanDirIntoCache(root);
      return this.cache.get(root) || [];
    }

    const cached = this.cache.get(element.resourceUri.fsPath);
    if (cached) return cached;
    await this.scanDirIntoCache(element.resourceUri.fsPath);
    return this.cache.get(element.resourceUri.fsPath) || [];
  }

  // Required by TreeView.reveal: return the parent element for a given element (or undefined for root-level)
  getParent(element: ObsidianNode): vscode.ProviderResult<ObsidianNode> {
    if (!element) return undefined;
    const parentPath = path.dirname(element.resourceUri.fsPath);
    if (!this.rootPath) return undefined;
    // if parent is the configured root, return undefined so the tree treats it as top-level
    if (parentPath === this.rootPath || parentPath === '' || parentPath === '.' || parentPath === path.sep) {
      return undefined;
    }
    // return a node representing the parent directory
    return { resourceUri: vscode.Uri.file(parentPath), isDirectory: true } as ObsidianNode;
  }

  private normalizeToFsPath(input: string): string | undefined {
    try {
      if (!input) return undefined;
      if (input.startsWith('file://')) return vscode.Uri.parse(input).fsPath;
      if (input.startsWith('~')) return path.join(process.env.HOME || '', input.slice(1));
      return input;
    } catch (e) {
      return undefined;
    }
  }

  private async preloadVault(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('obsidianManager');
  const configuredVault = ((cfg.get<string>('vault') || '')).trim();
    const root = this.normalizeToFsPath(configuredVault);
    if (!root) return;
    this.rootPath = root;
    this.cache.clear();
    await this.scanDirIntoCache(root);
  }

  /**
   * Ensure the initial preload is running and return a promise that resolves when done.
   * Public so the extension can wait for the tree to be populated before rendering.
   */
  public ensurePreloaded(): Promise<void> {
    if (!this.preloadPromise) {
      this.preloadPromise = this.preloadVault();
    }
    return this.preloadPromise;
  }

  // Public helper to trigger a fresh preload/scan and refresh the view
  public async refreshAll(): Promise<void> {
    // Reset preloadPromise so ensurePreloaded will re-run preloadVault
    this.preloadPromise = undefined;
    // Clear task cache to ensure fresh task counts
    this.taskCache.clear();
    await this.ensurePreloaded();
    this.refresh();
  }

  private async scanDirIntoCache(dir: string): Promise<void> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const nodes: ObsidianNode[] = [];
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === '@eaDir') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          nodes.push({ resourceUri: vscode.Uri.file(full), isDirectory: true });
          // Recursively preload children
          await this.scanDirIntoCache(full);
        } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
          nodes.push({ resourceUri: vscode.Uri.file(full), isDirectory: false });
        }
      }
      nodes.sort((a, b) => {
        if (a.isDirectory === b.isDirectory) return a.resourceUri.fsPath.localeCompare(b.resourceUri.fsPath);
        return a.isDirectory ? -1 : 1;
      });
      this.cache.set(dir, nodes);
    } catch (err) {
      // on error store empty to avoid repeated attempts
      this.cache.set(dir, []);
    }
  }

  private getIconForFile(fsPath: string): { light: vscode.Uri; dark: vscode.Uri } | undefined {
    const img = this.context.asAbsolutePath('images/obsidian.svg');
    return { light: vscode.Uri.file(img), dark: vscode.Uri.file(img) };
  }

  private getTaskCount(filePath: string): {completed: number, total: number} {
    try {
      // Check if we have cached task count and file hasn't been modified
      const stat = require('fs').statSync(filePath);
      const lastModified = stat.mtime.getTime();
      
      const cached = this.taskCache.get(filePath);
      if (cached && cached.lastModified === lastModified) {
        return { completed: cached.completed, total: cached.total };
      }

      // Read file and count tasks
      const content = require('fs').readFileSync(filePath, 'utf8');
      
      // Match both - [ ] (uncompleted) and - [x] or - [X] (completed) tasks
      const taskRegex = /^[\s]*[-*+]\s+\[(\s|x|X)\]/gm;
      const matches = content.match(taskRegex) || [];
      
      const total = matches.length;
      const completed = matches.filter((match: string) => match.includes('[x]') || match.includes('[X]')).length;
      
      // Cache the result
      this.taskCache.set(filePath, { completed, total, lastModified });
      
      return { completed, total };
    } catch (err) {
      // If file can't be read, return no tasks
      return { completed: 0, total: 0 };
    }
  }
}
