import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';

interface Task {
  id: string; // unique identifier: filePath:lineNumber
  status: boolean; // true = done, false = todo
  date: string; // YYYY-MM-DD extracted from filename
  project: string; // root folder name
  task: string; // task text
  filePath: string; // full path to the markdown file
  lineNumber: number; // line number in the file (0-indexed)
  originalLine: string; // original line content
}

export class TaskTableProvider {
  private panel: vscode.WebviewPanel | undefined;
  private tasks: Task[] = [];
  private vaultPath: string = '';

  constructor(private context: vscode.ExtensionContext) {}

  public async show(filterDate?: string, filterProject?: string, filterHashtag?: string) {
    // Get vault path from configuration
    const cfg = vscode.workspace.getConfiguration('obsidianManager');
    this.vaultPath = (cfg.get<string>('vault') || '').trim();

    if (!this.vaultPath) {
      vscode.window.showErrorMessage('Please configure the obsidianManager.vault setting first.');
      return;
    }

    // Create or show the webview panel
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
    } else {
      this.panel = vscode.window.createWebviewPanel(
        'obsidianTaskTable',
        'Obsidian Tasks Table',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        }
      );

      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });

      // Handle messages from the webview
      this.panel.webview.onDidReceiveMessage(
        async (message) => {
          switch (message.command) {
            case 'toggleStatus':
              if (message.taskId) {
                await this.toggleTaskStatus(message.taskId);
              }
              break;
            case 'updateTask':
              if (message.taskId) {
                await this.updateTaskText(message.taskId, message.newText);
              }
              break;
            case 'openFile':
              if (message.filePath && message.lineNumber !== undefined) {
                await this.openFileAtLine(message.filePath, message.lineNumber);
              }
              break;
            case 'addTaskAfter':
              if (message.taskId) {
                await this.addTaskAfter(message.taskId);
              }
              break;

            case 'deleteTask':
              if (message.taskId) {
                const answer = await vscode.window.showWarningMessage(
                  'Are you sure you want to delete this task?',
                  { modal: true },
                  'Delete'
                );
                if (answer === 'Delete') {
                  await this.deleteTask(message.taskId);
                }
              }
              break;
            
            case 'editTags':
              if (message.taskId) {
                await this.editTaskTags(message.taskId);
              }
              break;
            
            case 'removeTag':
              if (message.taskId && message.tag) {
                await this.removeTagFromTask(message.taskId, message.tag);
              }
              break;
          }
        },
        undefined,
        this.context.subscriptions
      );
    }

    // Load tasks and update webview
    await this.loadTasks();
    this.updateWebview();
    
    // Apply initial filters if provided
    if (filterDate || filterProject || filterHashtag) {
      this.sendTasksUpdate(undefined, filterDate, filterProject, filterHashtag);
    }
  }

  private async loadTasks() {
    this.tasks = [];
    
    try {
      const files = await this.findDatePrefixedMarkdownFiles(this.vaultPath);
      
      for (const file of files) {
        const tasks = await this.extractTasksFromFile(file);
        this.tasks.push(...tasks);
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Error loading tasks: ${error}`);
    }
  }

  private async findDatePrefixedMarkdownFiles(dir: string, rootDir: string = ''): Promise<string[]> {
    if (!rootDir) {
      rootDir = dir;
    }

    const files: string[] = [];
    
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          // Recursively search subdirectories
          const subFiles = await this.findDatePrefixedMarkdownFiles(fullPath, rootDir);
          files.push(...subFiles);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          // Check if filename starts with YYYY-MM-DD pattern
          const datePattern = /^\d{4}-\d{2}-\d{2}/;
          if (datePattern.test(entry.name)) {
            files.push(fullPath);
          }
        }
      }
    } catch (error) {
      console.error(`Error reading directory ${dir}:`, error);
    }
    
    return files;
  }

  private async extractTasksFromFile(filePath: string): Promise<Task[]> {
    const tasks: Task[] = [];
    
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      
      // Extract date from filename (YYYY-MM-DD)
      const filename = path.basename(filePath);
      const dateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})/);
      const date = dateMatch ? dateMatch[1] : '';
      
      // Extract project name (root folder)
      const relativePath = path.relative(this.vaultPath, filePath);
      const parts = relativePath.split(path.sep);
      const project = parts.length > 1 ? parts[0] : 'root';
      
      // Parse tasks
      lines.forEach((line, index) => {
        const todoMatch = line.match(/^[\s-]*- \[ \]\s*(.+)$/);
        const doneMatch = line.match(/^[\s-]*- \[x\]\s*(.+)$/i);
        
        if (todoMatch || doneMatch) {
          const taskText = todoMatch ? todoMatch[1] : doneMatch![1];
          const status = !!doneMatch;
          const id = `${filePath}:${index}`;
          
          tasks.push({
            id,
            status,
            date,
            project,
            task: taskText.trim(),
            filePath,
            lineNumber: index,
            originalLine: line,
          });
        }
      });
    } catch (error) {
      console.error(`Error extracting tasks from ${filePath}:`, error);
    }
    
    return tasks;
  }

  private async toggleTaskStatus(taskId: string) {
    const task = this.tasks.find(t => t.id === taskId);
    if (!task) {
      return;
    }

    try {
      const content = await fs.readFile(task.filePath, 'utf-8');
      const lines = content.split('\n');
      
      const line = lines[task.lineNumber];
      let newLine: string;
      
      if (task.status) {
        // Currently done, change to todo
        newLine = line.replace(/- \[x\]/i, '- [ ]');
      } else {
        // Currently todo, change to done
        newLine = line.replace(/- \[ \]/, '- [x]');
      }
      
      lines[task.lineNumber] = newLine;
      await fs.writeFile(task.filePath, lines.join('\n'), 'utf-8');
      
      // Reload tasks and send updated data without full refresh
      await this.loadTasks();
      this.sendTasksUpdate();
      
    } catch (error) {
      vscode.window.showErrorMessage(`Error updating task: ${error}`);
    }
  }

  private async updateTaskText(taskId: string, newText: string) {
    const task = this.tasks.find(t => t.id === taskId);
    if (!task) {
      return;
    }

    try {
      const content = await fs.readFile(task.filePath, 'utf-8');
      const lines = content.split('\n');
      
      const line = lines[task.lineNumber];
      const checkbox = task.status ? '- [x]' : '- [ ]';
      const indent = line.match(/^(\s*)/)?.[1] || '';
      
      lines[task.lineNumber] = `${indent}${checkbox} ${newText}`;
      await fs.writeFile(task.filePath, lines.join('\n'), 'utf-8');
      
      // Reload tasks and send updated data without full refresh
      await this.loadTasks();
      this.sendTasksUpdate();
      
      // Refresh hashtags tree (task text might contain hashtags)
      console.log('TaskTableProvider: Calling refreshHashtags after updateTaskText');
      vscode.commands.executeCommand('obsidianManager.refreshHashtags');
      
    } catch (error) {
      vscode.window.showErrorMessage(`Error updating task text: ${error}`);
    }
  }

  private async openFileAtLine(filePath: string, lineNumber: number) {
    try {
      const cfg = vscode.workspace.getConfiguration('obsidianManager');
      const openMode = cfg.get<string>('taskTableOpenFileMode', 'edit');
      
      const uri = vscode.Uri.file(filePath);
      
      if (openMode === 'preview') {
        // Open in markdown preview mode
        await this.showMarkdownPreviewSafe(uri);
      } else {
        // Open in edit mode
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc, { preview: false });
        
        // Move cursor to the specified line
        const position = new vscode.Position(lineNumber, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Error opening file: ${error}`);
    }
  }
  
  private async showMarkdownPreviewSafe(uri: vscode.Uri): Promise<void> {
    try {
      // Preload document to ensure it's in VS Code's document cache
      const document = await vscode.workspace.openTextDocument(uri);
      
      // Wait for document content to be available
      let attempts = 0;
      const maxAttempts = 3;
      while (attempts < maxAttempts) {
        if (document.getText().length > 0 || attempts === maxAttempts - 1) {
          break;
        }
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
        // If preview fails, fall back to opening in edit mode
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: false });
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Error opening file: ${error}`);
    }
  }

  private async deleteTask(taskId: string) {
    const task = this.tasks.find(t => t.id === taskId);
    if (!task) {
      return;
    }

    try {
      const content = await fs.readFile(task.filePath, 'utf-8');
      const lines = content.split('\n');
      
      // Remove the line completely
      lines.splice(task.lineNumber, 1);
      
      await fs.writeFile(task.filePath, lines.join('\n'), 'utf-8');
      
      // Reload tasks and send updated data without full refresh
      await this.loadTasks();
      this.sendTasksUpdate();
      
      // Refresh hashtags tree (deleted task might have had hashtags)
      console.log('TaskTableProvider: Calling refreshHashtags after deleteTask');
      vscode.commands.executeCommand('obsidianManager.refreshHashtags');
      
    } catch (error) {
      vscode.window.showErrorMessage(`Error deleting task: ${error}`);
    }
  }

  private async addTaskAfter(taskId: string) {
    const task = this.tasks.find(t => t.id === taskId);
    if (!task) {
      return;
    }

    try {
      const content = await fs.readFile(task.filePath, 'utf-8');
      const lines = content.split('\n');
      
      // Insert new empty task line after the current task
      lines.splice(task.lineNumber + 1, 0, '- [ ] ');
      
      await fs.writeFile(task.filePath, lines.join('\n'), 'utf-8');
      
      // Reload tasks and send updated data without full refresh
      await this.loadTasks();
      
      // Generate new task ID (filePath:lineNumber)
      const newTaskId = `${task.filePath}:${task.lineNumber + 1}`;
      this.sendTasksUpdate(newTaskId);
      
    } catch (error) {
      vscode.window.showErrorMessage(`Error adding task: ${error}`);
    }
  }

  private async editTaskTags(taskId: string) {
    const task = this.tasks.find(t => t.id === taskId);
    if (!task) {
      return;
    }

    try {
      // Extract current hashtags from task
      const currentTags = this.extractHashtags(task.task);
      
      // Get all unique hashtags from all tasks
      const allHashtags = new Set<string>();
      for (const t of this.tasks) {
        const tags = this.extractHashtags(t.task);
        tags.forEach(tag => allHashtags.add(tag));
      }
      
      // Convert to array and sort
      const availableTags = Array.from(allHashtags).sort();
      
      // Create QuickPick items
      interface TagQuickPickItem extends vscode.QuickPickItem {
        tag: string;
      }
      
      // Create a custom QuickPick for better control
      const quickPick = vscode.window.createQuickPick<TagQuickPickItem>();
      quickPick.title = 'Edit Task Hashtags';
      quickPick.placeholder = 'Type to search or create new hashtag (without #)';
      quickPick.canSelectMany = true;
      quickPick.matchOnDescription = true;
      quickPick.matchOnDetail = true;
      
      // Initial items
      const createItems = (filter: string = ''): TagQuickPickItem[] => {
        const items: TagQuickPickItem[] = availableTags.map(tag => ({
          label: tag,
          tag: tag,
          picked: currentTags.includes(tag)
        }));
        
        // If user is typing and it doesn't match any existing tag, add create option
        const filterNormalized = filter.trim().replace(/^#/, '');
        if (filterNormalized && !availableTags.some(tag => tag === `#${filterNormalized}`)) {
          items.unshift({
            label: `#${filterNormalized}`,
            tag: `#${filterNormalized}`,
            description: '$(add) Create new',
            picked: false
          });
        }
        
        return items;
      };
      
      quickPick.items = createItems();
      
      // Pre-select currently active tags
      quickPick.selectedItems = quickPick.items.filter(item => currentTags.includes(item.tag));
      
      // Update items as user types
      quickPick.onDidChangeValue(value => {
        quickPick.items = createItems(value);
        // Re-apply selection after items change
        const selectedTags = quickPick.selectedItems.map(item => item.tag);
        quickPick.selectedItems = quickPick.items.filter(item => selectedTags.includes(item.tag));
      });
      
      // Wait for user to accept or cancel
      const finalTags = await new Promise<string[] | undefined>((resolve) => {
        quickPick.onDidAccept(() => {
          let selected = quickPick.selectedItems.map(item => item.tag);
          
          // If user has typed something and pressed Enter, auto-add it if it's new
          const currentValue = quickPick.value.trim().replace(/^#/, '');
          if (currentValue) {
            const newTag = `#${currentValue}`;
            // Check if this tag doesn't exist in available tags and isn't already selected
            if (!availableTags.includes(newTag) && !selected.includes(newTag)) {
              selected.push(newTag);
            }
          }
          
          quickPick.hide();
          resolve(selected);
        });
        
        quickPick.onDidHide(() => {
          resolve(undefined);
          quickPick.dispose();
        });
        
        quickPick.show();
      });
      
      if (!finalTags) {
        return; // User cancelled
      }
      
      // Update task text by removing old hashtags and adding new ones
      let newTaskText = task.task;
      
      // Remove all existing hashtags
      currentTags.forEach(tag => {
        newTaskText = newTaskText.replace(new RegExp(tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '').trim();
      });
      
      // Add selected hashtags at the end
      if (finalTags.length > 0) {
        newTaskText = `${newTaskText} ${finalTags.join(' ')}`.trim();
      }
      
      // Update the task
      const content = await fs.readFile(task.filePath, 'utf-8');
      const lines = content.split('\n');
      const line = lines[task.lineNumber];
      const checkbox = task.status ? '- [x]' : '- [ ]';
      const indent = line.match(/^(\s*)/)?.[1] || '';
      
      lines[task.lineNumber] = `${indent}${checkbox} ${newTaskText}`;
      await fs.writeFile(task.filePath, lines.join('\n'), 'utf-8');
      
      // Reload tasks and update view
      await this.loadTasks();
      this.sendTasksUpdate();
      
      // Refresh hashtags tree
      console.log('TaskTableProvider: Calling refreshHashtags after editTaskTags');
      vscode.commands.executeCommand('obsidianManager.refreshHashtags');
      
    } catch (error) {
      vscode.window.showErrorMessage(`Error editing tags: ${error}`);
    }
  }
  
  private extractHashtags(text: string): string[] {
    const hashtagRegex = /#[a-zA-Z0-9_]+/g;
    const matches = text.match(hashtagRegex);
    return matches || [];
  }
  
  private async removeTagFromTask(taskId: string, tagToRemove: string) {
    const task = this.tasks.find(t => t.id === taskId);
    if (!task) {
      return;
    }

    try {
      // Remove the specific tag from task text
      let newTaskText = task.task;
      newTaskText = newTaskText.replace(new RegExp(tagToRemove.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*', 'g'), '').trim();
      
      // Update the task in file
      const content = await fs.readFile(task.filePath, 'utf-8');
      const lines = content.split('\n');
      const line = lines[task.lineNumber];
      const checkbox = task.status ? '- [x]' : '- [ ]';
      const indent = line.match(/^(\s*)/)?.[1] || '';
      
      lines[task.lineNumber] = `${indent}${checkbox} ${newTaskText}`;
      await fs.writeFile(task.filePath, lines.join('\n'), 'utf-8');
      
      // Reload tasks and update view
      await this.loadTasks();
      this.sendTasksUpdate();
      
      // Refresh hashtags tree
      console.log('TaskTableProvider: Calling refreshHashtags after removeTagFromTask');
      vscode.commands.executeCommand('obsidianManager.refreshHashtags');
      
    } catch (error) {
      vscode.window.showErrorMessage(`Error removing tag: ${error}`);
    }
  }

  private updateWebview() {
    if (!this.panel) {
      return;
    }

    this.panel.webview.html = this.getWebviewContent();
  }

  private sendTasksUpdate(focusTaskId?: string, filterDate?: string, filterProject?: string, filterHashtag?: string) {
    if (!this.panel) {
      return;
    }

    // Send updated tasks data to webview without full refresh
    this.panel.webview.postMessage({
      command: 'updateTasks',
      tasks: this.tasks,
      projects: [...new Set(this.tasks.map(t => t.project))].sort(),
      focusTaskId: focusTaskId,
      filterDate: filterDate,
      filterProject: filterProject,
      filterHashtag: filterHashtag
    });
  }

  private getHideCompletedDefault(): boolean {
    const cfg = vscode.workspace.getConfiguration('obsidianManager');
    return cfg.get<boolean>('taskTableHideCompletedByDefault', true);
  }

  private getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  private getWebviewContent(): string {
    const tasks = this.tasks;
    
    // Get unique projects for filter dropdown
    const projects = [...new Set(tasks.map(t => t.project))].sort();
    
    // Get hideCompleted default from settings
    const hideCompletedDefault = this.getHideCompletedDefault();
    
    // Helper function to escape HTML attributes
    const escapeHtml = (str: string) => {
      return str
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    };
    
    // Helper function to extract hashtags from text
    const extractTags = (text: string): string[] => {
      const hashtagRegex = /#[a-zA-Z0-9_]+/g;
      const matches = text.match(hashtagRegex);
      return matches || [];
    };
    
    // Generate a nonce for CSP
    const nonce = this.getNonce();
    
    if (!this.panel) {
      return '';
    }
    
    // Get Codicon font URI
    const codiconUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css')
    );
    
    const cspSource = this.panel.webview.cspSource;
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; font-src ${cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${codiconUri}" rel="stylesheet" />
  <title>Obsidian Tasks Table</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      padding: 20px;
    }
    
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      gap: 20px;
    }
    
    .header h1 {
      font-size: 24px;
      font-weight: 600;
      margin: 0;
    }
    
    .task-count {
      color: var(--vscode-descriptionForeground);
      font-size: 14px;
      margin-left: 12px;
    }
    
    .filters {
      display: flex;
      gap: 20px;
      align-items: center;
    }
    
    .filter-group {
      display: flex;
      gap: 10px;
      align-items: center;
    }
    
    .filters label {
      font-weight: 500;
    }
    
    .filters select {
      padding: 4px 8px;
      background-color: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      border-radius: 2px;
      min-width: 150px;
    }
    
    .filters input[type="checkbox"]:not(#hideCompleted) {
      cursor: pointer;
      width: 16px;
      height: 16px;
    }
    
    /* Toggle switch styling */
    .toggle-container {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    #hideCompleted {
      opacity: 0;
      width: 0;
      height: 0;
      position: absolute;
    }
    
    .toggle-switch {
      position: relative;
      display: inline-block;
      width: 34px;
      height: 18px;
      background-color: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 10px;
      cursor: pointer;
      transition: background-color 0.2s;
    }
    
    .toggle-switch::after {
      content: '';
      position: absolute;
      width: 14px;
      height: 14px;
      left: 2px;
      top: 2px;
      background-color: var(--vscode-input-foreground);
      border-radius: 50%;
      transition: transform 0.2s;
    }
    
    #hideCompleted:checked + .toggle-switch {
      background-color: var(--vscode-button-background);
      border-color: var(--vscode-button-background);
    }
    
    #hideCompleted:checked + .toggle-switch::after {
      background-color: var(--vscode-button-foreground);
      transform: translateX(15px);
    }
    
    .filters input[type="text"] {
      padding: 4px 8px;
      background-color: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 2px;
      min-width: 200px;
    }
    
    .filters input[type="text"]:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }
    
    .filters input[type="date"] {
      padding: 4px 8px;
      background-color: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 2px;
      min-width: 140px;
    }
    
    .filters input[type="date"]:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }
    
    .input-with-clear {
      display: inline-flex;
      align-items: center;
      border: 1px solid var(--vscode-input-border);
      border-radius: 2px;
      background-color: var(--vscode-input-background);
      padding: 0;
      margin: 0;
    }
    
    .input-with-clear input[type="text"],
    .input-with-clear input[type="date"],
    .input-with-clear select {
      border: none;
      min-width: auto;
    }
    
    .input-with-clear input[type="text"] {
      width: 200px;
    }
    
    .input-with-clear input[type="date"] {
      width: 140px;
    }
    
    .input-with-clear select {
      width: 150px;
      background-color: transparent;
    }
    
    .clear-btn {
      cursor: pointer;
      color: var(--vscode-descriptionForeground);
      font-size: 16px;
      padding: 4px 8px;
      background: transparent;
      border: none;
      opacity: 0.6;
      margin: 0;
    }
    
    .clear-btn:hover {
      opacity: 1;
      color: var(--vscode-errorForeground);
    }
    
    table {
      width: 100%;
      border-collapse: collapse;
      background-color: var(--vscode-editor-background);
    }
    
    thead {
      background-color: var(--vscode-editor-background);
      position: sticky;
      top: 0;
      z-index: 10;
      box-shadow: 0 1px 0 var(--vscode-panel-border);
    }
    
    th {
      padding: 12px;
      text-align: left;
      font-weight: 600;
      border-bottom: 2px solid var(--vscode-panel-border);
      cursor: pointer;
      user-select: none;
    }
    
    th:hover {
      background-color: var(--vscode-list-hoverBackground);
    }
    
    th.sortable::after {
      content: ' ⇅';
      opacity: 0.3;
    }
    
    th.sorted-asc::after {
      content: ' ↑';
      opacity: 1;
    }
    
    th.sorted-desc::after {
      content: ' ↓';
      opacity: 1;
    }
    
    td {
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    
    tr:hover {
      background-color: var(--vscode-list-hoverBackground);
    }
    
    tbody tr:nth-child(even) {
      background-color: rgba(255, 255, 255, 0.03);
    }
    
    tbody tr:nth-child(odd) {
      background-color: rgba(0, 0, 0, 0.05);
    }
    
    .status-cell {
      text-align: center;
      width: 40px;
    }
    
    .date-cell {
      width: 120px;
      font-family: monospace;
      cursor: pointer;
      color: var(--vscode-textLink-foreground);
    }
    
    .date-cell:hover {
      text-decoration: underline;
    }
    
    .project-cell {
      width: 150px;
      font-weight: 500;
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
    }
    
    .project-cell:hover {
      text-decoration: underline;
    }
    
    .task-cell {
      width: auto;
    }
    
    .task-cell-content {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .tags-cell {
      width: 150px;
      min-width: 150px;
      max-width: 150px;
      overflow-x: auto;
      white-space: nowrap;
      cursor: pointer;
      position: relative;
    }
    
    .tags-cell:hover {
      background-color: var(--vscode-list-hoverBackground);
    }
    
    .tags-cell:empty:after {
      content: 'Click to add tags...';
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      font-style: italic;
    }
    
    .tags-cell::-webkit-scrollbar {
      height: 4px;
    }
    
    .tag {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background-color: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 11px;
      margin-right: 4px;
      cursor: pointer;
      position: relative;
    }
    
    .tag:hover {
      opacity: 0.8;
    }
    
    .tag-remove {
      display: none;
      cursor: pointer;
      font-size: 12px;
      font-weight: bold;
      opacity: 0.7;
      margin-left: 2px;
    }
    
    .tag:hover .tag-remove {
      display: inline;
    }
    
    .tag-remove:hover {
      opacity: 1;
    }
    
    .open-file-icon {
      cursor: pointer;
      color: var(--vscode-textLink-foreground);
      opacity: 0.6;
      flex-shrink: 0;
    }
    
    .open-file-icon:hover {
      opacity: 1;
    }
    
    .insert-cell {
      width: 40px;
      min-width: 40px;
      text-align: center;
      padding: 4px !important;
    }
    
    .add-icon {
      cursor: pointer;
      color: var(--vscode-textLink-foreground);
      opacity: 0.8;
      font-size: 16px !important;
    }
    
    .add-icon:hover {
      opacity: 1;
    }
    
    .actions-cell {
      width: 40px;
      min-width: 40px;
      text-align: center;
      padding: 4px !important;
    }
    
    .delete-icon {
      cursor: pointer;
      color: var(--vscode-errorForeground);
      opacity: 0.8;
      font-size: 16px !important;
    }
    
    .delete-icon:hover {
      opacity: 1;
    }
    
    input[type="checkbox"] {
      cursor: pointer;
      width: 18px;
      height: 18px;
    }
    
    .task-input {
      width: 100%;
      background-color: transparent;
      color: var(--vscode-foreground);
      border: none;
      outline: none;
      font-family: inherit;
      font-size: inherit;
      padding: 2px;
    }
    
    .task-input:focus {
      background-color: var(--vscode-input-background);
      border: 1px solid var(--vscode-focusBorder);
      border-radius: 2px;
    }
    
    .delete-btn {
      background-color: transparent;
      color: var(--vscode-errorForeground);
      border: 1px solid var(--vscode-errorForeground);
      border-radius: 2px;
      padding: 4px 8px;
      cursor: pointer;
      font-size: 12px;
    }
    
    .delete-btn:hover {
      background-color: var(--vscode-errorForeground);
      color: var(--vscode-editor-background);
    }
    
    .empty-message {
      text-align: center;
      padding: 40px;
      color: var(--vscode-descriptionForeground);
      font-size: 16px;
    }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>Tasks <span class="task-count" id="taskCount"></span></h1>
    </div>
    <div class="filters">
      <div class="filter-group">
        <label for="searchInput">Search:</label>
        <fieldset class="input-with-clear">
          <input type="text" id="searchInput" placeholder="Filter by task, project, date or #hashtag..." />
          <button class="clear-btn" id="clearSearch" title="Clear search">×</button>
        </fieldset>
      </div>
      <div class="filter-group">
        <label for="dateFilter">Date:</label>
        <fieldset class="input-with-clear">
          <input type="date" id="dateFilter" />
          <button class="clear-btn" id="clearDate" title="Clear date filter">×</button>
        </fieldset>
      </div>
      <div class="filter-group">
        <label for="projectFilter">Project:</label>
        <fieldset class="input-with-clear">
          <select id="projectFilter">
            <option value="">All Projects</option>
            ${projects.map(p => `<option value="${p}">${p}</option>`).join('')}
          </select>
          <button class="clear-btn" id="clearProject" title="Clear project filter">×</button>
        </fieldset>
      </div>
      <div class="filter-group toggle-container">
        <input type="checkbox" id="hideCompleted" ${hideCompletedDefault ? 'checked' : ''} />
        <label for="hideCompleted" class="toggle-switch"></label>
        <label for="hideCompleted" style="cursor: pointer;">Hide completed</label>
      </div>
    </div>
  </div>
  
  ${tasks.length === 0 ? `
    <div class="empty-message">
      No tasks found in date-prefixed markdown files (YYYY-MM-DD*.md)
    </div>
  ` : `
    <table id="tasksTable">
      <thead>
        <tr>
          <th class="status-cell sortable" data-column="status"></th>
          <th class="date-cell sortable" data-column="date">DATE</th>
          <th class="project-cell sortable" data-column="project">PROJECT</th>
          <th class="task-cell">TASK</th>
          <th class="tags-cell">TAGS</th>
          <th class="insert-cell"></th>
          <th class="actions-cell"></th>
        </tr>
      </thead>
      <tbody>
        ${tasks.map((task, index) => `
          <tr data-task-id="${escapeHtml(task.id)}" data-index="${index}" data-project="${escapeHtml(task.project)}" data-filepath="${escapeHtml(task.filePath)}" data-line-number="${task.lineNumber}">

            <td class="status-cell">
              <input 
                type="checkbox" 
                class="task-status-checkbox"
                ${task.status ? 'checked' : ''}
              />
            </td>
            <td class="date-cell">${task.date}</td>
            <td class="project-cell">${task.project}</td>
            <td class="task-cell">
              <div class="task-cell-content">
                <span class="codicon codicon-link-external open-file-icon" title="Open file"></span>
                <input 
                  type="text" 
                  class="task-input"
                  value="${task.task.replace(/"/g, '&quot;')}"
                />
              </div>
            </td>
            <td class="tags-cell">${extractTags(task.task).map(tag => `<span class="tag" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}<span class="tag-remove">×</span></span>`).join('')}</td>
            <td class="insert-cell">
              <span class="codicon codicon-add add-icon" title="Add task after"></span>
            </td>
            <td class="actions-cell">
              <span class="codicon codicon-trash delete-icon" title="Delete task"></span>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `}
  
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    
    // Function to escape HTML
    function escapeHtml(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }
    
    // Function to extract hashtags from text
    function extractTags(text) {
      if (!text) return [];
      const hashtagRegex = /#[a-zA-Z0-9_]+/g;
      const matches = text.match(hashtagRegex);
      return matches || [];
    }
    
    // Preserve state - default sort by date descending
    let currentSort = { column: 'date', direction: 'desc' };
    let currentFilter = '';
    let currentHideCompleted = ${hideCompletedDefault};
    let currentSearchText = '';
    let currentDateFilter = '';
    
    // Event delegation for checkboxes
    document.addEventListener('change', function(e) {
      if (e.target.classList.contains('task-status-checkbox')) {
        const row = e.target.closest('tr');
        if (!row) return;
        
        const taskId = row.getAttribute('data-task-id');
        if (taskId) {
          vscode.postMessage({
            command: 'toggleStatus',
            taskId: taskId
          });
        }
      }
    });
    
    // Event delegation for text inputs
    document.addEventListener('blur', function(e) {
      if (e.target.classList.contains('task-input')) {
        const row = e.target.closest('tr');
        if (!row) return;
        
        const taskId = row.getAttribute('data-task-id');
        if (taskId) {
          vscode.postMessage({
            command: 'updateTask',
            taskId: taskId,
            newText: e.target.value
          });
        }
      }
    }, true);
    
    // Enter key on inputs
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && e.target.classList.contains('task-input')) {
        e.target.blur();
      }
      
      // Tab key on inputs - save and create new task after
      if (e.key === 'Tab' && e.target.classList.contains('task-input')) {
        e.preventDefault();
        
        const row = e.target.closest('tr');
        if (!row) return;
        
        const taskId = row.getAttribute('data-task-id');
        if (!taskId) return;
        
        // Trigger save by blurring current input
        e.target.blur();
        
        // Create new task after current one
        setTimeout(() => {
          vscode.postMessage({
            command: 'addTaskAfter',
            taskId: taskId
          });
        }, 50);
      }
    });
    
    // Click on open-file icon
    document.addEventListener('click', function(e) {
      if (e.target.classList.contains('open-file-icon')) {
        const row = e.target.closest('tr');
        if (!row) return;
        
        const filePath = row.getAttribute('data-filepath');
        const lineNumber = parseInt(row.getAttribute('data-line-number'), 10);
        
        if (filePath && !isNaN(lineNumber)) {
          vscode.postMessage({
            command: 'openFile',
            filePath: filePath,
            lineNumber: lineNumber
          });
        }
      }
      
      // Click on add icon
      if (e.target.classList.contains('add-icon')) {
        const row = e.target.closest('tr');
        if (!row) return;
        
        const taskId = row.getAttribute('data-task-id');
        
        if (taskId) {
          vscode.postMessage({
            command: 'addTaskAfter',
            taskId: taskId
          });
        }
      }
      
      // Click on delete icon
      if (e.target.classList.contains('delete-icon')) {
        const row = e.target.closest('tr');
        if (!row) return;
        
        const taskId = row.getAttribute('data-task-id');
        
        if (taskId) {
          vscode.postMessage({
            command: 'deleteTask',
            taskId: taskId
          });
        }
      }
      
      // Click on tag remove button
      if (e.target.classList.contains('tag-remove')) {
        e.preventDefault();
        e.stopPropagation();
        
        const tagSpan = e.target.closest('.tag');
        if (!tagSpan) return;
        
        const row = tagSpan.closest('tr');
        if (!row) return;
        
        const taskId = row.getAttribute('data-task-id');
        const tag = tagSpan.getAttribute('data-tag');
        
        if (taskId && tag) {
          vscode.postMessage({
            command: 'removeTag',
            taskId: taskId,
            tag: tag
          });
        }
        return;
      }
      
      // Click on tag to filter (toggle behavior)
      if (e.target.classList.contains('tag')) {
        const tagText = e.target.getAttribute('data-tag');
        if (tagText) {
          const searchInput = document.getElementById('searchInput');
          if (searchInput) {
            // Toggle: if tag is already in search, remove it; otherwise set it
            if (currentSearchText === tagText) {
              searchInput.value = '';
              currentSearchText = '';
            } else {
              searchInput.value = tagText;
              currentSearchText = tagText;
            }
            applyFilter();
          }
        }
      }
      
      // Click on tags cell to edit tags
      if (e.target.classList.contains('tags-cell') && e.target.tagName === 'TD') {
        const row = e.target.closest('tr');
        if (!row) return;
        
        const taskId = row.getAttribute('data-task-id');
        
        if (taskId) {
          vscode.postMessage({
            command: 'editTags',
            taskId: taskId
          });
        }
      }
    });
    
    function rebuildTable(tasks) {
      const tbody = document.querySelector('#tasksTable tbody');
      if (!tbody) return;
      
      tbody.innerHTML = tasks.map((task, index) => {
        const tags = extractTags(task.task);
        const tagsHtml = tags.map(tag => '<span class="tag" data-tag="' + escapeHtml(tag) + '">' + escapeHtml(tag) + '<span class="tag-remove">×</span></span>').join('');
        
        return \`
        <tr data-task-id="\${task.id}" data-project="\${task.project}" data-filepath="\${task.filePath}" data-line-number="\${task.lineNumber}">
          <td class="status-cell">
            <input 
              type="checkbox" 
              class="task-status-checkbox"
              \${task.status ? 'checked' : ''}
            />
          </td>
          <td class="date-cell">\${task.date}</td>
          <td class="project-cell">\${task.project}</td>
          <td class="task-cell">
            <div class="task-cell-content">
              <span class="codicon codicon-link-external open-file-icon" title="Open file"></span>
              <input 
                type="text" 
                class="task-input"
                value="\${task.task.replace(/"/g, '&quot;')}"
              />
            </div>
          </td>
          <td class="tags-cell">\${tagsHtml}</td>
          <td class="insert-cell">
            <span class="codicon codicon-add add-icon" title="Add task after"></span>
          </td>
          <td class="actions-cell">
            <span class="codicon codicon-trash delete-icon" title="Delete task"></span>
          </td>
        </tr>
        \`;
      }).join('');
      
      // Restore filter input states FIRST
      const hideCompletedCheckbox = document.getElementById('hideCompleted');
      if (hideCompletedCheckbox) {
        hideCompletedCheckbox.checked = currentHideCompleted;
      }
      
      const searchInput = document.getElementById('searchInput');
      if (searchInput) {
        searchInput.value = currentSearchText;
      }
      
      const dateFilter = document.getElementById('dateFilter');
      if (dateFilter) {
        dateFilter.value = currentDateFilter;
      }
      
      // Then apply sort
      if (currentSort.column) {
        // Update UI to show current sort
        document.querySelectorAll('th.sortable').forEach(h => {
          h.classList.remove('sorted-asc', 'sorted-desc');
        });
        const header = document.querySelector('th[data-column="' + currentSort.column + '"]');
        if (header) {
          header.classList.add('sorted-' + currentSort.direction);
        }
        applySorting();
      }
      
      // Finally apply filter (after restoring states and sorting)
      applyFilter();
    }
    
    function applyFilter() {
      const rows = document.querySelectorAll('#tasksTable tbody tr');
      const searchLower = currentSearchText.toLowerCase();
      let visibleCount = 0;
      
      rows.forEach(row => {
        const matchesProject = !currentFilter || row.getAttribute('data-project') === currentFilter;
        const isCompleted = row.querySelector('input[type="checkbox"]').checked;
        
        // Date filter
        const date = row.querySelector('.date-cell').textContent;
        const matchesDate = !currentDateFilter || date === currentDateFilter;
        
        // Search in task text, project, and date
        let matchesSearch = true;
        if (searchLower) {
          const taskText = row.querySelector('.task-input').value.toLowerCase();
          
          // Check if searching for hashtag
          if (searchLower.startsWith('#')) {
            // Hashtag search: only search in task text for exact hashtag match
            matchesSearch = taskText.includes(searchLower);
          } else {
            // Normal search: search in task text, project, and date
            const project = row.getAttribute('data-project').toLowerCase();
            const dateLower = date.toLowerCase();
            
            matchesSearch = taskText.includes(searchLower) || 
                           project.includes(searchLower) || 
                           dateLower.includes(searchLower);
          }
        }
        
        const shouldShow = matchesProject && matchesDate && matchesSearch && (!currentHideCompleted || !isCompleted);
        
        row.style.display = shouldShow ? '' : 'none';
        if (shouldShow) visibleCount++;
      });
      
      // Update task count
      const taskCountEl = document.getElementById('taskCount');
      if (taskCountEl) {
        taskCountEl.textContent = '(' + visibleCount + ')';
      }
    }
    
    function applySorting() {
      const tbody = document.querySelector('#tasksTable tbody');
      if (!tbody) return;
      
      const rows = Array.from(tbody.querySelectorAll('tr'));
      
      rows.sort((a, b) => {
        let aVal, bVal;
        
        if (currentSort.column === 'status') {
          aVal = a.querySelector('input[type="checkbox"]').checked ? 1 : 0;
          bVal = b.querySelector('input[type="checkbox"]').checked ? 1 : 0;
        } else if (currentSort.column === 'date') {
          aVal = a.querySelector('.date-cell').textContent;
          bVal = b.querySelector('.date-cell').textContent;
        } else if (currentSort.column === 'project') {
          aVal = a.querySelector('.project-cell').textContent;
          bVal = b.querySelector('.project-cell').textContent;
        }
        
        let result;
        if (currentSort.direction === 'asc') {
          result = aVal > bVal ? 1 : (aVal < bVal ? -1 : 0);
        } else {
          result = aVal < bVal ? 1 : (aVal > bVal ? -1 : 0);
        }
        
        // If primary sort is equal, maintain original file order
        if (result === 0) {
          const aPath = a.getAttribute('data-filepath');
          const bPath = b.getAttribute('data-filepath');
          if (aPath === bPath) {
            // Same file: sort by line number
            const aLine = parseInt(a.getAttribute('data-line-number') || '0');
            const bLine = parseInt(b.getAttribute('data-line-number') || '0');
            return aLine - bLine;
          } else {
            // Different files: sort by file path
            return aPath > bPath ? 1 : -1;
          }
        }
        
        return result;
      });
      
      rows.forEach(row => tbody.appendChild(row));
    }
    
    function updateProjectFilter(projects) {
      const select = document.getElementById('projectFilter');
      if (!select) return;
      
      // Save current filter BEFORE rebuilding dropdown
      const savedFilter = currentFilter;
      
      select.innerHTML = '<option value="">All Projects</option>' + 
        projects.map(p => '<option value="' + p + '">' + p + '</option>').join('');
      
      // Restore saved filter if still valid
      if (savedFilter && projects.includes(savedFilter)) {
        select.value = savedFilter;
        currentFilter = savedFilter;
      } else {
        // Reset filter if previous project no longer exists
        select.value = '';
        currentFilter = '';
      }
    }
    
    // Listen for updates from extension
    window.addEventListener('message', event => {
      const message = event.data;
      if (message.command === 'updateTasks') {
        rebuildTable(message.tasks);
        updateProjectFilter(message.projects);
        
        let filterApplied = false;
        
        // Apply date filter if provided
        if (message.filterDate) {
          currentDateFilter = message.filterDate;
          const dateInput = document.getElementById('dateFilter');
          if (dateInput) {
            dateInput.value = message.filterDate;
          }
          filterApplied = true;
        }
        
        // Apply project filter if provided
        if (message.filterProject) {
          currentFilter = message.filterProject;
          const projectSelect = document.getElementById('projectFilter');
          if (projectSelect) {
            projectSelect.value = message.filterProject;
          }
          filterApplied = true;
        }
        
        // Apply hashtag filter if provided
        if (message.filterHashtag) {
          currentSearchText = message.filterHashtag;
          const searchInput = document.getElementById('searchInput');
          if (searchInput) {
            searchInput.value = message.filterHashtag;
          }
          filterApplied = true;
        }
        
        // Always apply filter at the end to ensure table is properly filtered
        if (filterApplied) {
          applyFilter();
        }
        
        // Focus on new task input if specified
        if (message.focusTaskId) {
          setTimeout(() => {
            const row = document.querySelector('tr[data-task-id="' + message.focusTaskId + '"]');
            if (row) {
              const input = row.querySelector('.task-input');
              if (input) {
                input.focus();
                input.select();
              }
            }
          }, 100);
        }
      }
    });
    
    // Search filter
    document.getElementById('searchInput')?.addEventListener('input', function(e) {
      currentSearchText = e.target.value;
      applyFilter();
    });
    
    // Clear search button
    document.getElementById('clearSearch')?.addEventListener('click', function() {
      const searchInput = document.getElementById('searchInput');
      if (searchInput) {
        searchInput.value = '';
        currentSearchText = '';
        applyFilter();
      }
    });
    
    // Date filter
    document.getElementById('dateFilter')?.addEventListener('change', function(e) {
      currentDateFilter = e.target.value;
      applyFilter();
    });
    
    // Clear date button
    document.getElementById('clearDate')?.addEventListener('click', function() {
      const dateInput = document.getElementById('dateFilter');
      if (dateInput) {
        dateInput.value = '';
        currentDateFilter = '';
        applyFilter();
      }
    });
    
    // Click on date cells to toggle date filter (only TD, not TH header)
    document.addEventListener('click', function(e) {
      if (e.target.classList.contains('date-cell') && e.target.tagName === 'TD') {
        const clickedDate = e.target.textContent.trim();
        
        // Toggle: if same date is clicked, clear filter; otherwise set new filter
        if (currentDateFilter === clickedDate) {
          currentDateFilter = '';
        } else {
          currentDateFilter = clickedDate;
        }
        
        // Update the date input field
        const dateInput = document.getElementById('dateFilter');
        if (dateInput) {
          dateInput.value = currentDateFilter;
        }
        
        applyFilter();
      }
      
      // Click on project cells to toggle project filter (only TD, not TH header)
      if (e.target.classList.contains('project-cell') && e.target.tagName === 'TD') {
        const clickedProject = e.target.textContent.trim();
        
        // Toggle: if same project is clicked, clear filter; otherwise set new filter
        if (currentFilter === clickedProject) {
          currentFilter = '';
        } else {
          currentFilter = clickedProject;
        }
        
        // Update the project select dropdown
        const projectSelect = document.getElementById('projectFilter');
        if (projectSelect) {
          projectSelect.value = currentFilter;
        }
        
        applyFilter();
      }
    });
    
    // Project filter
    document.getElementById('projectFilter')?.addEventListener('change', function(e) {
      currentFilter = e.target.value;
      applyFilter();
    });
    
    // Clear project button
    document.getElementById('clearProject')?.addEventListener('click', function() {
      const projectSelect = document.getElementById('projectFilter');
      if (projectSelect) {
        projectSelect.value = '';
        currentFilter = '';
        applyFilter();
      }
    });
    
    // Hide completed toggle
    document.getElementById('hideCompleted')?.addEventListener('change', function(e) {
      currentHideCompleted = e.target.checked;
      applyFilter();
    });
    
    // Sorting
    document.querySelectorAll('th.sortable').forEach(th => {
      th.addEventListener('click', function() {
        const column = this.getAttribute('data-column');
        
        // Toggle sort direction
        if (currentSort.column === column) {
          currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
        } else {
          currentSort.column = column;
          currentSort.direction = 'asc';
        }
        
        // Update UI
        document.querySelectorAll('th.sortable').forEach(h => {
          h.classList.remove('sorted-asc', 'sorted-desc');
        });
        this.classList.add('sorted-' + currentSort.direction);
        
        // Apply sorting
        applySorting();
      });
    });
    
    // Apply initial sort by date descending
    const dateHeader = document.querySelector('th[data-column="date"]');
    if (dateHeader) {
      dateHeader.classList.add('sorted-desc');
      applySorting();
    }
    
    // Initialize task count
    applyFilter();
  </script>
</body>
</html>`;
  }
}
