
# Obsidian manager — VS Code extension

This extension adds an icon to the editor title area for Markdown files (.md) and provides a view to browse files from your Obsidian vault. Clicking the icon attempts to open the current file in Obsidian using the `obsidian://` URL handler.

Quick install & test

1. Open the extension folder in VS Code.
2. Install dependencies and compile:

```bash
npm install
npm run compile
```

3. Press F5 to launch a new "Extension Development Host" window.
4. Open a `.md` file. If the active editor is Markdown you'll see the Obsidian icon in the editor title area — clicking it will invoke an `obsidian://open?path=...` URL on your OS.

Notes on URLs and compatibility

- The extension tries a few deep link formats to open files in Obsidian. You can adjust behavior via the extension settings (see below).
- If Obsidian is not installed or the `obsidian://` protocol is not registered on your OS, VS Code will show an error message when attempting to open the link.

Replacing the icon

To use an official Obsidian icon (or a custom image) replace `images/obsidian.svg` with your chosen SVG (respect the logo license).

New Link Document Feature

The extension now includes a powerful feature to create links to other documents within your Obsidian vault:

- **Command**: `Obsidian Manager: Link to Document`
- **Keyboard shortcut**: `Ctrl+Shift+L` (Windows/Linux) or `Cmd+Shift+L` (Mac)
- **Usage**: While editing a Markdown file, use the command or keyboard shortcut to open a quick pick dialog showing all Markdown files in your vault. Select a file to insert an Obsidian-style link (`[[filename]]`) at your cursor position.
- **Smart link generation**: The extension automatically generates the appropriate link format based on file locations within your vault.
- **Selected text support**: If you have text selected when using the command, it will be used as custom link text in the format `[[filename|selected text]]`.

Access the Link Document feature through:
- The editor title bar (link icon)
- Right-click context menu in Markdown files  
- Command palette: "Obsidian Manager: Link to Document"
- Keyboard shortcut: `Ctrl+Shift+L` / `Cmd+Shift+L`

Possible future improvements

- Support a workspace -> vault mapping so the extension can build `obsidian://open?vault=...&file=...` links correctly.
- Add support for linking to specific headings within documents.

Settings

The extension exposes a few settings in VS Code which can be configured in Settings or in your `settings.json`:

- `obsidianManager.vault` (string): absolute path to your Obsidian vault folder (for example `/Users/you/Obsidian/MyVault`). The sidebar view reads Markdown files from this folder and the extension uses this path when building `obsidian://` links. Leave empty to disable vault scanning.

- `obsidianManager.expandFoldersOnLoad` (boolean, default: true): if true, folders in the Obsidian view will be expanded by default when the view is shown; if false they will be collapsed.

- `obsidianManager.showIcons` (boolean, default: true): show icons next to files and folders in the Obsidian sidebar. Set to `false` for a compact list.

- `obsidianManager.viewMode` (string, `folders` or `list`, default: `folders`): how to present files in the sidebar — `folders` shows a hierarchical view, `list` shows a flat list of Markdown files.

Example `settings.json`:

```json
{
  "obsidianManager.vault": "/Users/yourname/Obsidian/MyVault"

}
```
