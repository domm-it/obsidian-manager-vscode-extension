import * as vscode from 'vscode';
import { ObsidianTreeProvider } from './obsidianTree';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as os from 'os';

// Drag & Drop controller state (last dragged items). We'll record last dragged sources in memory
let _lastDragged: any[] = [];

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
            await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(destPath));
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

  context.subscriptions.push(disposableA, disposableB);

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

    // Prompt for filename
    const name = await vscode.window.showInputBox({ prompt: 'New note name (without extension)', placeHolder: 'my-note' });
    if (!name) return;
    const fileName = name.endsWith('.md') ? name : `${name}.md`;
    const target = path.join(folderFs, fileName);
    try {
      await fs.writeFile(target, '');
      // Open the new file in editor
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target));
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
          await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(newPath));
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

  const dndController = new ObsidianDragAndDropController(async () => { try { await provider.refreshAll(); } catch (e) { provider.refresh(); } });
  let treeView = vscode.window.createTreeView('obsidianFiles', { treeDataProvider: provider, dragAndDropController: dndController });
  context.subscriptions.push(treeView);

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
}

export function deactivate() {}
