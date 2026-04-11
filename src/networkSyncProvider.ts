import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type NetworkSyncNodeType = 'path-root' | 'folder' | 'file';

export interface SyncStats {
  added: number;
  updated: number;
  skipped: number;
  deleted: number;
}

export interface NetworkPathEntry {
  url: string;
  username?: string;
  password?: string;
}

// ─────────────────────────────────────────────
// Tree node
// ─────────────────────────────────────────────

export class NetworkSyncNode extends vscode.TreeItem {
  public readonly nodeType: NetworkSyncNodeType;
  public readonly networkUrl: string;       // original smb:// (or other) URL (for root nodes)
  public readonly localPath: string;        // absolute local path for this node
  public readonly children?: NetworkSyncNode[];

  constructor(opts: {
    label: string;
    nodeType: NetworkSyncNodeType;
    networkUrl: string;
    localPath: string;
    collapsibleState?: vscode.TreeItemCollapsibleState;
    description?: string;
    tooltip?: string;
  }) {
    super(opts.label, opts.collapsibleState ?? vscode.TreeItemCollapsibleState.None);
    this.nodeType = opts.nodeType;
    this.networkUrl = opts.networkUrl;
    this.localPath = opts.localPath;
    this.description = opts.description;
    this.tooltip = opts.tooltip ?? opts.localPath;

    if (opts.nodeType === 'path-root') {
      this.iconPath = new vscode.ThemeIcon('cloud');
      this.contextValue = 'networkSyncRoot';
      this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
    } else if (opts.nodeType === 'folder') {
      this.iconPath = new vscode.ThemeIcon('folder');
      this.contextValue = 'networkSyncFolder';
      this.collapsibleState = opts.collapsibleState ?? vscode.TreeItemCollapsibleState.Collapsed;
    } else {
      this.iconPath = new vscode.ThemeIcon('file');
      this.contextValue = 'networkSyncFile';
      this.command = {
        command: 'vscode.open',
        title: 'Open file',
        arguments: [vscode.Uri.file(opts.localPath)]
      };
    }
  }
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/** 
 * Sanitise a network URL into a safe folder name used inside the local sync root.
 * e.g. smb://192.168.1.10/documents → smb_192.168.1.10_documents
 */
function urlToLocalFolderName(url: string): string {
  // Strip credentials (user:pass@) before generating folder name
  const clean = url.replace(/^([a-z]+:\/\/)([^@/]+@)?(.*)$/i, '$1$3');
  return clean
    .replace(/^[a-z]+:\/\//, match => match.replace('://', '_').replace('/', ''))
    .replace(/[^a-zA-Z0-9._\-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Parse an SMB URL into { host, share, subPath }.
 * smb://192.168.1.10/sharename/optional/sub  →  { host: "192.168.1.10", share: "sharename", subPath: "optional/sub" }
 */
function parseSmbUrl(url: string): { host: string; share: string; subPath: string } | null {
  const match = url.match(/^smb:\/\/([^/]+)\/([^/]+)(\/.*)?$/i);
  if (!match) return null;
  return {
    host: match[1],
    share: match[2],
    subPath: match[3] ? match[3].replace(/^\//, '') : ''
  };
}

/**
 * Try to mount a share via macOS's `open` command and poll until /Volumes/<share> appears.
 * Returns the local mount path, or null on timeout / unsupported platform.
 */
async function mountSmbAndGetPath(url: string, username?: string, password?: string, timeoutMs = 30000, tryMount = true): Promise<string | null> {
  if (process.platform !== 'darwin') {
    return null;
  }

  const parsed = parseSmbUrl(url);
  if (!parsed) return null;

  const volumePath = `/Volumes/${parsed.share}`;

  // Already mounted?
  if (fs.existsSync(volumePath)) {
    return parsed.subPath ? path.join(volumePath, parsed.subPath) : volumePath;
  }

  // In silent/auto mode, don't attempt mounting (avoids opening Finder)
  if (!tryMount) {
    return null;
  }

  // Build authenticated URL if credentials provided
  let openUrl = url;
  if (username) {
    const creds = password
      ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
      : `${encodeURIComponent(username)}@`;
    openUrl = `smb://${creds}${parsed.host}/${parsed.share}${parsed.subPath ? '/' + parsed.subPath : ''}`;
  }

  // Try to mount via OS (execFile avoids shell injection)
  try {
    await execFileAsync('open', [openUrl]);
  } catch {
    // open may fail silently if already handling the request
  }

  // Poll up to timeoutMs
  const interval = 1000;
  const attempts = Math.ceil(timeoutMs / interval);
  for (let i = 0; i < attempts; i++) {
    await new Promise(resolve => setTimeout(resolve, interval));
    if (fs.existsSync(volumePath)) {
      return parsed.subPath ? path.join(volumePath, parsed.subPath) : volumePath;
    }
  }

  return null;
}

/**
 * Recursively collect all files under a directory.
 * Returns a Map<relativePath, mtime-ms>.
 */
async function collectFiles(dir: string, base: string = dir): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    const rel = path.relative(base, fullPath);
    if (entry.isDirectory()) {
      const sub = await collectFiles(fullPath, base);
      sub.forEach((mtime, r) => result.set(r, mtime));
    } else if (entry.isFile()) {
      try {
        const stat = await fsp.stat(fullPath);
        result.set(rel, stat.mtimeMs);
      } catch {
        // skip unreadable files
      }
    }
  }
  return result;
}

/**
 * Copy a file, creating parent directories as needed.
 */
async function copyFile(src: string, dest: string): Promise<void> {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.copyFile(src, dest);
  // Preserve mtime so future comparisons are stable
  const stat = await fsp.stat(src);
  await fsp.utimes(dest, stat.atime, stat.mtime);
}

const MANIFEST_FILE = '.networksync-manifest.json';

/** Load the sync manifest from localDir. Returns empty Map if not found. */
async function loadManifest(localDir: string): Promise<Map<string, number>> {
  const manifestPath = path.join(localDir, MANIFEST_FILE);
  try {
    const raw = await fsp.readFile(manifestPath, 'utf8');
    const obj = JSON.parse(raw) as Record<string, number>;
    return new Map(Object.entries(obj));
  } catch {
    return new Map();
  }
}

/** Save the sync manifest to localDir. */
async function saveManifest(localDir: string, manifest: Map<string, number>): Promise<void> {
  const manifestPath = path.join(localDir, MANIFEST_FILE);
  const obj: Record<string, number> = {};
  manifest.forEach((mtime, rel) => { obj[rel] = mtime; });
  await fsp.writeFile(manifestPath, JSON.stringify(obj, null, 2), 'utf8');
}

// ─────────────────────────────────────────────
// NetworkSyncProvider
// ─────────────────────────────────────────────

export class NetworkSyncProvider implements vscode.TreeDataProvider<NetworkSyncNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<NetworkSyncNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Map from networkUrl → human-readable status line shown as node description */
  private statusMap = new Map<string, string>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  // ── TreeDataProvider ─────────────────────────────────────────────────────

  getTreeItem(element: NetworkSyncNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: NetworkSyncNode): Promise<NetworkSyncNode[]> {
    if (!element) {
      // Root level: one node per configured network path
      return this.buildRootNodes();
    }

    // Children: list local folder contents
    return this.buildChildNodes(element);
  }

  // ── Root nodes ────────────────────────────────────────────────────────────

  private buildRootNodes(): NetworkSyncNode[] {
    const cfg = vscode.workspace.getConfiguration('obsidianManager');
    const rawPaths = cfg.get<Array<NetworkPathEntry | string>>('networkPaths', []);
    const entries: NetworkPathEntry[] = rawPaths
      .map(e => (typeof e === 'string' ? { url: e } : e))
      .filter(e => e.url?.trim());
    const localFolder = cfg.get<string>('networkSyncLocalFolder', '').trim();

    return entries.map(entry => {
      const url = entry.url.trim();
      const folderName = urlToLocalFolderName(url);
      const localPath = localFolder ? path.join(localFolder, folderName) : '';
      const status = this.statusMap.get(url) ?? '';
      return new NetworkSyncNode({
        label: url,
        nodeType: 'path-root',
        networkUrl: url,
        localPath,
        description: status,
        tooltip: localPath
          ? `Local copy: ${localPath}${entry.username ? ` (user: ${entry.username})` : ''}`
          : 'Configure networkSyncLocalFolder to enable sync'
      });
    });
  }

  // ── Child nodes ───────────────────────────────────────────────────────────

  private async buildChildNodes(parent: NetworkSyncNode): Promise<NetworkSyncNode[]> {
    const localPath = parent.localPath;
    if (!localPath || !fs.existsSync(localPath)) {
      return [];
    }

    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(localPath, { withFileTypes: true });
    } catch {
      return [];
    }

    const nodes: NetworkSyncNode[] = [];
    const sorted = entries
      .filter(e => !e.name.startsWith('.'))
      .sort((a, b) => {
        // Folders first
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    for (const entry of sorted) {
      const childPath = path.join(localPath, entry.name);
      nodes.push(new NetworkSyncNode({
        label: entry.name,
        nodeType: entry.isDirectory() ? 'folder' : 'file',
        networkUrl: parent.networkUrl,
        localPath: childPath
      }));
    }
    return nodes;
  }

  // ── Sync logic ────────────────────────────────────────────────────────────

  /**
   * Sync all configured network paths sequentially.
   */
  async syncAll(progress?: vscode.Progress<{ message?: string; increment?: number }>): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('obsidianManager');
    const rawPaths = cfg.get<Array<NetworkPathEntry | string>>('networkPaths', []);
    const entries: NetworkPathEntry[] = rawPaths
      .map(e => (typeof e === 'string' ? { url: e } : e))
      .filter(e => e.url?.trim());
    const localFolder = cfg.get<string>('networkSyncLocalFolder', '').trim();

    if (!localFolder) {
      vscode.window.showErrorMessage('Obsidian Manager: configure "networkSyncLocalFolder" before syncing.');
      return;
    }

    if (!entries.length) {
      vscode.window.showInformationMessage('Obsidian Manager: no network paths configured.');
      return;
    }

    for (const entry of entries) {
      await this.syncPath(entry.url.trim(), localFolder, progress);
    }
  }

  /**
   * Sync a single network path.
   * If localFolder is not provided, reads it from config.
   */
  async syncPath(
    networkUrl: string,
    localFolder?: string,
    progress?: vscode.Progress<{ message?: string; increment?: number }>,
    silent = false
  ): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('obsidianManager');
    const resolvedLocalFolder = (localFolder ?? cfg.get<string>('networkSyncLocalFolder', '')).trim();

    if (!resolvedLocalFolder) {
      vscode.window.showErrorMessage('Obsidian Manager: configure "networkSyncLocalFolder" before syncing.');
      return;
    }

    const folderName = urlToLocalFolderName(networkUrl);
    const localDir = path.join(resolvedLocalFolder, folderName);

    this.statusMap.set(networkUrl, '$(sync~spin) Connecting…');
    this.refresh();

    progress?.report({ message: `Connecting to ${networkUrl}…` });

    // Look up credentials from config entry matching this URL
    const rawPaths = cfg.get<Array<NetworkPathEntry | string>>('networkPaths', []);
    const matchedEntry = rawPaths.find(e => (typeof e === 'string' ? e : e.url)?.trim() === networkUrl);
    const username = typeof matchedEntry === 'object' ? matchedEntry?.username : undefined;
    const password = typeof matchedEntry === 'object' ? matchedEntry?.password : undefined;

    // ── Resolve remote path ────────────────────────────────────────────────
    let remoteDir: string | null = null;

    if (networkUrl.toLowerCase().startsWith('smb://')) {
      remoteDir = await mountSmbAndGetPath(networkUrl, username, password, 30000, !silent);
      if (!remoteDir) {
        if (!silent) {
          const msg = process.platform !== 'darwin'
            ? `SMB auto-mount is only supported on macOS. Mount the share manually and set its path in networkSyncLocalFolder.`
            : `Could not mount ${networkUrl}. Check the address and that the share is reachable.`;
          vscode.window.showErrorMessage(`Obsidian Manager: ${msg}`);
          this.statusMap.set(networkUrl, '$(error) Mount failed');
          this.refresh();
        }
        return;
      }
    } else {
      // Treat as a plain local path (already-mounted share, NFS, etc.)
      remoteDir = networkUrl;
    }

    if (!fs.existsSync(remoteDir)) {
      if (!silent) {
        vscode.window.showErrorMessage(`Obsidian Manager: remote path not found: ${remoteDir}`);
        this.statusMap.set(networkUrl, '$(error) Not found');
        this.refresh();
      }
      return;
    }

    // ── Ensure local directory exists ──────────────────────────────────────
    try {
      await fsp.mkdir(localDir, { recursive: true });
    } catch (err) {
      vscode.window.showErrorMessage(`Obsidian Manager: could not create local folder: ${String(err)}`);
      this.statusMap.set(networkUrl, '$(error) Local error');
      this.refresh();
      return;
    }

    // ── Bidirectional sync ─────────────────────────────────────────────────
    this.statusMap.set(networkUrl, '$(sync~spin) Syncing…');
    this.refresh();
    progress?.report({ message: `Syncing ${networkUrl}…` });

    let stats: SyncStats;
    try {
      stats = await this.syncBidirectional(localDir, remoteDir, progress);
    } catch (err) {
      vscode.window.showErrorMessage(`Obsidian Manager: sync error for ${networkUrl}: ${String(err)}`);
      this.statusMap.set(networkUrl, '$(error) Sync failed');
      this.refresh();
      return;
    }

    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    this.statusMap.set(networkUrl, `$(check) ${timeStr} (+${stats.added} ~${stats.updated})`);
    this.refresh();

    const detail = `Added: ${stats.added}, Updated: ${stats.updated}, Deleted: ${stats.deleted}, Skipped: ${stats.skipped}`;
    if (!silent) {
      vscode.window.showInformationMessage(`Sync complete for ${networkUrl}. ${detail}`);
    }
  }

  /**
   * Bidirectional sync between localDir and remoteDir.
   * Uses a manifest file to track deletions on either side.
   * Strategy: last-write-wins for updates; manifest-based deletion propagation.
   */
  private async syncBidirectional(
    localDir: string,
    remoteDir: string,
    progress?: vscode.Progress<{ message?: string; increment?: number }>
  ): Promise<SyncStats> {
    const manifest = await loadManifest(localDir);
    const [localFiles, remoteFiles] = await Promise.all([
      collectFiles(localDir),
      collectFiles(remoteDir)
    ]);

    const stats: SyncStats = { added: 0, updated: 0, skipped: 0, deleted: 0 };
    const allKeys = new Set([...localFiles.keys(), ...remoteFiles.keys(), ...manifest.keys()]);
    const newManifest = new Map<string, number>();

    for (const rel of allKeys) {
      const localPath_ = path.join(localDir, rel);
      const remotePath_ = path.join(remoteDir, rel);
      const localMtime = localFiles.get(rel);
      const remoteMtime = remoteFiles.get(rel);
      const inManifest = manifest.has(rel);

      if (localMtime !== undefined && remoteMtime !== undefined) {
        // Present on both sides → last-write-wins
        if (remoteMtime > localMtime + 1000) {
          progress?.report({ message: `Updating local ${path.basename(rel)}…` });
          await copyFile(remotePath_, localPath_);
          newManifest.set(rel, remoteMtime);
          stats.updated++;
        } else if (localMtime > remoteMtime + 1000) {
          progress?.report({ message: `Updating remote ${path.basename(rel)}…` });
          await copyFile(localPath_, remotePath_);
          newManifest.set(rel, localMtime);
          stats.updated++;
        } else {
          newManifest.set(rel, localMtime);
          stats.skipped++;
        }
      } else if (localMtime !== undefined && remoteMtime === undefined) {
        if (inManifest) {
          // Was synced before, now missing from remote → deleted remotely → delete locally
          progress?.report({ message: `Deleting local ${path.basename(rel)}…` });
          let localDeleted = false;
          try {
            await fsp.unlink(localPath_);
            localDeleted = true;
          } catch (e: any) {
            if (e.code === 'ENOENT') { localDeleted = true; } // already gone is fine
            // else: delete failed (permissions?), keep in manifest to avoid re-upload
          }
          if (localDeleted) {
            stats.deleted++;
            // Do NOT add to new manifest
          } else {
            newManifest.set(rel, localMtime); // keep tracking so next sync retries deletion
            stats.skipped++;
          }
        } else {
          // New in local → copy to remote
          progress?.report({ message: `Uploading ${path.basename(rel)}…` });
          await copyFile(localPath_, remotePath_);
          newManifest.set(rel, localMtime);
          stats.added++;
        }
      } else if (localMtime === undefined && remoteMtime !== undefined) {
        if (inManifest) {
          // Was synced before, now missing from local → deleted locally → delete remotely
          progress?.report({ message: `Deleting remote ${path.basename(rel)}…` });
          let remoteDeleted = false;
          try {
            await fsp.unlink(remotePath_);
            remoteDeleted = true;
          } catch (e: any) {
            if (e.code === 'ENOENT') { remoteDeleted = true; } // already gone is fine
            // else: delete failed (permissions?), keep in manifest to avoid marking as new
          }
          if (remoteDeleted) {
            stats.deleted++;
            // Do NOT add to new manifest
          } else {
            newManifest.set(rel, remoteMtime); // keep tracking so next sync retries deletion
            stats.skipped++;
          }
        } else {
          // New in remote → copy to local
          progress?.report({ message: `Downloading ${path.basename(rel)}…` });
          await copyFile(remotePath_, localPath_);
          newManifest.set(rel, remoteMtime);
          stats.added++;
        }
      }
      // Case: missing from both but in manifest → already deleted everywhere, skip
    }

    await saveManifest(localDir, newManifest);
    return stats;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private todayString(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /** Returns the networkUrl whose local sync root contains localPath, or undefined. */
  findNetworkUrlForPath(localPath: string): string | undefined {
    const cfg = vscode.workspace.getConfiguration('obsidianManager');
    const localFolder = cfg.get<string>('networkSyncLocalFolder', '').trim();
    if (!localFolder) return undefined;
    const rawPaths = cfg.get<Array<NetworkPathEntry | string>>('networkPaths', []);
    const entries: NetworkPathEntry[] = rawPaths
      .map(e => (typeof e === 'string' ? { url: e } : e))
      .filter(e => e.url?.trim());
    for (const entry of entries) {
      const url = entry.url.trim();
      const rootDir = path.join(localFolder, urlToLocalFolderName(url));
      const norm = path.normalize(localPath);
      const normRoot = path.normalize(rootDir);
      if (norm === normRoot || norm.startsWith(normRoot + path.sep)) {
        return url;
      }
    }
    return undefined;
  }

  private async triggerAutoSync(networkUrl: string): Promise<void> {
    try {
      await this.syncPath(networkUrl, undefined, undefined, true);
    } catch {
      // silent — errors surfaced via syncPath internally
    }
  }

  // ── CRUD operations ───────────────────────────────────────────────────────

  async createFileInNode(node: NetworkSyncNode): Promise<void> {
    const name = await vscode.window.showInputBox({
      prompt: 'New note name (without .md extension)',
      value: this.todayString(),
      placeHolder: 'YYYY-MM-DD'
    });
    if (!name) return;

    const fileName = name.endsWith('.md') ? name : `${name}.md`;
    const filePath = path.join(node.localPath, fileName);

    if (fs.existsSync(filePath)) {
      vscode.window.showErrorMessage(`File "${fileName}" already exists.`);
      return;
    }

    try {
      await fsp.writeFile(filePath, '');
    } catch (err) {
      vscode.window.showErrorMessage(`Could not create file: ${String(err)}`);
      return;
    }

    this.refresh();
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(doc, { preview: false });
    await this.triggerAutoSync(node.networkUrl);
  }

  async createFolderInNode(node: NetworkSyncNode): Promise<void> {
    const name = await vscode.window.showInputBox({
      prompt: 'New folder name',
      placeHolder: 'folder-name'
    });
    if (!name) return;

    const folderPath = path.join(node.localPath, name);

    if (fs.existsSync(folderPath)) {
      vscode.window.showErrorMessage(`Folder "${name}" already exists.`);
      return;
    }

    try {
      await fsp.mkdir(folderPath);
    } catch (err) {
      vscode.window.showErrorMessage(`Could not create folder: ${String(err)}`);
      return;
    }

    this.refresh();
    await this.triggerAutoSync(node.networkUrl);
  }

  async duplicateFile(node: NetworkSyncNode): Promise<void> {
    const ext = path.extname(node.localPath);
    const base = path.basename(node.localPath, ext);

    const name = await vscode.window.showInputBox({
      prompt: 'Duplicate as (without extension)',
      value: `${base}-copy`
    });
    if (!name) return;

    const newName = name.endsWith(ext) ? name : `${name}${ext}`;
    const destPath = path.join(path.dirname(node.localPath), newName);

    if (fs.existsSync(destPath)) {
      vscode.window.showErrorMessage(`File "${newName}" already exists.`);
      return;
    }

    try {
      await fsp.copyFile(node.localPath, destPath);
    } catch (err) {
      vscode.window.showErrorMessage(`Could not duplicate: ${String(err)}`);
      return;
    }

    this.refresh();
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(destPath));
    await vscode.window.showTextDocument(doc, { preview: false });
    await this.triggerAutoSync(node.networkUrl);
  }

  async renameFile(node: NetworkSyncNode): Promise<void> {
    const ext = path.extname(node.localPath);
    const base = path.basename(node.localPath, ext);

    const name = await vscode.window.showInputBox({
      prompt: 'New name (without extension)',
      value: base
    });
    if (!name) return;

    const newName = name.endsWith(ext) ? name : `${name}${ext}`;
    const destPath = path.join(path.dirname(node.localPath), newName);

    if (fs.existsSync(destPath)) {
      vscode.window.showErrorMessage(`A file named "${newName}" already exists in this location.`);
      return;
    }

    try {
      await fsp.rename(node.localPath, destPath);
    } catch (err) {
      vscode.window.showErrorMessage(`Could not rename: ${String(err)}`);
      return;
    }

    this.refresh();
    await this.triggerAutoSync(node.networkUrl);
  }

  async deleteFile(node: NetworkSyncNode): Promise<void> {
    const confirmed = await vscode.window.showWarningMessage(
      `Delete "${path.basename(node.localPath)}"?`,
      { modal: true },
      'Delete'
    );
    if (confirmed !== 'Delete') return;

    try {
      await fsp.unlink(node.localPath);
    } catch (err) {
      vscode.window.showErrorMessage(`Could not delete: ${String(err)}`);
      return;
    }

    this.refresh();
    await this.triggerAutoSync(node.networkUrl);
  }

  async renameFolder(node: NetworkSyncNode): Promise<void> {
    const base = path.basename(node.localPath);

    const name = await vscode.window.showInputBox({
      prompt: 'New folder name',
      value: base
    });
    if (!name) return;

    const destPath = path.join(path.dirname(node.localPath), name);

    if (fs.existsSync(destPath)) {
      vscode.window.showErrorMessage(`A folder named "${name}" already exists in this location.`);
      return;
    }

    try {
      await fsp.rename(node.localPath, destPath);
    } catch (err) {
      vscode.window.showErrorMessage(`Could not rename folder: ${String(err)}`);
      return;
    }

    this.refresh();
    await this.triggerAutoSync(node.networkUrl);
  }

  async deleteFolder(node: NetworkSyncNode): Promise<void> {
    const confirmed = await vscode.window.showWarningMessage(
      `Delete folder "${path.basename(node.localPath)}" and all its contents?`,
      { modal: true },
      'Delete'
    );
    if (confirmed !== 'Delete') return;

    try {
      await fsp.rm(node.localPath, { recursive: true, force: true });
    } catch (err) {
      vscode.window.showErrorMessage(`Could not delete folder: ${String(err)}`);
      return;
    }

    this.refresh();
    await this.triggerAutoSync(node.networkUrl);
  }
}

// ─────────────────────────────────────────────
// Drag & Drop controller
// ─────────────────────────────────────────────

const NETWORK_SYNC_MIME = 'application/vnd.code.tree.obsidianNetworkSync';

export class NetworkSyncDragAndDropController implements vscode.TreeDragAndDropController<NetworkSyncNode> {
  readonly dragMimeTypes = [NETWORK_SYNC_MIME];
  readonly dropMimeTypes = [NETWORK_SYNC_MIME];

  constructor(private readonly provider: NetworkSyncProvider) {}

  handleDrag(source: NetworkSyncNode[], data: vscode.DataTransfer): void {
    data.set(NETWORK_SYNC_MIME, new vscode.DataTransferItem(source));
  }

  async handleDrop(target: NetworkSyncNode | undefined, data: vscode.DataTransfer): Promise<void> {
    const item = data.get(NETWORK_SYNC_MIME);
    if (!item) return;

    const sources: NetworkSyncNode[] = item.value;
    if (!sources || sources.length === 0) return;

    // Determine destination folder
    let destFolder: string | undefined;
    if (!target) return; // no dropping onto empty space in network sync tree
    if (target.nodeType === 'path-root' || target.nodeType === 'folder') {
      destFolder = target.localPath;
    } else if (target.nodeType === 'file') {
      destFolder = path.dirname(target.localPath);
    }
    if (!destFolder) return;

    let needsSync = false;
    const networkUrl = sources[0].networkUrl;

    for (const src of sources) {
      const base = path.basename(src.localPath);
      let destPath = path.join(destFolder, base);

      // Can't move into itself or a descendant
      if (src.nodeType === 'folder' || src.nodeType === 'path-root') {
        const normSrc = path.normalize(src.localPath);
        const normDest = path.normalize(destFolder);
        if (normDest === normSrc || normDest.startsWith(normSrc + path.sep)) {
          vscode.window.showErrorMessage(`Cannot move "${base}" into itself or a sub-folder.`);
          continue;
        }
      }

      // No-op: same location
      if (path.normalize(path.dirname(src.localPath)) === path.normalize(destFolder)) {
        continue;
      }

      // Conflict handling
      if (fs.existsSync(destPath)) {
        const choice = await vscode.window.showQuickPick(['Overwrite', 'Rename', 'Cancel'], {
          placeHolder: `"${base}" already exists in the destination. What would you like to do?`
        });
        if (!choice || choice === 'Cancel') continue;
        if (choice === 'Overwrite') {
          try { await fsp.rm(destPath, { recursive: true, force: true }); } catch { /* ignore */ }
        } else if (choice === 'Rename') {
          const ext = src.nodeType === 'file' ? path.extname(base) : '';
          const nameOnly = path.basename(base, ext);
          let idx = 1;
          while (fs.existsSync(destPath)) {
            destPath = path.join(destFolder, `${nameOnly}-${idx}${ext}`);
            idx++;
          }
        }
      }

      try {
        await fsp.rename(src.localPath, destPath);
        needsSync = true;
      } catch (err) {
        vscode.window.showErrorMessage(`Could not move "${base}": ${String(err)}`);
      }
    }

    if (needsSync) {
      this.provider.refresh();
      await this.provider.syncPath(networkUrl, undefined, undefined, true);
    }
  }
}
