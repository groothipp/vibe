// ─── Tauri API Bridge ────────────────────────────────────────────
let invoke, listen;

function initTauriApi() {
  if (window.__TAURI__) {
    invoke = window.__TAURI__.core.invoke;
    listen = window.__TAURI__.event.listen;
    return true;
  }
  return false;
}

// ─── State ───────────────────────────────────────────────────────
let currentFilePath = null;
let currentFileType = null; // "md", "mmd", or "view"
let blocks = [];        // Array of { id, markdown, element }
let activeBlockIdx = -1;
let saveTimeout = null;
let umlPreviewVisible = false;
let umlRenderTimeout = null;
let umlLastError = null;
let umlZoom = 1.0;
// Terminal tab state
let terminalTabs = [];    // Array of { id, ptyId, term, fitAddon, containerEl, listeners }
let activeTabIdx = -1;
let termTabCounter = 0;

// Persistent app state (stored in .vibe/.state)
let appState = {};
let stateTimeout = null;

async function loadAppState() {
  try {
    const raw = await invoke("read_state");
    appState = JSON.parse(raw);
  } catch (e) {
    appState = {};
  }
}

async function saveAppState() {
  try {
    await invoke("write_state", { content: JSON.stringify(appState, null, 2) });
  } catch (e) {
    console.error("Failed to save app state:", e);
  }
}

function scheduleStateSave() {
  clearTimeout(stateTimeout);
  stateTimeout = setTimeout(() => saveAppState(), 300);
}

// ─── Markdown Setup ──────────────────────────────────────────────
marked.setOptions({
  breaks: true,
  gfm: true,
  highlight: function (code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try { return hljs.highlight(code, { language: lang }).value; } catch (e) {}
    }
    return code;
  },
});

// ─── Disable Default Browser Interactions ────────────────────────
// Block the default context menu everywhere; our custom menus call
// showContextMenu() directly so they never rely on the browser default.
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
}, true);

// Block drag-and-drop defaults
document.addEventListener("dragstart", (e) => e.preventDefault(), true);
document.addEventListener("drop", (e) => e.preventDefault(), true);
document.addEventListener("dragover", (e) => e.preventDefault(), true);

// Block find (Cmd/Ctrl+F), print (Cmd/Ctrl+P), etc.
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && ["f", "p", "g", "u"].includes(e.key.toLowerCase())) {
    e.preventDefault();
  }
  // Block Cmd+R / Ctrl+R reload (but allow through for UML preview toggle)
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "r" && !e.shiftKey) {
    e.preventDefault();
    // Let the global keydown handler pick it up for UML preview toggle
  }
}, true);

// ─── Mermaid Pre-Init (must run before window.load) ──────────────
// Mermaid auto-runs on load with startOnLoad:true by default.
// Disable it immediately so it doesn't interfere with app init.
// Both scripts are defer, so mermaid runs first, then this file.
if (window.mermaid) {
  try { mermaid.initialize({ startOnLoad: false }); } catch (e) { console.warn("Mermaid pre-init failed:", e); }
}

// ─── Initialize ──────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  // Wait for Tauri API to be injected
  if (!initTauriApi()) {
    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (initTauriApi()) {
          clearInterval(check);
          resolve();
        }
      }, 50);
      // Timeout after 5s
      setTimeout(() => { clearInterval(check); resolve(); }, 5000);
    });
  }

  if (!invoke) {
    document.body.innerHTML = '<div style="padding:40px;color:#f7768e;font-family:monospace;">Failed to connect to Tauri backend. Make sure you are running this inside the Tauri app.</div>';
    return;
  }

  // Ensure .vibe directory exists
  try {
    await invoke("create_dir", { path: "" });
  } catch (e) {
    console.log(".vibe dir init:", e);
  }

  await loadAppState();
  loadCollapsedFolders();
  await applySavedTheme();

  initSidebar();
  initResizeHandle();
  initTopbarButtons();
  initEditorClickAway();
  await refreshFileTree();

  // Listen for filesystem changes from the backend watcher
  if (listen) {
    await listen("vibe-fs-changed", () => {
      refreshFileTree();
    });
  }

  // Restore last opened note
  const lastFile = appState.lastOpenFile;
  if (lastFile) {
    try {
      await invoke("read_file", { path: lastFile });
      await openFile(lastFile);
    } catch (e) {
      delete appState.lastOpenFile;
      scheduleStateSave();
    }
  }

  try { initUmlEditor(); } catch (e) { console.error("UML editor init failed:", e); }
  initTerminalTabs();
  await createTerminalTab();
});

// Click outside active block → deactivate it
function initEditorClickAway() {
  document.addEventListener("mousedown", (e) => {
    if (activeBlockIdx < 0 || activeBlockIdx >= blocks.length) return;
    const activeEl = blocks[activeBlockIdx].element;
    if (!activeEl.contains(e.target)) {
      deactivateBlock(activeBlockIdx);
      activeBlockIdx = -1;
    }
  });

  // Click on empty space in the blocks container → activate last empty block or create one
  const container = document.getElementById("blocks-container");
  container.addEventListener("click", (e) => {
    if (e.target !== container) return;
    if (!currentFilePath) return;

    // If the last block is empty, activate it
    if (blocks.length > 0 && blocks[blocks.length - 1].markdown.trim() === "") {
      activateBlock(blocks.length - 1);
    } else {
      // Create a new empty block at the end
      insertBlockAfter(blocks.length - 1, "");
    }
  });
}

// ─── Sidebar / File Tree ─────────────────────────────────────────
function initSidebar() {
  const sidebarToggleBtn = document.getElementById("sidebar-toggle");

  // Restore saved sidebar state (suppress transition to avoid animate-on-load)
  if (appState.sidebarCollapsed) {
    const sidebar = document.getElementById("sidebar");
    sidebar.style.transition = "none";
    sidebar.classList.add("collapsed");
    sidebarToggleBtn.classList.add("collapsed-state");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        sidebar.style.transition = "";
      });
    });
  }

  sidebarToggleBtn.addEventListener("click", () => {
    const sidebar = document.getElementById("sidebar");
    sidebar.classList.toggle("collapsed");
    const collapsed = sidebar.classList.contains("collapsed");
    sidebarToggleBtn.classList.toggle("collapsed-state", collapsed);
    appState.sidebarCollapsed = collapsed;
    scheduleStateSave();
  });

  // Right-click on empty area of the sidebar → create at root
  const fileTree = document.getElementById("file-tree");
  const sidebarSections = document.getElementById("sidebar-sections");
  const resourcesSection = document.getElementById("resources-section");

  // Trigger context menu on any empty sidebar area (not on tree items)
  const sidebarContextItems = [
    { label: "New Note", action: () => promptNewNote("") },
    { label: "New Diagram", action: () => promptNewDiagram("") },
    { label: "New View", action: () => promptNewView("") },
    { label: "Sample View", action: () => createSampleView("") },
    { label: "New Folder", action: () => promptNewFolder("") },
  ];
  const sidebarContextTargets = [fileTree, sidebarSections, resourcesSection];
  for (const target of sidebarContextTargets) {
    if (!target) continue;
    target.addEventListener("contextmenu", (e) => {
      // Only fire if clicking the container background itself, not a child tree-item
      if (e.target === target || e.target.classList.contains("section-header") || e.target.classList.contains("section-label")) {
        e.preventDefault();
        e.stopPropagation();
        showContextMenu(e, sidebarContextItems);
      }
    });
  }

  document.getElementById("sidebar-header").addEventListener("contextmenu", (e) => {
    showContextMenu(e, [
      { label: "New Note", action: () => promptNewNote("") },
      { label: "New Diagram", action: () => promptNewDiagram("") },
      { label: "New View", action: () => promptNewView("") },
      { label: "Sample View", action: () => createSampleView("") },
      { label: "New Folder", action: () => promptNewFolder("") },
    ]);
  });

  // Section collapse toggles (resources only now)
  document.querySelectorAll(".section-header").forEach((header) => {
    header.addEventListener("click", () => {
      const content = document.getElementById("resources-tree");
      const isCollapsed = content.classList.contains("collapsed");
      if (isCollapsed) {
        content.classList.remove("collapsed");
      } else {
        content.classList.add("collapsed");
      }
    });
  });

  // Filesystem polling watchdog in the backend handles all change detection;
  // no need for a periodic refresh here.
}

const collapsedFolders = new Set();

function loadCollapsedFolders() {
  if (Array.isArray(appState.collapsedFolders)) {
    appState.collapsedFolders.forEach(p => collapsedFolders.add(p));
  }
}

function saveCollapsedFolders() {
  appState.collapsedFolders = [...collapsedFolders];
  scheduleStateSave();
}

let inlineRenameActive = false;

async function refreshFileTree() {
  if (inlineRenameActive) return; // Don't rebuild tree during inline rename
  try {
    const tree = await invoke("get_file_tree");
    const notesTree = filterTree(tree, "notes");
    const resourcesTree = filterTree(tree, "resources");
    renderFileTree(notesTree);
    renderResourcesTree(resourcesTree);
  } catch (e) {
    console.error("Failed to load file tree:", e);
  }
}

// Filter tree: "notes" keeps .md files + folders that contain .md files,
// "resources" keeps non-.md files + folders that contain them.
function filterTree(node, mode) {
  if (!node.children) return { ...node, children: [] };

  const filtered = node.children
    .map((child) => {
      if (child.is_dir) {
        const filteredChild = filterTree(child, mode);
        // In notes mode, always show folders so users can drag items into them.
        // In resources mode, only show folders that contain matching files.
        if (mode === "resources" && filteredChild.children.length === 0) return null;
        return filteredChild;
      } else {
        const isMd = child.name.endsWith(".md");
        const isMmd = child.name.endsWith(".mmd");
        const isView = child.name.endsWith(".view");
        const isNote = isMd || isMmd || isView;
        if (mode === "notes" && isNote) return child;
        if (mode === "resources" && !isNote) return child;
        return null;
      }
    })
    .filter(Boolean);

  return { ...node, children: filtered };
}

function getFileCategory(node) {
  if (node.is_dir) return 0; // folders
  const name = node.name.toLowerCase();
  if (name.endsWith('.md')) return 1; // notes
  if (name.endsWith('.mmd')) return 2; // diagrams
  if (name.endsWith('.view')) return 3; // views
  return 4; // everything else
}

function sortChildren(children) {
  return [...children].sort((a, b) => {
    const catA = getFileCategory(a);
    const catB = getFileCategory(b);
    if (catA !== catB) return catA - catB;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

function renderFileTree(node) {
  const container = document.getElementById("file-tree");
  container.innerHTML = "";
  if (node.children) {
    const sorted = sortChildren(node.children);
    sorted.forEach((child) => {
      container.appendChild(createTreeNode(child, ""));
    });
  }
}

let resourcesAnimated = false;

function renderResourcesTree(node) {
  const container = document.getElementById("resources-tree");
  container.innerHTML = "";
  if (node.children && node.children.length > 0) {
    const shouldAnimate = !resourcesAnimated;
    let animIndex = 0;
    node.children.forEach((child) => {
      const el = createResourceNode(child, "");
      if (shouldAnimate) {
        const items = el.classList?.contains("resource-item") ? [el] : el.querySelectorAll(".resource-item");
        items.forEach((item) => {
          item.classList.add("animate-in");
          item.style.animationDelay = `${animIndex * 0.05}s`;
          animIndex++;
        });
      }
      container.appendChild(el);
    });
    resourcesAnimated = true;
    document.getElementById("resources-section").style.display = "";
  } else {
    document.getElementById("resources-section").style.display = "none";
    resourcesAnimated = false;
  }
}

function createResourceNode(node, parentPath) {
  if (node.is_dir) {
    const wrapper = document.createElement("div");
    wrapper.className = "tree-node-wrapper";
    wrapper.dataset.nodePath = node.path || "";
    wrapper.dataset.nodeName = node.name;
    wrapper.dataset.nodeIsDir = "true";

    const item = document.createElement("div");
    item.className = "tree-item resource-item";
    item.innerHTML = `<span class="icon folder-icon">▶</span><span class="name">${escapeHtml(node.name)}</span>`;

    const children = document.createElement("div");
    children.className = "tree-folder-children";

    // Restore persisted collapsed state
    const folderPath = node.path || "";
    if (collapsedFolders.has(folderPath)) {
      children.classList.add("collapsed");
      item.querySelector(".folder-icon").classList.add("collapsed");
    }

    item.addEventListener("click", (e) => {
      if (e.detail === 3) {
        e.preventDefault();
        e.stopPropagation();
        const currentWrapper = wrapper;
        const currentItem = currentWrapper?.querySelector('.tree-item');
        if (currentItem) startInlineRename(currentItem, node.path, node.name, true);
        return;
      }
      if (e.detail === 1) {
        const isCollapsed = children.classList.toggle("collapsed");
        item.querySelector(".folder-icon").classList.toggle("collapsed", isCollapsed);
        if (isCollapsed) {
          collapsedFolders.add(folderPath);
        } else {
          collapsedFolders.delete(folderPath);
        }
        saveCollapsedFolders();
      }
    });

    item.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e, [
        { label: "New Note Here", action: () => promptNewNote(node.path || "") },
        { label: "New Diagram Here", action: () => promptNewDiagram(node.path || "") },
        { label: "New View Here", action: () => promptNewView(node.path || "") },
        { label: "Sample View", action: () => createSampleView(node.path || "") },
        { label: "New Folder Here", action: () => promptNewFolder(node.path || "") },
        { label: "Rename Folder", action: () => {
          const currentItem = wrapper.querySelector('.tree-item');
          if (currentItem) startInlineRename(currentItem, node.path, node.name, true);
        }},
        { label: "Delete Folder", action: () => confirmDelete(node.path, true), danger: true },
      ]);
    });

    node.children.forEach((child) => {
      children.appendChild(createResourceNode(child, node.path || ""));
    });

    wrapper.appendChild(item);
    wrapper.appendChild(children);
    return wrapper;
  } else {
    const wrapper = document.createElement("div");
    wrapper.className = "tree-node-wrapper";
    wrapper.dataset.nodePath = node.path;
    wrapper.dataset.nodeName = node.name;
    wrapper.dataset.nodeIsDir = "false";

    const item = document.createElement("div");
    item.className = "tree-item resource-item";

    item.innerHTML = `<span class="name">${escapeHtml(node.name)}</span>`;
    item.title = node.path;

    item.addEventListener("click", (e) => {
      if (e.detail === 3) {
        e.preventDefault();
        e.stopPropagation();
        const currentItem = wrapper.querySelector('.tree-item');
        if (currentItem) startInlineRename(currentItem, node.path, node.name, false);
        return;
      }
      // Single click does nothing for resources (no opening)
    });

    item.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e, [
        { label: "Rename", action: () => {
          const currentItem = wrapper.querySelector('.tree-item');
          if (currentItem) startInlineRename(currentItem, node.path, node.name, false);
        }},
        { label: "Delete", action: () => confirmDelete(node.path, false), danger: true },
      ]);
    });

    wrapper.appendChild(item);
    return wrapper;
  }
}

function createTreeNode(node, parentPath) {
  if (node.is_dir) {
    const wrapper = document.createElement("div");
    wrapper.className = "tree-node-wrapper";
    wrapper.dataset.nodePath = node.path || "";
    wrapper.dataset.nodeName = node.name;
    wrapper.dataset.nodeIsDir = "true";

    const item = document.createElement("div");
    item.className = "tree-item";
    item.innerHTML = `<span class="icon folder-icon">▶</span><span class="name">${escapeHtml(node.name)}</span>`;

    const children = document.createElement("div");
    children.className = "tree-folder-children";

    // Restore persisted collapsed state
    const folderPath = node.path || "";
    if (collapsedFolders.has(folderPath)) {
      children.classList.add("collapsed");
      item.querySelector(".folder-icon").classList.add("collapsed");
    }

    item.addEventListener("click", (e) => {
      if (e.detail === 3) {
        // Triple-click — rename folder
        e.preventDefault();
        e.stopPropagation();
        const currentWrapper = document.querySelector(`.tree-node-wrapper[data-node-path="${CSS.escape(node.path)}"]`);
        const currentItem = currentWrapper?.querySelector('.tree-item');
        if (currentItem) {
          startInlineRename(currentItem, node.path, node.name, true);
        }
        return;
      }
      if (e.detail === 1) {
        // Single click — toggle folder immediately
        const isCollapsed = children.classList.toggle("collapsed");
        item.querySelector(".folder-icon").classList.toggle("collapsed", isCollapsed);
        if (isCollapsed) {
          collapsedFolders.add(folderPath);
        } else {
          collapsedFolders.delete(folderPath);
        }
        saveCollapsedFolders();
      }
      // detail === 2: ignore (intermediate click before potential triple)
    });

    item.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e, [
        { label: "New Note Here", action: () => promptNewNote(node.path || "") },
        { label: "New Diagram Here", action: () => promptNewDiagram(node.path || "") },
        { label: "New View Here", action: () => promptNewView(node.path || "") },
        { label: "Sample View", action: () => createSampleView(node.path || "") },
        { label: "New Folder Here", action: () => promptNewFolder(node.path || "") },
        { label: "Rename Folder", action: () => {
          const currentWrapper = document.querySelector(`.tree-node-wrapper[data-node-path="${CSS.escape(node.path)}"]`);
          const currentItem = currentWrapper?.querySelector('.tree-item');
          if (currentItem) startInlineRename(currentItem, node.path, node.name, true);
        }},
        { label: "Delete Folder", action: () => confirmDelete(node.path, true), danger: true },
      ]);
    });

    // Custom drag source
    initDragSource(item, { path: node.path, name: node.name, isDir: true });

    const sortedChildren = sortChildren(node.children);
    sortedChildren.forEach((child) => {
      children.appendChild(createTreeNode(child, node.path || ""));
    });

    wrapper.appendChild(item);
    wrapper.appendChild(children);
    return wrapper;
  } else {
    const wrapper = document.createElement("div");
    wrapper.className = "tree-node-wrapper";
    wrapper.dataset.nodePath = node.path;
    wrapper.dataset.nodeName = node.name;
    wrapper.dataset.nodeIsDir = "false";

    const item = document.createElement("div");
    item.className = "tree-item";
    if (currentFilePath === node.path) item.classList.add("active");

    const isMmd = node.name.endsWith(".mmd");
    const isView = node.name.endsWith(".view");
    const isMd = node.name.endsWith(".md");
    const icon = isView ? "⊞" : isMmd ? "◇" : isMd ? "#" : "📄";
    const displayName = isMd ? node.name.slice(0, -3) : isMmd ? node.name.slice(0, -4) : isView ? node.name.slice(0, -5) : node.name;
    item.innerHTML = `<span class="icon${isMmd ? ' uml-icon' : ''}${isView ? ' view-icon' : ''}">${icon}</span><span class="name">${escapeHtml(displayName)}</span>`;

    item.addEventListener("click", (e) => {
      if (e.detail === 3) {
        // Triple-click — rename file
        e.preventDefault();
        e.stopPropagation();
        const currentWrapper = document.querySelector(`.tree-node-wrapper[data-node-path="${CSS.escape(node.path)}"]`);
        const currentItem = currentWrapper?.querySelector('.tree-item');
        if (currentItem) {
          startInlineRename(currentItem, node.path, node.name, false);
        }
        return;
      }
      if (e.detail === 1) {
        // Single click — open file immediately
        openFile(node.path);
      }
      // detail === 2: ignore (intermediate click before potential triple)
    });

    item.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e, [
        { label: "Rename", action: () => promptRename(node.path, node.name) },
        { label: "Delete", action: () => confirmDelete(node.path, false), danger: true },
      ]);
    });

    // Custom drag source
    initDragSource(item, { path: node.path, name: node.name, isDir: false });

    wrapper.appendChild(item);
    return wrapper;
  }
}

