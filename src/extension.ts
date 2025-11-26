import * as vscode from 'vscode';
import { ObsidianTreeProvider } from './obsidianTree';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as os from 'os';

// Drag & Drop controller state (last dragged items). We'll record last dragged sources in memory
let _lastDragged: any[] = [];

// Helper function to get all markdown files from the vault
async function getAllMarkdownFiles(provider: ObsidianTreeProvider, vaultPath: string): Promise<any[]> {
  const allFiles: any[] = [];
  
  async function collectFiles(node?: any): Promise<void> {
    const children = await provider.getChildren(node);
    for (const child of children) {
      if (child.isDirectory) {
        await collectFiles(child);
      } else if (child.resourceUri.fsPath.toLowerCase().endsWith('.md')) {
        allFiles.push(child);
      }
    }
  }
  
  await collectFiles();
  return allFiles;
}

// Helper function to generate Obsidian link based on file paths
function generateObsidianLink(targetFilePath: string, currentFilePath: string, vaultPath: string): string {
  // Get relative paths from vault root
  const targetRelative = path.relative(vaultPath, targetFilePath);
  const currentRelative = path.relative(vaultPath, currentFilePath);
  
  // Remove .md extension for Obsidian link format
  const targetWithoutExt = targetRelative.replace(/\.md$/, '');
  
  // Check if files are in same directory
  const targetDir = path.dirname(targetRelative);
  const currentDir = path.dirname(currentRelative);
  
  if (targetDir === currentDir && targetDir === '.') {
    // Both files in vault root
    return `[[${path.basename(targetWithoutExt)}]]`;
  } else if (targetDir === currentDir) {
    // Same directory, use just filename
    return `[[${path.basename(targetWithoutExt)}]]`;
  } else {
    // Different directories, use full path relative to vault
    return `[[${targetWithoutExt}]]`;
  }
}

