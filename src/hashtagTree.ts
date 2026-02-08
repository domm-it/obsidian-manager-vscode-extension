import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';

export type HashtagNode = {
  hashtag: string;
  count: number;
};

export class HashtagTreeProvider implements vscode.TreeDataProvider<HashtagNode> {
  private _onDidChangeTreeData: vscode.EventEmitter<HashtagNode | undefined | void> = new vscode.EventEmitter<HashtagNode | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<HashtagNode | undefined | void> = this._onDidChangeTreeData.event;

  private hashtags: Map<string, number> = new Map();
  private vaultPath: string | undefined;

  constructor(private context: vscode.ExtensionContext) {
    // Initial scan
    this.refreshHashtags().catch(() => {});
  }

  refresh(): void {
    this.refreshHashtags().catch(() => {});
  }

  getTreeItem(element: HashtagNode): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(
      `${element.hashtag} (${element.count})`,
      vscode.TreeItemCollapsibleState.None
    );
    
    treeItem.contextValue = 'obsidianHashtag';
    treeItem.iconPath = new vscode.ThemeIcon('tag');
    
    // Make hashtag clickable to open Task Table with filter
    treeItem.command = {
      command: 'obsidianManager.showTaskTable',
      title: 'Filter tasks by hashtag',
      arguments: [undefined, undefined, element.hashtag] // filterDate, filterProject, filterHashtag
    };
    
    return treeItem;
  }

  async getChildren(element?: HashtagNode): Promise<HashtagNode[]> {
    if (element) {
      return [];
    }

    // Return all hashtags sorted by count (descending), then alphabetically
    const nodes: HashtagNode[] = Array.from(this.hashtags.entries())
      .map(([hashtag, count]) => ({ hashtag, count }))
      .sort((a, b) => {
        if (b.count !== a.count) {
          return b.count - a.count; // Sort by count descending
        }
        return a.hashtag.localeCompare(b.hashtag); // Then alphabetically
      });

    return nodes;
  }

  private async refreshHashtags(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('obsidianManager');
    const configuredVault = ((cfg.get<string>('vault') || '')).trim();
    
    if (!configuredVault) {
      this.hashtags.clear();
      this._onDidChangeTreeData.fire();
      return;
    }

    this.vaultPath = this.normalizeToFsPath(configuredVault);
    if (!this.vaultPath) {
      this.hashtags.clear();
      this._onDidChangeTreeData.fire();
      return;
    }

    // Clear and rescan
    this.hashtags.clear();
    await this.scanForHashtags(this.vaultPath);
    this._onDidChangeTreeData.fire();
  }

  private async scanForHashtags(dir: string): Promise<void> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === '@eaDir') continue;
        
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          await this.scanForHashtags(fullPath);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          // Only process files with date prefix (YYYY-MM-DD-)
          const datePattern = /^\d{4}-\d{2}-\d{2}-/;
          if (datePattern.test(entry.name)) {
            await this.extractHashtagsFromFile(fullPath);
          }
        }
      }
    } catch (err) {
      // Ignore errors
    }
  }

  private async extractHashtagsFromFile(filePath: string): Promise<void> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      const hashtagRegex = /#[\w]+/g;
      
      for (const line of lines) {
        // Only extract hashtags from task lines (- [ ] or - [x])
        if (line.includes('- [ ]') || line.includes('- [x]')) {
          const matches = line.match(hashtagRegex);
          if (matches) {
            for (const hashtag of matches) {
              const current = this.hashtags.get(hashtag) || 0;
              this.hashtags.set(hashtag, current + 1);
            }
          }
        }
      }
    } catch (err) {
      // Ignore file read errors
    }
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
}