// ─── Custom Drag & Drop (mouse-event based) ─────────────────────
let drag = null; // { data, ghost, sourceItem, startX, startY, started }

// Persistent drop indicator line
const dropIndicator = document.createElement("div");
dropIndicator.className = "drop-indicator";
dropIndicator.style.display = "none";
document.body.appendChild(dropIndicator);

function initDragSource(item, data) {
  item.addEventListener("mousedown", (e) => {
    // Only left button, ignore if on a context menu etc
    if (e.button !== 0) return;
    e.preventDefault();

    drag = {
      data,
      ghost: null,
      sourceItem: item,
      startX: e.clientX,
      startY: e.clientY,
      started: false,
    };
  });
}

document.addEventListener("mousemove", (e) => {
  if (!drag) return;

  // Require 5px movement before starting drag
  if (!drag.started) {
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
    drag.started = true;

    // Create ghost
    const ghost = document.createElement("div");
    ghost.className = "drag-ghost";
    ghost.textContent = drag.data.name;
    document.body.appendChild(ghost);
    drag.ghost = ghost;

    drag.sourceItem.classList.add("dragging");
  }

  // Position ghost
  drag.ghost.style.left = (e.clientX + 12) + "px";
  drag.ghost.style.top = (e.clientY - 10) + "px";

  // Hit-test: find which tree-item we're over
  // Temporarily hide ghost and indicator so elementFromPoint hits the real tree
  drag.ghost.style.pointerEvents = "none";
  dropIndicator.style.display = "none";
  const target = document.elementFromPoint(e.clientX, e.clientY);
  drag.ghost.style.pointerEvents = "";

  updateDropIndicator(target, e.clientY);
});

document.addEventListener("mouseup", (e) => {
  if (!drag) return;

  const wasStarted = drag.started;
  const data = drag.data;

  // Clean up ghost
  if (drag.ghost) drag.ghost.remove();
  drag.sourceItem.classList.remove("dragging");

  // Read indicator state before hiding
  const action = dropIndicator.dataset.action;
  const targetPath = dropIndicator.dataset.targetPath;
  const hasConflict = dropIndicator.dataset.conflict === "true";

  dropIndicator.style.display = "none";
  drag = null;

  if (!wasStarted || action !== "into" || targetPath === undefined) return;

  // If there's a name conflict, cancel the drop
  if (hasConflict) return;

  // Execute the drop
  executeMoveInto(data, targetPath);
});

function wouldConflict(dragData, targetDir) {
  // Check if a file/folder with the same name already exists in the target directory
  const dirKey = targetDir || "__root__";
  const container = dirKey === "__root__"
    ? document.getElementById("file-tree")
    : document.querySelector(`.tree-node-wrapper[data-node-path="${CSS.escape(targetDir)}"] > .tree-folder-children`);
  if (!container) return false;
  const existingNames = Array.from(container.children)
    .map((el) => el.dataset?.nodeName)
    .filter(Boolean);
  // It's not a conflict if the source is already in that directory (same item)
  const sourceParent = getParentDir(dragData.path) || "";
  if (sourceParent === (targetDir || "") ) return false;
  return existingNames.includes(dragData.name);
}

function updateDropIndicator(targetEl, mouseY) {
  // Find the closest .tree-item (within #file-tree only, not resources)
  const treeItem = targetEl?.closest?.("#file-tree .tree-item");

  if (!treeItem) {
    dropIndicator.style.display = "none";
    dropIndicator.dataset.action = "";
    return;
  }

  // Find the wrapper to get node data
  const wrapper = treeItem.closest(".tree-node-wrapper");
  if (!wrapper) {
    dropIndicator.style.display = "none";
    return;
  }

  const nodePath = wrapper.dataset.nodePath;
  const isDir = wrapper.dataset.nodeIsDir === "true";

  // Only allow dropping into folders
  if (!isDir) {
    dropIndicator.style.display = "none";
    dropIndicator.dataset.action = "";
    return;
  }

  // Don't drop onto self
  if (nodePath === drag.data.path) {
    dropIndicator.style.display = "none";
    dropIndicator.dataset.action = "";
    return;
  }

  // Don't drop a folder into its own subtree
  if (drag.data.isDir && nodePath.startsWith(drag.data.path + "/")) {
    dropIndicator.style.display = "none";
    dropIndicator.dataset.action = "";
    return;
  }

  const rect = treeItem.getBoundingClientRect();
  const sidebar = document.getElementById("sidebar");
  const sidebarRect = sidebar.getBoundingClientRect();
  const depth = (nodePath.match(/\//g) || []).length;
  const indentPx = 14 + (depth * 12);

  dropIndicator.dataset.targetPath = nodePath;

  // Highlight the folder
  dropIndicator.style.display = "block";
  dropIndicator.style.left = (sidebarRect.left + indentPx - 4) + "px";
  dropIndicator.style.width = (sidebarRect.width - indentPx + 4) + "px";
  dropIndicator.style.top = rect.top + "px";
  dropIndicator.style.height = rect.height + "px";
  const conflict = wouldConflict(drag.data, nodePath);
  dropIndicator.className = "drop-indicator drop-indicator-into" + (conflict ? " drop-indicator-conflict" : "");
  dropIndicator.dataset.action = "into";
  dropIndicator.dataset.conflict = conflict ? "true" : "false";
}

// Get the parent directory of a path
function getParentDir(path) {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.substring(0, idx) : "";
}

async function executeMoveInto(data, targetDir) {
  const sourcePath = data.path;
  const sourceName = data.name;

  if (sourcePath === targetDir) return;
  if (data.isDir && targetDir.startsWith(sourcePath + "/")) return;

  const newPath = targetDir ? `${targetDir}/${sourceName}` : sourceName;
  if (sourcePath === newPath) return;

  try {
    await invoke("rename_path", { oldPath: sourcePath, newPath });
    updateCurrentFileAfterMove(sourcePath, newPath, data.isDir, sourceName, targetDir);
    scheduleStateSave();
    await refreshFileTree();
  } catch (err) {
    console.error("Failed to move:", err);
  }
}

function updateCurrentFileAfterMove(sourcePath, newPath, isDir, sourceName, targetDir) {
  if (currentFilePath === sourcePath) {
    currentFilePath = newPath;
    appState.lastOpenFile = newPath; scheduleStateSave();
    document.getElementById("current-file-path").textContent = newPath;
  } else if (isDir && currentFilePath && currentFilePath.startsWith(sourcePath + "/")) {
    currentFilePath = currentFilePath.replace(sourcePath, targetDir ? `${targetDir}/${sourceName}` : sourceName);
    appState.lastOpenFile = currentFilePath; scheduleStateSave();
    document.getElementById("current-file-path").textContent = currentFilePath;
  }
}

// ─── Context Menu ────────────────────────────────────────────────
function showContextMenu(e, items) {
  removeContextMenu();
  const menu = document.createElement("div");
  menu.className = "context-menu";

  items.forEach(({ label, action, danger }) => {
    const el = document.createElement("div");
    el.className = "context-menu-item" + (danger ? " danger" : "");
    el.textContent = label;
    el.addEventListener("click", () => {
      removeContextMenu();
      action();
    });
    menu.appendChild(el);
  });

  // Temporarily place off-screen to measure dimensions
  menu.style.visibility = "hidden";
  menu.style.left = "0px";
  menu.style.top = "0px";
  document.body.appendChild(menu);

  const menuRect = menu.getBoundingClientRect();
  const winW = window.innerWidth;
  const winH = window.innerHeight;

  let x = e.clientX;
  let y = e.clientY;

  // If menu would overflow the bottom, show it above the cursor
  if (y + menuRect.height > winH) {
    y = Math.max(0, e.clientY - menuRect.height);
  }

  // If menu would overflow the right edge, shift left
  if (x + menuRect.width > winW) {
    x = Math.max(0, winW - menuRect.width);
  }

  menu.style.left = x + "px";
  menu.style.top = y + "px";
  menu.style.visibility = "visible";

  setTimeout(() => {
    document.addEventListener("click", removeContextMenu, { once: true });
  }, 10);
}

function removeContextMenu() {
  document.querySelectorAll(".context-menu").forEach((m) => m.remove());
}

// ─── Dialogs ─────────────────────────────────────────────────────
function showConfirmDialog(title, message) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay";

    overlay.innerHTML = `
      <div class="dialog">
        <h3>${escapeHtml(title)}</h3>
        <p style="margin:0 0 16px;color:var(--text-secondary,#aaa);">${escapeHtml(message)}</p>
        <div class="dialog-buttons">
          <button class="cancel">Cancel</button>
          <button class="primary confirm danger-btn">Delete</button>
        </div>
      </div>
    `;

    overlay.querySelector(".cancel").addEventListener("click", () => { overlay.remove(); resolve(false); });
    overlay.querySelector(".confirm").addEventListener("click", () => { overlay.remove(); resolve(true); });
    overlay.addEventListener("click", (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
    document.addEventListener("keydown", function handler(e) {
      if (e.key === "Enter") { overlay.remove(); resolve(true); document.removeEventListener("keydown", handler); }
      if (e.key === "Escape") { overlay.remove(); resolve(false); document.removeEventListener("keydown", handler); }
    });

    document.body.appendChild(overlay);
    overlay.querySelector(".confirm").focus();
  });
}

function showDialog(title, placeholder, defaultValue = "") {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay";

    overlay.innerHTML = `
      <div class="dialog">
        <h3>${escapeHtml(title)}</h3>
        <input type="text" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(defaultValue)}" />
        <div class="dialog-buttons">
          <button class="cancel">Cancel</button>
          <button class="primary confirm">OK</button>
        </div>
      </div>
    `;

    const input = overlay.querySelector("input");
    overlay.querySelector(".cancel").addEventListener("click", () => { overlay.remove(); resolve(null); });
    overlay.querySelector(".confirm").addEventListener("click", () => { overlay.remove(); resolve(input.value); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { overlay.remove(); resolve(input.value); }
      if (e.key === "Escape") { overlay.remove(); resolve(null); }
    });

    document.body.appendChild(overlay);
    input.focus();
    input.select();
  });
}

// ─── Topbar Buttons ──────────────────────────────────────────────
function initTopbarButtons() {
  // Top bar buttons removed — new notes/folders via sidebar right-click
}

async function promptNewNote(parentDir) {
  const name = await showDialog("New Note", "filename", "untitled");
  if (!name) return;
  const fileName = name.endsWith(".md") ? name : name + ".md";
  const path = parentDir ? `${parentDir}/${fileName}` : fileName;
  try {
    await invoke("create_file", { path });
    await refreshFileTree();
    openFile(path);
  } catch (e) {
    console.error("Failed to create note:", e);
  }
}

async function promptNewView(parentDir) {
  const name = await showDialog("New View", "filename", "untitled");
  if (!name) return;
  const fileName = name.endsWith(".view") ? name : name + ".view";
  const path = parentDir ? `${parentDir}/${fileName}` : fileName;
  const isSample = fileName === "sample.view";
  const content = isSample ? SAMPLE_VIEW_CONTENT : DEFAULT_VIEW_CONTENT;
  try {
    await invoke("write_file", { path, content });
    await refreshFileTree();
    openFile(path);
  } catch (e) {
    console.error("Failed to create view:", e);
  }
}

async function createSampleView(parentDir) {
  const path = parentDir ? `${parentDir}/sample.view` : "sample.view";
  try {
    await invoke("write_file", { path, content: SAMPLE_VIEW_CONTENT });
    await refreshFileTree();
    openFile(path);
  } catch (e) {
    console.error("Failed to create sample view:", e);
  }
}

const DEFAULT_VIEW_CONTENT = `name: Untitled View
canvas:
  width: 390
  height: 844

tree:
  - id: root
    type: frame
    name: Root
    style:
      width: "100%"
      height: "100%"
      background: "#111111"
      display: flex
      flexDirection: column
      alignItems: center
      padding: 24
      gap: 16
`;

const SAMPLE_VIEW_CONTENT = `# This is a sample .view file demonstrating the full format.
# View files describe UI layouts in YAML. AI can read these
# to help construct user interfaces in code.

name: Login Screen
canvas:
  width: 390
  height: 844

# Tokens: reusable design values scoped to this file.
# Reference them with $category.name (e.g. $colors.primary)
tokens:
  colors:
    primary: "#6366F1"
    surface: "#1A1A1A"
    bg: "#0A0A0A"
    border: "#333333"
    text: "#FFFFFF"
    muted: "#666666"
  typography:
    body:
      fontSize: 16
      fontWeight: 400
    button:
      fontSize: 16
      fontWeight: 600
    caption:
      fontSize: 14
      fontWeight: 400
  spacing:
    sm: 8
    md: 16
    lg: 24
    xl: 32

# Imports: reference other .view files as reusable components.
# imports:
#   - name: AppHeader
#     from: ./components/header.view

# Tree: the UI hierarchy. Each node has a type, name, style, and optional children.
# Types: frame, text, button, input, image, icon, divider
# Styles use CSS property names. Numbers are pixels, strings for %, compound values.
tree:
  - id: root
    type: frame
    name: Background
    style:
      width: "100%"
      height: "100%"
      background: "$colors.bg"
      display: flex
      flexDirection: column
      alignItems: center
      justifyContent: center
      padding: "$spacing.lg"
      gap: "$spacing.xl"

    children:
      - id: logo
        type: frame
        name: Logo
        style:
          width: 80
          height: 80
          borderRadius: 16
          background: "linear-gradient(135deg, #6366F1, #8B5CF6)"

      - id: heading
        type: text
        name: Welcome Title
        text: "Welcome back"
        style:
          color: "$colors.text"
          fontSize: 28
          fontWeight: 700
          textAlign: center

      - id: subtitle
        type: text
        name: Subtitle
        text: "Sign in to your account"
        style:
          color: "$colors.muted"
          # apply: spreads a token group into the style
          apply: "$typography.caption"
          textAlign: center

      - id: form
        type: frame
        name: Login Form
        style:
          width: "100%"
          display: flex
          flexDirection: column
          gap: "$spacing.md"

        children:
          - id: email-input
            type: input
            name: Email Field
            placeholder: "Email address"
            style:
              height: 48
              background: "$colors.surface"
              borderRadius: 8
              border: "1px solid $colors.border"
              color: "$colors.text"
              apply: "$typography.body"
              padding: "0 16px"
              # responsive: override styles above a canvas width
              responsive:
                - above: 768
                  height: 56
                  fontSize: 18

          - id: password-input
            type: input
            name: Password Field
            placeholder: "Password"
            style:
              height: 48
              background: "$colors.surface"
              borderRadius: 8
              border: "1px solid $colors.border"
              color: "$colors.text"
              apply: "$typography.body"
              padding: "0 16px"

          - id: login-btn
            type: button
            name: Sign In Button
            text: "Sign In"
            style:
              height: 48
              background: "$colors.primary"
              borderRadius: 8
              color: "$colors.text"
              apply: "$typography.button"
              responsive:
                - above: 768
                  height: 56

      - id: divider-row
        type: frame
        name: Divider Row
        style:
          width: "100%"
          display: flex
          alignItems: center
          gap: "$spacing.md"

        children:
          - id: divider-left
            type: divider
            name: Left Line
            style:
              width: "100%"
              height: 1
              background: "$colors.border"

          - id: or-text
            type: text
            name: Or Text
            text: "or"
            style:
              color: "$colors.muted"
              fontSize: 12

          - id: divider-right
            type: divider
            name: Right Line
            style:
              width: "100%"
              height: 1
              background: "$colors.border"

      - id: footer
        type: text
        name: Footer Text
        text: "Don't have an account? Sign up"
        style:
          color: "$colors.muted"
          apply: "$typography.caption"
`;

