import * as vscode from 'vscode';
import { ObsidianTreeProvider } from './obsidianTree';
import { TaskTableProvider } from './taskTableProvider';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as os from 'os';

// Drag & Drop controller state (last dragged items). We'll record last dragged sources in memory
let _lastDragged: any[] = [];

// Helper function to safely show markdown preview by preloading the document first
async function showMarkdownPreviewSafe(uri: vscode.Uri): Promise<void> {
  try {
    // Preload document to ensure it's in VS Code's document cache
    const document = await vscode.workspace.openTextDocument(uri);
    
    // Wait for document content to be available with exponential backoff
    let attempts = 0;
    const maxAttempts = 3;
    while (attempts < maxAttempts) {
      if (document.getText().length > 0 || attempts === maxAttempts - 1) {
        break;
      }
      // Short delays: 25ms, 50ms, 100ms
      const delay = 25 * Math.pow(2, attempts);
      await new Promise(resolve => setTimeout(resolve, delay));
      attempts++;
    }
    
    // Short delay to ensure document is fully processed
    await new Promise(resolve => setTimeout(resolve, 100));
    
    try {
      // Try to show markdown preview
      await vscode.commands.executeCommand('markdown.showPreview', uri);
      
      // Additional delay to let the preview render
      await new Promise(resolve => setTimeout(resolve, 200));
      
    } catch (previewError) {
      console.warn('Direct preview failed, trying alternative approach:', previewError);
      
      // Alternative approach: open in editor first, then show preview
      await vscode.window.showTextDocument(document, { 
        preview: true,
        preserveFocus: true
      });
      
      // Wait a bit more and try preview again
      setTimeout(async () => {
        try {
          await vscode.commands.executeCommand('markdown.showPreview', uri);
        } catch (e) {
          // If this also fails, the document will remain in editor mode
          console.warn('Alternative preview approach also failed:', e);
        }
      }, 500);
    }
    
  } catch (error) {
    // Final fallback to regular file opening if everything fails
    console.error('All preview approaches failed:', error);
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: true });
    } catch (fallbackError) {
      vscode.window.showErrorMessage(`Unable to open file: ${String(fallbackError)}`);
    }
  }
}

