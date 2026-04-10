# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Vibe is a local-first desktop editor for prototyping applications with AI coding agents. Built with Tauri 2 (Rust backend) and vanilla HTML/CSS/JS (no frameworks). It combines a markdown editor, UML diagram editor (Mermaid.js), visual UI builder (.view files), integrated terminal, and file management — all scoped to a `.vibe/` directory per project.

## Build & Development Commands

```bash
bun install                # Install JS dependencies (required first)
bun run build              # Build both Tauri app and CLI (release mode)
bun run dev                # Hot-reload development mode
bun run serve              # Serve UI on port 8080 (standalone preview)
bun run view-editor        # Serve view editor on port 8090
```

The build command runs `cargo build --release` in both `src-tauri/` and `cli/`. There are no test or lint commands configured.

### Prerequisites

- Rust stable toolchain
- Bun package manager
- Linux only: `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libgtk-3-dev libsoup-3.0-dev javascriptcoregtk-4.1 libxdo-dev`

## Architecture

### Backend (src-tauri/src/)

Rust Tauri 2 app exposing commands to the frontend via IPC:

- **lib.rs** — App initialization, registers all Tauri commands, installs CLI on first launch, starts filesystem watcher
- **files.rs** — File tree building (walkdir), CRUD operations on `.vibe/` directory files
- **pty.rs** — Multi-tab PTY management using `portable-pty`. Each tab gets a UUID, reader thread streams output to frontend via `pty-output` events
- **watcher.rs** — Polls filesystem every 1s, emits `vibe-fs-changed` event on changes

State is managed via `AppState` (base_dir + pty map behind `parking_lot::Mutex`).

### Frontend (ui/)

Single-page vanilla JS app — no build step, no bundler:

- **ui/app.js** (~4300 lines) — Main application: file tree, markdown block editor, Mermaid diagram preview, terminal tabs (xterm.js), view editor launcher, keyboard shortcuts, state persistence
- **ui/style.css** — All app styling
- **ui/view-editor/** — Separate full-screen visual UI builder with 3-panel layout (layers/canvas/properties). Uses a custom YAML-based `.view` format with design tokens and responsive breakpoints
- **ui/vendor/** — Bundled libraries (marked, highlight.js, mermaid, xterm, jsPDF, js-yaml)

### CLI (cli/src/main.rs)

Lightweight Rust binary that locates and launches the Tauri app. Searches for the app binary via: `VIBE_APP_PATH` env var → adjacent to CLI → build output paths → `/Applications` → `PATH`.

### Data Model

- Project files: `.vibe/` directory relative to CWD
- App state: `.vibe/.state` (JSON)
- Global theme: `~/.config/vibe/theme.json`
- `.view` files: YAML format defining UI components (frame, text, button, input, image, divider)

## CI/CD

Two GitHub Actions workflows:

- **ci.yml** — Builds on push/PR for macOS (aarch64 + x86_64), Linux (x86_64), Windows (x86_64)
- **release.yml** — Triggered by `v*` tags; builds all platforms, creates draft GitHub release with artifacts (.dmg, .deb, .rpm, .AppImage, .msi, .exe)

## Key Patterns

- Frontend-backend communication is entirely through Tauri's `invoke()` IPC and event system (`listen`/`emit`)
- No frontend framework — DOM manipulation is direct via vanilla JS
- PTY output flows: Rust reader thread → `app_handle.emit("pty-output", ...)` → xterm.js terminal
- File operations are scoped to the `.vibe/` directory for safety
- CSP is disabled in tauri.conf.json (set to `null`)