async function promptNewFolder(parentDir) {
  const name = await showDialog("New Folder", "folder-name");
  if (!name) return;
  const path = parentDir ? `${parentDir}/${name}` : name;
  try {
    await invoke("create_dir", { path });
    await refreshFileTree();
  } catch (e) {
    console.error("Failed to create folder:", e);
  }
}

async function promptNewDiagram(parentDir) {
  const name = await showDialog("New Diagram", "diagram-name", "untitled");
  if (!name) return;
  const fileName = name.endsWith(".mmd") ? name : name + ".mmd";
  const path = parentDir ? `${parentDir}/${fileName}` : fileName;
  const defaultContent = "classDiagram\n    class MyClass {\n        +String name\n    }\n";
  try {
    await invoke("write_file", { path, content: defaultContent });
    await refreshFileTree();
    openFile(path);
  } catch (e) {
    console.error("Failed to create diagram:", e);
  }
}

async function promptRename(oldPath, oldName) {
  const newName = await showDialog("Rename", "new-name", oldName);
  if (!newName || newName === oldName) return;
  const parts = oldPath.split("/");
  parts[parts.length - 1] = newName;
  const newPath = parts.join("/");
  try {
    await invoke("rename_path", { oldPath, newPath });
    if (currentFilePath === oldPath) {
      currentFilePath = newPath;
      appState.lastOpenFile = newPath; scheduleStateSave();
      document.getElementById("current-file-path").textContent = newPath;
    }
    await refreshFileTree();
  } catch (e) {
    console.error("Failed to rename:", e);
  }
}

async function confirmDelete(path, isDir) {
  const type = isDir ? "folder" : "file";
  const name = path.split("/").pop();
  const confirmed = await showConfirmDialog(`Delete ${type}`, `Delete ${type} "${name}"? This cannot be undone.`);
  if (!confirmed) return;
  try {
    await invoke("delete_path", { path });
    if (currentFilePath === path) {
      currentFilePath = null;
      delete appState.lastOpenFile; scheduleStateSave();
      showWelcome();
    }
    await refreshFileTree();
  } catch (e) {
    console.error("Failed to delete:", e);
  }
}

// ─── File Open / Save ────────────────────────────────────────────
async function openFile(path) {
  // Save current file first
  if (currentFilePath) {
    await saveCurrentFile();
  }

  try {
    const content = await invoke("read_file", { path });
    currentFilePath = path;
    currentFileType = path.endsWith(".mmd") ? "mmd" : path.endsWith(".view") ? "view" : "md";
    appState.lastOpenFile = path; scheduleStateSave();
    document.getElementById("current-file-path").textContent = path;
    document.getElementById("editor-welcome").style.display = "none";

    if (currentFileType === "view") {
      document.getElementById("editor-container").style.display = "none";
      document.getElementById("uml-editor").style.display = "none";
      document.getElementById("view-editor").style.display = "flex";
      hideUmlPreview();
      enterViewEditorMode();
      veLoadFile(content);
    } else if (currentFileType === "mmd") {
      exitViewEditorMode();
      document.getElementById("editor-container").style.display = "none";
      document.getElementById("uml-editor").style.display = "flex";
      document.getElementById("view-editor").style.display = "none";
      loadUmlEditor(content);
    } else {
      exitViewEditorMode();
      document.getElementById("uml-editor").style.display = "none";
      document.getElementById("editor-container").style.display = "block";
      document.getElementById("view-editor").style.display = "none";
      hideUmlPreview();
      loadBlocks(content);
    }
    await refreshFileTree();
  } catch (e) {
    console.error("Failed to open file:", e);
  }
}

function showWelcome() {
  exitViewEditorMode();
  document.getElementById("editor-welcome").style.display = "flex";
  document.getElementById("editor-container").style.display = "none";
  document.getElementById("uml-editor").style.display = "none";
  document.getElementById("view-editor").style.display = "none";
  document.getElementById("current-file-path").textContent = "";
  hideUmlPreview();
}

// ── View editor fullscreen mode ──
let _veFullscreen = false;

function enterViewEditorMode() {
  if (_veFullscreen) return;
  _veFullscreen = true;
  document.getElementById("sidebar").style.display = "none";
  document.getElementById("resize-handle").style.display = "none";
  document.getElementById("terminal-panel").style.display = "none";
  document.getElementById("topbar").style.display = "none";
}

function exitViewEditorMode() {
  if (!_veFullscreen) return;
  _veFullscreen = false;
  document.getElementById("sidebar").style.display = "";
  document.getElementById("resize-handle").style.display = "";
  document.getElementById("terminal-panel").style.display = "";
  document.getElementById("topbar").style.display = "";
}

async function saveCurrentFile() {
  if (!currentFilePath) return;
  let content;
  if (currentFileType === "view") {
    content = veGetContent();
  } else if (currentFileType === "mmd") {
    content = document.getElementById("uml-textarea").value;
  } else {
    content = blocks.map((b) => b.markdown).join("\n\n");
  }
  try {
    await invoke("write_file", { path: currentFilePath, content });
  } catch (e) {
    console.error("Failed to save:", e);
  }
}

function scheduleSave() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => saveCurrentFile(), 800);
}

// ─── Block Editor ────────────────────────────────────────────────
// Splits content into blocks separated by double-newlines.
// Current block is an editable textarea; others are rendered HTML.

function loadBlocks(content) {
  const container = document.getElementById("blocks-container");
  container.innerHTML = "";
  blocks = [];
  activeBlockIdx = -1;

  // Split into blocks (double newline). Keep code fences intact.
  const rawBlocks = splitIntoBlocks(content);

  rawBlocks.forEach((md, i) => {
    const block = { id: i, markdown: md, element: null };
    blocks.push(block);
    const el = createRenderedBlock(block, i);
    container.appendChild(el);
  });

  // If empty (no blocks), add a single empty block (but don't auto-activate)
  if (blocks.length === 0) {
    const block = { id: 0, markdown: "", element: null };
    blocks.push(block);
    const el = createRenderedBlock(block, 0);
    container.appendChild(el);
  }
}