// Helper function to create a new file with proper content and opening mode
async function createAndOpenNewFile(filePath: string, baseFileName: string): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('obsidianManager');
  const addTitle = cfg.get<boolean>('addTitleToNewFiles', true);
  const newFileOpenMode = cfg.get<string>('newFileOpenMode', 'edit');
  
  // Determine content based on settings
  let content = '';
  if (addTitle) {
    // Remove .md extension and use as title
    const title = baseFileName.replace(/\.md$/, '');
    content = `# ${title}\n\n`;
  }
  
  // Create the file
  await fs.writeFile(filePath, content);
  
  // Open the file based on newFileOpenMode setting
  if (newFileOpenMode === 'edit') {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(document, { preview: false });
  } else {
    await showMarkdownPreviewSafe(vscode.Uri.file(filePath));
  }
}

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
  readonly dropMimeTypes = ['application/vnd.code.tree.obsidianFiles', 'text/uri-list'];
  constructor(private refreshFn: () => Promise<void>) {}
  // Called when dragging items
  handleDrag(source: any[], data: vscode.DataTransfer, token: vscode.CancellationToken): void | Thenable<void> {
    _lastDragged = source;
  }
  // Called when dropping onto a target (folder or file)
  async handleDrop(target: any | undefined, data: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
    // Check for external files first (from system file manager)
    const uriList = data.get('text/uri-list');
    if (uriList) {
      await this.handleExternalFileDrop(target, uriList, token);
      return;
    }

    // Handle internal drag and drop (within the tree view)
    const sources = _lastDragged || [];
    _lastDragged = [];
    if (!sources || sources.length === 0) return;
    
    // Determine destination folder
    let destFolder: string | undefined;
    if (target && target.isDirectory) {
      destFolder = target.resourceUri.fsPath;
    } else if (target && target.resourceUri) {
      destFolder = path.dirname(target.resourceUri.fsPath);
    } else if (!target) {
      // Dropped onto root/empty space - move to vault root
      const cfg = vscode.workspace.getConfiguration('obsidianManager');
      const configuredVault = ((cfg.get<string>('vault') || '')).trim();
      if (!configuredVault) {
        vscode.window.showErrorMessage('Please configure the obsidianManager.vault setting first.');
        return;
      }
      destFolder = configuredVault;
    }
    
    // If no destination folder determined, abort
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
              await showMarkdownPreviewSafe(vscode.Uri.file(destPath));
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

  // Handle external file drops from system file manager
  private async handleExternalFileDrop(target: any | undefined, uriList: vscode.DataTransferItem, token: vscode.CancellationToken): Promise<void> {
    const uriListText = await uriList.asString();
    if (!uriListText) return;

    // Parse URIs from the uri-list format
    const uris = uriListText.split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .map(uri => {
        try {
          // Handle both file:// URLs and local paths
          if (uri.startsWith('file://')) {
            return vscode.Uri.parse(uri);
          } else {
            return vscode.Uri.file(uri);
          }
        } catch (e) {
          return null;
        }
      })
      .filter(uri => uri !== null) as vscode.Uri[];

    if (uris.length === 0) return;

    // Determine destination folder
    let destFolder: string | undefined;
    if (target && target.isDirectory) {
      destFolder = target.resourceUri.fsPath;
    } else if (target && target.resourceUri) {
      destFolder = path.dirname(target.resourceUri.fsPath);
    } else if (!target) {
      // Dropped onto root/empty space - move to vault root
      const cfg = vscode.workspace.getConfiguration('obsidianManager');
      const configuredVault = ((cfg.get<string>('vault') || '')).trim();
      if (!configuredVault) {
        vscode.window.showErrorMessage('Please configure the obsidianManager.vault setting first.');
        return;
      }
      destFolder = configuredVault;
    }

    if (!destFolder) return;

    // Process each external file
    for (const sourceUri of uris) {
      if (token.isCancellationRequested) break;

      try {
        const sourcePath = sourceUri.fsPath;
        const fileName = path.basename(sourcePath);
        let destPath = path.join(destFolder, fileName);

        // Check if source file exists and get file stats
        let sourceStats;
        try {
          sourceStats = await fs.lstat(sourcePath);
        } catch (e) {
          vscode.window.showWarningMessage(`Source file not found: ${fileName}`);
          continue;
        }

        // Skip special files that can't be copied (sockets, pipes, etc.)
        if (!sourceStats.isFile() && !sourceStats.isDirectory()) {
          vscode.window.showWarningMessage(`Cannot copy "${fileName}": unsupported file type (socket, pipe, or device file)`);
          continue;
        }

        // Handle filename conflicts
        let destExists = false;
        try { 
          await fs.access(destPath); 
          destExists = true; 
        } catch (e) { 
          destExists = false; 
        }

        if (destExists) {
          const choice = await vscode.window.showQuickPick(['Overwrite', 'Rename', 'Cancel'], { 
            placeHolder: `File "${fileName}" already exists. What would you like to do?` 
          });
          
          if (!choice || choice === 'Cancel') continue;
          
          if (choice === 'Rename') {
            // Find a new name
            const ext = path.extname(fileName);
            const nameOnly = path.basename(fileName, ext);
            let idx = 1;
            
            while (true) {
              const candidate = `${nameOnly}-${idx}${ext}`;
              const candidatePath = path.join(destFolder, candidate);
              try { 
                await fs.access(candidatePath); 
                idx++; 
                continue; 
              } catch (e) { 
                destPath = candidatePath; 
                break; 
              }
            }
          }
          // For 'Overwrite', we proceed with the original destPath
        }

        // Copy the file or directory to the destination
        if (sourceStats.isDirectory()) {
          await this.copyDirectory(sourcePath, destPath);
        } else {
          await fs.copyFile(sourcePath, destPath);
        }

        // Delete the original file/directory after successful copy (move operation)
        try {
          if (sourceStats.isDirectory()) {
            await fs.rm(sourcePath, { recursive: true, force: true });
          } else {
            await fs.unlink(sourcePath);
          }
        } catch (deleteErr) {
          // If deletion fails, warn user but don't fail the whole operation
          vscode.window.showWarningMessage(`File copied successfully but failed to delete original "${fileName}": ${String(deleteErr)}`);
        }
        
      } catch (err) {
        const fileName = path.basename(sourceUri.fsPath);
        vscode.window.showErrorMessage(`Failed to copy "${fileName}": ${String(err)}`);
      }
    }

    // Refresh the tree view
    try { 
      await this.refreshFn(); 
    } catch (e) {}
  }

  // Recursively copy a directory and its contents
  private async copyDirectory(sourcePath: string, destPath: string): Promise<void> {
    // Create destination directory
    await fs.mkdir(destPath, { recursive: true });

    // Read source directory contents
    const entries = await fs.readdir(sourcePath, { withFileTypes: true });

    // Copy each entry
    for (const entry of entries) {
      const sourceEntryPath = path.join(sourcePath, entry.name);
      const destEntryPath = path.join(destPath, entry.name);

      if (entry.isDirectory()) {
        // Recursively copy subdirectory
        await this.copyDirectory(sourceEntryPath, destEntryPath);
      } else if (entry.isFile()) {
        // Copy file
        await fs.copyFile(sourceEntryPath, destEntryPath);
      }
      // Skip special files (sockets, pipes, etc.)
    }
  }
}

