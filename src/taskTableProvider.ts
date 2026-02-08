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

  public async show() {
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
          console.log('Received message from webview:', message);
          switch (message.command) {
            case 'toggleStatus':
              if (message.taskId) {
                console.log('Toggle status for task:', message.taskId);
                await this.toggleTaskStatus(message.taskId);
              }
              break;
            case 'updateTask':
              if (message.taskId) {
                console.log('Update task:', message.taskId, 'with text:', message.newText);
                await this.updateTaskText(message.taskId, message.newText);
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
      
    } catch (error) {
      vscode.window.showErrorMessage(`Error updating task text: ${error}`);
    }
  }

  private updateWebview() {
    if (!this.panel) {
      return;
    }

    this.panel.webview.html = this.getWebviewContent();
  }

  private sendTasksUpdate() {
    if (!this.panel) {
      return;
    }

    // Send updated tasks data to webview without full refresh
    this.panel.webview.postMessage({
      command: 'updateTasks',
      tasks: this.tasks,
      projects: [...new Set(this.tasks.map(t => t.project))].sort()
    });
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
    
    // Helper function to escape HTML attributes
    const escapeHtml = (str: string) => {
      return str
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    };
    
    // Generate a nonce for CSP
    const nonce = this.getNonce();
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
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
    
    .filters input[type="checkbox"] {
      cursor: pointer;
      width: 16px;
      height: 16px;
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
    
    table {
      width: 100%;
      border-collapse: collapse;
      background-color: var(--vscode-editor-background);
    }
    
    thead {
      background-color: var(--vscode-editor-lineHighlightBackground);
      position: sticky;
      top: 0;
      z-index: 10;
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
    
    .status-cell {
      text-align: center;
      width: 60px;
    }
    
    .date-cell {
      width: 120px;
      font-family: monospace;
    }
    
    .project-cell {
      width: 150px;
      font-weight: 500;
      color: var(--vscode-textLink-foreground);
    }
    
    .task-cell {
      width: auto;
    }
    
    .actions-cell {
      width: 80px;
      text-align: center;
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
    <h1>📋 Obsidian Tasks</h1>
    <div class="filters">
      <div class="filter-group">
        <label for="searchInput">Search:</label>
        <input type="text" id="searchInput" placeholder="Filter by task, project or date..." />
      </div>
      <div class="filter-group">
        <label for="projectFilter">Project:</label>
        <select id="projectFilter">
          <option value="">All Projects</option>
          ${projects.map(p => `<option value="${p}">${p}</option>`).join('')}
        </select>
      </div>
      <div class="filter-group">
        <input type="checkbox" id="hideCompleted" />
        <label for="hideCompleted">Hide completed</label>
      </div>
    </div>
  </div>
  
  ${tasks.length === 0 ? `
    <div class="empty-message">
      No tasks found in date-prefixed markdown files (YYYY-MM-DD-*.md)
    </div>
  ` : `
    <table id="tasksTable">
      <thead>
        <tr>
          <th class="status-cell sortable" data-column="status">STATUS</th>
          <th class="date-cell sortable" data-column="date">DATE</th>
          <th class="project-cell sortable" data-column="project">PROJECT</th>
          <th class="task-cell">TASK</th>
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
              <input 
                type="text" 
                class="task-input"
                value="${task.task.replace(/"/g, '&quot;')}"
              />
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `}
  
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    
    console.log('Script loaded');
    
    // Preserve state - default sort by date descending
    let currentSort = { column: 'date', direction: 'desc' };
    let currentFilter = '';
    let currentHideCompleted = false;
    let currentSearchText = '';
    
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
    });
    
    function rebuildTable(tasks) {
      const tbody = document.querySelector('#tasksTable tbody');
      if (!tbody) return;
      
      tbody.innerHTML = tasks.map((task, index) => \`
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
            <input 
              type="text" 
              class="task-input"
              value="\${task.task.replace(/"/g, '&quot;')}"
            />
          </td>
        </tr>
      \`).join('');
      
      console.log('Table rebuilt with', tasks.length, 'tasks');
      console.log('Delete buttons found:', document.querySelectorAll('.delete-btn').length);
      
      // Reapply filter
      applyFilter();
      
      // Reapply sort
      if (currentSort.column) {
        // Update UI to show current sort
        document.querySelectorAll('th.sortable').forEach(h => {
          h.classList.remove('sorted-asc', 'sorted-desc');
        });
        const header = document.querySelector(\`th[data-column="\${currentSort.column}"]\`);
        if (header) {
          header.classList.add('sorted-' + currentSort.direction);
        }
        applySorting();
      }
      
      // Restore filter states
      const projectFilter = document.getElementById('projectFilter');
      if (projectFilter) {
        projectFilter.value = currentFilter;
      }
      
      const hideCompletedCheckbox = document.getElementById('hideCompleted');
      if (hideCompletedCheckbox) {
        hideCompletedCheckbox.checked = currentHideCompleted;
      }
      
      const searchInput = document.getElementById('searchInput');
      if (searchInput) {
        searchInput.value = currentSearchText;
      }
    }
    
    function applyFilter() {
      const rows = document.querySelectorAll('#tasksTable tbody tr');
      const searchLower = currentSearchText.toLowerCase();
      
      rows.forEach(row => {
        const matchesProject = !currentFilter || row.getAttribute('data-project') === currentFilter;
        const isCompleted = row.querySelector('input[type="checkbox"]').checked;
        
        // Search in task text, project, and date
        let matchesSearch = true;
        if (searchLower) {
          const taskText = row.querySelector('.task-input').value.toLowerCase();
          const project = row.getAttribute('data-project').toLowerCase();
          const date = row.querySelector('.date-cell').textContent.toLowerCase();
          
          matchesSearch = taskText.includes(searchLower) || 
                         project.includes(searchLower) || 
                         date.includes(searchLower);
        }
        
        const shouldShow = matchesProject && matchesSearch && (!currentHideCompleted || !isCompleted);
        
        row.style.display = shouldShow ? '' : 'none';
      });
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
      
      const currentValue = select.value;
      select.innerHTML = '<option value="">All Projects</option>' + 
        projects.map(p => \`<option value="\${p}">\${p}</option>\`).join('');
      
      // Restore previous selection if still valid
      if (projects.includes(currentValue)) {
        select.value = currentValue;
      }
    }
    
    // Listen for updates from extension
    window.addEventListener('message', event => {
      const message = event.data;
      if (message.command === 'updateTasks') {
        rebuildTable(message.tasks);
        updateProjectFilter(message.projects);
      }
    });
    
    // Search filter
    document.getElementById('searchInput')?.addEventListener('input', function(e) {
      currentSearchText = e.target.value;
      applyFilter();
    });
    
    // Project filter
    document.getElementById('projectFilter')?.addEventListener('change', function(e) {
      currentFilter = e.target.value;
      applyFilter();
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
  </script>
</body>
</html>`;
  }
}