function splitIntoBlocks(content) {
  if (!content.trim()) return [""];

  const lines = content.split("\n");
  const rawBlocks = [];
  let current = [];
  let inCodeFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isFence = /^```/.test(line.trim());

    if (isFence) inCodeFence = !inCodeFence;

    if (!inCodeFence && line.trim() === "" && current.length > 0) {
      // Check if next line is also empty (double newline = block break)
      // Actually, let's use single blank line as block separator for simplicity
      rawBlocks.push(current.join("\n"));
      current = [];
    } else {
      current.push(line);
    }
  }

  if (current.length > 0) {
    rawBlocks.push(current.join("\n"));
  }

  return rawBlocks;
}

function createRenderedBlock(block, idx) {
  const el = document.createElement("div");
  el.className = "block";
  block.element = el;

  const html = renderMarkdown(block.markdown);
  if (html) {
    const rendered = document.createElement("div");
    rendered.className = "block-rendered";
    rendered.innerHTML = html;
    rendered.addEventListener("click", () => activateBlock(idx));
    el.appendChild(rendered);
  } else {
    // Show an empty placeholder that can be clicked to start editing
    const placeholder = document.createElement("div");
    placeholder.className = "block-rendered block-placeholder";
    placeholder.innerHTML = '<span class="placeholder-text">Click to start writing…</span>';
    placeholder.addEventListener("click", () => activateBlock(idx));
    el.appendChild(placeholder);
  }

  return el;
}

function activateBlock(idx) {
  // Deactivate previous block
  if (activeBlockIdx >= 0 && activeBlockIdx < blocks.length && activeBlockIdx !== idx) {
    deactivateBlock(activeBlockIdx);
  }

  if (idx < 0 || idx >= blocks.length) return;
  activeBlockIdx = idx;

  const block = blocks[idx];
  const el = block.element;
  el.innerHTML = "";
  el.className = "block block-editing";
  el.style.display = "";

  const textarea = document.createElement("textarea");
  textarea.value = block.markdown;
  textarea.spellcheck = false;
  el.appendChild(textarea);

  // Auto-resize textarea based on content
  const autoResize = () => {
    // Temporarily shrink to 0 so scrollHeight reflects actual content, not current size
    textarea.style.height = "0px";
    textarea.style.height = textarea.scrollHeight + "px";
  };

  textarea.addEventListener("input", () => {
    block.markdown = textarea.value;
    autoResize();
    scheduleSave();
  });

  // Handle Enter for new block creation (double enter on empty line)
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      const val = textarea.value;
      const pos = textarea.selectionStart;
      const before = val.substring(0, pos);
      const after = val.substring(pos);

      // If cursor is at end and last line is empty → new block
      if (after.trim() === "" && before.endsWith("\n")) {
        e.preventDefault();
        block.markdown = before.trimEnd();
        textarea.value = block.markdown;

        // Insert new block after current
        insertBlockAfter(idx, "");
        return;
      }
    }

    // Shift+Enter → close/deactivate current block
    if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      block.markdown = textarea.value;
      deactivateBlock(idx);
      activeBlockIdx = -1;
      return;
    }

    // Navigate blocks with arrow keys
    if (e.key === "ArrowUp" && textarea.selectionStart === 0) {
      e.preventDefault();
      if (idx > 0) activateBlock(idx - 1);
    }
    if (e.key === "ArrowDown" && textarea.selectionEnd === textarea.value.length) {
      e.preventDefault();
      if (idx < blocks.length - 1) activateBlock(idx + 1);
    }

    // Backspace at start of empty block → delete block
    if (e.key === "Backspace" && textarea.value === "" && blocks.length > 1) {
      e.preventDefault();
      deleteBlock(idx);
      return;
    }
  });

  textarea.focus();
  // Place cursor at end
  textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
  autoResize();
}

function deactivateBlock(idx) {
  if (idx < 0 || idx >= blocks.length) return;
  const block = blocks[idx];
  const el = block.element;

  el.innerHTML = "";
  el.className = "block";

  const html = renderMarkdown(block.markdown);
  if (html) {
    el.style.display = "";
    const rendered = document.createElement("div");
    rendered.className = "block-rendered";
    rendered.innerHTML = html;
    rendered.addEventListener("click", () => activateBlock(idx));
    el.appendChild(rendered);
  } else {
    el.style.display = "";
    // Show an empty placeholder that can be clicked to start editing
    const placeholder = document.createElement("div");
    placeholder.className = "block-rendered block-placeholder";
    placeholder.innerHTML = '<span class="placeholder-text">Click to start writing…</span>';
    placeholder.addEventListener("click", () => activateBlock(idx));
    el.appendChild(placeholder);
  }
}

function insertBlockAfter(idx, markdown) {
  const container = document.getElementById("blocks-container");
  const newBlock = { id: Date.now(), markdown, element: null };

  blocks.splice(idx + 1, 0, newBlock);
  const el = createRenderedBlock(newBlock, idx + 1);

  if (idx + 1 < blocks.length - 1) {
    container.insertBefore(el, blocks[idx + 2]?.element);
  } else {
    container.appendChild(el);
  }

  // Re-index click handlers
  reindexBlocks();
  activateBlock(idx + 1);
  scheduleSave();
}

function deleteBlock(idx) {
  const container = document.getElementById("blocks-container");
  const block = blocks[idx];
  container.removeChild(block.element);
  blocks.splice(idx, 1);

  reindexBlocks();

  const newIdx = Math.min(idx, blocks.length - 1);
  activateBlock(newIdx);
  scheduleSave();
}

function reindexBlocks() {
  blocks.forEach((block, i) => {
    block.element.querySelectorAll(".block-rendered").forEach((r) => {
      // Re-bind click
      r.replaceWith(r.cloneNode(true));
    });
    // Simpler: just recreate rendered blocks for inactive ones
    if (i !== activeBlockIdx) {
      const el = block.element;
      const rendered = el.querySelector(".block-rendered");
      if (rendered) {
        const newRendered = rendered.cloneNode(true);
        newRendered.addEventListener("click", () => activateBlock(i));
        el.replaceChild(newRendered, rendered);
      }
    }
  });
}

function renderMarkdown(md) {
  if (!md.trim()) return "";
  return marked.parse(md);
}

// ─── Terminal Tabs ───────────────────────────────────────────────
const TERM_THEME = {
  background: "#1c1a17",
  foreground: "#c8c4b8",
  cursor: "#8cb369",
  cursorAccent: "#1c1a17",
  selectionBackground: "#3a3630",
  black: "#161412",
  red: "#e07a6e",
  green: "#8cb369",
  yellow: "#d4a54a",
  blue: "#6d9a5b",
  magenta: "#a68daf",
  cyan: "#6dba94",
  white: "#b0ab9e",
  brightBlack: "#4a4640",
  brightRed: "#e07a6e",
  brightGreen: "#8cb369",
  brightYellow: "#d4a54a",
  brightBlue: "#6d9a5b",
  brightMagenta: "#a68daf",
  brightCyan: "#6dba94",
  brightWhite: "#c8c4b8",
};

function initTerminalTabs() {
  const tabBar = document.getElementById("terminal-tabs");
  const addBtn = document.getElementById("terminal-tab-add");
  addBtn.addEventListener("click", () => createTerminalTab());

  // Click anywhere in the terminal panel to re-focus the active xterm
  const termPanel = document.getElementById("terminal-panel");
  termPanel.addEventListener("mousedown", () => {
    const tab = terminalTabs[activeTabIdx];
    if (tab) tab.term.focus();
  });

  // Resize observer on the wrapper — fits whichever tab is active
  const wrapper = document.getElementById("terminal-container");
  let resizeTimeout = null;
  const resizeObserver = new ResizeObserver(() => {
    if (resizeTimeout) clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      const tab = terminalTabs[activeTabIdx];
      if (!tab) return;
      tab.fitAddon.fit();
      if (tab.term.rows !== tab.prevRows || tab.term.cols !== tab.prevCols) {
        tab.prevRows = tab.term.rows;
        tab.prevCols = tab.term.cols;
        invoke("pty_resize", {
          id: tab.ptyId,
          rows: tab.term.rows,
          cols: tab.term.cols,
        }).catch(console.error);
      }
    }, 50);
  });
  resizeObserver.observe(wrapper);
}

async function createTerminalTab() {
  termTabCounter++;
  const idx = terminalTabs.length;
  const ptyId = `tab-${termTabCounter}-${Date.now()}`;
  const wrapper = document.getElementById("terminal-container");

  // Create a container div for this tab's xterm instance
  const containerEl = document.createElement("div");
  containerEl.className = "term-tab-content";
  containerEl.style.display = "none";
  wrapper.appendChild(containerEl);

  const term = new Terminal({
    fontFamily: '"JetBrains Mono", "SF Mono", "Fira Code", monospace',
    fontSize: 13,
    lineHeight: 1.3,
    theme: TERM_THEME,
    cursorBlink: true,
    allowProposedApi: true,
  });

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(containerEl);

  const tabObj = {
    id: termTabCounter,
    ptyId,
    term,
    fitAddon,
    containerEl,
    prevRows: term.rows,
    prevCols: term.cols,
    listeners: [],
    closed: false,
  };
  terminalTabs.push(tabObj);

  // Switch to this tab (makes container visible so fit() works)
  switchTerminalTab(idx);

  // Small delay to let DOM settle before fitting
  await new Promise((r) => setTimeout(r, 100));
  fitAddon.fit();

  try {
    await invoke("pty_create", {
      id: ptyId,
      rows: term.rows,
      cols: term.cols,
    });

    const unlOutput = await listen(`pty-output-${ptyId}`, (event) => {
      term.write(event.payload);
    });
    tabObj.listeners.push(unlOutput);

    const unlClose = await listen(`pty-close-${ptyId}`, () => {
      tabObj.closed = true;
      term.writeln("\r\n\x1b[90m[Shell exited]\x1b[0m");
      renderTerminalTabs();
    });
    tabObj.listeners.push(unlClose);

    term.onData((data) => {
      invoke("pty_write", { id: ptyId, data }).catch(console.error);
    });
  } catch (e) {
    console.error("Failed to create PTY session:", e);
    term.writeln(`\x1b[31mFailed to start shell: ${e}\x1b[0m`);
  }

  renderTerminalTabs();
}

function switchTerminalTab(idx) {
  if (idx < 0 || idx >= terminalTabs.length) return;
  activeTabIdx = idx;

  terminalTabs.forEach((tab, i) => {
    tab.containerEl.style.display = i === idx ? "block" : "none";
  });

  // Fit the newly visible tab
  const tab = terminalTabs[idx];
  setTimeout(() => {
    tab.fitAddon.fit();
    tab.term.focus();
  }, 0);

  renderTerminalTabs();
}

function closeTerminalTab(idx) {
  if (idx < 0 || idx >= terminalTabs.length) return;
  const tab = terminalTabs[idx];

  // Unlisten PTY events
  tab.listeners.forEach((unlisten) => unlisten());

  // Close PTY session on backend
  invoke("pty_close", { id: tab.ptyId }).catch(() => {});

  // Dispose xterm
  tab.term.dispose();
  tab.containerEl.remove();

  terminalTabs.splice(idx, 1);

  if (terminalTabs.length === 0) {
    // Always keep at least one tab
    activeTabIdx = -1;
    createTerminalTab();
    return;
  }

  // Adjust activeTabIdx
  if (activeTabIdx >= terminalTabs.length) {
    activeTabIdx = terminalTabs.length - 1;
  } else if (activeTabIdx > idx) {
    activeTabIdx--;
  } else if (activeTabIdx === idx) {
    activeTabIdx = Math.min(idx, terminalTabs.length - 1);
  }

  switchTerminalTab(activeTabIdx);
}

function renderTerminalTabs() {
  const tabBar = document.getElementById("terminal-tabs");
  // Remove existing tab buttons (keep the + button)
  tabBar.querySelectorAll(".term-tab").forEach((el) => el.remove());

  const addBtn = document.getElementById("terminal-tab-add");

  terminalTabs.forEach((tab, i) => {
    const btn = document.createElement("button");
    btn.className = "term-tab" + (i === activeTabIdx ? " active" : "");
    if (tab.closed) btn.classList.add("exited");

    const label = document.createElement("span");
    label.className = "term-tab-label";
    label.textContent = `Shell ${tab.id}`;
    btn.appendChild(label);

    const closeBtn = document.createElement("span");
    closeBtn.className = "term-tab-close";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTerminalTab(i);
    });
    btn.appendChild(closeBtn);

    btn.addEventListener("click", () => switchTerminalTab(i));
    tabBar.insertBefore(btn, addBtn);
  });
}

// ─── Panel Resize Handle ─────────────────────────────────────────
function initResizeHandle() {
  const handle = document.getElementById("resize-handle");
  const editorPanel = document.getElementById("editor-panel");
  const terminalPanel = document.getElementById("terminal-panel");
  const container = document.getElementById("main-container");

  let isDragging = false;

  handle.addEventListener("mousedown", (e) => {
    isDragging = true;
    handle.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;

    const sidebar = document.getElementById("sidebar");
    const sidebarWidth = sidebar.classList.contains("collapsed") ? 0 : sidebar.offsetWidth;
    const containerRect = container.getBoundingClientRect();
    const available = containerRect.width - sidebarWidth - 4; // 4 for handle
    const mouseX = e.clientX - containerRect.left - sidebarWidth;

    const editorWidth = Math.max(200, Math.min(available - 200, mouseX));
    const termWidth = available - editorWidth;

    editorPanel.style.flex = "none";
    editorPanel.style.width = editorWidth + "px";
    terminalPanel.style.flex = "none";
    terminalPanel.style.width = termWidth + "px";

    const activeTab = terminalTabs[activeTabIdx];
    if (activeTab) activeTab.fitAddon.fit();
  });

  document.addEventListener("mouseup", () => {
    if (isDragging) {
      isDragging = false;
      handle.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
  });
}

// ─── Quick Create (Super+N) ──────────────────────────────────────
function showQuickCreate() {
  // Don't stack multiple
  if (document.querySelector(".quick-create-overlay")) return;

  const overlay = document.createElement("div");
  overlay.className = "quick-create-overlay";

  const box = document.createElement("div");
  box.className = "quick-create-box";

  const label = document.createElement("div");
  label.className = "quick-create-label";
  label.textContent = "New note path";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "folder/subfolder/note.md";
  input.spellcheck = false;

  const error = document.createElement("div");
  error.className = "quick-create-error";
  error.style.display = "none";

  const hint = document.createElement("div");
  hint.className = "quick-create-hint";
  hint.textContent = "Enter to create · Esc to cancel";

  box.appendChild(label);
  box.appendChild(input);
  box.appendChild(error);
  box.appendChild(hint);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  input.focus();

  // Hide error on typing
  input.addEventListener("input", () => {
    error.style.display = "none";
  });

  input.addEventListener("keydown", async (e) => {
    if (e.key === "Escape") {
      overlay.remove();
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      let path = input.value.trim();
      if (!path) return;

      // Block path traversal — must stay within .vibe/
      if (path.startsWith("/") || path.includes("..")) {
        error.textContent = "Path must stay within the project directory";
        error.style.display = "block";
        return;
      }

      // Strip leading ./ if present
      if (path.startsWith("./")) path = path.slice(2);

      // Auto-append .md if no extension (unless it looks like .mmd or .view)
      if (!path.includes(".")) path += ".md";

      try {
        // Check if file already exists by trying to read it
        await invoke("read_file", { path });
        // If we get here, file exists — show error
        error.textContent = `"${path}" already exists`;
        error.style.display = "block";
        input.select();
      } catch {
        // File doesn't exist — create it
        try {
          // Use appropriate default content based on extension
          let content = "";
          if (path.endsWith(".view")) {
            content = path.endsWith("sample.view") ? SAMPLE_VIEW_CONTENT : DEFAULT_VIEW_CONTENT;
          } else if (path.endsWith(".mmd")) {
            content = "classDiagram\n    class MyClass {\n        +String name\n    }\n";
          }
          await invoke("write_file", { path, content });
          overlay.remove();
          await refreshFileTree();
          openFile(path);
        } catch (createErr) {
          error.textContent = `Failed to create: ${createErr}`;
          error.style.display = "block";
        }
      }
    }
  });

  // Click outside to close
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) overlay.remove();
  });
}

// ─── Quick Open (Super+O) ────────────────────────────────────────
function showQuickOpen() {
  if (document.querySelector(".quick-create-overlay")) return;

  const overlay = document.createElement("div");
  overlay.className = "quick-create-overlay";

  const box = document.createElement("div");
  box.className = "quick-create-box";

  const label = document.createElement("div");
  label.className = "quick-create-label";
  label.textContent = "Open note";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Start typing to filter…";
  input.spellcheck = false;

  const results = document.createElement("div");
  results.className = "quick-open-results";

  const error = document.createElement("div");
  error.className = "quick-create-error";
  error.style.display = "none";

  const hint = document.createElement("div");
  hint.className = "quick-create-hint";
  hint.textContent = "↑↓ Navigate · Enter to open · Esc to cancel";

  box.appendChild(label);
  box.appendChild(input);
  box.appendChild(results);
  box.appendChild(error);
  box.appendChild(hint);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  let allFiles = [];
  let filtered = [];
  let selectedIdx = 0;

  // Collect all .md files from the tree
  async function loadFiles() {
    try {
      const tree = await invoke("get_file_tree");
      allFiles = [];
      collectMdFiles(tree, allFiles);
      updateResults();
    } catch (e) {
      console.error("Failed to load file tree for quick open:", e);
    }
  }

  function collectMdFiles(node, list) {
    if (!node.children) return;
    for (const child of node.children) {
      if (child.is_dir) {
        collectMdFiles(child, list);
      } else if (child.name.endsWith(".md") || child.name.endsWith(".mmd") || child.name.endsWith(".view")) {
        list.push(child.path);
      }
    }
  }

  function updateResults() {
    const query = input.value.trim().toLowerCase();
    error.style.display = "none";

    if (query === "") {
      filtered = [...allFiles];
    } else {
      // Fuzzy-ish path matching: all query chars must appear in order
      filtered = allFiles.filter((path) => {
        const lower = path.toLowerCase();
        let qi = 0;
        for (let i = 0; i < lower.length && qi < query.length; i++) {
          if (lower[i] === query[qi]) qi++;
        }
        return qi === query.length;
      });

      // Sort: prefer paths that start with or contain the query as substring
      filtered.sort((a, b) => {
        const al = a.toLowerCase(), bl = b.toLowerCase();
        const aExact = al.includes(query) ? 0 : 1;
        const bExact = bl.includes(query) ? 0 : 1;
        if (aExact !== bExact) return aExact - bExact;
        return al.localeCompare(bl);
      });
    }

    selectedIdx = Math.max(0, Math.min(selectedIdx, filtered.length - 1));
    renderResults();
  }

  function renderResults() {
    results.innerHTML = "";

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "quick-open-empty";
      empty.textContent = allFiles.length === 0 ? "No notes found" : "No matches";
      results.appendChild(empty);
      return;
    }

    // Show max 10 results
    const visible = filtered.slice(0, 10);
    visible.forEach((path, i) => {
      const item = document.createElement("div");
      item.className = "quick-open-item" + (i === selectedIdx ? " selected" : "");

      const name = path.split("/").pop();
      const dir = path.includes("/") ? path.substring(0, path.lastIndexOf("/")) + "/" : "";

      item.innerHTML = `<span class="quick-open-name">${escapeHtml(name)}</span><span class="quick-open-path">${escapeHtml(dir)}</span>`;

      item.addEventListener("click", () => {
        overlay.remove();
        openFile(path);
      });
      item.addEventListener("mouseenter", () => {
        selectedIdx = i;
        renderResults();
      });

      results.appendChild(item);
    });

    // Scroll selected into view
    const sel = results.querySelector(".selected");
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }

  input.addEventListener("input", () => {
    selectedIdx = 0;
    updateResults();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      overlay.remove();
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filtered.length > 0) {
        selectedIdx = (selectedIdx + 1) % Math.min(filtered.length, 10);
        renderResults();
      }
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filtered.length > 0) {
        selectedIdx = (selectedIdx - 1 + Math.min(filtered.length, 10)) % Math.min(filtered.length, 10);
        renderResults();
      }
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      if (filtered.length > 0 && selectedIdx < filtered.length) {
        overlay.remove();
        openFile(filtered[selectedIdx]);
      } else {
        error.textContent = "No matching note found";
        error.style.display = "block";
      }
      return;
    }
  });

  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  input.focus();
  loadFiles();
}

// ─── Inline Rename (triple-click) ────────────────────────────────
// Global triple-click state (persists across tree rebuilds)

function startInlineRename(item, filePath, fileName, isDir) {
  const nameSpan = item.querySelector(".name");
  if (!nameSpan) return;
  inlineRenameActive = true;

  const displayName = (!isDir && fileName.endsWith(".md")) ? fileName.slice(0, -3) : fileName;
  const ext = (!isDir && fileName.endsWith(".md")) ? ".md" : "";

  // Compute sibling names for duplicate detection
  const parentPath = filePath.split("/").slice(0, -1).join("/");
  const siblingWrappers = document.querySelectorAll(`.tree-node-wrapper[data-node-path]`);
  const siblingNames = new Set();
  for (const w of siblingWrappers) {
    const wp = w.dataset.nodePath || "";
    const wn = w.dataset.nodeName || "";
    // Same parent, not self
    if (wp !== filePath && wp.split("/").slice(0, -1).join("/") === parentPath) {
      siblingNames.add(wn.toLowerCase());
    }
  }

  const input = document.createElement("input");
  input.type = "text";
  input.className = "rename-input";
  input.value = displayName;
  input.spellcheck = false;


  nameSpan.replaceWith(input);
  input.focus();
  input.select();

  let committed = false;
  let hasError = false;

  const checkDuplicate = () => {
    const val = input.value.trim();
    const candidateName = (val + ext).toLowerCase();
    if (val && candidateName !== fileName.toLowerCase() && siblingNames.has(candidateName)) {
      input.classList.add("rename-error-outline");
      hasError = true;
    } else {
      input.classList.remove("rename-error-outline");
      hasError = false;
    }
  };

  input.addEventListener("input", checkDuplicate);

  const commit = async () => {
    if (committed) return;
    if (hasError) return; // don't commit if duplicate
    committed = true;
    inlineRenameActive = false;

    const newDisplayName = input.value.trim();
    if (!newDisplayName || newDisplayName === displayName) {
      await refreshFileTree();
      return;
    }

    const newName = newDisplayName + ext;
    const parts = filePath.split("/");
    parts[parts.length - 1] = newName;
    const newPath = parts.join("/");

    try {
      await invoke("rename_path", { oldPath: filePath, newPath });
      if (currentFilePath === filePath) {
        currentFilePath = newPath;
        appState.lastOpenFile = newPath;
        scheduleStateSave();
        document.getElementById("current-file-path").textContent = newPath;
      }
      await refreshFileTree();
    } catch (e) {
      console.error("Failed to rename:", e);
      await refreshFileTree();
    }
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    if (e.key === "Escape") {
      committed = true;
      inlineRenameActive = false;
      refreshFileTree();
    }
    e.stopPropagation();
  });

  input.addEventListener("blur", () => {
    if (hasError) {
      committed = true;
      inlineRenameActive = false;
      refreshFileTree();
      return;
    }
    commit();
  });
  input.addEventListener("mousedown", (e) => e.stopPropagation());
  input.addEventListener("click", (e) => e.stopPropagation());
}

// ─── Theme Palette (Super+T) ────────────────────────────────────
function showThemePalette() {
  if (document.querySelector(".theme-overlay")) return;

  const themeVars = [
    { key: "--bg-primary", label: "Background" },
    { key: "--bg-secondary", label: "Sidebar / Panel BG" },
    { key: "--bg-tertiary", label: "Elevated BG" },
    { key: "--bg-hover", label: "Hover BG" },
    { key: "--bg-active", label: "Active BG" },
    { key: "--text-primary", label: "Text Primary" },
    { key: "--text-secondary", label: "Text Secondary" },
    { key: "--text-muted", label: "Text Muted" },
    { key: "--accent", label: "Accent" },
    { key: "--accent-dim", label: "Accent Dim" },
    { key: "--border", label: "Border" },
    { key: "--success", label: "Success" },
    { key: "--error", label: "Error" },
    { key: "--code-inline", label: "Inline Code" },
  ];

  const overlay = document.createElement("div");
  overlay.className = "theme-overlay";

  const box = document.createElement("div");
  box.className = "theme-box";

  const titleEl = document.createElement("h3");
  titleEl.textContent = "Theme";
  box.appendChild(titleEl);

  const root = document.documentElement;
  const savedTheme = appState._globalTheme || {};
  const inputs = {};

  themeVars.forEach(({ key, label }) => {
    const currentVal = savedTheme[key] || getComputedStyle(root).getPropertyValue(key).trim();

    const row = document.createElement("div");
    row.className = "theme-row";

    const labelEl = document.createElement("span");
    labelEl.className = "theme-label";
    labelEl.textContent = label;

    const colorGroup = document.createElement("div");
    colorGroup.className = "theme-color-input";

    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.value = currentVal;

    const hexLabel = document.createElement("span");
    hexLabel.className = "theme-hex";
    hexLabel.textContent = currentVal;

    colorInput.addEventListener("input", () => {
      hexLabel.textContent = colorInput.value;
      root.style.setProperty(key, colorInput.value);
    });

    inputs[key] = colorInput;

    colorGroup.appendChild(colorInput);
    colorGroup.appendChild(hexLabel);
    row.appendChild(labelEl);
    row.appendChild(colorGroup);
    box.appendChild(row);
  });

  const actions = document.createElement("div");
  actions.className = "theme-actions";

  const resetBtn = document.createElement("button");
  resetBtn.textContent = "Reset";
  resetBtn.addEventListener("click", () => {
    themeVars.forEach(({ key }) => {
      root.style.removeProperty(key);
    });
    delete appState._globalTheme;
    invoke('write_global_theme', { content: '{}' }).catch(e => console.error('Failed to reset theme:', e));
    overlay.remove();
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => {
    themeVars.forEach(({ key }) => {
      if (savedTheme[key]) {
        root.style.setProperty(key, savedTheme[key]);
      } else {
        root.style.removeProperty(key);
      }
    });
    overlay.remove();
  });

  const saveBtn = document.createElement("button");
  saveBtn.className = "primary";
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", () => {
    const theme = {};
    themeVars.forEach(({ key }) => {
      theme[key] = inputs[key].value;
      root.style.setProperty(key, inputs[key].value);
    });
    appState._globalTheme = theme;
    invoke('write_global_theme', { content: JSON.stringify(theme) }).catch(e => console.error('Failed to save theme:', e));
    overlay.remove();
  });

  actions.appendChild(resetBtn);
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  box.appendChild(actions);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) {
      themeVars.forEach(({ key }) => {
        if (savedTheme[key]) {
          root.style.setProperty(key, savedTheme[key]);
        } else {
          root.style.removeProperty(key);
        }
      });
      overlay.remove();
    }
  });

  const escHandler = (e) => {
    if (e.key === "Escape") {
      themeVars.forEach(({ key }) => {
        if (savedTheme[key]) {
          root.style.setProperty(key, savedTheme[key]);
        } else {
          root.style.removeProperty(key);
        }
      });
      overlay.remove();
      document.removeEventListener("keydown", escHandler);
    }
  };
  document.addEventListener("keydown", escHandler);
}

const THEME_KEYS = [
  '--bg-primary', '--bg-secondary', '--bg-tertiary', '--bg-hover', '--bg-active',
  '--text-primary', '--text-secondary', '--text-muted',
  '--accent', '--accent-dim', '--border', '--success', '--error', '--code-inline',
];

async function applySavedTheme() {
  try {
    const json = await invoke('read_global_theme');
    const theme = JSON.parse(json);
    const root = document.documentElement;

    if (theme && typeof theme === 'object' && Object.keys(theme).length > 0) {
      // Apply saved theme
      for (const [key, value] of Object.entries(theme)) {
        root.style.setProperty(key, value);
      }
      appState._globalTheme = theme;
    } else {
      // No theme saved yet — capture current defaults and write them
      const defaults = {};
      for (const key of THEME_KEYS) {
        defaults[key] = getComputedStyle(root).getPropertyValue(key).trim();
      }
      appState._globalTheme = defaults;
      await invoke('write_global_theme', { content: JSON.stringify(defaults, null, 2) });
    }
  } catch (e) {
    console.error('Failed to load global theme:', e);
  }
}

// ─── UML Editor ──────────────────────────────────────────────────

const UML_TEMPLATES = {
  "Class Diagram": `classDiagram
    class Animal {
        +String name
        +int age
        +makeSound() void
    }
    class Dog {
        +fetch() void
    }
    Animal <|-- Dog`,

  "Sequence Diagram": `sequenceDiagram
    participant A as Alice
    participant B as Bob
    A->>B: Hello Bob
    B-->>A: Hi Alice
    A->>B: How are you?
    B-->>A: Great!`,

  "State Diagram": `stateDiagram-v2
    [*] --> Idle
    Idle --> Processing : start
    Processing --> Done : complete
    Processing --> Error : fail
    Error --> Idle : reset
    Done --> [*]`,

  "ER Diagram": `erDiagram
    CUSTOMER ||--o{ ORDER : places
    ORDER ||--|{ LINE_ITEM : contains
    CUSTOMER {
        int id PK
        string name
        string email
    }
    ORDER {
        int id PK
        date created
        string status
    }`,

  "Flowchart": `flowchart TD
    A[Start] --> B{Decision?}
    B -->|Yes| C[Do something]
    B -->|No| D[Do something else]
    C --> E[End]
    D --> E`,

  "Flowchart LR": `flowchart LR
    A[Input] --> B[Process]
    B --> C{Valid?}
    C -->|Yes| D[Output]
    C -->|No| E[Error]
    E --> B`,

  "Gantt Chart": `gantt
    title Project Schedule
    dateFormat YYYY-MM-DD
    section Phase 1
        Research     :a1, 2025-01-01, 30d
        Design       :a2, after a1, 20d
    section Phase 2
        Development  :b1, after a2, 60d
        Testing      :b2, after b1, 30d`,

  "Git Graph": `gitGraph
    commit
    branch develop
    checkout develop
    commit
    commit
    checkout main
    merge develop
    commit`,

  "Mindmap": `mindmap
    root((Project))
        Frontend
            React
            CSS
        Backend
            API
            Database
        DevOps
            CI/CD
            Monitoring`,

  "Timeline": `timeline
    title Product Roadmap
    section Q1
        Feature A : Design complete
        Feature B : Development started
    section Q2
        Feature A : Released
        Feature C : Planning`,

  "Pie Chart": `pie title Tech Stack
    "JavaScript" : 40
    "Rust" : 30
    "Python" : 20
    "Other" : 10`,

  "Component Diagram": `flowchart TB
    subgraph Frontend
        UI[UI Layer]
        State[State Management]
    end
    subgraph Backend
        API[API Gateway]
        Auth[Auth Service]
        DB[(Database)]
    end
    UI --> State
    State --> API
    API --> Auth
    API --> DB`,
};

function initUmlEditor() {
  const textarea = document.getElementById("uml-textarea");
  const toggleBtn = document.getElementById("uml-toggle-preview");
  const templateBtn = document.getElementById("uml-insert-template");

  // Configure mermaid theme (already pre-initialized with startOnLoad:false at top level)
  if (!window.mermaid) {
    console.warn("Mermaid not loaded, UML editor will not render previews");
    return;
  }
  mermaid.initialize({
    startOnLoad: false,
    theme: "dark",
    themeVariables: {
      darkMode: true,
      background: "#1c1a17",
      primaryColor: "#2c2924",
      primaryTextColor: "#c8c4b8",
      primaryBorderColor: "#4a4640",
      lineColor: "#8a8475",
      secondaryColor: "#38342d",
      tertiaryColor: "#211f1b",
      noteBkgColor: "#2c2924",
      noteTextColor: "#c8c4b8",
      noteBorderColor: "#4a4640",
      actorBkg: "#2c2924",
      actorTextColor: "#c8c4b8",
      actorBorder: "#4a4640",
      actorLineColor: "#8a8475",
      signalColor: "#c8c4b8",
      signalTextColor: "#c8c4b8",
      labelBoxBkgColor: "#2c2924",
      labelBoxBorderColor: "#4a4640",
      labelTextColor: "#c8c4b8",
      loopTextColor: "#c8c4b8",
      activationBorderColor: "#8cb369",
      activationBkgColor: "#2c2924",
      sequenceNumberColor: "#1c1a17",
      sectionBkgColor: "#2c2924",
      altSectionBkgColor: "#211f1b",
      sectionBkgColor2: "#38342d",
      excludeBkgColor: "#161412",
      taskBorderColor: "#4a4640",
      taskBkgColor: "#2c2924",
      taskTextColor: "#c8c4b8",
      taskTextLightColor: "#c8c4b8",
      taskTextOutsideColor: "#c8c4b8",
      activeTaskBorderColor: "#8cb369",
      activeTaskBkgColor: "#4a6b35",
      gridColor: "#302d27",
      doneTaskBkgColor: "#38342d",
      doneTaskBorderColor: "#4a4640",
      critBorderColor: "#e07a6e",
      critBkgColor: "#4a2520",
      todayLineColor: "#e07a6e",
      classText: "#c8c4b8",
      fillType0: "#2c2924",
      fillType1: "#38342d",
      fillType2: "#211f1b",
      fillType3: "#2c2924",
      fillType4: "#38342d",
      fillType5: "#211f1b",
      fillType6: "#2c2924",
      fillType7: "#38342d",
    },
    flowchart: { curve: "basis", htmlLabels: true },
    sequence: { mirrorActors: false },
    class: { htmlLabels: true },
  });

  // Text input → debounced re-render
  textarea.addEventListener("input", () => {
    scheduleSave();
    scheduleUmlRender();
  });

  // Tab key support in textarea
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      textarea.value = textarea.value.substring(0, start) + "    " + textarea.value.substring(end);
      textarea.selectionStart = textarea.selectionEnd = start + 4;
      textarea.dispatchEvent(new Event("input"));
    }
  });

  // Toggle preview
  toggleBtn.addEventListener("click", () => toggleUmlPreview());

  // Template dropdown
  templateBtn.addEventListener("click", (e) => {
    showTemplateMenu(e);
  });

  // Zoom controls
  document.getElementById("uml-zoom-in").addEventListener("click", () => setUmlZoom(umlZoom + 0.15));
  document.getElementById("uml-zoom-out").addEventListener("click", () => setUmlZoom(umlZoom - 0.15));
  document.getElementById("uml-zoom-reset").addEventListener("click", () => setUmlZoom(1.0));
  document.getElementById("uml-export-pdf").addEventListener("click", exportUmlPdf);

  // Error tooltip on dot hover
  const dot = document.getElementById("uml-status-dot");
  const errorTooltip = document.createElement("div");
  errorTooltip.id = "uml-error-tooltip";
  errorTooltip.style.display = "none";
  document.getElementById("uml-toolbar").appendChild(errorTooltip);

  dot.addEventListener("mouseenter", () => {
    if (umlLastError) {
      errorTooltip.textContent = umlLastError;
      errorTooltip.style.display = "block";
    }
  });
  dot.addEventListener("mouseleave", () => {
    errorTooltip.style.display = "none";
  });

  // Scroll zoom on preview
  document.getElementById("uml-preview-container").addEventListener("wheel", (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      setUmlZoom(umlZoom + delta);
    }
  }, { passive: false });
}

function loadUmlEditor(content) {
  const textarea = document.getElementById("uml-textarea");
  textarea.value = content;
  const dot = document.getElementById("uml-status-dot");
  dot.className = "";
  umlLastError = null;

  // Restore preview state from saved preference
  if (appState.umlPreviewOpen && !umlPreviewVisible) {
    showUmlPreview();
  } else if (!appState.umlPreviewOpen && umlPreviewVisible) {
    hideUmlPreview();
  }
}

function scheduleUmlRender() {
  clearTimeout(umlRenderTimeout);
  umlRenderTimeout = setTimeout(() => {
    if (umlPreviewVisible) {
      renderUmlPreview();
    }
  }, 400);
}

let umlRenderCounter = 0;

async function renderUmlPreview() {
  const textarea = document.getElementById("uml-textarea");
  const content = textarea.value.trim();
  const dot = document.getElementById("uml-status-dot");
  const previewContent = document.getElementById("uml-preview-content");

  if (!content) {
    previewContent.innerHTML = '<div style="color:var(--text-muted);font-family:var(--font-mono);font-size:13px;">No diagram content</div>';
    dot.className = "";
    umlLastError = null;
    return;
  }

  try {
    umlRenderCounter++;
    const id = `uml-render-${umlRenderCounter}`;
    const { svg } = await mermaid.render(id, content);
    previewContent.innerHTML = svg;
    dot.className = "success";
    umlLastError = null;
  } catch (e) {
    dot.className = "error";
    const msg = e.message || String(e);
    umlLastError = msg.replace(/.*Syntax error in text.*?mermaid version.*?\n?/s, "").trim() || "Syntax error";
    // Remove the error element mermaid injects
    const errEl = document.getElementById(`duml-render-${umlRenderCounter}`);
    if (errEl) errEl.remove();
  }
}

function toggleUmlPreview() {
  if (umlPreviewVisible) {
    hideUmlPreview();
  } else {
    showUmlPreview();
  }
  appState.umlPreviewOpen = umlPreviewVisible;
  scheduleStateSave();
}

function showUmlPreview() {
  umlPreviewVisible = true;
  const previewPanel = document.getElementById("uml-preview-panel");
  const termHeader = document.getElementById("terminal-header");
  const termContainer = document.getElementById("terminal-container");
  const toggleBtn = document.getElementById("uml-toggle-preview");

  // Hide terminal, show preview
  termHeader.style.display = "none";
  termContainer.style.display = "none";
  previewPanel.style.display = "flex";
  toggleBtn.classList.add("active");

  renderUmlPreview();
}

function hideUmlPreview() {
  umlPreviewVisible = false;
  const previewPanel = document.getElementById("uml-preview-panel");
  const termHeader = document.getElementById("terminal-header");
  const termContainer = document.getElementById("terminal-container");
  const toggleBtn = document.getElementById("uml-toggle-preview");

  // Show terminal, hide preview
  previewPanel.style.display = "none";
  termHeader.style.display = "";
  termContainer.style.display = "";
  toggleBtn.classList.remove("active");

  // Re-fit terminal
  const tab = terminalTabs[activeTabIdx];
  if (tab) {
    setTimeout(() => tab.fitAddon.fit(), 50);
  }
}

function setUmlZoom(level) {
  umlZoom = Math.max(0.2, Math.min(3.0, level));
  const previewContent = document.getElementById("uml-preview-content");
  previewContent.style.transform = `scale(${umlZoom})`;
  document.getElementById("uml-zoom-reset").textContent = `${Math.round(umlZoom * 100)}%`;
}

async function exportUmlPdf() {
  const previewContent = document.getElementById("uml-preview-content");
  const svg = previewContent.querySelector("svg");
  if (!svg) return;

  if (!window.jspdf) {
    console.error("jsPDF not loaded");
    return;
  }

  const name = currentFilePath ? currentFilePath.split("/").pop().replace(".mmd", "") : "diagram";

  // Build the PNG data URL first, before opening the dialog
  let pngDataUrl, pdfW, pdfH;
  try {
    const svgClone = svg.cloneNode(true);

    // Use the SVG's native coordinate system (viewBox) for accurate dimensions.
    // Mermaid sets width/height via style which may differ from viewBox.
    const viewBox = svg.getAttribute("viewBox");
    let vbX = 0, vbY = 0, vbW, vbH;
    if (viewBox) {
      const parts = viewBox.split(/[\s,]+/).map(Number);
      vbX = parts[0];
      vbY = parts[1];
      vbW = parts[2];
      vbH = parts[3];
    }

    // For aspect ratio, trust viewBox if available; otherwise measure from DOM
    const aspectW = vbW || svg.getBoundingClientRect().width;
    const aspectH = vbH || svg.getBoundingClientRect().height;

    // Render at a fixed high resolution based on the longer side
    const scale = 3;
    const renderW = aspectW * scale;
    const renderH = aspectH * scale;

    // Force exact pixel dimensions on clone, remove any max-width/style overrides
    svgClone.removeAttribute("style");
    svgClone.setAttribute("width", renderW);
    svgClone.setAttribute("height", renderH);
    svgClone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    svgClone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
    if (viewBox) svgClone.setAttribute("viewBox", viewBox);

    // PDF dimensions in points (1:1 with viewBox units)
    pdfW = aspectW;
    pdfH = aspectH;

    // Inline computed styles so the rasterized image looks correct
    const allEls = svg.querySelectorAll("*");
    const cloneEls = svgClone.querySelectorAll("*");
    for (let i = 0; i < allEls.length; i++) {
      const computed = window.getComputedStyle(allEls[i]);
      const important = ["fill", "stroke", "stroke-width", "font-family", "font-size", "font-weight", "color", "opacity", "visibility", "text-anchor", "dominant-baseline"];
      for (const prop of important) {
        const val = computed.getPropertyValue(prop);
        if (val) cloneEls[i].style.setProperty(prop, val);
      }
    }

    const svgData = new XMLSerializer().serializeToString(svgClone);
    const svgDataUrl = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svgData)));

    const canvas = document.createElement("canvas");
    canvas.width = renderW;
    canvas.height = renderH;
    const ctx = canvas.getContext("2d");

    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("Failed to load SVG as image"));
      img.src = svgDataUrl;
    });
    ctx.drawImage(img, 0, 0, renderW, renderH);

    pngDataUrl = canvas.toDataURL("image/png");
  } catch (e) {
    console.error("Failed to render diagram to image:", e);
    return;
  }

  // Now open the save dialog
  try {
    const savePath = await invoke("plugin:dialog|save", {
      options: {
        title: "Export PDF",
        defaultPath: `${name}.pdf`,
        filters: [{ name: "PDF Document", extensions: ["pdf"] }],
      },
    });
    if (!savePath) return;

    const padding = 20;
    const pageW = pdfW + padding * 2;
    const pageH = pdfH + padding * 2;
    // Pass format as [short, long] — jsPDF always treats format[0] as short side
    const shortSide = Math.min(pageW, pageH);
    const longSide = Math.max(pageW, pageH);
    const orientation = pageW >= pageH ? "landscape" : "portrait";
    const doc = new jspdf.jsPDF({
      orientation,
      unit: "pt",
      format: [shortSide, longSide],
    });

    doc.addImage(pngDataUrl, "PNG", padding, padding, pdfW, pdfH);

    const base64Pdf = doc.output("datauristring").split(",")[1];
    await invoke("write_bytes_absolute", { path: savePath, data: base64Pdf });
  } catch (e) {
    console.error("Failed to export PDF:", e);
  }
}

function showTemplateMenu(e) {
  removeContextMenu();
  const btn = e.target.closest("button");
  const rect = btn.getBoundingClientRect();

  const menu = document.createElement("div");
  menu.className = "uml-template-menu";

  Object.keys(UML_TEMPLATES).forEach((name) => {
    const item = document.createElement("div");
    item.className = "uml-template-item";
    item.textContent = name;
    item.addEventListener("click", () => {
      const textarea = document.getElementById("uml-textarea");
      textarea.value = UML_TEMPLATES[name];
      textarea.dispatchEvent(new Event("input"));
      menu.remove();
    });
    menu.appendChild(item);
  });

  menu.style.left = rect.left + "px";
  menu.style.top = rect.bottom + 4 + "px";
  document.body.appendChild(menu);

  setTimeout(() => {
    document.addEventListener("click", () => menu.remove(), { once: true });
  }, 10);
}

// ─── Utility ─────────────────────────────────────────────────────
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Save before closing
window.addEventListener("beforeunload", () => {
  if (currentFilePath) saveCurrentFile();
  saveAppState();
});

// Global keyboard shortcuts
document.addEventListener("keydown", (e) => {
  // Cmd/Ctrl+S → block browser save dialog
  if ((e.metaKey || e.ctrlKey) && e.key === "s") {
    e.preventDefault();
  }
  // Cmd/Ctrl+R → toggle UML preview / terminal (only when editing .mmd)
  if ((e.metaKey || e.ctrlKey) && e.key === "r" && !e.shiftKey) {
    if (currentFileType === "mmd") {
      e.preventDefault();
      toggleUmlPreview();
    }
  }
  // Cmd/Ctrl+= / Cmd/Ctrl+- → zoom UML preview
  if ((e.metaKey || e.ctrlKey) && umlPreviewVisible) {
    if (e.key === "=" || e.key === "+") {
      e.preventDefault();
      setUmlZoom(umlZoom + 0.15);
    } else if (e.key === "-") {
      e.preventDefault();
      setUmlZoom(umlZoom - 0.15);
    }
  }
  // Super/Cmd+N → quick create file
  if ((e.metaKey || e.ctrlKey) && e.key === "n") {
    e.preventDefault();
    showQuickCreate();
  }
  // Super/Cmd+O → quick open file
  if ((e.metaKey || e.ctrlKey) && e.key === "o") {
    e.preventDefault();
    showQuickOpen();
  }
  // Super/Cmd+B → toggle sidebar
  if ((e.metaKey || e.ctrlKey) && e.key === "b") {
    e.preventDefault();
    const sidebar = document.getElementById("sidebar");
    sidebar.classList.toggle("collapsed");
    const _collapsed = sidebar.classList.contains("collapsed");
    document.getElementById("sidebar-toggle").classList.toggle("collapsed-state", _collapsed);
    appState.sidebarCollapsed = _collapsed;
    scheduleStateSave();
  }
  // Cmd/Ctrl+T → new terminal tab (when shell panel is focused)
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "t") {
    const terminalPanel = document.getElementById("terminal-panel");
    if (terminalPanel && terminalPanel.contains(document.activeElement)) {
      e.preventDefault();
      createTerminalTab();
    }
  }
  // Shift+Cmd/Ctrl+T → theme palette
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "t") {
    e.preventDefault();
    showThemePalette();
  }
});


// ═══════════════════════════════════════════════════════════════════
// ── View Editor (.view files) ─────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════

const ViewEditor = (() => {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  let _idCounter = 0;
  const _uid = () => `el_${++_idCounter}`;

  const TYPES = {
    frame:   { label: 'Frame',   icon: '▢', hasChildren: true },
    text:    { label: 'Text',    icon: 'T', hasChildren: false },
    button:  { label: 'Button',  icon: '⊡', hasChildren: false },
    input:   { label: 'Input',   icon: '⊟', hasChildren: false },
    image:   { label: 'Image',   icon: 'svg:image', hasChildren: false },
    icon:    { label: 'Icon',    icon: '◉', hasChildren: false },
    divider: { label: 'Divider', icon: '—', hasChildren: false },
  };

  const DEFAULTS = {
    frame:   { width: 200, height: 150, background: '#222222', borderRadius: 8 },
    text:    { width: 120, height: 24, color: '#ffffff', fontSize: 14 },
    button:  { width: 120, height: 40, background: '#6366f1', borderRadius: 8, color: '#ffffff', fontSize: 14, fontWeight: 600 },
    input:   { width: 200, height: 40, background: '#1a1a1a', borderRadius: 6, border: '1px solid #333', color: '#ffffff', fontSize: 14 },
    image:   { width: 150, height: 100, background: '#1e1e1e', borderRadius: 4 },
    icon:    { width: 24, height: 24 },
    divider: { width: '100%', height: 1, background: '#333' },
  };

  // ── Document model ──

  function createDoc() {
    return {
      name: 'Untitled View',
      canvas: { width: 390, height: 844 },
      tokens: { colors: {}, typography: {}, spacing: {} },
      imports: [],
      tree: [],
      filePath: null,
    };
  }

  function createDefaultDoc() {
    const doc = createDoc();
    const root = createElement('frame', 'Root');
    root.style = {
      width: '100%', height: '100%', background: '#111111',
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: 24, gap: 16,
    };
    doc.tree = [root];
    return doc;
  }

  function createElement(type, name) {
    const el = {
      id: _uid(), type, name: name || TYPES[type]?.label || type,
      style: { ...DEFAULTS[type] },
    };
    if (type === 'text') el.text = 'Text';
    if (type === 'button') el.text = 'Button';
    if (type === 'input') el.placeholder = 'Placeholder...';
    if (TYPES[type]?.hasChildren) el.children = [];
    return el;
  }

  function findById(id, nodes, parent) {
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].id === id) return { el: nodes[i], parent, index: i, siblings: nodes };
      if (nodes[i].children) {
        const r = findById(id, nodes[i].children, nodes[i]);
        if (r) return r;
      }
    }
    return null;
  }

  function flatten(nodes, depth, result) {
    depth = depth || 0; result = result || [];
    for (const n of nodes) {
      result.push({ el: n, depth });
      if (n.children) flatten(n.children, depth + 1, result);
    }
    return result;
  }

  function removeById(tree, id) {
    const f = findById(id, tree, null);
    if (f) { f.siblings.splice(f.index, 1); return f.el; }
    return null;
  }

  // ── Serialization ──

  function serializeNode(node) {
    const out = { id: node.id, type: node.type, name: node.name };
    if (node.text != null) out.text = node.text;
    if (node.placeholder != null) out.placeholder = node.placeholder;
    if (node.src != null) out.src = node.src;
    if (node.icon != null) out.icon = node.icon;
    if (node.style && Object.keys(node.style).length > 0) {
      out.style = {};
      for (const [k, v] of Object.entries(node.style)) {
        if (v !== undefined && v !== '') out.style[k] = v;
      }
    }
    if (node.children?.length > 0) out.children = node.children.map(serializeNode);
    return out;
  }

  function toYAML(doc) {
    const obj = { name: doc.name, canvas: doc.canvas };
    const hasTokens = Object.keys(doc.tokens.colors).length ||
                      Object.keys(doc.tokens.typography).length ||
                      Object.keys(doc.tokens.spacing).length;
    if (hasTokens) obj.tokens = doc.tokens;
    if (doc.imports.length) obj.imports = doc.imports;
    obj.tree = doc.tree.map(serializeNode);
    return jsyaml.dump(obj, { indent: 2, lineWidth: 120, noRefs: true, quotingType: '"', forceQuotes: false });
  }

  function deserializeNode(obj) {
    const node = { id: obj.id || _uid(), type: obj.type || 'frame', name: obj.name || obj.type || 'Element', style: obj.style || {} };
    if (obj.text != null) node.text = obj.text;
    if (obj.placeholder != null) node.placeholder = obj.placeholder;
    if (obj.src != null) node.src = obj.src;
    if (obj.icon != null) node.icon = obj.icon;
    if (obj.children) node.children = obj.children.map(deserializeNode);
    else if (TYPES[node.type]?.hasChildren) node.children = [];
    return node;
  }

  function fromYAML(str) {
    const obj = jsyaml.load(str);
    const doc = createDoc();
    doc.name = obj.name || 'Untitled View';
    doc.canvas = obj.canvas || { width: 390, height: 844 };
    doc.tokens = obj.tokens || { colors: {}, typography: {}, spacing: {} };
    if (!doc.tokens.colors) doc.tokens.colors = {};
    if (!doc.tokens.typography) doc.tokens.typography = {};
    if (!doc.tokens.spacing) doc.tokens.spacing = {};
    doc.imports = obj.imports || [];
    doc.tree = (obj.tree || []).map(deserializeNode);
    // Sync id counter
    for (const { el } of flatten(doc.tree)) {
      const m = el.id.match(/^el_(\d+)$/);
      if (m) _idCounter = Math.max(_idCounter, parseInt(m[1]));
    }
    return doc;
  }

  // ── Token resolution ──

  function resolveToken(value, tokens) {
    if (typeof value !== 'string') return value;
    return value.replace(/\$(\w+)\.(\w+)/g, (match, cat, key) => {
      const v = tokens[cat]?.[key];
      return (v !== undefined && typeof v !== 'object') ? v : match;
    });
  }

  function resolveStyle(style, tokens) {
    if (!style) return {};
    const out = {};
    for (const [k, v] of Object.entries(style)) {
      if (k === 'responsive') continue;
      if (k === 'apply') {
        if (typeof v === 'string') {
          const m = v.match(/^\$(\w+)\.(\w+)$/);
          if (m && tokens[m[1]] && typeof tokens[m[1]][m[2]] === 'object') Object.assign(out, tokens[m[1]][m[2]]);
        }
        continue;
      }
      out[k] = resolveToken(v, tokens);
    }
    return out;
  }

  function applyResponsive(style, canvasW, tokens) {
    const out = resolveStyle(style, tokens);
    if (style?.responsive) {
      for (const bp of style.responsive) {
        if (canvasW >= bp.above) {
          const r = resolveStyle(bp, tokens);
          delete r.above;
          Object.assign(out, r);
        }
      }
    }
    return out;
  }

  // ── History ──

  class History {
    constructor() { this.stack = []; this.idx = -1; }
    push(snap) { this.stack = this.stack.slice(0, this.idx + 1); this.stack.push(snap); if (this.stack.length > 100) this.stack.shift(); this.idx = this.stack.length - 1; }
    undo() { return this.idx > 0 ? this.stack[--this.idx] : null; }
    redo() { return this.idx < this.stack.length - 1 ? this.stack[++this.idx] : null; }
  }

  // ═════════════════════════════════════════
  // ── Editor State ──
  // ═════════════════════════════════════════

  let doc = createDefaultDoc();
  let selectedId = null;
  let hoveredId = null;
  let activeTool = 'select';
  let zoom = 1;
  const history = new History();
  let initialized = false;
  let dragState = null;

  // DOM refs (lazy)
  let $canvasBg, $canvas, $selOverlay, $layerTree, $propsContent, $propsTitle, $canvasW, $canvasH, $zoomDisplay;

  function initRefs() {
    $canvasBg    = document.getElementById('ve-canvas-bg');
    $canvas      = document.getElementById('ve-canvas');
    $selOverlay  = document.getElementById('ve-selection-overlay');
    $layerTree   = document.getElementById('ve-layer-tree');
    $propsContent = document.getElementById('ve-props-content');
    $propsTitle  = document.getElementById('ve-props-title');
    $canvasW     = document.getElementById('ve-canvas-w');
    $canvasH     = document.getElementById('ve-canvas-h');
    $zoomDisplay = document.getElementById('ve-zoom-display');
  }

  function px(v) { return typeof v === 'number' ? v + 'px' : v; }

  // ── Canvas sizing ──

  function updateCanvasSize() {
    $canvasBg.style.width = (doc.canvas.width * zoom) + 'px';
    $canvasBg.style.height = (doc.canvas.height * zoom) + 'px';
    $canvas.style.transform = `scale(${zoom})`;
    $canvas.style.transformOrigin = 'top left';
    $canvas.style.width = doc.canvas.width + 'px';
    $canvas.style.height = doc.canvas.height + 'px';
    $canvasW.value = doc.canvas.width;
    $canvasH.value = doc.canvas.height;
    $zoomDisplay.textContent = Math.round(zoom * 100) + '%';
    $selOverlay.style.transform = `scale(${zoom})`;
    $selOverlay.style.transformOrigin = 'top left';
    $selOverlay.style.width = doc.canvas.width + 'px';
    $selOverlay.style.height = doc.canvas.height + 'px';
  }

  function setZoom(z) { zoom = clamp(z, 0.1, 5); updateCanvasSize(); renderSelection(); }

  // ── Render tree → DOM ──

  function render() {
    if (doc.imports.length > 0) {
      renderAsync();
      return;
    }
    $canvas.innerHTML = '';
    for (const node of doc.tree) renderNode(node, $canvas);
    renderSelection();
  }

  function renderNode(node, parentEl) {
    const style = applyResponsive(node.style, doc.canvas.width, doc.tokens);
    const el = document.createElement('div');
    el.className = `ve-el ve-el-${node.type}`;
    el.dataset.id = node.id;
    applyStyleDOM(el, style);

    if (node.type === 'text' && node.text) el.textContent = node.text;
    if (node.type === 'button' && node.text) el.textContent = node.text;
    if (node.type === 'image') {
      el.innerHTML = '<svg width="24" height="24" viewBox="0 0 16 16" fill="none" style="opacity:0.3;"><rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/><circle cx="5.5" cy="5.5" r="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M2 11l3-3 2 2 3-3 4 4" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    }
    if (node.type === 'input') {
      const sp = document.createElement('span');
      sp.className = 've-placeholder';
      sp.textContent = node.placeholder || '';
      el.appendChild(sp);
    }

    if (node.children) for (const c of node.children) renderNode(c, el);
    parentEl.appendChild(el);
  }

  function applyStyleDOM(el, s) {
    const st = el.style;
    const set = (prop, val) => { if (val != null) st[prop] = px(val); };
    set('display', s.display); set('flexDirection', s.flexDirection);
    set('alignItems', s.alignItems); set('justifyContent', s.justifyContent);
    set('flexWrap', s.flexWrap); set('gap', s.gap);
    set('width', s.width); set('height', s.height);
    set('minWidth', s.minWidth); set('maxWidth', s.maxWidth);
    set('minHeight', s.minHeight); set('maxHeight', s.maxHeight);
    set('padding', s.padding); set('paddingTop', s.paddingTop);
    set('paddingRight', s.paddingRight); set('paddingBottom', s.paddingBottom);
    set('paddingLeft', s.paddingLeft); set('margin', s.margin);
    if (s.background) st.background = s.background;
    if (s.color) st.color = s.color;
    if (s.border) st.border = s.border;
    set('borderRadius', s.borderRadius);
    if (s.opacity != null) st.opacity = s.opacity;
    if (s.overflow) st.overflow = s.overflow;
    if (s.boxShadow) st.boxShadow = s.boxShadow;
    set('fontSize', s.fontSize);
    if (s.fontWeight != null) st.fontWeight = s.fontWeight;
    if (s.lineHeight != null) st.lineHeight = s.lineHeight;
    if (s.textAlign) st.textAlign = s.textAlign;
    set('letterSpacing', s.letterSpacing);
    if (s.position) st.position = s.position;
    set('top', s.top); set('left', s.left);
    set('right', s.right); set('bottom', s.bottom);
  }

  // ── Selection ──

  function getRelRect(el) {
    const cr = $canvas.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    return { left: (er.left - cr.left) / zoom, top: (er.top - cr.top) / zoom, width: er.width / zoom, height: er.height / zoom };
  }

  function renderSelection() {
    $selOverlay.innerHTML = '';
    if (hoveredId && hoveredId !== selectedId) {
      const hEl = $canvas.querySelector(`[data-id="${hoveredId}"]`);
      if (hEl) {
        const r = getRelRect(hEl);
        const hb = document.createElement('div');
        hb.className = 've-hover-box';
        hb.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;`;
        $selOverlay.appendChild(hb);
      }
    }
    if (!selectedId) return;
    const selEl = $canvas.querySelector(`[data-id="${selectedId}"]`);
    if (!selEl) return;
    const r = getRelRect(selEl);
    const box = document.createElement('div');
    box.className = 've-sel-box';
    box.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;`;
    $selOverlay.appendChild(box);
    for (const dir of ['nw','n','ne','e','se','s','sw','w']) {
      const h = document.createElement('div');
      h.className = `ve-sel-handle ${dir}`;
      h.dataset.handle = dir;
      box.appendChild(h);
    }
  }

  function select(id) {
    selectedId = id;
    renderSelection();
    renderLayerTree();
    renderProps();
  }

  // ── Layer tree ──

  function renderLayerTree() {
    $layerTree.innerHTML = '';
    for (const { el, depth } of flatten(doc.tree)) {
      const item = document.createElement('div');
      item.className = 've-layer-item' + (el.id === selectedId ? ' selected' : '');
      item.dataset.id = el.id;
      const indent = document.createElement('span');
      indent.className = 've-layer-indent';
      indent.style.width = (depth * 14) + 'px';
      const icon = document.createElement('span');
      icon.className = 've-layer-icon';
      const iconVal = TYPES[el.type]?.icon || (getImportByType(el.type) ? 'svg:view' : '?');
      if (iconVal === 'svg:image') {
        icon.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/><circle cx="5.5" cy="5.5" r="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M2 11l3-3 2 2 3-3 4 4" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
      } else if (iconVal === 'svg:view') {
        icon.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><rect x="1" y="1" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="9" y="1" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="1" y="9" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="9" y="9" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.5"/></svg>';
      } else {
        icon.textContent = iconVal;
      }
      const name = document.createElement('span');
      name.className = 've-layer-name';
      name.textContent = el.name;
      item.append(indent, icon, name);
      $layerTree.appendChild(item);

      item.addEventListener('click', () => select(el.id));
      initLayerDrag(item, el);
      item.addEventListener('dblclick', () => {
        name.contentEditable = true; name.focus();
        const range = document.createRange(); range.selectNodeContents(name);
        window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
        const finish = () => { name.contentEditable = false; el.name = name.textContent.trim() || el.name; pushHist(); renderLayerTree(); };
        name.addEventListener('blur', finish, { once: true });
        name.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); name.blur(); } if (e.key === 'Escape') { name.textContent = el.name; name.blur(); } });
      });

      item.addEventListener('contextmenu', e => {
        e.preventDefault();
        select(el.id);
        showLayerCtxMenu(e.clientX, e.clientY, el, depth);
      });
    }
  }

  function showLayerCtxMenu(x, y, el, depth) {
    closeCtxMenu();
    const menu = document.createElement('div'); menu.className = 've-ctx-menu';
    menu.style.cssText = `left:${x}px;top:${y}px;`;
    const items = [];
    const f = findById(el.id, doc.tree, null);

    // Add children (only for frames/containers)
    if (el.children) {
      items.push({ label: 'Add Frame', fn: () => addChildTo(el, 'frame') });
      items.push({ label: 'Add Text', fn: () => addChildTo(el, 'text') });
      items.push({ label: 'Add Button', fn: () => addChildTo(el, 'button') });
      items.push({ label: 'Add Input', fn: () => addChildTo(el, 'input') });
      items.push({ label: 'Add Image', fn: () => addChildTo(el, 'image') });
      items.push({ label: 'Add Divider', fn: () => addChildTo(el, 'divider') });
      items.push({ label: 'Add View...', fn: () => showViewPicker(el) });
      items.push({ sep: true });
    }

    // Rename
    items.push({ label: 'Rename', fn: () => {
      const layerItem = $layerTree.querySelector(`[data-id="${el.id}"]`);
      if (layerItem) layerItem.dispatchEvent(new MouseEvent('dblclick'));
    }});

    // Duplicate
    items.push({ label: 'Duplicate', fn: () => { select(el.id); duplicateSelected(); }});

    // Delete (not root)
    if (f && f.parent) {
      items.push({ sep: true });
      items.push({ label: 'Delete', fn: () => {
        removeById(doc.tree, el.id);
        selectedId = null;
        pushHist(); render(); renderLayerTree(); renderProps();
      }, danger: true });
    }

    for (const it of items) {
      if (it.sep) { const s = document.createElement('div'); s.className = 've-ctx-sep'; menu.appendChild(s); continue; }
      const d = document.createElement('div'); d.className = 've-ctx-item' + (it.danger ? ' danger' : ''); d.textContent = it.label;
      d.addEventListener('click', () => { closeCtxMenu(); it.fn(); }); menu.appendChild(d);
    }
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener('click', closeCtxMenu, { once: true }), 0);
  }

  // ── Layer drag & drop ──

  let layerDrag = null;

  const veDropIndicator = document.createElement('div');
  veDropIndicator.className = 've-drop-indicator';
  veDropIndicator.style.display = 'none';
  document.body.appendChild(veDropIndicator);

  function initLayerDrag(item, el) {
    item.addEventListener('mousedown', e => {
      if (e.button !== 0 || e.target.isContentEditable) return;
      e.preventDefault();
      layerDrag = {
        el, sourceItem: item, ghost: null,
        startX: e.clientX, startY: e.clientY, started: false,
      };
    });
  }

  document.addEventListener('mousemove', e => {
    if (!layerDrag) return;
    if (document.getElementById('view-editor').style.display === 'none') return;

    if (!layerDrag.started) {
      const dx = e.clientX - layerDrag.startX;
      const dy = e.clientY - layerDrag.startY;
      if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
      layerDrag.started = true;
      const ghost = document.createElement('div');
      ghost.className = 've-drag-ghost';
      ghost.textContent = layerDrag.el.name;
      document.body.appendChild(ghost);
      layerDrag.ghost = ghost;
      layerDrag.sourceItem.classList.add('dragging');
    }

    layerDrag.ghost.style.left = (e.clientX + 12) + 'px';
    layerDrag.ghost.style.top = (e.clientY - 10) + 'px';

    // Hit-test
    layerDrag.ghost.style.pointerEvents = 'none';
    veDropIndicator.style.display = 'none';
    const target = document.elementFromPoint(e.clientX, e.clientY);
    layerDrag.ghost.style.pointerEvents = '';

    updateLayerDropIndicator(target, e.clientY);
  });

  document.addEventListener('mouseup', () => {
    if (!layerDrag) return;
    const wasStarted = layerDrag.started;
    const srcEl = layerDrag.el;

    if (layerDrag.ghost) layerDrag.ghost.remove();
    layerDrag.sourceItem.classList.remove('dragging');

    const action = veDropIndicator.dataset.action;
    const targetId = veDropIndicator.dataset.targetId;
    veDropIndicator.style.display = 'none';
    layerDrag = null;

    if (!wasStarted || !action || !targetId) return;
    if (targetId === srcEl.id) return;

    // Find source and target
    const srcFound = findById(srcEl.id, doc.tree, null);
    const tgtFound = findById(targetId, doc.tree, null);
    if (!srcFound || !tgtFound) return;

    // Don't drop into own descendant
    if (isDescendant(srcEl, targetId)) return;

    // Remove source from its current position
    srcFound.siblings.splice(srcFound.index, 1);

    // Re-find target after removal (indices may have shifted)
    const tgtAfter = findById(targetId, doc.tree, null);
    if (!tgtAfter) return;

    if (action === 'into') {
      if (!tgtAfter.el.children) tgtAfter.el.children = [];
      tgtAfter.el.children.push(srcEl);
    } else if (action === 'before') {
      tgtAfter.siblings.splice(tgtAfter.index, 0, srcEl);
    } else if (action === 'after') {
      tgtAfter.siblings.splice(tgtAfter.index + 1, 0, srcEl);
    }

    pushHist(); render(); renderLayerTree(); renderProps();
  });

  function isDescendant(parentNode, childId) {
    if (!parentNode.children) return false;
    for (const c of parentNode.children) {
      if (c.id === childId) return true;
      if (isDescendant(c, childId)) return true;
    }
    return false;
  }

  function updateLayerDropIndicator(targetEl, mouseY) {
    const layerItem = targetEl?.closest?.('.ve-layer-item');
    if (!layerItem) {
      veDropIndicator.style.display = 'none';
      veDropIndicator.dataset.action = '';
      return;
    }

    const targetId = layerItem.dataset.id;
    if (!targetId || targetId === layerDrag.el.id) {
      veDropIndicator.style.display = 'none';
      veDropIndicator.dataset.action = '';
      return;
    }

    // Don't allow dropping into own descendant
    if (isDescendant(layerDrag.el, targetId)) {
      veDropIndicator.style.display = 'none';
      veDropIndicator.dataset.action = '';
      return;
    }

    const rect = layerItem.getBoundingClientRect();
    const y = mouseY - rect.top;
    const ratio = y / rect.height;
    const tgtFound = findById(targetId, doc.tree, null);
    const isContainer = tgtFound?.el.children != null;
    const panelRect = $layerTree.getBoundingClientRect();

    veDropIndicator.dataset.targetId = targetId;

    if (isContainer && ratio > 0.25 && ratio < 0.75) {
      // Drop INTO container
      veDropIndicator.style.display = 'block';
      veDropIndicator.style.left = rect.left + 'px';
      veDropIndicator.style.width = rect.width + 'px';
      veDropIndicator.style.top = rect.top + 'px';
      veDropIndicator.style.height = rect.height + 'px';
      veDropIndicator.className = 've-drop-indicator ve-drop-into';
      veDropIndicator.dataset.action = 'into';
    } else {
      // Drop BEFORE or AFTER
      const isBefore = isContainer ? ratio < 0.25 : ratio < 0.5;
      const lineY = isBefore ? rect.top : rect.bottom;
      veDropIndicator.style.display = 'block';
      veDropIndicator.style.left = rect.left + 'px';
      veDropIndicator.style.width = rect.width + 'px';
      veDropIndicator.style.top = (lineY - 1) + 'px';
      veDropIndicator.style.height = '2px';
      veDropIndicator.className = 've-drop-indicator ve-drop-line';
      veDropIndicator.dataset.action = isBefore ? 'before' : 'after';
    }
  }

  // ── Properties panel ──

  function renderProps() {
    if (!selectedId) {
      $propsTitle.textContent = 'Properties';
      $propsContent.innerHTML = '<div class="ve-props-empty">Select an element</div>';
      return;
    }
    const f = findById(selectedId, doc.tree, null);
    if (!f) return;
    const el = f.el;
    $propsTitle.textContent = el.name;
    $propsContent.innerHTML = '';

    addSection('Element', $propsContent, body => {
      addRow(body, 'Name', 'text', el.name, v => { el.name = v; renderLayerTree(); });
      addRow(body, 'Type', 'display', TYPES[el.type]?.label || el.type);
      if (el.text != null) addRow(body, 'Text', 'text', el.text, v => { el.text = v; render(); });
      if (el.placeholder != null) addRow(body, 'Placeholder', 'text', el.placeholder, v => { el.placeholder = v; render(); });
    });

    addSection('Layout', $propsContent, body => {
      addRow(body, 'Display', 'select', el.style.display || '', v => { el.style.display = v || undefined; render(); }, ['','flex','block','grid','none']);
      if (el.style.display === 'flex') {
        addRow(body, 'Direction', 'select', el.style.flexDirection || 'row', v => { el.style.flexDirection = v; render(); }, ['row','column','row-reverse','column-reverse']);
        addRow(body, 'Align', 'select', el.style.alignItems || '', v => { el.style.alignItems = v || undefined; render(); }, ['','flex-start','center','flex-end','stretch','baseline']);
        addRow(body, 'Justify', 'select', el.style.justifyContent || '', v => { el.style.justifyContent = v || undefined; render(); }, ['','flex-start','center','flex-end','space-between','space-around','space-evenly']);
        addRow(body, 'Gap', 'number', el.style.gap, v => { el.style.gap = v; render(); });
      }
      addRow(body, 'Overflow', 'select', el.style.overflow || '', v => { el.style.overflow = v || undefined; render(); }, ['','visible','hidden','scroll','auto']);
    });

    addSection('Size', $propsContent, body => {
      addPairRow(body, 'W', 'width', 'H', 'height', el.style);
      addPairRow(body, 'Min W', 'minWidth', 'Min H', 'minHeight', el.style);
      addPairRow(body, 'Max W', 'maxWidth', 'Max H', 'maxHeight', el.style);
    });

    addSection('Spacing', $propsContent, body => {
      addRow(body, 'Padding', 'sizeOrStr', el.style.padding, v => { el.style.padding = v; render(); });
      addPairRow(body, 'P Top', 'paddingTop', 'P Bot', 'paddingBottom', el.style);
      addPairRow(body, 'P Left', 'paddingLeft', 'P Right', 'paddingRight', el.style);
      addRow(body, 'Margin', 'sizeOrStr', el.style.margin, v => { el.style.margin = v; render(); });
    });

    addSection('Appearance', $propsContent, body => {
      addRow(body, 'Background', 'color', el.style.background || '', v => { el.style.background = v || undefined; render(); });
      addRow(body, 'Border', 'text', el.style.border || '', v => { el.style.border = v || undefined; render(); });
      addRow(body, 'Radius', 'number', el.style.borderRadius, v => { el.style.borderRadius = v; render(); });
      addRow(body, 'Opacity', 'number', el.style.opacity != null ? el.style.opacity : '', v => { el.style.opacity = v === '' ? undefined : parseFloat(v); render(); });
      addRow(body, 'Shadow', 'text', el.style.boxShadow || '', v => { el.style.boxShadow = v || undefined; render(); });
    });

    if (['text','button','input'].includes(el.type)) {
      addSection('Typography', $propsContent, body => {
        addRow(body, 'Color', 'color', el.style.color || '#ffffff', v => { el.style.color = v; render(); });
        addRow(body, 'Size', 'number', el.style.fontSize, v => { el.style.fontSize = v; render(); });
        addRow(body, 'Weight', 'select', el.style.fontWeight || '', v => { el.style.fontWeight = v ? parseInt(v) : undefined; render(); }, ['','300','400','500','600','700','800']);
        addRow(body, 'Align', 'select', el.style.textAlign || '', v => { el.style.textAlign = v || undefined; render(); }, ['','left','center','right']);
      });
    }

    addSection('Position', $propsContent, body => {
      addRow(body, 'Position', 'select', el.style.position || '', v => { el.style.position = v || undefined; render(); }, ['','relative','absolute','fixed']);
      addPairRow(body, 'Top', 'top', 'Left', 'left', el.style);
      addPairRow(body, 'Bottom', 'bottom', 'Right', 'right', el.style);
    });

    addSection('Responsive', $propsContent, body => {
      const responsive = el.style.responsive || [];
      for (let i = 0; i < responsive.length; i++) {
        const bp = responsive[i];
        const bpDiv = document.createElement('div');
        bpDiv.style.cssText = 'border:1px solid var(--border);border-radius:4px;padding:6px;margin-bottom:6px;';
        const hdr = document.createElement('div');
        hdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;';
        const abLbl = document.createElement('span'); abLbl.style.cssText = 'font-size:10px;color:var(--text-secondary);'; abLbl.textContent = 'Above:';
        const abIn = document.createElement('input'); abIn.className = 've-prop-input ve-prop-input-sm'; abIn.type = 'number'; abIn.value = bp.above || 0;
        abIn.addEventListener('change', () => { bp.above = parseInt(abIn.value) || 0; pushHist(); render(); });
        const rmBtn = document.createElement('button'); rmBtn.textContent = '✕'; rmBtn.style.cssText = 'background:none;border:none;color:var(--error);cursor:pointer;font-size:11px;';
        rmBtn.addEventListener('click', () => { responsive.splice(i, 1); if (!responsive.length) delete el.style.responsive; pushHist(); render(); renderProps(); });
        hdr.append(abLbl, abIn, rmBtn); bpDiv.appendChild(hdr);
        for (const prop of ['width','height','fontSize','padding','gap']) {
          addRow(bpDiv, prop, 'sizeOrStr', bp[prop] != null ? bp[prop] : '', v => { if (v === '' || v === undefined) delete bp[prop]; else bp[prop] = v; pushHist(); render(); });
        }
        body.appendChild(bpDiv);
      }
      const addBtn = document.createElement('button');
      addBtn.textContent = '+ Add Breakpoint';
      addBtn.style.cssText = 'background:var(--accent-dim);border:1px solid var(--accent);border-radius:4px;color:var(--accent);padding:3px 10px;font-size:10px;cursor:pointer;width:100%;';
      addBtn.addEventListener('click', () => { if (!el.style.responsive) el.style.responsive = []; el.style.responsive.push({ above: 768 }); pushHist(); renderProps(); });
      body.appendChild(addBtn);
    });
  }

  // ── Property UI helpers ──

  function addSection(title, container, buildFn) {
    const sec = document.createElement('div'); sec.className = 've-prop-section';
    const hdr = document.createElement('div'); hdr.className = 've-prop-section-header'; hdr.textContent = title;
    const body = document.createElement('div'); body.className = 've-prop-section-body';
    sec.append(hdr, body); container.appendChild(sec);
    hdr.addEventListener('click', () => { body.style.display = body.style.display === 'none' ? '' : 'none'; });
    buildFn(body);
  }

  function toHex6(s) {
    if (!s) return null;
    if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
    if (/^#[0-9a-fA-F]{3}$/.test(s)) return '#' + s[1]+s[1]+s[2]+s[2]+s[3]+s[3];
    return null;
  }

  function addRow(container, label, type, value, onChange, options) {
    const row = document.createElement('div'); row.className = 've-prop-row';
    const lbl = document.createElement('span'); lbl.className = 've-prop-label'; lbl.textContent = label;
    row.appendChild(lbl);

    if (type === 'display') {
      const sp = document.createElement('span'); sp.style.cssText = 'font-size:11px;color:var(--text-secondary);'; sp.textContent = value; row.appendChild(sp);
    } else if (type === 'text') {
      const inp = document.createElement('input'); inp.className = 've-prop-input'; inp.type = 'text'; inp.value = value || '';
      inp.addEventListener('change', () => { onChange(inp.value); pushHist(); }); row.appendChild(inp);
    } else if (type === 'number') {
      const inp = document.createElement('input'); inp.className = 've-prop-input ve-prop-input-sm'; inp.type = 'number'; inp.value = value != null ? value : '';
      inp.addEventListener('change', () => { const v = inp.value === '' ? undefined : parseFloat(inp.value); onChange(v); pushHist(); }); row.appendChild(inp);
    } else if (type === 'sizeOrStr') {
      const inp = document.createElement('input'); inp.className = 've-prop-input'; inp.type = 'text'; inp.value = value != null ? value : '';
      inp.addEventListener('change', () => { let v = inp.value.trim(); if (v === '') onChange(undefined); else if (/^\d+$/.test(v)) onChange(parseInt(v)); else onChange(v); pushHist(); }); row.appendChild(inp);
    } else if (type === 'color') {
      const ci = document.createElement('input'); ci.className = 've-prop-color'; ci.type = 'color'; ci.value = toHex6(value) || '#000000';
      const ti = document.createElement('input'); ti.className = 've-prop-input'; ti.type = 'text'; ti.value = value || '';
      ci.addEventListener('input', () => { ti.value = ci.value; onChange(ci.value); });
      ci.addEventListener('change', () => pushHist());
      ti.addEventListener('change', () => { ci.value = toHex6(ti.value) || '#000000'; onChange(ti.value); pushHist(); });
      row.append(ci, ti);
    } else if (type === 'select') {
      const sel = document.createElement('select'); sel.className = 've-prop-select';
      for (const opt of (options || [])) { const o = document.createElement('option'); o.value = opt; o.textContent = opt || '—'; if (opt == value) o.selected = true; sel.appendChild(o); }
      sel.addEventListener('change', () => { onChange(sel.value); pushHist(); }); row.appendChild(sel);
    }
    container.appendChild(row);
  }

  function addPairRow(container, l1, k1, l2, k2, style) {
    const row = document.createElement('div'); row.className = 've-prop-row ve-prop-row-pair';
    for (const [l, k] of [[l1,k1],[l2,k2]]) {
      const pair = document.createElement('div'); pair.className = 've-prop-pair-item';
      const lbl = document.createElement('span'); lbl.className = 've-prop-pair-label'; lbl.textContent = l;
      const inp = document.createElement('input'); inp.className = 've-prop-input'; inp.type = 'text'; inp.value = style[k] != null ? style[k] : '';
      inp.addEventListener('change', () => {
        let v = inp.value.trim();
        if (v === '') style[k] = undefined; else if (/^\d+(\.\d+)?$/.test(v)) style[k] = parseFloat(v); else style[k] = v;
        pushHist(); render(); renderSelection();
      });
      pair.append(lbl, inp); row.appendChild(pair);
    }
    container.appendChild(row);
  }

  // ── History ──

  function pushHist() { history.push(toYAML(doc)); }

  function undo() {
    const s = history.undo();
    if (s) { doc = fromYAML(s); selectedId = findById(selectedId, doc.tree, null) ? selectedId : null; render(); renderLayerTree(); renderProps(); }
  }

  function redo() {
    const s = history.redo();
    if (s) { doc = fromYAML(s); selectedId = findById(selectedId, doc.tree, null) ? selectedId : null; render(); renderLayerTree(); renderProps(); }
  }

  // ── Drawing ──

  function finishDraw(state) {
    let w = Math.abs(state.curX - state.startX);
    let h = Math.abs(state.curY - state.startY);
    if (w < 5 && h < 5) { w = DEFAULTS[state.tool]?.width || 100; h = DEFAULTS[state.tool]?.height || 40; }
    const el = createElement(state.tool);
    el.style.width = Math.round(w); el.style.height = Math.round(h);

    let parent = null;
    if (selectedId) { const f = findById(selectedId, doc.tree, null); if (f?.el.children) parent = f.el; }
    if (!parent && doc.tree[0]?.children) parent = doc.tree[0];
    if (parent) parent.children.push(el); else doc.tree.push(el);

    pushHist(); select(el.id); render(); renderLayerTree();
    activeTool = 'select';
    document.querySelectorAll('.ve-tool-btn').forEach(b => b.classList.toggle('active', b.dataset.tool === 'select'));
    $canvas.style.cursor = '';
  }

  function duplicateSelected() {
    if (!selectedId) return;
    const f = findById(selectedId, doc.tree, null);
    if (!f) return;
    const clone = JSON.parse(JSON.stringify(f.el));
    const reId = n => { n.id = _uid(); if (n.children) n.children.forEach(reId); };
    reId(clone); clone.name += ' Copy';
    f.siblings.splice(f.index + 1, 0, clone);
    pushHist(); select(clone.id); render(); renderLayerTree();
  }

  // ── Context menu ──

  function showCtxMenu(x, y) {
    closeCtxMenu();
    const menu = document.createElement('div'); menu.className = 've-ctx-menu';
    menu.style.cssText = `left:${x}px;top:${y}px;`;
    const items = [];
    if (selectedId) {
      const f = findById(selectedId, doc.tree, null);
      if (f) {
        if (f.el.children) {
          items.push({ label: 'Add Frame Inside', fn: () => addChildTo(f.el, 'frame') });
          items.push({ label: 'Add Text Inside', fn: () => addChildTo(f.el, 'text') });
          items.push({ label: 'Add Button Inside', fn: () => addChildTo(f.el, 'button') });
          items.push({ label: 'Add Input Inside', fn: () => addChildTo(f.el, 'input') });
          items.push({ sep: true });
        }
        items.push({ label: 'Duplicate', fn: duplicateSelected });
        if (f.parent) items.push({ label: 'Delete', fn: () => { removeById(doc.tree, selectedId); selectedId = null; pushHist(); render(); renderLayerTree(); renderProps(); }, danger: true });
      }
      items.push({ sep: true });
      items.push({ label: 'Add View Component...', fn: () => {
        const parent = (f?.el?.children) ? f.el : null;
        showViewPicker(parent);
      }});
    } else {
      items.push({ label: 'Add Frame', fn: () => addToRoot('frame') });
      items.push({ label: 'Add Text', fn: () => addToRoot('text') });
      items.push({ sep: true });
      items.push({ label: 'Add View Component...', fn: () => showViewPicker(null) });
    }
    for (const it of items) {
      if (it.sep) { const s = document.createElement('div'); s.className = 've-ctx-sep'; menu.appendChild(s); continue; }
      const d = document.createElement('div'); d.className = 've-ctx-item' + (it.danger ? ' danger' : ''); d.textContent = it.label;
      d.addEventListener('click', () => { closeCtxMenu(); it.fn(); }); menu.appendChild(d);
    }
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener('click', closeCtxMenu, { once: true }), 0);
  }

  function closeCtxMenu() { const m = document.querySelector('.ve-ctx-menu'); if (m) m.remove(); }

  function addChildTo(parent, type) {
    const el = createElement(type); parent.children.push(el);
    pushHist(); select(el.id); render(); renderLayerTree();
  }

  function addToRoot(type) {
    const el = createElement(type);
    if (doc.tree[0]?.children) doc.tree[0].children.push(el); else doc.tree.push(el);
    pushHist(); select(el.id); render(); renderLayerTree();
  }

  // ── Imported view components ──

  const _viewCache = {}; // path -> parsed doc

  async function loadImportedView(fromPath) {
    if (_viewCache[fromPath]) return _viewCache[fromPath];
    try {
      const content = await invoke('read_file', { path: fromPath });
      const imported = fromYAML(content);
      _viewCache[fromPath] = imported;
      return imported;
    } catch (e) {
      console.error('Failed to load imported view:', fromPath, e);
      return null;
    }
  }

  function getImportByType(typeName) {
    return doc.imports.find(imp => imp.name === typeName);
  }

  // Re-render, loading any imported views as needed
  async function renderAsync() {
    $canvas.innerHTML = '';
    for (const node of doc.tree) await renderNodeAsync(node, $canvas);
    renderSelection();
  }

  async function renderNodeAsync(node, parentEl) {
    // Check if this is an imported component
    const imp = getImportByType(node.type);
    if (imp) {
      const importedDoc = await loadImportedView(imp.from);
      if (importedDoc) {
        // Render the imported view's tree inside a wrapper
        const wrapper = document.createElement('div');
        wrapper.className = 've-el ve-el-component';
        wrapper.dataset.id = node.id;
        // Apply any style overrides from the instance
        if (node.style && Object.keys(node.style).length) {
          const style = applyResponsive(node.style, doc.canvas.width, doc.tokens);
          applyStyleDOM(wrapper, style);
        }
        for (const child of importedDoc.tree) {
          renderImportedNode(child, wrapper, importedDoc.tokens);
        }
        parentEl.appendChild(wrapper);
        return;
      }
    }

    // Normal element
    const style = applyResponsive(node.style, doc.canvas.width, doc.tokens);
    const el = document.createElement('div');
    el.className = `ve-el ve-el-${node.type}`;
    el.dataset.id = node.id;
    applyStyleDOM(el, style);

    if (node.type === 'text' && node.text) el.textContent = node.text;
    if (node.type === 'button' && node.text) el.textContent = node.text;
    if (node.type === 'image') {
      el.innerHTML = '<svg width="24" height="24" viewBox="0 0 16 16" fill="none" style="opacity:0.3;"><rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/><circle cx="5.5" cy="5.5" r="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M2 11l3-3 2 2 3-3 4 4" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    }
    if (node.type === 'input') {
      const sp = document.createElement('span');
      sp.className = 've-placeholder';
      sp.textContent = node.placeholder || '';
      el.appendChild(sp);
    }

    if (node.children) for (const c of node.children) await renderNodeAsync(c, el);
    parentEl.appendChild(el);
  }

  // Render imported view nodes (uses the imported doc's tokens, non-interactive)
  function renderImportedNode(node, parentEl, tokens) {
    const style = applyResponsive(node.style, doc.canvas.width, tokens);
    const el = document.createElement('div');
    el.className = `ve-el ve-el-${node.type}`;
    // No data-id — imported internals aren't selectable
    applyStyleDOM(el, style);

    if (node.type === 'text' && node.text) el.textContent = node.text;
    if (node.type === 'button' && node.text) el.textContent = node.text;
    if (node.type === 'image') {
      el.innerHTML = '<svg width="24" height="24" viewBox="0 0 16 16" fill="none" style="opacity:0.3;"><rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/><circle cx="5.5" cy="5.5" r="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M2 11l3-3 2 2 3-3 4 4" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    }
    if (node.type === 'input') {
      const sp = document.createElement('span');
      sp.className = 've-placeholder';
      sp.textContent = node.placeholder || '';
      el.appendChild(sp);
    }

    if (node.children) for (const c of node.children) renderImportedNode(c, el, tokens);
    parentEl.appendChild(el);
  }

  // ── View picker ──

  async function collectViewFiles() {
    try {
      const tree = await invoke('get_file_tree');
      const views = [];
      const walk = (node) => {
        if (node.is_dir) {
          for (const child of (node.children || [])) walk(child);
        } else {
          if (node.name.endsWith('.view') && node.path !== currentFilePath) views.push(node);
        }
      };
      walk(tree);
      return views;
    } catch (e) {
      console.error('Failed to get file tree:', e);
      return [];
    }
  }

  async function showViewPicker(targetParent) {
    const picker = document.getElementById('ve-view-picker');
    const list = document.getElementById('ve-picker-list');
    const empty = document.getElementById('ve-picker-empty');
    list.innerHTML = '';

    const views = await collectViewFiles();

    if (views.length === 0) {
      empty.style.display = '';
      list.style.display = 'none';
    } else {
      empty.style.display = 'none';
      list.style.display = '';
      for (const v of views) {
        const item = document.createElement('div');
        item.className = 've-picker-item';
        const icon = document.createElement('span');
        icon.className = 've-picker-icon';
        icon.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><rect x="1" y="1" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="9" y="1" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="1" y="9" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="9" y="9" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.5"/></svg>';
        const nameSpan = document.createElement('span');
        // Derive component name from filename: header.view -> Header
        const compName = v.name.replace('.view', '').split(/[-_]/).map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');
        nameSpan.textContent = compName;
        const pathSpan = document.createElement('span');
        pathSpan.className = 've-picker-path';
        pathSpan.textContent = v.path;
        item.append(icon, nameSpan, pathSpan);

        item.addEventListener('click', () => {
          placeImportedView(compName, v.path, targetParent);
          closeViewPicker();
        });

        list.appendChild(item);
      }
    }

    picker.style.display = 'flex';
  }

  function closeViewPicker() {
    document.getElementById('ve-view-picker').style.display = 'none';
  }

  function placeImportedView(compName, fromPath, targetParent) {
    // Add import if not already present
    if (!doc.imports.find(imp => imp.name === compName && imp.from === fromPath)) {
      doc.imports.push({ name: compName, from: fromPath });
    }

    // Create element with the component type
    const el = {
      id: _uid(),
      type: compName,
      name: compName,
      style: {},
    };

    if (targetParent) {
      if (!targetParent.children) targetParent.children = [];
      targetParent.children.push(el);
    } else if (doc.tree[0]?.children) {
      doc.tree[0].children.push(el);
    } else {
      doc.tree.push(el);
    }

    // Clear cache for this path so it loads fresh
    delete _viewCache[fromPath];

    pushHist(); select(el.id); renderAsync(); renderLayerTree();
  }

  // ── Panel resize ──

  function initPanelResize(handleId, panelId, isLeft) {
    const handle = document.getElementById(handleId);
    const panel = document.getElementById(panelId);
    let startX, startW;

    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      startX = e.clientX;
      startW = panel.getBoundingClientRect().width;
      handle.classList.add('active');
      document.body.style.cursor = 'col-resize';

      const onMove = e => {
        const dx = e.clientX - startX;
        const newW = isLeft ? startW + dx : startW - dx;
        panel.style.width = clamp(newW, 100, 500) + 'px';
      };

      const onUp = () => {
        handle.classList.remove('active');
        document.body.style.cursor = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ── Event binding ──

  function bindEvents() {
    if (initialized) return;
    initialized = true;

    // Tool buttons
    document.querySelectorAll('.ve-tool-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        activeTool = btn.dataset.tool;
        document.querySelectorAll('.ve-tool-btn').forEach(b => b.classList.toggle('active', b.dataset.tool === activeTool));
        $canvas.style.cursor = activeTool === 'select' ? '' : 'crosshair';
      });
    });

    // Canvas mouse
    $canvasBg.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      const cr = $canvas.getBoundingClientRect();
      const mx = (e.clientX - cr.left) / zoom;
      const my = (e.clientY - cr.top) / zoom;

      // Resize handle?
      const handle = e.target.closest('.ve-sel-handle');
      if (handle && selectedId) {
        e.preventDefault();
        const f = findById(selectedId, doc.tree, null); if (!f) return;
        const selDom = $canvas.querySelector(`[data-id="${selectedId}"]`);
        dragState = { type: 'resize', handle: handle.dataset.handle, startX: e.clientX, startY: e.clientY, origStyle: { ...f.el.style }, origRect: getRelRect(selDom) };
        return;
      }

      // Draw tool
      if (activeTool !== 'select') {
        e.preventDefault();
        dragState = { type: 'draw', tool: activeTool, startX: mx, startY: my, curX: mx, curY: my };
        return;
      }

      // Select
      const target = e.target.closest('.ve-el[data-id]');
      if (target) {
        const id = target.dataset.id;
        select(id);
        const selDom = $canvas.querySelector(`[data-id="${id}"]`);
        const f = findById(id, doc.tree, null);
        dragState = { type: 'move', startX: e.clientX, startY: e.clientY, origStyle: { ...f.el.style }, origRect: getRelRect(selDom) };
      } else {
        select(null);
      }
    });

    document.addEventListener('mousemove', e => {
      // Only respond when view editor is visible
      if (document.getElementById('view-editor').style.display === 'none') return;

      if (!dragState) {
        const target = e.target.closest('.ve-el[data-id]');
        const nh = target ? target.dataset.id : null;
        if (nh !== hoveredId) { hoveredId = nh; renderSelection(); }
        return;
      }

      const dx = (e.clientX - dragState.startX) / zoom;
      const dy = (e.clientY - dragState.startY) / zoom;

      if (dragState.type === 'draw') {
        const cr = $canvas.getBoundingClientRect();
        dragState.curX = (e.clientX - cr.left) / zoom;
        dragState.curY = (e.clientY - cr.top) / zoom;
        // Draw preview
        const existing = $canvasBg.querySelector('.ve-draw-preview');
        if (existing) existing.remove();
        const x = Math.min(dragState.startX, dragState.curX), y = Math.min(dragState.startY, dragState.curY);
        const w = Math.abs(dragState.curX - dragState.startX), h = Math.abs(dragState.curY - dragState.startY);
        if (w > 2 || h > 2) {
          const prev = document.createElement('div'); prev.className = 've-draw-preview';
          prev.style.cssText = `left:${x*zoom}px;top:${y*zoom}px;width:${w*zoom}px;height:${h*zoom}px;`;
          $canvasBg.appendChild(prev);
        }
      }

      if (dragState.type === 'move' && selectedId) {
        const f = findById(selectedId, doc.tree, null); if (!f) return;
        if (f.el.style.position === 'absolute') {
          f.el.style.left = Math.round((dragState.origStyle.left || 0) + dx);
          f.el.style.top = Math.round((dragState.origStyle.top || 0) + dy);
          render();
        }
      }

      if (dragState.type === 'resize' && selectedId) {
        const f = findById(selectedId, doc.tree, null); if (!f) return;
        const orig = dragState.origStyle, oR = dragState.origRect, h = dragState.handle;
        let w = typeof orig.width === 'number' ? orig.width : oR.width;
        let ht = typeof orig.height === 'number' ? orig.height : oR.height;
        if (h.includes('e')) w = Math.max(10, w + dx);
        if (h.includes('w')) w = Math.max(10, w - dx);
        if (h.includes('s')) ht = Math.max(10, ht + dy);
        if (h.includes('n')) ht = Math.max(10, ht - dy);
        f.el.style.width = Math.round(w); f.el.style.height = Math.round(ht);
        if (f.el.style.position === 'absolute') {
          if (h.includes('w')) f.el.style.left = Math.round((orig.left || 0) + dx);
          if (h.includes('n')) f.el.style.top = Math.round((orig.top || 0) + dy);
        }
        render(); renderProps();
      }
    });

    document.addEventListener('mouseup', () => {
      if (!dragState) return;
      if (dragState.type === 'draw') finishDraw(dragState);
      if (dragState.type === 'move' || dragState.type === 'resize') pushHist();
      dragState = null;
      const prev = $canvasBg.querySelector('.ve-draw-preview'); if (prev) prev.remove();
    });

    // Canvas size inputs
    $canvasW.addEventListener('change', () => { doc.canvas.width = parseInt($canvasW.value) || 390; pushHist(); updateCanvasSize(); render(); });
    $canvasH.addEventListener('change', () => { doc.canvas.height = parseInt($canvasH.value) || 844; pushHist(); updateCanvasSize(); render(); });

    // Device presets
    document.querySelectorAll('.ve-device-presets button').forEach(btn => {
      btn.addEventListener('click', () => { doc.canvas.width = parseInt(btn.dataset.w); doc.canvas.height = parseInt(btn.dataset.h); pushHist(); updateCanvasSize(); render(); });
    });

    // Zoom
    document.getElementById('ve-zoom-in').addEventListener('click', () => setZoom(zoom + 0.1));
    document.getElementById('ve-zoom-out').addEventListener('click', () => setZoom(zoom - 0.1));
    document.getElementById('ve-zoom-fit').addEventListener('click', () => {
      const area = document.getElementById('ve-canvas-area');
      const fw = (area.clientWidth - 80) / doc.canvas.width;
      const fh = (area.clientHeight - 80) / doc.canvas.height;
      setZoom(Math.min(fw, fh, 1));
    });

    document.getElementById('ve-canvas-area').addEventListener('wheel', e => {
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(zoom - e.deltaY * 0.002); }
    }, { passive: false });

    // Context menu
    $canvasBg.addEventListener('contextmenu', e => { e.preventDefault(); showCtxMenu(e.clientX, e.clientY); });

    // Panel resize handles
    initPanelResize('ve-resize-left', 've-layers', true);
    initPanelResize('ve-resize-right', 've-props', false);

    // View picker
    document.getElementById('ve-add-view').addEventListener('click', () => {
      const targetParent = selectedId ? findById(selectedId, doc.tree, null)?.el : null;
      const parent = (targetParent?.children) ? targetParent : null;
      showViewPicker(parent);
    });
    document.getElementById('ve-picker-close').addEventListener('click', closeViewPicker);
    document.querySelector('.ve-picker-backdrop').addEventListener('click', closeViewPicker);

    // Back button — return to notes
    document.getElementById('ve-back').addEventListener('click', () => {
      saveCurrentFile();
      showWelcome();
    });

    // Keyboard (only when view editor is visible)
    document.addEventListener('keydown', e => {
      if (document.getElementById('view-editor').style.display === 'none') return;
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;

      const key = e.key.toLowerCase();
      const toolMap = { v:'select', f:'frame', t:'text', b:'button', i:'input', g:'image', d:'divider' };
      if (toolMap[key] && !e.metaKey && !e.ctrlKey) {
        activeTool = toolMap[key];
        document.querySelectorAll('.ve-tool-btn').forEach(b => b.classList.toggle('active', b.dataset.tool === activeTool));
        $canvas.style.cursor = activeTool === 'select' ? '' : 'crosshair';
        return;
      }
      if (key === 'w' && !e.metaKey && !e.ctrlKey) {
        const targetParent = selectedId ? findById(selectedId, doc.tree, null)?.el : null;
        showViewPicker((targetParent?.children) ? targetParent : null);
        return;
      }
      if ((key === 'delete' || key === 'backspace') && selectedId) {
        const f = findById(selectedId, doc.tree, null);
        if (f?.parent) { removeById(doc.tree, selectedId); selectedId = null; pushHist(); render(); renderLayerTree(); renderProps(); }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.metaKey || e.ctrlKey) && key === 'z' && e.shiftKey) { e.preventDefault(); redo(); }
      if ((e.metaKey || e.ctrlKey) && key === 'd' && selectedId) { e.preventDefault(); duplicateSelected(); }
      if (key === 'escape') {
        if (document.getElementById('ve-view-picker').style.display !== 'none') {
          closeViewPicker();
        } else {
          saveCurrentFile();
          showWelcome();
        }
      }
    });
  }

  // ── Public API ──

  return {
    load(yamlStr) {
      initRefs();
      bindEvents();
      try { doc = fromYAML(yamlStr); } catch (e) { console.error('Failed to parse .view:', e); doc = createDefaultDoc(); }
      selectedId = null; hoveredId = null; activeTool = 'select';
      history.stack = []; history.idx = -1;
      pushHist();
      updateCanvasSize(); render(); renderLayerTree(); renderProps();
    },
    loadDefault() {
      initRefs();
      bindEvents();
      doc = createDefaultDoc();
      selectedId = null; hoveredId = null; activeTool = 'select';
      history.stack = []; history.idx = -1;
      pushHist();
      updateCanvasSize(); render(); renderLayerTree(); renderProps();
    },
    getContent() { return toYAML(doc); },
  };
})();

// Bridge functions called from the main app flow
function veLoadFile(content) {
  ViewEditor.load(content);
  const name = currentFilePath ? currentFilePath.split("/").pop() : "untitled.view";
  document.getElementById("ve-file-name").textContent = name;
}
function veGetContent() { return ViewEditor.getContent(); }
