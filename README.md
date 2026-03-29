# Vibe

Vibe is a local-first note-taking and design tool built with Tauri and vanilla HTML/CSS/JS. It runs as a native desktop app and stores everything as flat files in a `.vibe/` directory inside whatever folder you point it at.

## Installation

Download the latest release for your platform:

- macOS: `.pkg` installer
- Linux: `.deb` (Debian/Ubuntu), `.rpm` (Fedora/RHEL), or `.AppImage` (any distro)
- Windows: `.msi` or `.exe` installer

On first launch, the app installs a `vibe` CLI command so you can open it from any terminal:

```
vibe            # opens in current directory
vibe ~/projects # opens in ~/projects
```

On macOS and Linux the CLI is installed to `/usr/local/bin/vibe`. On Windows a `vibe.cmd` is placed next to the app binary and added to PATH.

All project files are stored under `.vibe/` in the target directory.

### macOS: unsigned app warning

macOS may show a warning since the app is not notarized. Right-click the `.pkg` file and select Open to bypass Gatekeeper, then proceed with the installation.

## Building

Requires Rust and Bun.

```
bun install
bun run build
```

This builds both the Tauri app (`src-tauri/target/release/vibe-editor`) and the CLI (`cli/target/release/vibe`).

For development with hot reload:

```
bun run dev
```

## Features

### Notes (Markdown)

- Notes are `.md` files stored in `.vibe/`.
- Block-based editor: content is split into blocks separated by blank lines. Click a block to edit its raw markdown. Click away or press Shift+Enter to deactivate and see the rendered output.
- Rendered markdown supports headings, bold, italic, links, images, code blocks, blockquotes, tables, lists, task checkboxes, and horizontal rules.
- Code blocks get syntax highlighting (JavaScript, TypeScript, Python, Rust, Bash, JSON, CSS, HTML/XML).
- Press Enter on an empty line at the end of a block to create a new block below. Press Backspace in an empty block to delete it.
- Arrow keys at the top/bottom of a block navigate to the adjacent block.

### Diagrams (Mermaid)

- Diagrams are `.mmd` files stored in `.vibe/`.
- Full-screen text editor with Mermaid syntax. A live preview panel renders the diagram in real time.
- Status dot in the toolbar turns green on valid syntax and red on errors. Hover the dot to see the error message.
- Template button inserts starter code for: class diagram, sequence diagram, state diagram, ER diagram, flowchart (TD and LR), Gantt chart, git graph, mindmap, timeline, pie chart, and component diagram.
- Preview panel has zoom controls (buttons, Cmd+/Cmd-, scroll wheel with Cmd held).
- Export to PDF with the Export PDF button. Uses a native save dialog.
- Toggle preview with the Preview button or Cmd+R.

### View Editor (.view files)

- Views are `.view` files written in YAML that describe UI layouts. They are meant to be readable by both humans and AI to help translate designs into code.
- Opening a `.view` file enters a full-screen visual editor with three panels: layer tree, canvas, and properties.
- Canvas has configurable width and height. Zoom with +/- buttons, Cmd+scroll, or the fit-to-view button.
- Drawing tools on the toolbar: Frame (F), Text (T), Button (B), Input (I), Image (G), Divider (D). Press V to switch back to the select tool.
- Click and drag on the canvas with a drawing tool to place a new element.
- Select an element on the canvas or in the layer tree to see and edit its properties: layout (display, flex direction, align, justify, gap, overflow), size (width, height, min/max), spacing (padding, margin), appearance (background, border, radius, opacity, shadow), typography (color, size, weight, align), and position (relative, absolute, fixed, top/left/bottom/right).
- Responsive breakpoints: add style overrides that apply above a specified canvas width.
- Design tokens: define reusable colors, typography groups, and spacing values in the YAML. Reference them with `$category.name` syntax (e.g. `$colors.primary`). Typography token groups can be spread into a style with the `apply` key.
- Layer tree supports drag and drop to reorder and reparent elements. Double-click a layer name to rename it. Right-click for a context menu with add, rename, duplicate, and delete options.
- Import other `.view` files as reusable components. Press W or click the view button in the toolbar to pick from existing `.view` files in the project. Imported views render inline on the canvas.
- Resize elements by dragging selection handles. Move absolutely-positioned elements by dragging.
- Undo/redo with Cmd+Z and Shift+Cmd+Z.
- Duplicate elements with Cmd+D.
- Delete elements with Backspace or Delete.
- Press Esc or click the back arrow to return to the main editor.
- A "Sample View" option is available in the sidebar context menu that creates a fully commented example file demonstrating all .view features.