// Wiki-link document link provider for Cmd+Click functionality in editor
class WikiLinkProvider implements vscode.DocumentLinkProvider {
  provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
    const links: vscode.DocumentLink[] = [];
    const text = document.getText();
    
    // Get vault configuration
    const cfg = vscode.workspace.getConfiguration('obsidianManager');
    const configuredVault = ((cfg.get<string>('vault') || '')).trim();
    if (!configuredVault) {
      return links; // No vault configured, no links
    }
    
    // Regex to find wiki-links [[text]]
    const wikiLinkRegex = /\[\[([^\]]+)\]\]/g;
    let match;
    
    while ((match = wikiLinkRegex.exec(text)) !== null) {
      const linkText = match[1];
      const startPos = document.positionAt(match.index);
      const endPos = document.positionAt(match.index + match[0].length);
      
      // Extract target (handle piped links)
      let target = linkText;
      if (linkText.includes('|')) {
        target = linkText.split('|')[0].trim();
      }
      
      // Clean target
      let cleanTarget = target.trim();
      if (cleanTarget.endsWith('.md')) {
        cleanTarget = cleanTarget.slice(0, -3);
      }
      
      // Resolve absolute path
      const fullPath = path.join(configuredVault, `${cleanTarget}.md`);
      
      // Create URI for the file directly (not via command)
      const fileUri = vscode.Uri.file(fullPath);
      
      const documentLink = new vscode.DocumentLink(
        new vscode.Range(startPos, endPos),
        fileUri
      );
      
      documentLink.tooltip = `Click to open "${target}"`;
      links.push(documentLink);
    }
    
    return links;
  }
}

// Hover provider to show "Open link" tooltip
class WikiHoverProvider implements vscode.HoverProvider {
  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const line = document.lineAt(position.line);
    const text = line.text;
    
