# Vibe

> A prototyping editor for building applications with agentic coding.

Vibe is a desktop editor designed around the workflow of prototyping applications with AI coding agents. It combines a markdown editor, a UML diagram editor, and a visual UI editor with a custom `.view` file format that is specifically structured to be readable and writable by AI. Everything is stored as flat files in a `.vibe/` directory, making it easy for agents to read your designs and translate them directly into code. An integrated terminal keeps your shell, your notes, your diagrams, and your UI prototypes in one place.

Built with Tauri 2 and vanilla HTML/CSS/JS. No frameworks, no cloud, no accounts. Local-first and GPL-3.0 licensed.

---

### Contents

- [Features](#features)
  - [Markdown Editor](#markdown-editor)
  - [UML Diagram Editor](#uml-diagram-editor)
  - [View Editor (.view files)](#view-editor-view-files)
  - [Integrated Terminal](#integrated-terminal)
  - [File Management](#file-management)
  - [Theming](#theming)
  - [Keyboard Shortcuts](#keyboard-shortcuts)
- [Installation](#installation)
  - [macOS / Linux](#macos--linux)
  - [Windows](#windows)
  - [CLI](#cli)
- [Building from Source](#building-from-source)
- [Architecture](#architecture)
- [License](#license)

---

## Features

### Markdown Editor

Notes are `.md` files with a block-based editing model. Content is split into blocks at blank lines. Click any block to edit its raw markdown source. Click away or press Shift+Enter to see the rendered output.

- Headings, bold, italic, links, images, blockquotes, tables, lists, task checkboxes, horizontal rules
- Syntax-highlighted code blocks (JavaScript, TypeScript, Python, Rust, Bash, JSON, CSS, HTML/XML)
- Press Enter on an empty line to create a new block below
- Backspace in an empty block deletes it
- Arrow keys at the top or bottom of a block navigate to the adjacent block

### UML Diagram Editor

Diagrams are `.mmd` files using Mermaid syntax. The editor provides a text area on the left and a live-rendered preview on the right.

- Real-time preview with a status indicator (green for valid, red for errors — hover to see the message)
- Built-in templates for class diagrams, sequence diagrams, state diagrams, ER diagrams, flowcharts, Gantt charts, git graphs, mindmaps, timelines, pie charts, and component diagrams
- Zoom controls on the preview (buttons, Cmd+/-, Cmd+scroll)
- Export diagrams to PDF with a native save dialog
- Toggle the preview panel with the Preview button or Cmd+R

### View Editor (.view files)

The `.view` format is a YAML-based UI layout format designed to be readable and editable by both humans and AI agents. An AI can read a `.view` file to understand a UI design and generate corresponding code, or create a `.view` file from a description. The format supports:

- **Element types**: frame, text, button, input, image, divider
- **Layout**: flexbox properties (direction, align, justify, gap, wrap), overflow
- **Styling**: background, border, border radius, opacity, box shadow, typography (color, size, weight, alignment)
- **Design tokens**: reusable colors, typography groups, and spacing values defined in the file header, referenced with `$category.name` syntax (e.g. `$colors.primary`). Typography groups can be spread into a style with the `apply` key.
- **Responsive breakpoints**: style overrides that activate above a specified canvas width
- **Imports**: reference other `.view` files as reusable components

The visual editor opens in a full-screen view with three panels:

- **Layer tree** (left): shows the element hierarchy. Drag and drop to reorder or reparent. Double-click to rename. Right-click for add, duplicate, and delete options.
- **Canvas** (center): renders the live UI. Configurable width and height. Zoom with +/- buttons, Cmd+scroll, or fit-to-view. Click elements to select them, drag handles to resize, drag to move absolutely-positioned elements.
- **Properties** (right): edit the selected element's name, layout, size, spacing, appearance, typography, position, and responsive breakpoints.

Drawing tools on the toolbar: Frame (F), Text (T), Button (B), Input (I), Image (G), Divider (D), Select (V). Press W to import another `.view` file as a component.

A "Sample View" option in the sidebar context menu creates a fully commented example file demonstrating every feature of the format.

### Integrated Terminal

A terminal panel on the right side of the window backed by a real PTY.

- Multiple tabs — click + to add, x to close
- Resizable divider between the editor and terminal
- Shell exit is indicated with a strikethrough tab label
- Cmd+T creates a new tab when the terminal is focused

### File Management

The sidebar shows all files in `.vibe/`. Notes (`.md`, `.mmd`, `.view`) appear in the main tree. Other files (images, data, etc.) appear in a collapsible Resources section.

- Create notes, diagrams, views, and folders via right-click context menu
- Rename by triple-clicking a name in the sidebar or via context menu (duplicate names are detected and blocked)
- Delete via context menu with a confirmation dialog
- Drag and drop files and folders to reorganize (name conflicts shown in red)
- Folder collapse state persists across sessions
- Cmd+N opens a quick create dialog (type a path like `folder/note.md` to create with intermediate directories)
- Cmd+O opens a quick open dialog with fuzzy matching
- A filesystem watcher auto-refreshes the sidebar when files change externally

### Theming

Shift+Cmd+T opens a theme editor where every UI color is configurable: backgrounds, text colors, accent, border, success, error, inline code. Changes preview in real time. Theme is stored globally at `~/.config/vibe/theme.json` and applies across all projects.

### Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| Cmd+N | Quick create file |
| Cmd+O | Quick open file |
| Cmd+B | Toggle sidebar |
| Cmd+R | Toggle diagram preview (in .mmd files) |
| Cmd+T | New terminal tab (when terminal focused) |
| Shift+Cmd+T | Open theme editor |
| Cmd+Z | Undo (view editor) |
| Shift+Cmd+Z | Redo (view editor) |
| Cmd+D | Duplicate element (view editor) |
| Cmd+/Cmd- | Zoom diagram preview |
| Esc | Exit view editor / close dialogs |
| Shift+Enter | Close current block (markdown editor) |
| V / F / T / B / I / G / D | Tool selection (view editor) |
| W | Import view component (view editor) |
| Delete / Backspace | Delete selected element (view editor) |

---

## Installation

### macOS / Linux

```
curl -fsSL https://raw.githubusercontent.com/groothipp/vibe/main/scripts/install.sh | bash
```

Downloads the latest release, installs it, and sets up the `vibe` CLI command. On macOS it installs to `/Applications` and clears the quarantine flag. On Linux it installs the `.deb`, `.rpm`, or `.AppImage` depending on your distro.

Manual install from the [releases page](https://github.com/groothipp/vibe/releases):

- macOS: `.dmg` — drag to Applications, then run `xattr -cr /Applications/Vibe\ Editor.app`
- Debian / Ubuntu: `sudo dpkg -i vibe-editor*.deb`
- Fedora / RHEL: `sudo rpm -i vibe-editor*.rpm`
- Any distro: `chmod +x *.AppImage && ./*.AppImage`

### Windows

```
irm https://raw.githubusercontent.com/groothipp/vibe/main/scripts/install.ps1 | iex
```

Or download and run the `.msi` installer from the [releases page](https://github.com/groothipp/vibe/releases).

### CLI

On first launch (or via the install scripts above), a `vibe` command is installed so you can open the editor from any terminal:

```
vibe              # open in current directory
vibe ~/myproject  # open in a specific directory
```

All project files are stored in a `.vibe/` directory inside the target folder.

---

## Building from Source

Requires Rust and Bun.

```
bun install
bun run build
```

This builds the Tauri app (`src-tauri/target/release/vibe-editor`) and the CLI (`cli/target/release/vibe`).

For development with hot reload:

```
bun run dev
```

---

## Architecture

- **Frontend**: Vanilla HTML, CSS, and JS with no build step. Vendor libraries (marked.js, highlight.js, mermaid.js, xterm.js, jsPDF, js-yaml) are included as pre-built files in `ui/vendor/`.
- **Backend**: Rust via Tauri 2. Handles file I/O, directory watching, and PTY management using the `portable-pty` crate.
- **CLI**: A small wrapper script installed to `/usr/local/bin/vibe` (macOS/Linux) or as `vibe.cmd` (Windows) that launches the app in a target directory.
- **Storage**: All project data lives in `.vibe/` directories. No database, no cloud, no accounts.

---

## License

GPL-3.0. See [LICENSE](LICENSE) for the full text.