### File Management

- Sidebar shows a file tree of everything in `.vibe/`. Notes (.md, .mmd, .view) are shown in the main tree. Non-note files (images, data, etc.) appear in a collapsible Resources section at the bottom.
- Files are sorted by type (folders first, then notes, diagrams, views) and alphabetically within each group.
- Create new notes, diagrams, views, and folders by right-clicking in the sidebar or on a folder.
- Rename files and folders by triple-clicking their name in the sidebar, or through the right-click context menu. Duplicate names are detected and blocked with a visual indicator.
- Delete files and folders through the right-click context menu. A confirmation dialog appears.
- Drag and drop files and folders into other folders to move them. A visual indicator shows the drop target. Conflicts (name collisions) are shown in red and blocked.
- Folders can be collapsed and expanded. Their state is persisted across sessions.
- The sidebar can be toggled with the hamburger button or Cmd+B.

### Terminal

- Integrated terminal panel on the right side of the window, powered by xterm.js and a real PTY backend.
- Multiple terminal tabs. Click + to add a new tab. Click the x on a tab to close it.
- When a shell exits, the tab is marked with a strikethrough label.
- Terminal panel is resizable by dragging the divider between the editor and terminal.
- Cmd+T creates a new terminal tab when the terminal panel is focused.

### Quick Create and Quick Open

- Cmd+N opens a quick create dialog. Type a path like `folder/subfolder/note.md` to create a file with intermediate directories. Omitting an extension defaults to `.md`. Path traversal outside the project is blocked.
- Cmd+O opens a quick open dialog with fuzzy path matching. Arrow keys to navigate, Enter to open, Esc to cancel.

### Theming

- Shift+Cmd+T opens a theme editor. Every color in the UI is configurable: backgrounds, text colors, accent, border, success, error, inline code.
- Changes preview in real time. Save to persist or Reset to restore defaults.
- Theme is stored globally at `~/.config/vibe/theme.json` and applies across all projects.
- Terminal colors are defined separately in the source and match the default earthy palette.

### State Persistence

- The app remembers which file was last open, which folders are collapsed, whether the sidebar is collapsed, and whether the UML preview was open. This state is stored per-project in `.vibe/.state`.
- The global theme is stored at `~/.config/vibe/theme.json`.

### File Watching

- A backend filesystem watcher monitors the `.vibe/` directory and automatically refreshes the sidebar when files change outside the app.

### Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| Cmd+N | Quick create file |
| Cmd+O | Quick open file |
| Cmd+B | Toggle sidebar |
| Cmd+R | Toggle diagram preview (when editing .mmd) |
| Cmd+T | New terminal tab (when terminal is focused) |
| Shift+Cmd+T | Open theme editor |
| Cmd+S | Save (auto-saves on change, this just blocks the browser dialog) |
| Cmd+Z | Undo (view editor) |
| Shift+Cmd+Z | Redo (view editor) |
| Cmd+D | Duplicate element (view editor) |
| Cmd+/Cmd- | Zoom diagram preview |
| Esc | Exit view editor / close dialogs |
| Shift+Enter | Deactivate current block (markdown editor) |

### Architecture

- **Frontend**: Vanilla HTML, CSS, and JS. No build step, no framework. Vendor libraries (marked.js, highlight.js, mermaid.js, xterm.js, jsPDF, js-yaml) are included as pre-built files in `ui/vendor/`.
- **Backend**: Rust via Tauri 2. Handles file I/O, directory watching, and PTY management. The PTY layer uses the `portable-pty` crate.
- **CLI**: A small Rust binary that finds and launches the Tauri app binary, pointing it at a target directory.
- **Storage**: All project data lives in a `.vibe/` directory. No database, no cloud, no accounts.

## License

GPL-3.0. See [LICENSE](LICENSE) for the full text.