    // Find wiki-links on the current line
    const wikiLinkRegex = /\[\[([^\]]+)\]\]/g;
    let match;
    
    while ((match = wikiLinkRegex.exec(text)) !== null) {
      const startCol = match.index;
      const endCol = match.index + match[0].length;
      
      // Check if cursor is within this wiki-link
      if (position.character >= startCol && position.character <= endCol) {
        const linkText = match[1];
        let target = linkText;
        
        // Handle piped links
        if (linkText.includes('|')) {
          const parts = linkText.split('|');
          target = parts[0].trim();
        }
        
        const range = new vscode.Range(
          new vscode.Position(position.line, startCol),
          new vscode.Position(position.line, endCol)
        );
        
        const markdown = new vscode.MarkdownString();
        markdown.isTrusted = true;
        markdown.supportHtml = true;
        markdown.appendMarkdown(`**Wiki-link**: \`${target}\`\n\n`);
        markdown.appendMarkdown(`*Click to open | Cmd+Click for new tab*`);
        
        return new vscode.Hover(markdown, range);
      }
    }
    
    return undefined;
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
      await showMarkdownPreviewSafe(uri);
    } else {
      // Open in edit mode
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: false });
    }
  });

  // Command to open file in edit mode in beside column
  const openFileBesideCmd = vscode.commands.registerCommand('obsidianManager.openFileBeside', async (...args: any[]) => {
    const first = args && args[0];
    let uri: vscode.Uri | undefined;
    
    if (first instanceof vscode.Uri) uri = first;
    else if (first && typeof first === 'object') {
      if ((first as any).resourceUri instanceof vscode.Uri) uri = (first as any).resourceUri;
      else if ((first as any).uri instanceof vscode.Uri) uri = (first as any).uri;
    }

    if (!uri && vscode.window.activeTextEditor) {
      uri = vscode.window.activeTextEditor.document.uri;
    }

    if (!uri) {
      vscode.window.showErrorMessage('No file available to open beside.');
      return;
    }

    try {
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { 
        preview: false,
        viewColumn: vscode.ViewColumn.Beside
      });
    } catch (error) {
      vscode.window.showErrorMessage(`Unable to open file: ${String(error)}`);
    }
  });

  context.subscriptions.push(disposableA, disposableB, openFileWithModeCmd, openFileBesideCmd);

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
      await createAndOpenNewFile(target, fileName);
      // Refresh provider so view updates
      try { await provider.refreshAll(); } catch (e) { provider.refresh(); }
    } catch (err) {
      vscode.window.showErrorMessage(`Unable to create file: ${String(err)}`);
    }
  });
  context.subscriptions.push(createFileCmd);

  // Command to create a new folder at vault root
  const createFolderCmd = vscode.commands.registerCommand('obsidianManager.createFolder', async (...args: any[]) => {
    const cfg = vscode.workspace.getConfiguration('obsidianManager');
    const configuredVault = ((cfg.get<string>('vault') || '')).trim();
    if (!configuredVault) {
      vscode.window.showErrorMessage('Please configure the `obsidianManager.vault` setting with the vault path first.');
      return;
    }

    // If invoked with a folder node (from context menu), create under that folder; otherwise use vault root
    let parentFs: string | undefined;
    const first = args && args[0];
    
    // Only check for arguments if they exist - when called from view title, args will be empty
    if (first instanceof vscode.Uri) {
      parentFs = first.fsPath;
    } else if (first && typeof first === 'object') {
      if ((first as any).resourceUri instanceof vscode.Uri) parentFs = (first as any).resourceUri.fsPath;
      else if ((first as any).uri instanceof vscode.Uri) parentFs = (first as any).uri.fsPath;
    }

    // If parentFs is provided and it's a file, use its directory
    if (parentFs) {
      try {
        const stat = await fs.lstat(parentFs);
        if (!stat.isDirectory()) parentFs = path.dirname(parentFs);
      } catch (e) {
        // ignore and fallback to vault root
        parentFs = undefined;
      }
    }

    // Always use vault root if no valid parent folder is found
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
            await showMarkdownPreviewSafe(vscode.Uri.file(newPath));
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
      
      const updateCalendar = async (year: number, month: number) => {
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
        

        
        // Get files from entire vault to check which days have files (always show all events)
        const filesInFolder = new Set<string>();
        const filePathsMap = new Map<string, string[]>(); // Map date to array of full file paths
        if (vaultPath) {
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
          
          // Always scan entire vault (root folder)
          await scanFolderRecursively(vaultPath);
        }
        
        let calendarHtml = `
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
                month: currentMonth 
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
                month: currentMonth 
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
                // Refresh calendar
                vscode.postMessage({ 
                    command: 'updateCalendar', 
                    year: currentYear, 
                    month: currentMonth 
                });
            }
        });
        
        function dayClicked(dateStr) {
            const existingFilePaths = filePathsMap[dateStr];
            vscode.postMessage({ 
                command: 'dayClicked', 
                date: dateStr, 
                existingFilePaths: existingFilePaths 
            });
        }
    </script>
</body>
</html>`;
      };

      // Initialize with current month
      const now = new Date();
      updateCalendar(now.getFullYear(), now.getMonth());

      webviewView.webview.onDidReceiveMessage(async message => {
        if (message.command === 'updateCalendar') {
          await updateCalendar(message.year, message.month);


        } else if (message.command === 'dayClicked') {
          const cfg = vscode.workspace.getConfiguration('obsidianManager');
          const vaultPath = cfg.get<string>('vault', '');
          
          if (!vaultPath) {
            vscode.window.showWarningMessage('Vault path not configured');
            return;
          }
          
          const existingFilePaths = message.existingFilePaths;
          
          // Create quick pick items
          const quickPickItems: vscode.QuickPickItem[] = [];
          
          // Add "Open Tasks Table" as first option
          quickPickItems.push({
            label: '$(table) Open Tasks Table for this date',
            description: 'Show all tasks for ' + message.date,
            detail: 'OPEN_TASK_TABLE'
          });
          
          // Add "Create new file" as second option
          quickPickItems.push({
            label: 'Create new file in root vault',
            description: 'Create in root vault folder',
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
          
          if (selectedItem.detail === 'OPEN_TASK_TABLE') {
            // Open Task Table filtered by this date
            await vscode.commands.executeCommand('obsidianManager.showTaskTable', message.date);
            return;
          }
          
          if (selectedItem.detail === 'NEW_FILE') {
            // Create new file - prompt for filename
            const folderPath = vaultPath; // Always use root vault
            const defaultFileName = message.date; // YYYY-MM-DD format
            
            // Show input box for filename (without .md extension)
            const fileName = await vscode.window.showInputBox({
              prompt: 'Create new file in root vault folder',
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
                
                // Create and open the file
                await createAndOpenNewFile(filePath, fullFileName);
                
                // Refresh the tree view to show the new file
                vscode.commands.executeCommand('obsidianManager.refreshView');
                
                // Update calendar to reflect the new file
                const dateObj = new Date(message.date);
                updateCalendar(dateObj.getFullYear(), dateObj.getMonth());
                
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
              await showMarkdownPreviewSafe(vscode.Uri.file(selectedFilePath));
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

  // Command to duplicate current active file from editor
  const duplicateFromEditorCmd = vscode.commands.registerCommand('obsidianManager.duplicateFromEditor', async () => {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
      vscode.window.showInformationMessage('No active file to duplicate');
      return;
    }

    const document = activeEditor.document;
    if (!document.fileName.endsWith('.md')) {
      vscode.window.showInformationMessage('Duplicate command is only available for markdown files');
      return;
    }

    const originalPath = document.fileName;
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
      // Save current document if it has unsaved changes
      if (document.isDirty) {
        await document.save();
      }
      
      // Copy the file
      await fs.copyFile(originalPath, targetPath);
      
      // Open the duplicated file in editor
      const cfg = vscode.workspace.getConfiguration('obsidianManager');
      const openFileMode = cfg.get<string>('openFileMode', 'preview');
      if (openFileMode === 'preview') {
        await showMarkdownPreviewSafe(vscode.Uri.file(targetPath));
      } else {
        const newDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(targetPath));
        await vscode.window.showTextDocument(newDocument, { preview: false });
      }
      
      // Refresh the tree view
      try { await provider.refreshAll(); } catch (e) { provider.refresh(); }
      
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to duplicate file: ${String(err)}`);
    }
  });
  context.subscriptions.push(duplicateFromEditorCmd);

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

  // Command to paste clipboard as a markdown link or an obsidian file link snippet
  const pasteAsLinkCmd = vscode.commands.registerCommand('obsidianManager.pasteAsLink', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No active editor found.');
      return;
    }

    // Only for markdown files
    if (!editor.document.fileName.endsWith('.md')) {
      vscode.window.showErrorMessage('Paste as link command is only available for Markdown files.');
      return;
    }

    try {
      const clipboardContent = (await vscode.env.clipboard.readText()) || '';
      if (!clipboardContent) {
        vscode.window.showWarningMessage('Clipboard is empty.');
        return;
      }

      const selection = editor.selection;
      const trimmed = clipboardContent.trim();

      if (/^https?:\/\//i.test(trimmed)) {
        const cfg = vscode.workspace.getConfiguration('obsidianManager');
        const mode = cfg.get<string>('linkPreviewMode', 'full');

        // Remove query/hash part for display purposes
        const withoutQuery = trimmed.split(/[?#]/)[0];
        let displayText = withoutQuery;
        if (mode === 'lastSegment') {
          // Use only the last path segment (filename-like)
          const trimmedPath = withoutQuery.replace(/\/+$/g, '');
          const parts = trimmedPath.split('/').filter(Boolean);
          displayText = parts.length ? parts[parts.length - 1] : withoutQuery;
        }

        // Escape any snippet dollar signs to avoid accidental variable expansion
        displayText = displayText.replace(/\$/g, '\\$');

        const snippet = new vscode.SnippetString(`[${displayText}](${trimmed})`);
        await editor.insertSnippet(snippet, selection);
      } else {
        // Insert provided snippet that references the clipboard and builds a vscode://file/ link
        const snippetText = "[${1:${CLIPBOARD/(.*[\\/])?([^\\/]+)$/$2/}}](vscode://file/${2:$CLIPBOARD})$0";
        const snippet = new vscode.SnippetString(snippetText);
        await editor.insertSnippet(snippet, selection);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Error pasting as link: ${String(err)}`);
    }
  });
  context.subscriptions.push(pasteAsLinkCmd);

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

  // Command to copy selected text to another file
  const copySelectionToFileCmd = vscode.commands.registerCommand('obsidianManager.copySelectionToFile', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No active editor found.');
      return;
    }

    // Check if current file is markdown
    if (!editor.document.fileName.endsWith('.md')) {
      vscode.window.showErrorMessage('Copy selection to file command is only available for Markdown files.');
      return;
    }

    // Check if there's selected text
    const selection = editor.selection;
    const selectedText = editor.document.getText(selection);
    
    if (!selectedText || selection.isEmpty) {
      vscode.window.showErrorMessage('Please select some text first.');
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

      // Create quick pick items - first option is to create a new file
      const quickPickItems: vscode.QuickPickItem[] = [];

      // Add "Create new file" as first option
      quickPickItems.push({
        label: '$(file-add) Create new file',
        description: 'Create a new markdown file with the selected content',
        detail: '__CREATE_NEW__'
      });

      // Add separator if there are existing files
      if (allFiles.length > 0) {
        quickPickItems.push({
          label: '',
          description: '─────────────────────────',
          detail: '__SEPARATOR__',
          kind: vscode.QuickPickItemKind.Separator
        });

        // Add existing files
        allFiles.forEach(file => {
          const relativePath = path.relative(configuredVault, file.resourceUri.fsPath);
          const fileName = path.basename(file.resourceUri.fsPath, '.md');
          
          quickPickItems.push({
            label: fileName,
            description: relativePath,
            detail: file.resourceUri.fsPath
          });
        });

        // Sort existing files by name (skip the first items which are "Create new" and separator)
        const filesToSort = quickPickItems.slice(2);
        filesToSort.sort((a, b) => a.label.localeCompare(b.label));
        quickPickItems.splice(2, filesToSort.length, ...filesToSort);
      }

      // Show quick pick dialog
      const selectedItem = await vscode.window.showQuickPick(quickPickItems, {
        placeHolder: 'Select destination file or create a new one...',
        matchOnDescription: true,
        matchOnDetail: true
      });

      if (!selectedItem || selectedItem.detail === '__SEPARATOR__') {
        return; // User cancelled or selected separator
      }

      if (selectedItem.detail === '__CREATE_NEW__') {
        // Create new file workflow
        // Generate today's date as default filename
        const today = new Date();
        const year = today.getFullYear();
        const month = String(today.getMonth() + 1).padStart(2, '0');
        const day = String(today.getDate()).padStart(2, '0');
        const todayString = `${year}-${month}-${day}`;

        // Show input dialog for new filename
        const newFileName = await vscode.window.showInputBox({
          prompt: 'Enter filename for the new file (without .md extension)',
          value: todayString,
          placeHolder: 'Enter filename',
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

        if (!newFileName) {
          return; // User cancelled
        }

        const fullFileName = `${newFileName.trim()}.md`;
        const newFilePath = path.join(configuredVault, fullFileName);

        try {
          // Check if file already exists
          try {
            await fs.access(newFilePath);
            const choice = await vscode.window.showQuickPick(['Overwrite', 'Cancel'], { 
              placeHolder: `File "${fullFileName}" already exists. What would you like to do?` 
            });
            if (!choice || choice === 'Cancel') return;
          } catch (e) {
            // File doesn't exist, continue
          }

          // Create file content with title and selected text
          const addTitle = cfg.get<boolean>('addTitleToNewFiles', true);
          let content = '';
          if (addTitle) {
            const title = newFileName.trim();
            content = `# ${title}\n\n`;
          }
          
          // Add context header with source file name as markdown link with full relative path
          const sourceFileName = path.basename(editor.document.fileName);
          const sourceFileNameWithoutExt = path.basename(editor.document.fileName, '.md');
          const sourceRelativePath = path.relative(configuredVault, editor.document.fileName);
          content += `---\n\n## Context pasted from [${sourceFileNameWithoutExt}](${sourceRelativePath})\n\n`;
          content += selectedText;

          // Create the file
          await fs.writeFile(newFilePath, content);

          // Open the new file
          const newFileOpenMode = cfg.get<string>('newFileOpenMode', 'edit');
          if (newFileOpenMode === 'edit') {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(newFilePath));
            await vscode.window.showTextDocument(document, { preview: false });
          } else {
            await showMarkdownPreviewSafe(vscode.Uri.file(newFilePath));
          }

          // Refresh provider
          try { await provider.refreshAll(); } catch (e) { provider.refresh(); }

        } catch (err) {
          vscode.window.showErrorMessage(`Failed to create new file: ${String(err)}`);
        }

      } else {
        // Append to existing file
        const targetFilePath = selectedItem.detail!;

        try {
          // Read existing content
          const existingContent = await fs.readFile(targetFilePath, 'utf8');

          // Add context header with source file name as markdown link with full relative path
          const sourceFileName = path.basename(editor.document.fileName);
          const sourceFileNameWithoutExt = path.basename(editor.document.fileName, '.md');
          const sourceRelativePath = path.relative(configuredVault, editor.document.fileName);
          const contextHeader = `---\n\n## Context pasted from [${sourceFileNameWithoutExt}](${sourceRelativePath})\n\n`;
          
          // Append selected text with separator and context header
          const newContent = existingContent + '\n\n' + contextHeader + selectedText;

          // Write back to file
          await fs.writeFile(targetFilePath, newContent);

          // Open the target file
          const openFileMode = cfg.get<string>('openFileMode', 'preview');
          if (openFileMode === 'preview') {
            await showMarkdownPreviewSafe(vscode.Uri.file(targetFilePath));
          } else {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(targetFilePath));
            await vscode.window.showTextDocument(document, { preview: false });
          }

        } catch (err) {
          vscode.window.showErrorMessage(`Failed to append content to file: ${String(err)}`);
        }
      }

    } catch (err) {
      vscode.window.showErrorMessage(`Error copying selection to file: ${String(err)}`);
    }
  });
  context.subscriptions.push(copySelectionToFileCmd);

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
        await showMarkdownPreviewSafe(vscode.Uri.file(targetPath));
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



  // Command to create a new file in vault root
  const createFileInRootCmd = vscode.commands.registerCommand('obsidianManager.createFileInRoot', async () => {
    const cfg = vscode.workspace.getConfiguration('obsidianManager');
    const configuredVault = ((cfg.get<string>('vault') || '')).trim();
    if (!configuredVault) {
      vscode.window.showErrorMessage('Please configure the `obsidianManager.vault` setting with the vault path first.');
      return;
    }

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
      
      await createAndOpenNewFile(target, fileName);
      
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
          await showMarkdownPreviewSafe(vscode.Uri.file(targetPath));
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
      
      // Create and open the file
      await createAndOpenNewFile(targetPath, fullFileName);
      
      // Refresh provider so view updates
      try { await provider.refreshAll(); } catch (e) { provider.refresh(); }
      
    } catch (err) {
      vscode.window.showErrorMessage(`Unable to create today's file: ${String(err)}`);
    }
  });
  context.subscriptions.push(createTodayFileInFolderCmd);

  // Command to reveal file/folder in system file manager
  const revealInFinderCmd = vscode.commands.registerCommand('obsidianManager.revealInFinder', async (...args: any[]) => {
    const first = args && args[0];
    let node = undefined as any;
    if (first instanceof vscode.Uri) node = { resourceUri: first, isDirectory: false };
    else if (first && typeof first === 'object') node = first;
    
    if (!node || !node.resourceUri) {
      vscode.window.showErrorMessage('No file or folder selected to reveal.');
      return;
    }

    try {
      const itemPath = node.resourceUri.fsPath;
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(itemPath));
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to reveal item: ${String(err)}`);
    }
  });
  context.subscriptions.push(revealInFinderCmd);

  // Command to open file in edit mode
  const openInEditModeCmd = vscode.commands.registerCommand('obsidianManager.openInEditMode', async (...args: any[]) => {
    const first = args && args[0];
    let uri: vscode.Uri | undefined;
    
    if (first instanceof vscode.Uri) uri = first;
    else if (first && typeof first === 'object') {
      if ((first as any).resourceUri instanceof vscode.Uri) uri = (first as any).resourceUri;
      else if ((first as any).uri instanceof vscode.Uri) uri = (first as any).uri;
    }

    if (!uri && vscode.window.activeTextEditor) {
      uri = vscode.window.activeTextEditor.document.uri;
    }

    if (!uri) {
      vscode.window.showErrorMessage('No file available to open in edit mode.');
      return;
    }

    try {
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: false });
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to open file in edit mode: ${String(err)}`);
    }
  });
  context.subscriptions.push(openInEditModeCmd);

  // Command to open file in preview mode
  const openInPreviewModeCmd = vscode.commands.registerCommand('obsidianManager.openInPreviewMode', async (...args: any[]) => {
    const first = args && args[0];
    let uri: vscode.Uri | undefined;
    
    if (first instanceof vscode.Uri) uri = first;
    else if (first && typeof first === 'object') {
      if ((first as any).resourceUri instanceof vscode.Uri) uri = (first as any).resourceUri;
      else if ((first as any).uri instanceof vscode.Uri) uri = (first as any).uri;
    }

    if (!uri && vscode.window.activeTextEditor) {
      uri = vscode.window.activeTextEditor.document.uri;
    }

    if (!uri) {
      vscode.window.showErrorMessage('No file available to open in preview mode.');
      return;
    }

    try {
      if (uri.fsPath.toLowerCase().endsWith('.md')) {
        await showMarkdownPreviewSafe(uri);
      } else {
        // For non-markdown files, open in read-only mode
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, { preview: true });
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to open file in preview mode: ${String(err)}`);
    }
  });
  context.subscriptions.push(openInPreviewModeCmd);

  // Context menu commands for edit and preview mode
  const openInEditModeContextCmd = vscode.commands.registerCommand('obsidianManager.openInEditMode.context', async (...args: any[]) => {
    return vscode.commands.executeCommand('obsidianManager.openInEditMode', ...args);
  });
  
  const openInPreviewModeContextCmd = vscode.commands.registerCommand('obsidianManager.openInPreviewMode.context', async (...args: any[]) => {
    return vscode.commands.executeCommand('obsidianManager.openInPreviewMode', ...args);
  });
  
  const openFileBesideContextCmd = vscode.commands.registerCommand('obsidianManager.openFileBeside.context', async (...args: any[]) => {
    return vscode.commands.executeCommand('obsidianManager.openFileBeside', ...args);
  });
  
  context.subscriptions.push(openInEditModeContextCmd);
  context.subscriptions.push(openInPreviewModeContextCmd);
  context.subscriptions.push(openFileBesideContextCmd);

  // Wiki-link command (no dialogs, only opens existing files)
  const openWikiLinkDirectCmd = vscode.commands.registerCommand('obsidianManager.openWikiLinkDirect', async (target: string, openInNewTab: boolean = false) => {
    if (!target) return;

    const cfg = vscode.workspace.getConfiguration('obsidianManager');
    const configuredVault = ((cfg.get<string>('vault') || '')).trim();
    if (!configuredVault) return;

    try {
      // Clean up the target - same logic as main command
      let cleanTarget = target.trim();
      if (cleanTarget.endsWith('.md')) {
        cleanTarget = cleanTarget.slice(0, -3);
      }
      if (cleanTarget.startsWith('[[') && cleanTarget.endsWith(']]')) {
        cleanTarget = cleanTarget.slice(2, -2);
      }
      if (cleanTarget.includes('|')) {
        cleanTarget = cleanTarget.split('|')[0].trim();
      }
      
      // Build full path and check if file exists directly
      const fullPath = path.join(configuredVault, `${cleanTarget}.md`);
      const targetUri = vscode.Uri.file(fullPath);
      
      try {
        // Check if file exists
        const stat = await vscode.workspace.fs.stat(targetUri);
        if (stat.type === vscode.FileType.File) {
          // File exists - open it
          const openFileMode = cfg.get<string>('openFileMode', 'preview');
          if (openFileMode === 'preview') {
            await showMarkdownPreviewSafe(targetUri);
          } else {
            const document = await vscode.workspace.openTextDocument(targetUri);
            await vscode.window.showTextDocument(document, { 
              preview: false,
              viewColumn: openInNewTab ? vscode.ViewColumn.Beside : undefined
            });
          }
        }
      } catch {
        // File doesn't exist - do nothing
      }
    } catch (err) {
      // Silent error handling
    }
  });
  
  context.subscriptions.push(openWikiLinkDirectCmd);

  // Register wiki-link providers for markdown editor
  const wikiLinkProvider = new WikiLinkProvider();
  const wikiHoverProvider = new WikiHoverProvider();
  
  context.subscriptions.push(
    vscode.languages.registerDocumentLinkProvider(
      { scheme: 'file', language: 'markdown' },
      wikiLinkProvider
    ),
    vscode.languages.registerHoverProvider(
      { scheme: 'file', language: 'markdown' },
      wikiHoverProvider
    )
  );

  // Register context menu aliases (without numbers) that call the original commands
  const contextAliases = [
    { alias: 'obsidianManager.openFileFromView.context', original: 'obsidianManager.openFileFromView' },
    { alias: 'obsidianManager.createFileInFolder.context', original: 'obsidianManager.createFileInFolder' },
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

  // Listen for file save events to refresh the vault tree and calendar
  const saveListener = vscode.workspace.onDidSaveTextDocument(async (document) => {
    const cfg = vscode.workspace.getConfiguration('obsidianManager');
    const vault = cfg.get<string>('vault') || '';
    
    if (vault && document.uri.scheme === 'file') {
      const documentPath = document.uri.fsPath;
      const vaultPath = vault.replace(/^~/, require('os').homedir());
      
      // Check if the saved file is within the configured vault
      if (documentPath.startsWith(vaultPath)) {
        // Refresh the vault tree
        try {
          await provider.refreshAll();
        } catch (e) {
          provider.refresh();
        }
        
        // Refresh calendar if it's a markdown file and might be a daily note
        if (documentPath.toLowerCase().endsWith('.md')) {
          try {
            await vscode.commands.executeCommand('obsidianManager.refreshCalendar');
          } catch (e) {
            // Calendar command might not be available, ignore error
          }
        }
      }
    }
  });
  
  context.subscriptions.push(saveListener);

  // Task Table Provider
  const taskTableProvider = new TaskTableProvider(context);
  const showTaskTableCmd = vscode.commands.registerCommand('obsidianManager.showTaskTable', async (filterDate?: string) => {
    await taskTableProvider.show(filterDate);
  });
  context.subscriptions.push(showTaskTableCmd);
}

export function deactivate() {}