class ObsidianDragAndDropController implements vscode.TreeDragAndDropController<any> {
  readonly dragMimeTypes = ['application/vnd.code.tree.obsidianFiles'];
  readonly dropMimeTypes = ['application/vnd.code.tree.obsidianFiles'];
  constructor(private refreshFn: () => Promise<void>) {}
  // Called when dragging items
  handleDrag(source: any[], data: vscode.DataTransfer, token: vscode.CancellationToken): void | Thenable<void> {
    _lastDragged = source;
  }
  // Called when dropping onto a target (folder or file)
  async handleDrop(target: any | undefined, data: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
    const sources = _lastDragged || [];
    _lastDragged = [];
    if (!sources || sources.length === 0) return;
    // Determine destination folder
    let destFolder: string | undefined;
    if (target && target.isDirectory) destFolder = target.resourceUri.fsPath;
    else if (target && target.resourceUri) destFolder = path.dirname(target.resourceUri.fsPath);
    // If no target folder, abort
    if (!destFolder) return;

    for (const s of sources) {
      try {
        const srcPath = s.resourceUri.fsPath;
        const base = path.basename(srcPath);
        let destPath = path.join(destFolder, base);
        // If dest exists, ask what to do
        let destExists = false;
        try { await fs.access(destPath); destExists = true; } catch (e) { destExists = false; }
        if (destExists) {
          const choice = await vscode.window.showQuickPick(['Overwrite', 'Rename', 'Cancel'], { placeHolder: `Conflict for ${base}` });
          if (!choice || choice === 'Cancel') continue;
          if (choice === 'Overwrite') {
            // remove dest then move
            try { await fs.rm(destPath, { recursive: true, force: true }); } catch (e) {}
          } else if (choice === 'Rename') {
            // find a new name
            const ext = path.extname(base);
            const nameOnly = path.basename(base, ext);
            let idx = 1;
            while (true) {
              const candidate = `${nameOnly}-${idx}${ext}`;
              const candidatePath = path.join(destFolder, candidate);
              try { await fs.access(candidatePath); idx++; continue; } catch (e) { destPath = candidatePath; break; }
            }
          }
        }
        await fs.rename(srcPath, destPath);
        // If file open in editor, reopen new uri
        for (const ed of vscode.window.visibleTextEditors) {
          if (ed.document.uri.fsPath === srcPath) {
            const cfg = vscode.workspace.getConfiguration('obsidianManager');
            const openFileMode = cfg.get<string>('openFileMode', 'preview');
            if (openFileMode === 'preview') {
              await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(destPath));
            } else {
              const document = await vscode.workspace.openTextDocument(vscode.Uri.file(destPath));
              await vscode.window.showTextDocument(document, { preview: false });
            }
            break;
          }
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Move failed: ${String(err)}`);
      }
    }
    // refresh provider via provided callback
    try { await this.refreshFn(); } catch (e) {}
  }
}

export async function activate(context: vscode.ExtensionContext) {
  const openHandler = async (args: any) => {
    // Prefer a URI passed by the command (e.g., from a menu on a resource). Fallback to active editor.
    let fileUri: vscode.Uri | undefined;

    if (args instanceof vscode.Uri) {
      fileUri = args;
    } else {
      const editor = vscode.window.activeTextEditor;
      if (editor) fileUri = editor.document.uri;
    }

    if (!fileUri) {
      vscode.window.showErrorMessage('No file available to open in Obsidian.');
      return;
    }

    if (fileUri.scheme !== 'file') {
      vscode.window.showErrorMessage('Only local files can be opened in Obsidian.');
      return;
    }

  const fsPath = fileUri.fsPath;

  // Read user configuration
  const cfg = vscode.workspace.getConfiguration('obsidianManager');
  const vault = cfg.get<string>('vault') || '';

    const tryOpen = async (url: string) => {
      try {
        // openExternal resolves to boolean; true if the OS handled the link
        const opened = await vscode.env.openExternal(vscode.Uri.parse(url));
        return opened;
      } catch (e) {
        return false;
      }
    };

    // Try a few common Obsidian URL forms. Encode the full path.
    const encoded = encodeURIComponent(fsPath);
    const encVault = vault ? encodeURIComponent(vault) : '';

    // Build candidate URLs according to configuration
    const candidates: string[] = [];

    const pushVaultCandidates = () => {
      if (!vault) return;
      // use path then file (stable default)
      candidates.push(`obsidian://open?vault=${encVault}&path=${encoded}`);
      candidates.push(`obsidian://open?vault=${encVault}&file=${encoded}`);
    };

    const pushNonVaultCandidates = () => {
      // non-vault links: prefer path then file
      candidates.push(`obsidian://open?path=${encoded}`);
      candidates.push(`obsidian://open?file=${encoded}`);
    };

    if (vault) {
      // Vault configured — try non-vault links first (default behavior) then vault links.
      pushNonVaultCandidates();
      pushVaultCandidates();
    } else {
      pushNonVaultCandidates();
    }

    // Try each candidate until one succeeds
    for (const url of candidates) {
      const ok = await tryOpen(url);
      if (ok) return;
    }

    vscode.window.showErrorMessage('Unable to open file in Obsidian. Make sure Obsidian is installed and obsidian:// links are handled by your OS.');
  };

  const disposableA = vscode.commands.registerCommand('obsidianManager.openFile', openHandler);
  const disposableB = vscode.commands.registerCommand('obsidianManager.openFile.icon', openHandler);

  // Command to open file with mode setting
  const openFileWithModeCmd = vscode.commands.registerCommand('obsidianManager.openFileWithMode', async (uri: vscode.Uri) => {
    const cfg = vscode.workspace.getConfiguration('obsidianManager');
    const openFileMode = cfg.get<string>('openFileMode', 'preview');
    
    if (openFileMode === 'preview') {
      // Open in preview mode (read-only)
      await vscode.commands.executeCommand('markdown.showPreview', uri);
    } else {
      // Open in edit mode
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: false });
    }
  });

  context.subscriptions.push(disposableA, disposableB, openFileWithModeCmd);

  // Register command used by the view to open a file in Obsidian
  const openFromView = vscode.commands.registerCommand('obsidianManager.openFileFromView', async (...args: any[]) => {
    // The view/context menu may pass different shapes (a Uri, a TreeItem-like object, or nothing).
    let uri: vscode.Uri | undefined;
    if (args && args.length) {
      const first = args[0];
      if (first instanceof vscode.Uri) {
        uri = first;
      } else if (first && typeof first === 'object') {
        // Common shapes: { resourceUri: Uri } or { uri: Uri }
        if ((first as any).resourceUri instanceof vscode.Uri) uri = (first as any).resourceUri;
        else if ((first as any).uri instanceof vscode.Uri) uri = (first as any).uri;
      }
    }

    // Fallback to active editor
    if (!uri && vscode.window.activeTextEditor) {
      uri = vscode.window.activeTextEditor.document.uri;
    }

    if (!uri) {
      vscode.window.showErrorMessage('No file available to open in Obsidian.');
      return;
    }

  await vscode.commands.executeCommand('obsidianManager.openFile', uri);
  });
  context.subscriptions.push(openFromView);

  // Command to create a new .md file inside a folder (inline button on folder items)
  const createFileCmd = vscode.commands.registerCommand('obsidianManager.createFileInFolder', async (...args: any[]) => {
    // Determine folder Uri from args or active selection
    let folderUri: vscode.Uri | undefined;
    const first = args && args[0];
    if (first instanceof vscode.Uri) folderUri = first;
    else if (first && typeof first === 'object') {
      if ((first as any).resourceUri instanceof vscode.Uri) folderUri = (first as any).resourceUri;
      else if ((first as any).uri instanceof vscode.Uri) folderUri = (first as any).uri;
    }

    if (!folderUri && vscode.window.activeTextEditor) {
      folderUri = vscode.window.activeTextEditor.document.uri;
    }

    if (!folderUri) {
      vscode.window.showErrorMessage('No folder selected to create a new note.');
      return;
    }

  const cfg = vscode.workspace.getConfiguration('obsidianManager');
    const configuredVault = ((cfg.get<string>('vault') || '')).trim();
    const folderFs = folderUri.fsPath;

    // Generate today's date in YYYY-MM-DD format as default
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    const todayString = `${year}-${month}-${day}`;

    // Prompt for filename
    const name = await vscode.window.showInputBox({ 
      prompt: 'New note name (without extension)', 
      value: todayString,
      placeHolder: 'YYYY-MM-DD'
    });
    if (!name) return;
    const fileName = name.endsWith('.md') ? name : `${name}.md`;
    const target = path.join(folderFs, fileName);
    try {
      await fs.writeFile(target, '');
      // Open the new file in editor
      const openFileMode = cfg.get<string>('openFileMode', 'preview');
      if (openFileMode === 'preview') {
        await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(target));
      } else {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
        await vscode.window.showTextDocument(document, { preview: false });
      }
      // Refresh provider so view updates
      try { await provider.refreshAll(); } catch (e) { provider.refresh(); }
    } catch (err) {
      vscode.window.showErrorMessage(`Unable to create file: ${String(err)}`);
    }
  });
  context.subscriptions.push(createFileCmd);

  // Command to create a new folder at vault root
  const createFolderCmd = vscode.commands.registerCommand('obsidianManager.createFolder', async (...args: any[]) => {
    // If invoked with a folder node (from context menu), create under that folder; otherwise use vault root
    let parentFs: string | undefined;
    const first = args && args[0];
    if (first instanceof vscode.Uri) parentFs = first.fsPath;
    else if (first && typeof first === 'object') {
      if ((first as any).resourceUri instanceof vscode.Uri) parentFs = (first as any).resourceUri.fsPath;
      else if ((first as any).uri instanceof vscode.Uri) parentFs = (first as any).uri.fsPath;
    }

  const cfg = vscode.workspace.getConfiguration('obsidianManager');
  const configuredVault = ((cfg.get<string>('vault') || '')).trim();
    if (!configuredVault) {
  vscode.window.showErrorMessage('Please configure the `obsidianManager.vault` setting with the vault path first.');
      return;
    }

    // If parentFs is provided and it's a file, use its directory
    if (parentFs) {
      try {
        const stat = await fs.lstat(parentFs);
        if (!stat.isDirectory()) parentFs = path.dirname(parentFs);
      } catch (e) {
        // ignore and fallback to vault
        parentFs = undefined;
      }
    }

    const baseFolder = parentFs || configuredVault;
    const name = await vscode.window.showInputBox({ prompt: 'New folder name', placeHolder: 'NewFolder' });
    if (!name) return;
    const target = path.join(baseFolder, name);
    try {
      await fs.mkdir(target, { recursive: true });
      try { await provider.refreshAll(); } catch (e) { provider.refresh(); }
    } catch (err) {
      vscode.window.showErrorMessage(`Unable to create folder: ${String(err)}`);
    }
  });
  context.subscriptions.push(createFolderCmd);

  // Command to rename a file or folder
  const renameCmd = vscode.commands.registerCommand('obsidianManager.renameItem', async (...args: any[]) => {
    const first = args && args[0];
    let node = undefined as any;
    if (first instanceof vscode.Uri) node = { resourceUri: first, isDirectory: false };
    else if (first && typeof first === 'object') node = first;
    if (!node) { vscode.window.showErrorMessage('No item to rename'); return; }
    const oldPath = node.resourceUri.fsPath;
    const ext = node.isDirectory ? '' : path.extname(oldPath);
    const base = path.basename(oldPath, ext);
    const input = await vscode.window.showInputBox({ prompt: 'New name', value: base });
    if (!input) return;
    const newName = node.isDirectory ? input : (input.endsWith(ext) ? input : input + ext);
    const newPath = path.join(path.dirname(oldPath), newName);
    try {
      // handle existing
      try { await fs.access(newPath); // exists
        const choice = await vscode.window.showQuickPick(['Overwrite','Cancel'], { placeHolder: 'Target exists' });
        if (!choice || choice === 'Cancel') return;
        await fs.rm(newPath, { recursive: true, force: true });
      } catch (e) {
        // doesn't exist
      }
      await fs.rename(oldPath, newPath);
      // reopen if needed
      for (const ed of vscode.window.visibleTextEditors) {
        if (ed.document.uri.fsPath === oldPath) {
          const cfg = vscode.workspace.getConfiguration('obsidianManager');
          const openFileMode = cfg.get<string>('openFileMode', 'preview');
          if (openFileMode === 'preview') {
            await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(newPath));
          } else {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(newPath));
            await vscode.window.showTextDocument(document, { preview: false });
          }
          break;
        }
      }
      try { await provider.refreshAll(); } catch (e) { provider.refresh(); }
    } catch (err) {
      vscode.window.showErrorMessage(`Rename failed: ${String(err)}`);
    }
  });
  context.subscriptions.push(renameCmd);

  // Command to delete a file or folder
  const deleteCmd = vscode.commands.registerCommand('obsidianManager.deleteItem', async (...args: any[]) => {
    const first = args && args[0];
    let node = undefined as any;
    if (first instanceof vscode.Uri) node = { resourceUri: first, isDirectory: false };
    else if (first && typeof first === 'object') node = first;
    if (!node) { vscode.window.showErrorMessage('No item to delete'); return; }
    const ok = await vscode.window.showWarningMessage(`Delete '${node.resourceUri.fsPath}'?`, { modal: true }, 'Delete');
    if (ok !== 'Delete') return;
    try {
      await vscode.workspace.fs.delete(node.resourceUri, { recursive: !!node.isDirectory, useTrash: true });
      try { await provider.refreshAll(); } catch (e) { provider.refresh(); }
    } catch (err) {
      vscode.window.showErrorMessage(`Delete failed: ${String(err)}`);
    }
  });
  context.subscriptions.push(deleteCmd);

  // Register view provider and wait for initial preload so the view can render fully
  const provider = new ObsidianTreeProvider(context);
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Preloading Obsidian vault...' }, async () => {
    await provider.ensurePreloaded();
  });

  // File system watcher to monitor vault changes
  const cfg = vscode.workspace.getConfiguration('obsidianManager');
  const vaultPath = cfg.get<string>('vault', '');
  let fileWatcher: vscode.FileSystemWatcher | undefined;
  
  const setupFileWatcher = () => {
    if (fileWatcher) {
      fileWatcher.dispose();
    }
    
    const currentVaultPath = vscode.workspace.getConfiguration('obsidianManager').get<string>('vault', '');
    if (currentVaultPath) {
      const pattern = new vscode.RelativePattern(currentVaultPath, '**/*.md');
      fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);
      
      // Refresh calendar when files are created, changed, or deleted
      fileWatcher.onDidCreate(() => {
        vscode.commands.executeCommand('obsidianManager.refreshCalendar');
      });
      
      fileWatcher.onDidChange(() => {
        vscode.commands.executeCommand('obsidianManager.refreshCalendar');
      });
      
      fileWatcher.onDidDelete(() => {
        vscode.commands.executeCommand('obsidianManager.refreshCalendar');
      });
      
      context.subscriptions.push(fileWatcher);
    }
  };
  
  setupFileWatcher();
  
  // Re-setup watcher when vault configuration changes
  vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('obsidianManager.vault')) {
      setupFileWatcher();
    }
  });

  const dndController = new ObsidianDragAndDropController(async () => { try { await provider.refreshAll(); } catch (e) { provider.refresh(); } });
  let treeView = vscode.window.createTreeView('obsidianFiles', { treeDataProvider: provider, dragAndDropController: dndController });
  context.subscriptions.push(treeView);



  // Create calendar webview
  let currentCalendarView: vscode.WebviewView | undefined;
  const calendarViewProvider = vscode.window.registerWebviewViewProvider('obsidianCalendar', {
    resolveWebviewView(webviewView: vscode.WebviewView) {
      currentCalendarView = webviewView;
      webviewView.webview.options = { enableScripts: true };
      
      const updateCalendar = async (year: number, month: number, selectedFolder?: string) => {
        const cfg = vscode.workspace.getConfiguration('obsidianManager');
        const weekStartDay = cfg.get<string>('weekStartDay', 'monday');
        const startOnMonday = weekStartDay === 'monday';
        const vaultPath = cfg.get<string>('vault', '');
        
        const today = new Date();
        const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        
        const firstDay = new Date(year, month, 1);
        const lastDay = new Date(year, month + 1, 0);
        const startDate = new Date(firstDay);
        
        // Calculate start date based on week start preference
        let dayOffset = firstDay.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
        if (startOnMonday) {
          dayOffset = dayOffset === 0 ? 6 : dayOffset - 1; // Convert Sunday=0 to Sunday=6 for Monday start
        }
        startDate.setDate(startDate.getDate() - dayOffset);
        
        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
          'July', 'August', 'September', 'October', 'November', 'December'];
        
        // Day headers based on week start preference
        const dayHeaders = startOnMonday 
          ? ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
          : ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
        
        // Get all folders from vault
        let folderOptions = '';
        if (vaultPath) {
          try {
            const getTopLevelFolders = async (dirPath: string): Promise<string[]> => {
              const folders: string[] = [];
              try {
                const entries = await fs.readdir(dirPath, { withFileTypes: true });
                for (const entry of entries) {
                  if (entry.isDirectory() && !entry.name.startsWith('.')) {
                    folders.push(entry.name);
                  }
                }
              } catch (e) {
                // Ignore unreadable directories
              }
              return folders;
            };
            
            const folders = await getTopLevelFolders(vaultPath);
            folders.sort();
            folderOptions = ['Root', ...folders].map(folder => 
              `<option value="${folder}" ${folder === (selectedFolder || 'Root') ? 'selected' : ''}>${folder}</option>`
            ).join('');
          } catch (e) {
            folderOptions = '<option value="Root">Root</option>';
          }
        }
        
        // Get files in selected folder to check which days have files (including subfolders)
        const filesInFolder = new Set<string>();
        const filePathsMap = new Map<string, string[]>(); // Map date to array of full file paths
        if (vaultPath && selectedFolder) {
          const scanFolderRecursively = async (dirPath: string): Promise<void> => {
            try {
              const entries = await fs.readdir(dirPath, { withFileTypes: true });
              for (const entry of entries) {
                if (entry.isFile() && entry.name.endsWith('.md')) {
                  const dateMatch = entry.name.match(/^(\d{4}-\d{2}-\d{2})/);
                  if (dateMatch) {
                    const dateStr = dateMatch[1];
                    filesInFolder.add(dateStr);
                    // Store the full paths for this date (support multiple files)
                    if (!filePathsMap.has(dateStr)) {
                      filePathsMap.set(dateStr, []);
                    }
                    filePathsMap.get(dateStr)!.push(path.join(dirPath, entry.name));
                  }
                } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
                  await scanFolderRecursively(path.join(dirPath, entry.name));
                }
              }
            } catch (e) {
              // Ignore errors
            }
          };
          
          try {
            const folderPath = selectedFolder === 'Root' ? vaultPath : path.join(vaultPath, selectedFolder);
            await scanFolderRecursively(folderPath);
          } catch (e) {
            // Ignore errors
          }
        }
        
        let calendarHtml = `
          <div class="top-controls">
            <button class="action-button" onclick="goToRoot()" title="Go to root folder">
              🏠
            </button>
            <select class="folder-selector" onchange="folderChanged(this.value)">
              ${folderOptions}
            </select>
            <button class="action-button" onclick="createTodayRecap()" title="Create today recap">
              📋
            </button>
          </div>
          <div class="calendar-header">
            <button onclick="previousMonth()">&lt;</button>
            <span class="month-year">${monthNames[month]} ${year}</span>
            <button onclick="nextMonth()">&gt;</button>
          </div>
          <div class="calendar-grid">
            ${dayHeaders.map(day => `<div class="day-header">${day}</div>`).join('')}`;
        
        const currentDate = new Date(startDate);
        for (let week = 0; week < 6; week++) {
          for (let day = 0; day < 7; day++) {
            const dateStr = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-${String(currentDate.getDate()).padStart(2, '0')}`;
            const isCurrentMonth = currentDate.getMonth() === month;
            const isToday = dateStr === todayStr;
            const hasFile = filesInFolder.has(dateStr);
            
            const classes = [
              'day',
              isCurrentMonth ? 'current-month' : 'other-month',
              isToday ? 'today' : '',
              hasFile ? 'has-file' : ''
            ].filter(Boolean).join(' ');
            
            // Generate dots for each file found for this date
            let dotsHtml = '';
            const filesForDate = filePathsMap.get(dateStr);
            if (filesForDate && filesForDate.length > 0) {
              dotsHtml = filesForDate.map(filePath => {
                const fileName = path.basename(filePath, '.md');
                return `<span class="file-dot" title="${fileName}"></span>`;
              }).join('');
            }
            
            calendarHtml += `<div class="${classes}" onclick="dayClicked('${dateStr}')">
              <span class="day-number">${currentDate.getDate()}</span>
              <div class="file-dots">${dotsHtml}</div>
            </div>`;
            
            currentDate.setDate(currentDate.getDate() + 1);
          }
        }
        
        calendarHtml += '</div>';
        
        // Send updated file paths map to webview
        webviewView.webview.postMessage({
          command: 'updateFilePathsMap',
          filePathsMap: Object.fromEntries(filePathsMap)
        });

        webviewView.webview.html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 8px;
            margin: 0;
            font-size: 11px;
        }
        .top-controls {
            display: flex;
            gap: 8px;
            margin-bottom: 8px;
            align-items: center;
        }
        .action-button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 8px;
            border-radius: 2px;
            cursor: pointer;
            font-size: 8px;
            white-space: nowrap;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .action-button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .folder-selector {
            flex: 1;
            padding: 4px 8px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 2px;
            font-size: 11px;
        }
        .calendar-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }
        .calendar-header button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 4px 8px;
            cursor: pointer;
            border-radius: 2px;
        }
        .calendar-header button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .month-year {
            font-weight: bold;
            font-size: 12px;
        }
        .calendar-grid {
            display: grid;
            grid-template-columns: repeat(7, 1fr);
            gap: 1px;
        }
        .day-header {
            text-align: center;
            font-weight: bold;
            padding: 4px;
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
        }
        .day {
            text-align: center;
            padding: 4px 2px;
            cursor: pointer;
            border-radius: 2px;
            min-height: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
            position: relative;
        }
        .day-number {
            font-size: 11px;
        }
        .file-dots {
            position: absolute;
            bottom: 1px;
            justify-content: center;
            display: flex;
            gap: 1px;
        }
        .file-dot {
            width: 4px;
            height: 2px;
            border-radius: 2px;
            background: white;
            display: inline-block;
        }
        .day:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .day.current-month {
            color: var(--vscode-foreground);
        }
        .day.other-month {
            color: var(--vscode-descriptionForeground);
            opacity: 0.6;
        }
        .day.today {
            background: var(--vscode-focusBorder);
        }
        .day.today .day-number {
            color: var(--vscode-editor-background);
            font-weight: bold;
        }
        .day.has-file {
            background: var(--vscode-sideBarSectionHeader-foreground);
        }
        .day.has-file .day-number {
            color: var(--vscode-button-foreground);
            font-weight: bold;
        }
        .day.has-file:hover {
            background: var(--vscode-charts-blue);
        }
        .day.today.has-file {
            background: var(--vscode-focusBorder);
        }
        .day.today.has-file .day-number {
            color: var(--vscode-editor-background);
        }
    </style>
</head>
<body>
    ${calendarHtml}
    <script>
        const vscode = acquireVsCodeApi();
        let currentYear = ${year};
        let currentMonth = ${month};
        let selectedFolder = '${selectedFolder || 'Root'}';
        let filePathsMap = ${JSON.stringify(Object.fromEntries(filePathsMap))};
        
        function previousMonth() {
            if (currentMonth === 0) {
                currentMonth = 11;
                currentYear--;
            } else {
                currentMonth--;
            }
            vscode.postMessage({ 
                command: 'updateCalendar', 
                year: currentYear, 
                month: currentMonth, 
                folder: selectedFolder 
            });
        }
        
        function nextMonth() {
            if (currentMonth === 11) {
                currentMonth = 0;
                currentYear++;
            } else {
                currentMonth++;
            }
            vscode.postMessage({ 
                command: 'updateCalendar', 
                year: currentYear, 
                month: currentMonth, 
                folder: selectedFolder 
            });
        }
        
        function folderChanged(folder) {
            selectedFolder = folder;
            vscode.postMessage({ 
                command: 'updateCalendar', 
                year: currentYear, 
                month: currentMonth, 
                folder: selectedFolder 
            });
        }
        
        function updateFilePathsMap(newMap) {
            filePathsMap = newMap;
        }
        
        // Listen for messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'updateFilePathsMap') {
                updateFilePathsMap(message.filePathsMap);
            } else if (message.command === 'refreshCalendar') {
                // Refresh calendar maintaining current selected folder
                vscode.postMessage({ 
                    command: 'updateCalendar', 
                    year: currentYear, 
                    month: currentMonth, 
                    folder: selectedFolder 
                });
            } else if (message.command === 'selectFolder') {
                // Update dropdown selection
                const folderSelect = document.querySelector('.folder-selector');
                if (folderSelect && message.folder !== undefined) {
                    folderSelect.value = message.folder;
                    folderChanged(message.folder);
                }
            }
        });
        
        function goToRoot() {
            const folderSelect = document.querySelector('.folder-selector');
            if (folderSelect) {
                folderSelect.value = 'Root';
                folderChanged('Root');
            }
        }
        
        function createTodayRecap() {
            vscode.postMessage({ command: 'createTodayInRoot' });
        }
        
        function dayClicked(dateStr) {
            const existingFilePaths = filePathsMap[dateStr];
            vscode.postMessage({ 
                command: 'dayClicked', 
                date: dateStr, 
                folder: selectedFolder,
                existingFilePaths: existingFilePaths 
            });
        }
    </script>
</body>
</html>`;
      };

      // Initialize with current month
      const now = new Date();
      updateCalendar(now.getFullYear(), now.getMonth(), 'Root');

      webviewView.webview.onDidReceiveMessage(async message => {
        if (message.command === 'updateCalendar') {
          await updateCalendar(message.year, message.month, message.folder);
        } else if (message.command === 'createTodayInRoot') {
          vscode.commands.executeCommand('obsidianManager.createTodayInRoot');
        } else if (message.command === 'selectFolder') {
          // This message is sent from extension to webview to update dropdown selection
          return;
        } else if (message.command === 'dayClicked') {
          const cfg = vscode.workspace.getConfiguration('obsidianManager');
          const vaultPath = cfg.get<string>('vault', '');
          
          if (!vaultPath) {
            vscode.window.showWarningMessage('Vault path not configured');
            return;
          }
          
          const currentFolder = message.folder || 'Root';
          const existingFilePaths = message.existingFilePaths;
          
          // Create quick pick items - always start with "Create new file" option
          const quickPickItems: vscode.QuickPickItem[] = [];
          
          // Add "Create new file" as first option
          quickPickItems.push({
            label: 'Create new file in selected folder',
            description: `Create in ${currentFolder === 'Root' ? 'root folder' : currentFolder}`,
            detail: 'NEW_FILE'
          });
          
          // Add existing files if any
          if (existingFilePaths && existingFilePaths.length > 0) {
            // Add separator
            quickPickItems.push({
              label: '',
              description: '─────────────────────────',
              detail: '__SEPARATOR__',
              kind: vscode.QuickPickItemKind.Separator
            });
            
            // Add existing files
            existingFilePaths.forEach((filePath: string) => {
              quickPickItems.push({
                label: path.basename(filePath),
                description: path.relative(vaultPath, path.dirname(filePath)),
                detail: filePath
              });
            });
          }
          
          // Show quick pick dialog
          const selectedItem = await vscode.window.showQuickPick(quickPickItems, {
            placeHolder: `Options for ${message.date}...`,
            matchOnDescription: true
          });
          
          if (!selectedItem || selectedItem.detail === '__SEPARATOR__') {
            return; // User cancelled or selected separator
          }
          
          if (selectedItem.detail === 'NEW_FILE') {
            // Create new file - prompt for filename
            const folderPath = currentFolder === 'Root' ? vaultPath : path.join(vaultPath, currentFolder);
            const defaultFileName = message.date; // YYYY-MM-DD format
            
            // Show input box for filename (without .md extension)
            const fileName = await vscode.window.showInputBox({
              prompt: `Create new file in ${currentFolder === 'Root' ? 'root folder' : `folder "${currentFolder}"`}`,
              value: defaultFileName,
              placeHolder: 'Enter filename (without .md extension)',
              validateInput: (value) => {
                if (!value || value.trim() === '') {
                  return 'Filename cannot be empty';
                }
                // Check for invalid characters
                if (/[<>:"/\\|?*]/.test(value)) {
                  return 'Filename contains invalid characters';
                }
                return null;
              }
            });
            
            if (fileName) {
              try {
                // Ensure folder exists
                await fs.mkdir(folderPath, { recursive: true });
                
                const fullFileName = `${fileName.trim()}.md`;
                const filePath = path.join(folderPath, fullFileName);
                
                // Create file with basic daily note template
                const content = `# ${fileName.trim()}\n\n`;
                await fs.writeFile(filePath, content, 'utf8');
                
                // Open the newly created file
                const openFileMode = cfg.get<string>('openFileMode', 'preview');
                if (openFileMode === 'preview') {
                  await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(filePath));
                } else {
                  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                  await vscode.window.showTextDocument(document, { preview: false });
                }
                
                // Refresh the tree view to show the new file
                vscode.commands.executeCommand('obsidianManager.refreshView');
                
                // Update calendar to reflect the new file
                const dateObj = new Date(message.date);
                updateCalendar(dateObj.getFullYear(), dateObj.getMonth(), currentFolder);
                
              } catch (createError) {
                vscode.window.showErrorMessage(`Failed to create file: ${String(createError)}`);
              }
            }
            // If fileName is undefined (user pressed Esc), do nothing
          } else {
            // Open existing file
            const selectedFilePath = selectedItem.detail!;
            
            // Open the selected file
            const openFileMode = cfg.get<string>('openFileMode', 'preview');
            if (openFileMode === 'preview') {
              await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(selectedFilePath));
            } else {
              const document = await vscode.workspace.openTextDocument(vscode.Uri.file(selectedFilePath));
              await vscode.window.showTextDocument(document, { preview: false });
            }
          }
        }
      });
    }
  });
  context.subscriptions.push(calendarViewProvider);

  // Command to refresh calendar
  const refreshCalendarCmd = vscode.commands.registerCommand('obsidianManager.refreshCalendar', () => {
    if (currentCalendarView) {
      // Refresh calendar with current view state
      const now = new Date();
      currentCalendarView.webview.postMessage({
        command: 'refreshCalendar',
        year: now.getFullYear(),
        month: now.getMonth()
      });
    }
  });
  context.subscriptions.push(refreshCalendarCmd);





  // Command to expand (reveal) all folders in the view with progress and diagnostics
  const explodeCmd = vscode.commands.registerCommand('obsidianManager.explodeView', async () => {
    try {
  const cfg = vscode.workspace.getConfiguration('obsidianManager');
  const configuredVault = ((cfg.get<string>('vault') || '')).trim();
      if (!configuredVault) {
        // vault not configured — silently return
        return;
      }

      const rootChildren = await provider.getChildren(undefined);
      if (!rootChildren || rootChildren.length === 0) {
        // nothing to expand
        return;
      }

  // no debug output in production

      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Expanding Obsidian view', cancellable: true }, async (progress, token) => {
        const queue: any[] = [...rootChildren.filter(c => c.isDirectory)];
        let processed = 0;
        const totalEstimate = Math.max(queue.length, 1);

        while (queue.length && !token.isCancellationRequested) {
          const node = queue.shift();
          try {
            await treeView.reveal(node, { expand: true, focus: false, select: false });
          } catch (e) {
            // ignore reveal errors silently
          }
          processed++;
          progress.report({ message: `${processed} folders expanded`, increment: (1 / totalEstimate) * 100 });
          // slight delay to allow UI to update
          await new Promise(r => setTimeout(r, 30));
          // enqueue children of this node
          const children = await provider.getChildren(node);
          for (const c of children) {
            if (c.isDirectory) queue.push(c);
          }
        }

  // done
        // finished (silent)
      });
    } catch (err) {
      vscode.window.showErrorMessage(`Error expanding view: ${String(err)}`);
    }
  });
  context.subscriptions.push(explodeCmd);

  // Command to open the extension settings UI
  const openSettingsCmd = vscode.commands.registerCommand('obsidianManager.openSettings', async () => {
    // Open the Settings UI filtered to this extension's configuration
    await vscode.commands.executeCommand('workbench.action.openSettings', 'obsidianManager');
  });
  context.subscriptions.push(openSettingsCmd);

  // Command to toggle view mode between 'folders' and 'list'
  const toggleViewCmd = vscode.commands.registerCommand('obsidianManager.toggleViewMode', async () => {
    const cfg = vscode.workspace.getConfiguration('obsidianManager');
    const current = (cfg.get<string>('viewMode') || 'folders');
    const next = current === 'folders' ? 'list' : 'folders';
  await cfg.update('viewMode', next, vscode.ConfigurationTarget.Global);
  provider.refresh();
  });
  context.subscriptions.push(toggleViewCmd);

  // Toggle expand/collapse all folders in the view (runtime state only)
  let expandAllState = false;
  const toggleExpandAllCmd = vscode.commands.registerCommand('obsidianManager.toggleExpandAll', async () => {
    expandAllState = !expandAllState;
    try {
      const rootChildren = await provider.getChildren(undefined);
      if (!rootChildren || rootChildren.length === 0) return;

      if (!expandAllState) {
        // Collapse all: focus the tree and use the built-in list.collapseAll command which reliably collapses the focused tree view
        try {
          // reveal first root node and focus the view
          await treeView.reveal(rootChildren[0], { expand: false, focus: true, select: false });
        } catch (e) {
          // ignore reveal focus errors
        }
        // run collapse all for the focused list/tree
        try { await vscode.commands.executeCommand('list.collapseAll'); } catch (e) {}
        return;
      }

      // Expand all: collect directories and reveal shallow -> deep
      const allDirs: Array<{ node: any; depth: number }> = [];
      const queue: Array<{ node: any; depth: number }> = [];
      for (const c of rootChildren) if (c.isDirectory) queue.push({ node: c, depth: 0 });

      while (queue.length) {
        const { node, depth } = queue.shift()!;
        allDirs.push({ node, depth });
        try {
          const children = await provider.getChildren(node);
          for (const ch of children) {
            if (ch.isDirectory) queue.push({ node: ch, depth: depth + 1 });
          }
        } catch (e) {
          // ignore child read errors
        }
      }

      allDirs.sort((a, b) => a.depth - b.depth);
      for (const item of allDirs) {
        try {
          await treeView.reveal(item.node, { expand: true, focus: false, select: false });
          await new Promise(r => setTimeout(r, 8));
        } catch (e) {
          // ignore per-node reveal errors
        }
      }
    } catch (err) {
      // ignore errors
    }
  });
  context.subscriptions.push(toggleExpandAllCmd);

  const refreshCmd = vscode.commands.registerCommand('obsidianManager.refreshView', async () => {
    // Force a fresh preload/scan of the vault (in case files changed externally) and refresh the view.
    try {
      await provider.refreshAll();
    } catch (e) {
      // fallback to a quick refresh if refreshAll fails for some reason
      try { provider.refresh(); } catch (ee) {}
    }
  });
  context.subscriptions.push(refreshCmd);

  // Command to link to another document in the vault
  const linkDocumentCmd = vscode.commands.registerCommand('obsidianManager.linkDocument', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No active editor found.');
      return;
    }

    // Check if current file is markdown
    if (!editor.document.fileName.endsWith('.md')) {
      vscode.window.showErrorMessage('Link document command is only available for Markdown files.');
      return;
    }

    const cfg = vscode.workspace.getConfiguration('obsidianManager');
    const configuredVault = ((cfg.get<string>('vault') || '')).trim();
    if (!configuredVault) {
      vscode.window.showErrorMessage('Please configure the obsidianManager.vault setting first.');
      return;
    }

    try {
      // Get all markdown files from the provider's cache
      await provider.ensurePreloaded();
      const allFiles = await getAllMarkdownFiles(provider, configuredVault);
      
      if (allFiles.length === 0) {
        vscode.window.showWarningMessage('No markdown files found in the vault.');
        return;
      }

      // Create quick pick items
      const quickPickItems: vscode.QuickPickItem[] = allFiles.map(file => {
        const relativePath = path.relative(configuredVault, file.resourceUri.fsPath);
        const fileName = path.basename(file.resourceUri.fsPath, '.md');
        
        return {
          label: fileName,
          description: relativePath,
          detail: file.resourceUri.fsPath
        };
      });

      // Sort by file name
      quickPickItems.sort((a, b) => a.label.localeCompare(b.label));

      // Show quick pick dialog
      const selectedItem = await vscode.window.showQuickPick(quickPickItems, {
        placeHolder: 'Select a document to link to...',
        matchOnDescription: true,
        matchOnDetail: true
      });

      if (!selectedItem) {
        return; // User cancelled
      }

      // Get the selected file path
      const selectedFilePath = selectedItem.detail!;
      const currentFilePath = editor.document.fileName;
      
      // Check if there's selected text to use as link text
      const selection = editor.selection;
      const selectedText = editor.document.getText(selection);
      
      // Generate the appropriate link format
      let linkText: string;
      if (selectedText && !selection.isEmpty) {
        // Use selected text as custom link text
        const targetWithoutExt = path.basename(selectedFilePath, '.md');
        linkText = `[[${targetWithoutExt}|${selectedText}]]`;
      } else {
        linkText = generateObsidianLink(selectedFilePath, currentFilePath, configuredVault);
      }
      
      // Insert or replace the link
      await editor.edit(editBuilder => {
        if (selectedText && !selection.isEmpty) {
          editBuilder.replace(selection, linkText);
        } else {
          editBuilder.insert(selection.active, linkText);
        }
      });

    } catch (err) {
      vscode.window.showErrorMessage(`Error linking document: ${String(err)}`);
    }
  });
  context.subscriptions.push(linkDocumentCmd);

  // Command to include clipboard content in a code block
  const includeClipboardCodeBlockCmd = vscode.commands.registerCommand('obsidianManager.includeClipboardCodeBlock', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No active editor found.');
      return;
    }

    // Check if current file is markdown
    if (!editor.document.fileName.endsWith('.md')) {
      vscode.window.showErrorMessage('Include clipboard in code block command is only available for Markdown files.');
      return;
    }

    try {
      // Read clipboard content
      const clipboardContent = await vscode.env.clipboard.readText();
      
      if (!clipboardContent) {
        vscode.window.showWarningMessage('Clipboard is empty.');
        return;
      }

      // Format as code block
      const codeBlock = `\`\`\`\n${clipboardContent}\n\`\`\``;
      
      // Insert at current cursor position
      const selection = editor.selection;
      await editor.edit(editBuilder => {
        editBuilder.insert(selection.active, codeBlock);
      });

      // Move cursor to after the code block
      const newPosition = selection.active.translate(codeBlock.split('\n').length, 0);
      editor.selection = new vscode.Selection(newPosition, newPosition);

    } catch (err) {
      vscode.window.showErrorMessage(`Error including clipboard content: ${String(err)}`);
    }
  });
  context.subscriptions.push(includeClipboardCodeBlockCmd);

  // Command to put selected text or create empty codeblock
  const putInsideCodeblockCmd = vscode.commands.registerCommand('obsidianManager.putInsideCodeblock', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No active editor found.');
      return;
    }

    // Check if current file is markdown
    if (!editor.document.fileName.endsWith('.md')) {
      vscode.window.showErrorMessage('Put inside codeblock command is only available for Markdown files.');
      return;
    }

    try {
      const selection = editor.selection;
      const selectedText = editor.document.getText(selection);
      
      await editor.edit(editBuilder => {
        if (selectedText && !selection.isEmpty) {
          // Wrap selected text in codeblock
          const codeBlock = `\`\`\`\n${selectedText}\n\`\`\``;
          editBuilder.replace(selection, codeBlock);
        } else {
          // Create empty codeblock and position cursor inside
          const codeBlock = '\`\`\`\n\n\`\`\`';
          editBuilder.insert(selection.active, codeBlock);
        }
      });

      // Position cursor appropriately
      if (!selectedText || selection.isEmpty) {
        // Move cursor to inside the empty codeblock (after first newline)
        const currentPosition = selection.active;
        const newPosition = new vscode.Position(
          currentPosition.line + 1, // Move to next line (inside codeblock)
          0 // Start of line
        );
        editor.selection = new vscode.Selection(newPosition, newPosition);
      }

    } catch (err) {
      vscode.window.showErrorMessage(`Error creating codeblock: ${String(err)}`);
    }
  });
  context.subscriptions.push(putInsideCodeblockCmd);

  // Command to duplicate a file
  const duplicateCmd = vscode.commands.registerCommand('obsidianManager.duplicateItem', async (...args: any[]) => {
    const first = args && args[0];
    let node = undefined as any;
    if (first instanceof vscode.Uri) node = { resourceUri: first, isDirectory: false };
    else if (first && typeof first === 'object') node = first;
    
    if (!node || node.isDirectory) { 
      vscode.window.showErrorMessage('Duplicate command is only available for files'); 
      return; 
    }

    const originalPath = node.resourceUri.fsPath;
    const originalDir = path.dirname(originalPath);
    const originalExt = path.extname(originalPath);
    const originalBaseName = path.basename(originalPath, originalExt);
    
    // Default new name with (copy) suffix
    const defaultNewName = `${originalBaseName} (copy)${originalExt}`;
    
    // Show input dialog with default name
    const newName = await vscode.window.showInputBox({ 
      prompt: 'Enter name for duplicated file', 
      value: defaultNewName,
      validateInput: (input) => {
        if (!input || input.trim() === '') {
          return 'File name cannot be empty';
        }
        // Check if file already exists
        const targetPath = path.join(originalDir, input);
        try {
          require('fs').accessSync(targetPath);
          return 'A file with this name already exists';
        } catch (e) {
          return null; // File doesn't exist, name is valid
        }
      }
    });
    
    if (!newName) return; // User cancelled
    
    const targetPath = path.join(originalDir, newName);
    
    try {
      // Copy the file
      await fs.copyFile(originalPath, targetPath);
      
      // Open the duplicated file in editor
      const cfg = vscode.workspace.getConfiguration('obsidianManager');
      const openFileMode = cfg.get<string>('openFileMode', 'preview');
      if (openFileMode === 'preview') {
        await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(targetPath));
      } else {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(targetPath));
        await vscode.window.showTextDocument(document, { preview: false });
      }
      
      // Refresh the tree view
      try { await provider.refreshAll(); } catch (e) { provider.refresh(); }
      
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to duplicate file: ${String(err)}`);
    }
  });
  context.subscriptions.push(duplicateCmd);

  // Command to create today's note
  const createTodayCmd = vscode.commands.registerCommand('obsidianManager.createTodayNote', async (...args: any[]) => {
    // Determine folder Uri from args or active selection
    let folderUri: vscode.Uri | undefined;
    const first = args && args[0];
    if (first instanceof vscode.Uri) folderUri = first;
    else if (first && typeof first === 'object') {
      if ((first as any).resourceUri instanceof vscode.Uri) folderUri = (first as any).resourceUri;
      else if ((first as any).uri instanceof vscode.Uri) folderUri = (first as any).uri;
    }

    if (!folderUri && vscode.window.activeTextEditor) {
      folderUri = vscode.window.activeTextEditor.document.uri;
    }

    if (!folderUri) {
      vscode.window.showErrorMessage('No folder selected to create today\'s note.');
      return;
    }

    const cfg = vscode.workspace.getConfiguration('obsidianManager');
    const configuredVault = ((cfg.get<string>('vault') || '')).trim();
    const folderFs = folderUri.fsPath;

    // Generate today's date in YYYY-MM-DD format
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    const todayString = `${year}-${month}-${day}`;
    
    const fileName = `${todayString}.md`;
    const targetPath = path.join(folderFs, fileName);
    
    // Update calendar dropdown to show the selected folder
    if (currentCalendarView && configuredVault) {
      const relativePath = path.relative(configuredVault, folderFs);
      const folderToSelect = relativePath === '' || relativePath === '.' ? 'Root' : path.basename(folderFs);
      
      currentCalendarView.webview.postMessage({
        command: 'selectFolder',
        folder: folderToSelect
      });
    }
    
    // No file operations - calendar will handle file opening
  });
  context.subscriptions.push(createTodayCmd);

  // Command to create a new file in vault root
  const createFileInRootCmd = vscode.commands.registerCommand('obsidianManager.createFileInRoot', async () => {
    const cfg = vscode.workspace.getConfiguration('obsidianManager');
    const configuredVault = ((cfg.get<string>('vault') || '')).trim();
    if (!configuredVault) {
      vscode.window.showErrorMessage('Please configure the `obsidianManager.vault` setting with the vault path first.');
      return;
    }

    // Prompt for filename
    const name = await vscode.window.showInputBox({ 
      prompt: 'New note name (without extension)', 
      placeHolder: 'my-note' 
    });
    if (!name) return;
    
    const fileName = name.endsWith('.md') ? name : `${name}.md`;
    const target = path.join(configuredVault, fileName);
    
    try {
      // Check if file already exists
      try {
        await fs.access(target);
        vscode.window.showErrorMessage(`A file with the name "${fileName}" already exists in the vault root.`);
        return;
      } catch (e) {
        // File doesn't exist, proceed to create it
      }
      
      await fs.writeFile(target, '');
      
      // Open the new file in editor
      const openFileMode = cfg.get<string>('openFileMode', 'preview');
      if (openFileMode === 'preview') {
        await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(target));
      } else {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
        await vscode.window.showTextDocument(document, { preview: false });
      }
      
      // Refresh provider so view updates
      try { await provider.refreshAll(); } catch (e) { provider.refresh(); }
      
    } catch (err) {
      vscode.window.showErrorMessage(`Unable to create file: ${String(err)}`);
    }
  });
  context.subscriptions.push(createFileInRootCmd);

  // Command to create today's aggregated note in vault root
  const createTodayInRootCmd = vscode.commands.registerCommand('obsidianManager.createTodayInRoot', async () => {
    const cfg = vscode.workspace.getConfiguration('obsidianManager');
    const configuredVault = ((cfg.get<string>('vault') || '')).trim();
    if (!configuredVault) {
      vscode.window.showErrorMessage('Please configure the `obsidianManager.vault` setting with the vault path first.');
      return;
    }

    // Generate today's date in YYYY-MM-DD format
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    const todayString = `${year}-${month}-${day}`;
    
    const fileName = `${todayString}-Recap.md`;
    const targetPath = path.join(configuredVault, fileName);
    
    try {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Aggregating today's notes (${todayString})...`,
        cancellable: false
      }, async (progress) => {
        
        // Function to recursively search for today's files
        const findTodayFiles = async (dirPath: string): Promise<string[]> => {
          const foundFiles: string[] = [];
          try {
            const entries = await fs.readdir(dirPath, { withFileTypes: true });
            
            for (const entry of entries) {
              const fullPath = path.join(dirPath, entry.name);
              
              if (entry.isDirectory()) {
                // Recursively search in subdirectories
                const subFiles = await findTodayFiles(fullPath);
                foundFiles.push(...subFiles);
              } else if (entry.isFile() && entry.name.endsWith('.md')) {
                // Check if filename contains today's date
                if (entry.name.includes(todayString)) {
                  foundFiles.push(fullPath);
                }
              }
            }
          } catch (err) {
            // Ignore directories we can't read
          }
          return foundFiles;
        };

        progress.report({ message: 'Searching for today\'s files...', increment: 20 });
        
        // Find all files containing today's date
        const todayFiles = await findTodayFiles(configuredVault);
        
        // Filter out the target file if it already exists
        const filteredFiles = todayFiles.filter(file => file !== targetPath);
        
        progress.report({ message: `Found ${filteredFiles.length} files to aggregate...`, increment: 40 });
        
        // Build content by creating links organized by folder
        let aggregatedContent = `# ${todayString}\n\n`;
        
        if (filteredFiles.length === 0) {
          aggregatedContent += `*No other files found for ${todayString}*\n\n`;
        } else {
          aggregatedContent += `*Found ${filteredFiles.length} files for ${todayString}*\n\n`;
          
          // Group files by folder
          const filesByFolder: { [folder: string]: string[] } = {};
          
          for (const file of filteredFiles) {
            const relativePath = path.relative(configuredVault, file);
            const folderPath = path.dirname(relativePath);
            const folderName = folderPath === '.' ? 'Root' : folderPath;
            
            if (!filesByFolder[folderName]) {
              filesByFolder[folderName] = [];
            }
            filesByFolder[folderName].push(file);
          }
          
          // Sort folders alphabetically, but put 'Root' first
          const sortedFolders = Object.keys(filesByFolder).sort((a, b) => {
            if (a === 'Root') return -1;
            if (b === 'Root') return 1;
            return a.localeCompare(b);
          });
          
          for (const folderName of sortedFolders) {
            progress.report({ 
              message: `Creating links for ${folderName}...`, 
              increment: 40 + (sortedFolders.indexOf(folderName) / sortedFolders.length) * 30 
            });
            
            aggregatedContent += `## ${folderName}\n\n`;
            
            for (const file of filesByFolder[folderName]) {
              const fileName = path.basename(file, '.md');
              const relativePath = path.relative(configuredVault, file);
              
              // Create markdown-style link with full path
              aggregatedContent += `- [${fileName}](${relativePath})\n`;
            }
            
            aggregatedContent += `\n`;
          }
        }
        
        progress.report({ message: 'Creating aggregated file...', increment: 90 });
        
        // Write the aggregated content
        await fs.writeFile(targetPath, aggregatedContent);
        
        progress.report({ message: 'Opening file...', increment: 100 });
        
        // Open the new file in editor
        const openFileMode = cfg.get<string>('openFileMode', 'preview');
        if (openFileMode === 'preview') {
          await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(targetPath));
        } else {
          const document = await vscode.workspace.openTextDocument(vscode.Uri.file(targetPath));
          await vscode.window.showTextDocument(document, { preview: false });
        }
        
        // Refresh provider so view updates
        try { await provider.refreshAll(); } catch (e) { provider.refresh(); }
      });
      
    } catch (err) {
      vscode.window.showErrorMessage(`Unable to create today's aggregated note: ${String(err)}`);
    }
  });
  context.subscriptions.push(createTodayInRootCmd);

  // Command to create today's file in a specific folder with customizable name
  const createTodayFileInFolderCmd = vscode.commands.registerCommand('obsidianManager.createTodayFileInFolder', async (...args: any[]) => {
    // Determine folder Uri from args or active selection
    let folderUri: vscode.Uri | undefined;
    const first = args && args[0];
    if (first instanceof vscode.Uri) folderUri = first;
    else if (first && typeof first === 'object') {
      if ((first as any).resourceUri instanceof vscode.Uri) folderUri = (first as any).resourceUri;
      else if ((first as any).uri instanceof vscode.Uri) folderUri = (first as any).uri;
    }

    if (!folderUri && vscode.window.activeTextEditor) {
      folderUri = vscode.window.activeTextEditor.document.uri;
    }

    if (!folderUri) {
      vscode.window.showErrorMessage('No folder selected to create today\'s file.');
      return;
    }

    const cfg = vscode.workspace.getConfiguration('obsidianManager');
    const configuredVault = ((cfg.get<string>('vault') || '')).trim();
    const folderFs = folderUri.fsPath;

    // Generate today's date in YYYY-MM-DD format
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    const todayString = `${year}-${month}-${day}`;
    
    // Show input dialog with default today's date as filename
    const fileName = await vscode.window.showInputBox({
      prompt: 'Enter filename for today\'s file (without .md extension)',
      value: todayString,
      placeHolder: 'YYYY-MM-DD',
      validateInput: (input) => {
        if (!input || input.trim() === '') {
          return 'Filename cannot be empty';
        }
        // Check for invalid characters
        if (/[<>:"/\\|?*]/.test(input)) {
          return 'Filename contains invalid characters';
        }
        return null;
      }
    });
    
    if (!fileName) {
      // User pressed Esc or cancelled - don't create file
      return;
    }
    
    const fullFileName = `${fileName.trim()}.md`;
    const targetPath = path.join(folderFs, fullFileName);
    
    try {
      // Check if file already exists
      try {
        await fs.access(targetPath);
        const choice = await vscode.window.showQuickPick(['Overwrite', 'Cancel'], { 
          placeHolder: `File "${fullFileName}" already exists. What would you like to do?` 
        });
        if (!choice || choice === 'Cancel') return;
        // If overwrite, continue with file creation
      } catch (e) {
        // File doesn't exist, proceed to create it
      }
      
      // Create file with basic content
      const content = `# ${fileName.trim()}\n\n`;
      await fs.writeFile(targetPath, content);
      
      // Open the new file in editor
      const openFileMode = cfg.get<string>('openFileMode', 'preview');
      if (openFileMode === 'preview') {
        await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(targetPath));
      } else {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(targetPath));
        await vscode.window.showTextDocument(document, { preview: false });
      }
      
      // Refresh provider so view updates
      try { await provider.refreshAll(); } catch (e) { provider.refresh(); }
      
    } catch (err) {
      vscode.window.showErrorMessage(`Unable to create today's file: ${String(err)}`);
    }
  });
  context.subscriptions.push(createTodayFileInFolderCmd);

  // Register context menu aliases (without numbers) that call the original commands
  const contextAliases = [
    { alias: 'obsidianManager.openFileFromView.context', original: 'obsidianManager.openFileFromView' },
    { alias: 'obsidianManager.createFileInFolder.context', original: 'obsidianManager.createFileInFolder' },
    { alias: 'obsidianManager.createTodayNote.context', original: 'obsidianManager.createTodayNote' },
    { alias: 'obsidianManager.createFolder.context', original: 'obsidianManager.createFolder' },
    { alias: 'obsidianManager.renameItem.context', original: 'obsidianManager.renameItem' },
    { alias: 'obsidianManager.deleteItem.context', original: 'obsidianManager.deleteItem' },
    { alias: 'obsidianManager.duplicateItem.context', original: 'obsidianManager.duplicateItem' }
  ];

  for (const { alias, original } of contextAliases) {
    const aliasCmd = vscode.commands.registerCommand(alias, async (...args: any[]) => {
      await vscode.commands.executeCommand(original, ...args);
    });
    context.subscriptions.push(aliasCmd);
  }
}

export function deactivate() {}
