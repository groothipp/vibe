// ─────────────────────────────────────────────
// Vibe View Editor — app.js
// ─────────────────────────────────────────────

(() => {
  'use strict';

  // ── Helpers ──
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => [...(el || document).querySelectorAll(s)];
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  let idCounter = 0;
  const uid = () => `el_${++idCounter}`;

  // ── Element type definitions ──
  const ELEMENT_TYPES = {
    frame:   { label: 'Frame',   icon: '▢', hasChildren: true },
    text:    { label: 'Text',    icon: 'T', hasChildren: false },
    button:  { label: 'Button',  icon: '⊡', hasChildren: false },
    input:   { label: 'Input',   icon: '⊟', hasChildren: false },
    image:   { label: 'Image',   icon: '⊞', hasChildren: false },
    icon:    { label: 'Icon',    icon: '◉', hasChildren: false },
    divider: { label: 'Divider', icon: '—', hasChildren: false },
  };

  // Default styles per type
  const DEFAULT_STYLES = {
    frame: {
      width: 200, height: 150,
      background: '#222222',
      borderRadius: 8,
    },
    text: {
      width: 120, height: 24,
      color: '#ffffff',
      fontSize: 14,
    },
    button: {
      width: 120, height: 40,
      background: '#6366f1',
      borderRadius: 8,
      color: '#ffffff',
      fontSize: 14,
      fontWeight: 600,
    },
    input: {
      width: 200, height: 40,
      background: '#1a1a1a',
      borderRadius: 6,
      border: '1px solid #333',
      color: '#ffffff',
      fontSize: 14,
    },
    image: {
      width: 150, height: 100,
      background: '#1e1e1e',
      borderRadius: 4,
    },
    icon: {
      width: 24, height: 24,
    },
    divider: {
      width: '100%', height: 1,
      background: '#333',
    },
  };

  // ── Data Model ──

  class ViewDocument {
    constructor() {
      this.name = 'Untitled View';
      this.canvas = { width: 390, height: 844 };
      this.tokens = {
        colors: {},
        typography: {},
        spacing: {},
      };
      this.imports = [];
      this.tree = [];
      this.filePath = null;
    }

    static createDefault() {
      const doc = new ViewDocument();
      const root = ViewDocument.createElement('frame', 'Root');
      root.style = {
        width: '100%',
        height: '100%',
        background: '#111111',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: 24,
        gap: 16,
      };
      doc.tree = [root];
      return doc;
    }

    static createElement(type, name) {
      const el = {
        id: uid(),
        type: type,
        name: name || ELEMENT_TYPES[type]?.label || type,
        style: { ...DEFAULT_STYLES[type] },
      };
      if (type === 'text') el.text = 'Text';
      if (type === 'button') el.text = 'Button';
      if (type === 'input') el.placeholder = 'Placeholder...';
      if (ELEMENT_TYPES[type]?.hasChildren) el.children = [];
      return el;
    }

    // Find element by id (returns { el, parent, index })
    findById(id, nodes, parent) {
      nodes = nodes || this.tree;
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].id === id) return { el: nodes[i], parent: parent || null, index: i, siblings: nodes };
        if (nodes[i].children) {
          const r = this.findById(id, nodes[i].children, nodes[i]);
          if (r) return r;
        }
      }
      return null;
    }

    // Flatten tree to array
    flatten(nodes, depth, result) {
      nodes = nodes || this.tree;
      depth = depth || 0;
      result = result || [];
      for (const n of nodes) {
        result.push({ el: n, depth });
        if (n.children) this.flatten(n.children, depth + 1, result);
      }
      return result;
    }

    removeById(id) {
      const found = this.findById(id);
      if (found) {
        found.siblings.splice(found.index, 1);
        return found.el;
      }
      return null;
    }

    // ── Serialization ──

    toYAML() {
      const obj = {
        name: this.name,
        canvas: this.canvas,
      };

      // Only include tokens if they have content
      const hasTokens = Object.keys(this.tokens.colors).length > 0 ||
                        Object.keys(this.tokens.typography).length > 0 ||
                        Object.keys(this.tokens.spacing).length > 0;
      if (hasTokens) obj.tokens = this.tokens;

      if (this.imports.length > 0) obj.imports = this.imports;

      obj.tree = this.tree.map(n => this._serializeNode(n));

      return jsyaml.dump(obj, {
        indent: 2,
        lineWidth: 120,
        noRefs: true,
        quotingType: '"',
        forceQuotes: false,
      });
    }

    _serializeNode(node) {
      const out = { id: node.id, type: node.type, name: node.name };
      if (node.text != null) out.text = node.text;
      if (node.placeholder != null) out.placeholder = node.placeholder;
      if (node.src != null) out.src = node.src;
      if (node.icon != null) out.icon = node.icon;

      if (node.style && Object.keys(node.style).length > 0) {
        out.style = { ...node.style };
        // Clean up undefined values
        for (const k of Object.keys(out.style)) {
          if (out.style[k] === undefined || out.style[k] === '') delete out.style[k];
        }
      }

      if (node.children && node.children.length > 0) {
        out.children = node.children.map(c => this._serializeNode(c));
      }

      return out;
    }

    static fromYAML(yamlStr) {
      const obj = jsyaml.load(yamlStr);
      const doc = new ViewDocument();
      doc.name = obj.name || 'Untitled View';
      doc.canvas = obj.canvas || { width: 390, height: 844 };
      doc.tokens = obj.tokens || { colors: {}, typography: {}, spacing: {} };
      if (!doc.tokens.colors) doc.tokens.colors = {};
      if (!doc.tokens.typography) doc.tokens.typography = {};
      if (!doc.tokens.spacing) doc.tokens.spacing = {};
      doc.imports = obj.imports || [];
      doc.tree = (obj.tree || []).map(n => ViewDocument._deserializeNode(n));
      // Ensure id counter is above all existing ids
      const allIds = doc.flatten().map(f => f.el.id);
      for (const id of allIds) {
        const m = id.match(/^el_(\d+)$/);
        if (m) idCounter = Math.max(idCounter, parseInt(m[1]));
      }
      return doc;
    }

    static _deserializeNode(obj) {
      const node = {
        id: obj.id || uid(),
        type: obj.type || 'frame',
        name: obj.name || obj.type || 'Element',
        style: obj.style || {},
      };
      if (obj.text != null) node.text = obj.text;
      if (obj.placeholder != null) node.placeholder = obj.placeholder;
      if (obj.src != null) node.src = obj.src;
      if (obj.icon != null) node.icon = obj.icon;
      if (obj.children) {
        node.children = obj.children.map(c => ViewDocument._deserializeNode(c));
      } else if (ELEMENT_TYPES[node.type]?.hasChildren) {
        node.children = [];
      }
      return node;
    }
  }

  // ── Undo/Redo ──

  class History {
    constructor(maxSize = 100) {
      this.stack = [];
      this.index = -1;
      this.maxSize = maxSize;
    }

    push(snapshot) {
      // Remove anything ahead of current position
      this.stack = this.stack.slice(0, this.index + 1);
      this.stack.push(snapshot);
      if (this.stack.length > this.maxSize) this.stack.shift();
      this.index = this.stack.length - 1;
    }

    undo() {
      if (this.index > 0) return this.stack[--this.index];
      return null;
    }

    redo() {
      if (this.index < this.stack.length - 1) return this.stack[++this.index];
      return null;
    }

    get canUndo() { return this.index > 0; }
    get canRedo() { return this.index < this.stack.length - 1; }
  }

  // ── Token Resolver ──

  function resolveToken(value, tokens) {
    if (typeof value !== 'string') return value;
    // Replace $category.key patterns
    return value.replace(/\$(\w+)\.(\w+)/g, (match, cat, key) => {
      const category = tokens[cat];
      if (!category) return match;
      const val = category[key];
      if (val === undefined) return match;
      if (typeof val === 'object') return match; // Can't inline objects
      return val;
    });
  }

  function resolveStyle(style, tokens) {
    if (!style) return {};
    const resolved = {};
    for (const [k, v] of Object.entries(style)) {
      if (k === 'responsive') continue; // Don't resolve, keep as-is
      if (k === 'apply') {
        // Spread a typography or other token group
        const ref = typeof v === 'string' ? v : null;
        if (ref) {
          const m = ref.match(/^\$(\w+)\.(\w+)$/);
          if (m && tokens[m[1]] && typeof tokens[m[1]][m[2]] === 'object') {
            Object.assign(resolved, tokens[m[1]][m[2]]);
          }
        }
        continue;
      }
      resolved[k] = resolveToken(v, tokens);
    }
    return resolved;
  }

  // Apply responsive overrides based on canvas width
  function applyResponsive(style, canvasWidth, tokens) {
    const resolved = resolveStyle(style, tokens);
    if (style && style.responsive) {
      for (const bp of style.responsive) {
        if (canvasWidth >= bp.above) {
          const bpResolved = resolveStyle(bp, tokens);
          delete bpResolved.above;
          Object.assign(resolved, bpResolved);
        }
      }
    }
    return resolved;
  }


  // ═══════════════════════════════════════════════
  // ── Main Editor ──
  // ═══════════════════════════════════════════════

  let doc = ViewDocument.createDefault();
  let selectedId = null;
  let hoveredId = null;
  let activeTool = 'select';
  let zoom = 1;
  const history = new History();

  // DOM refs
  const canvasBg = $('#canvas-bg');
  const canvasEl = $('#canvas');
  const selOverlay = $('#selection-overlay');
  const guidesOverlay = $('#guides-overlay');
  const layerTree = $('#layer-tree');
  const propsContent = $('#props-content');
  const propsTitle = $('#props-title');
  const canvasWInput = $('#canvas-w');
  const canvasHInput = $('#canvas-h');
  const zoomDisplay = $('#zoom-display');

  // ── Init ──
  function init() {
    pushHistory();
    updateCanvasSize();
    render();
    renderLayerTree();
    renderProps();
    bindEvents();
  }

  // ── History helpers ──
  function pushHistory() {
    history.push(doc.toYAML());
  }

  function undo() {
    const snap = history.undo();
    if (snap) {
      doc = ViewDocument.fromYAML(snap);
      selectedId = doc.findById(selectedId) ? selectedId : null;
      render(); renderLayerTree(); renderProps();
    }
  }

  function redo() {
    const snap = history.redo();
    if (snap) {
      doc = ViewDocument.fromYAML(snap);
      selectedId = doc.findById(selectedId) ? selectedId : null;
      render(); renderLayerTree(); renderProps();
    }
  }

  // ── Canvas Size ──
  function updateCanvasSize() {
    canvasBg.style.width = (doc.canvas.width * zoom) + 'px';
    canvasBg.style.height = (doc.canvas.height * zoom) + 'px';
    canvasEl.style.transform = `scale(${zoom})`;
    canvasEl.style.transformOrigin = 'top left';
    canvasEl.style.width = doc.canvas.width + 'px';
    canvasEl.style.height = doc.canvas.height + 'px';
    canvasWInput.value = doc.canvas.width;
    canvasHInput.value = doc.canvas.height;
    zoomDisplay.textContent = Math.round(zoom * 100) + '%';
    // Selection overlay needs same transform
    selOverlay.style.transform = `scale(${zoom})`;
    selOverlay.style.transformOrigin = 'top left';
    selOverlay.style.width = doc.canvas.width + 'px';
    selOverlay.style.height = doc.canvas.height + 'px';
    guidesOverlay.style.transform = `scale(${zoom})`;
    guidesOverlay.style.transformOrigin = 'top left';
    guidesOverlay.style.width = doc.canvas.width + 'px';
    guidesOverlay.style.height = doc.canvas.height + 'px';
  }

  function setZoom(z) {
    zoom = clamp(z, 0.1, 5);
    updateCanvasSize();
    renderSelection();
  }

  // ── Render tree to canvas ──

  function render() {
    canvasEl.innerHTML = '';
    for (const node of doc.tree) {
      renderNode(node, canvasEl);
    }
    renderSelection();
  }

  function renderNode(node, parentEl) {
    const style = applyResponsive(node.style, doc.canvas.width, doc.tokens);
    const el = document.createElement('div');
    el.className = `ce ce-${node.type}`;
    el.dataset.id = node.id;

    // Apply styles
    applyStylesToDOM(el, style, node);

    // Content
    if (node.type === 'text' && node.text) {
      el.textContent = node.text;
    }
    if (node.type === 'button' && node.text) {
      el.textContent = node.text;
    }
    if (node.type === 'input') {
      const span = document.createElement('span');
      span.className = 'placeholder';
      span.textContent = node.placeholder || '';
      el.appendChild(span);
    }

    // Children
    if (node.children) {
      for (const child of node.children) {
        renderNode(child, el);
      }
    }

    parentEl.appendChild(el);
  }

  function applyStylesToDOM(el, style, node) {
    const s = el.style;

    // Position: if parent is flex, don't set absolute
    // For root-level items, use relative positioning within the canvas
    // The canvas itself is the container

    // Layout props
    if (style.display) s.display = style.display;
    if (style.flexDirection) s.flexDirection = style.flexDirection;
    if (style.alignItems) s.alignItems = style.alignItems;
    if (style.justifyContent) s.justifyContent = style.justifyContent;
    if (style.flexWrap) s.flexWrap = style.flexWrap;
    if (style.gap != null) s.gap = px(style.gap);

    // Size
    if (style.width != null) s.width = px(style.width);
    if (style.height != null) s.height = px(style.height);
    if (style.minWidth != null) s.minWidth = px(style.minWidth);
    if (style.maxWidth != null) s.maxWidth = px(style.maxWidth);
    if (style.minHeight != null) s.minHeight = px(style.minHeight);
    if (style.maxHeight != null) s.maxHeight = px(style.maxHeight);

    // Spacing
    if (style.padding != null) s.padding = px(style.padding);
    if (style.paddingTop != null) s.paddingTop = px(style.paddingTop);
    if (style.paddingRight != null) s.paddingRight = px(style.paddingRight);
    if (style.paddingBottom != null) s.paddingBottom = px(style.paddingBottom);
    if (style.paddingLeft != null) s.paddingLeft = px(style.paddingLeft);
    if (style.margin != null) s.margin = px(style.margin);

    // Appearance
    if (style.background) s.background = style.background;
    if (style.color) s.color = style.color;
    if (style.border) s.border = style.border;
    if (style.borderRadius != null) s.borderRadius = px(style.borderRadius);
    if (style.opacity != null) s.opacity = style.opacity;
    if (style.overflow) s.overflow = style.overflow;
    if (style.boxShadow) s.boxShadow = style.boxShadow;

    // Typography
    if (style.fontSize != null) s.fontSize = px(style.fontSize);
    if (style.fontWeight != null) s.fontWeight = style.fontWeight;
    if (style.lineHeight != null) s.lineHeight = typeof style.lineHeight === 'number' ? style.lineHeight : style.lineHeight;
    if (style.textAlign) s.textAlign = style.textAlign;
    if (style.letterSpacing != null) s.letterSpacing = px(style.letterSpacing);

    // Position (for absolutely-positioned items)
    if (style.position) s.position = style.position;
    if (style.top != null) s.top = px(style.top);
    if (style.left != null) s.left = px(style.left);
    if (style.right != null) s.right = px(style.right);
    if (style.bottom != null) s.bottom = px(style.bottom);
  }

  function px(v) {
    if (typeof v === 'number') return v + 'px';
    return v; // string like '100%' or '0 16px'
  }

  // ── Selection ──

  function renderSelection() {
    selOverlay.innerHTML = '';

    // Hover highlight
    if (hoveredId && hoveredId !== selectedId) {
      const hEl = canvasEl.querySelector(`[data-id="${hoveredId}"]`);
      if (hEl) {
        const r = getRelativeRect(hEl);
        const hbox = document.createElement('div');
        hbox.className = 'hover-box';
        hbox.style.left = r.left + 'px';
        hbox.style.top = r.top + 'px';
        hbox.style.width = r.width + 'px';
        hbox.style.height = r.height + 'px';
        selOverlay.appendChild(hbox);
      }
    }

    if (!selectedId) return;
    const selEl = canvasEl.querySelector(`[data-id="${selectedId}"]`);
    if (!selEl) return;

    const r = getRelativeRect(selEl);

    // Selection box
    const box = document.createElement('div');
    box.className = 'sel-box';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
    selOverlay.appendChild(box);

    // Resize handles
    const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
    for (const dir of handles) {
      const h = document.createElement('div');
      h.className = `sel-handle ${dir}`;
      h.dataset.handle = dir;
      box.appendChild(h);
    }
  }

  function getRelativeRect(el) {
    const canvasRect = canvasEl.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    return {
      left: (elRect.left - canvasRect.left) / zoom,
      top: (elRect.top - canvasRect.top) / zoom,
      width: elRect.width / zoom,
      height: elRect.height / zoom,
    };
  }

  function select(id) {
    selectedId = id;
    renderSelection();
    renderLayerTree();
    renderProps();
  }

  // ── Layer Tree ──

  function renderLayerTree() {
    layerTree.innerHTML = '';
    const flat = doc.flatten();
    for (const { el, depth } of flat) {
      const item = document.createElement('div');
      item.className = 'layer-item' + (el.id === selectedId ? ' selected' : '');
      item.dataset.id = el.id;

      const indent = document.createElement('span');
      indent.className = 'layer-indent';
      indent.style.width = (depth * 16) + 'px';

      const icon = document.createElement('span');
      icon.className = 'layer-icon';
      icon.textContent = ELEMENT_TYPES[el.type]?.icon || '?';

      const name = document.createElement('span');
      name.className = 'layer-name';
      name.textContent = el.name;

      item.appendChild(indent);
      item.appendChild(icon);
      item.appendChild(name);
      layerTree.appendChild(item);

      item.addEventListener('click', () => select(el.id));
      item.addEventListener('dblclick', () => {
        // Inline rename
        name.contentEditable = true;
        name.focus();
        const range = document.createRange();
        range.selectNodeContents(name);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);

        const finish = () => {
          name.contentEditable = false;
          el.name = name.textContent.trim() || el.name;
          pushHistory();
          renderLayerTree();
        };
        name.addEventListener('blur', finish, { once: true });
        name.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); name.blur(); }
          if (e.key === 'Escape') { name.textContent = el.name; name.blur(); }
        });
      });
    }
  }

  // ── Properties Panel ──

  function renderProps() {
    if (!selectedId) {
      propsTitle.textContent = 'Properties';
      propsContent.innerHTML = '<div class="props-empty">Select an element to edit its properties</div>';
      return;
    }

    const found = doc.findById(selectedId);
    if (!found) return;
    const el = found.el;

    propsTitle.textContent = el.name;
    propsContent.innerHTML = '';

    // ── Element section ──
    addSection('Element', propsContent, (body) => {
      addPropRow(body, 'Name', 'text', el.name, v => { el.name = v; renderLayerTree(); });
      addPropRow(body, 'Type', 'display', ELEMENT_TYPES[el.type]?.label || el.type);
      if (el.text != null) {
        addPropRow(body, 'Text', 'text', el.text, v => { el.text = v; render(); });
      }
      if (el.placeholder != null) {
        addPropRow(body, 'Placeholder', 'text', el.placeholder, v => { el.placeholder = v; render(); });
      }
    });

    // ── Layout section ──
    addSection('Layout', propsContent, (body) => {
      addPropRow(body, 'Display', 'select', el.style.display || '', v => {
        el.style.display = v || undefined; render();
      }, ['', 'flex', 'block', 'grid', 'none']);

      if (el.style.display === 'flex') {
        addPropRow(body, 'Direction', 'select', el.style.flexDirection || 'row', v => {
          el.style.flexDirection = v; render();
        }, ['row', 'column', 'row-reverse', 'column-reverse']);

        addPropRow(body, 'Align', 'select', el.style.alignItems || '', v => {
          el.style.alignItems = v || undefined; render();
        }, ['', 'flex-start', 'center', 'flex-end', 'stretch', 'baseline']);

        addPropRow(body, 'Justify', 'select', el.style.justifyContent || '', v => {
          el.style.justifyContent = v || undefined; render();
        }, ['', 'flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly']);

        addPropRow(body, 'Wrap', 'select', el.style.flexWrap || '', v => {
          el.style.flexWrap = v || undefined; render();
        }, ['', 'wrap', 'nowrap', 'wrap-reverse']);

        addPropRow(body, 'Gap', 'number', el.style.gap, v => { el.style.gap = v; render(); });
      }

      addPropRow(body, 'Overflow', 'select', el.style.overflow || '', v => {
        el.style.overflow = v || undefined; render();
      }, ['', 'visible', 'hidden', 'scroll', 'auto']);
    });

    // ── Size section ──
    addSection('Size', propsContent, (body) => {
      addPropPairRow(body, 'W', 'width', 'H', 'height', el.style);
      addPropPairRow(body, 'Min W', 'minWidth', 'Min H', 'minHeight', el.style);
      addPropPairRow(body, 'Max W', 'maxWidth', 'Max H', 'maxHeight', el.style);
    });

    // ── Spacing section ──
    addSection('Spacing', propsContent, (body) => {
      addPropRow(body, 'Padding', 'sizeOrStr', el.style.padding, v => { el.style.padding = v; render(); });
      addPropPairRow(body, 'P Top', 'paddingTop', 'P Bot', 'paddingBottom', el.style);
      addPropPairRow(body, 'P Left', 'paddingLeft', 'P Right', 'paddingRight', el.style);
      addPropRow(body, 'Margin', 'sizeOrStr', el.style.margin, v => { el.style.margin = v; render(); });
    });

    // ── Appearance section ──
    addSection('Appearance', propsContent, (body) => {
      addPropRow(body, 'Background', 'color', el.style.background || '', v => { el.style.background = v || undefined; render(); });
      addPropRow(body, 'Border', 'text', el.style.border || '', v => { el.style.border = v || undefined; render(); });
      addPropRow(body, 'Radius', 'number', el.style.borderRadius, v => { el.style.borderRadius = v; render(); });
      addPropRow(body, 'Opacity', 'number', el.style.opacity != null ? el.style.opacity : '', v => {
        el.style.opacity = v === '' ? undefined : parseFloat(v); render();
      });
      addPropRow(body, 'Shadow', 'text', el.style.boxShadow || '', v => { el.style.boxShadow = v || undefined; render(); });
    });

    // ── Typography section ──
    if (['text', 'button', 'input'].includes(el.type)) {
      addSection('Typography', propsContent, (body) => {
        addPropRow(body, 'Color', 'color', el.style.color || '#ffffff', v => { el.style.color = v; render(); });
        addPropRow(body, 'Size', 'number', el.style.fontSize, v => { el.style.fontSize = v; render(); });
        addPropRow(body, 'Weight', 'select', el.style.fontWeight || '', v => {
          el.style.fontWeight = v ? parseInt(v) : undefined; render();
        }, ['', '300', '400', '500', '600', '700', '800']);
        addPropRow(body, 'Align', 'select', el.style.textAlign || '', v => {
          el.style.textAlign = v || undefined; render();
        }, ['', 'left', 'center', 'right']);
        addPropRow(body, 'Line H', 'number', el.style.lineHeight, v => { el.style.lineHeight = v; render(); });
      });
    }

    // ── Position section ──
    addSection('Position', propsContent, (body) => {
      addPropRow(body, 'Position', 'select', el.style.position || '', v => {
        el.style.position = v || undefined; render();
      }, ['', 'relative', 'absolute', 'fixed']);
      addPropPairRow(body, 'Top', 'top', 'Left', 'left', el.style);
      addPropPairRow(body, 'Bottom', 'bottom', 'Right', 'right', el.style);
    });

    // ── Responsive section ──
    addSection('Responsive', propsContent, (body) => {
      const responsive = el.style.responsive || [];
      for (let i = 0; i < responsive.length; i++) {
        const bp = responsive[i];
        const bpDiv = document.createElement('div');
        bpDiv.style.cssText = 'border:1px solid var(--border);border-radius:4px;padding:8px;margin-bottom:8px;';

        const headerRow = document.createElement('div');
        headerRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;';
        const aboveLabel = document.createElement('span');
        aboveLabel.style.cssText = 'font-size:11px;color:var(--text-dim);';
        aboveLabel.textContent = 'Above:';
        const aboveInput = document.createElement('input');
        aboveInput.className = 'prop-input prop-input-sm';
        aboveInput.type = 'number';
        aboveInput.value = bp.above || 0;
        aboveInput.addEventListener('change', () => {
          bp.above = parseInt(aboveInput.value) || 0;
          pushHistory(); render();
        });
        const removeBtn = document.createElement('button');
        removeBtn.textContent = '✕';
        removeBtn.style.cssText = 'background:none;border:none;color:var(--danger);cursor:pointer;font-size:12px;';
        removeBtn.addEventListener('click', () => {
          responsive.splice(i, 1);
          if (responsive.length === 0) delete el.style.responsive;
          pushHistory(); render(); renderProps();
        });
        headerRow.appendChild(aboveLabel);
        headerRow.appendChild(aboveInput);
        headerRow.appendChild(removeBtn);
        bpDiv.appendChild(headerRow);

        // Show overridable props (simplified: just width, height, fontSize, padding)
        for (const prop of ['width', 'height', 'fontSize', 'padding', 'gap']) {
          addPropRow(bpDiv, prop, 'sizeOrStr', bp[prop] != null ? bp[prop] : '', v => {
            if (v === '' || v === undefined) { delete bp[prop]; } else { bp[prop] = v; }
            pushHistory(); render();
          });
        }

        body.appendChild(bpDiv);
      }

      const addBtn = document.createElement('button');
      addBtn.textContent = '+ Add Breakpoint';
      addBtn.style.cssText = 'background:var(--accent-dim);border:1px solid var(--accent);border-radius:4px;color:var(--accent);padding:4px 12px;font-size:11px;cursor:pointer;width:100%;';
      addBtn.addEventListener('click', () => {
        if (!el.style.responsive) el.style.responsive = [];
        el.style.responsive.push({ above: 768 });
        pushHistory(); renderProps();
      });
      body.appendChild(addBtn);
    });
  }

  // ── Property UI helpers ──

  function addSection(title, container, buildFn) {
    const sec = document.createElement('div');
    sec.className = 'prop-section';
    const header = document.createElement('div');
    header.className = 'prop-section-header';
    header.textContent = title;
    const body = document.createElement('div');
    body.className = 'prop-section-body';
    sec.appendChild(header);
    sec.appendChild(body);
    container.appendChild(sec);

    header.addEventListener('click', () => {
      body.style.display = body.style.display === 'none' ? '' : 'none';
    });

    buildFn(body);
  }

  function addPropRow(container, label, type, value, onChange, options) {
    const row = document.createElement('div');
    row.className = 'prop-row';

    const lbl = document.createElement('span');
    lbl.className = 'prop-label';
    lbl.textContent = label;
    row.appendChild(lbl);

    if (type === 'display') {
      const span = document.createElement('span');
      span.style.cssText = 'font-size:12px;color:var(--text-dim);';
      span.textContent = value;
      row.appendChild(span);
    } else if (type === 'text') {
      const input = document.createElement('input');
      input.className = 'prop-input';
      input.type = 'text';
      input.value = value || '';
      input.addEventListener('change', () => { onChange(input.value); pushHistory(); });
      row.appendChild(input);
    } else if (type === 'number') {
      const input = document.createElement('input');
      input.className = 'prop-input prop-input-sm';
      input.type = 'number';
      input.value = value != null ? value : '';
      input.addEventListener('change', () => {
        const v = input.value === '' ? undefined : parseFloat(input.value);
        onChange(v);
        pushHistory();
      });
      row.appendChild(input);
    } else if (type === 'sizeOrStr') {
      const input = document.createElement('input');
      input.className = 'prop-input';
      input.type = 'text';
      input.value = value != null ? value : '';
      input.placeholder = 'e.g. 16 or 8px 16px';
      input.addEventListener('change', () => {
        let v = input.value.trim();
        if (v === '') { onChange(undefined); }
        else if (/^\d+$/.test(v)) { onChange(parseInt(v)); }
        else { onChange(v); }
        pushHistory();
      });
      row.appendChild(input);
    } else if (type === 'color') {
      const colorInput = document.createElement('input');
      colorInput.className = 'prop-color';
      colorInput.type = 'color';
      colorInput.value = toHex6(value) || '#000000';
      const textInput = document.createElement('input');
      textInput.className = 'prop-input';
      textInput.type = 'text';
      textInput.value = value || '';
      colorInput.addEventListener('input', () => {
        textInput.value = colorInput.value;
        onChange(colorInput.value);
      });
      colorInput.addEventListener('change', () => pushHistory());
      textInput.addEventListener('change', () => {
        colorInput.value = toHex6(textInput.value) || '#000000';
        onChange(textInput.value);
        pushHistory();
      });
      row.appendChild(colorInput);
      row.appendChild(textInput);
    } else if (type === 'select') {
      const sel = document.createElement('select');
      sel.className = 'prop-select';
      for (const opt of (options || [])) {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt || '—';
        if (opt == value) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => { onChange(sel.value); pushHistory(); });
      row.appendChild(sel);
    }

    container.appendChild(row);
  }

  function addPropPairRow(container, label1, key1, label2, key2, style) {
    const row = document.createElement('div');
    row.className = 'prop-row prop-row-pair';

    for (const [label, key] of [[label1, key1], [label2, key2]]) {
      const pair = document.createElement('div');
      pair.className = 'prop-pair-item';
      const lbl = document.createElement('span');
      lbl.className = 'prop-pair-label';
      lbl.textContent = label;
      const input = document.createElement('input');
      input.className = 'prop-input';
      input.type = 'text';
      input.value = style[key] != null ? style[key] : '';
      input.addEventListener('change', () => {
        let v = input.value.trim();
        if (v === '') { style[key] = undefined; }
        else if (/^\d+(\.\d+)?$/.test(v)) { style[key] = parseFloat(v); }
        else { style[key] = v; }
        pushHistory(); render(); renderSelection();
      });
      pair.appendChild(lbl);
      pair.appendChild(input);
      row.appendChild(pair);
    }

    container.appendChild(row);
  }

  function toHex6(str) {
    if (!str) return null;
    if (/^#[0-9a-fA-F]{6}$/.test(str)) return str;
    if (/^#[0-9a-fA-F]{3}$/.test(str)) {
      return '#' + str[1]+str[1]+str[2]+str[2]+str[3]+str[3];
    }
    return null;
  }

  // ── Event Binding ──

  function bindEvents() {
    // Tool selection
    for (const btn of $$('.tool-btn')) {
      btn.addEventListener('click', () => {
        activeTool = btn.dataset.tool;
        $$('.tool-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        canvasEl.style.cursor = activeTool === 'select' ? '' : 'crosshair';
      });
    }

    // Keyboard shortcuts for tools
    document.addEventListener('keydown', (e) => {
      // Don't intercept when typing in inputs
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;

      const key = e.key.toLowerCase();

      // Tool shortcuts
      const toolMap = { v: 'select', f: 'frame', t: 'text', b: 'button', i: 'input', g: 'image', d: 'divider' };
      if (toolMap[key] && !e.metaKey && !e.ctrlKey) {
        activeTool = toolMap[key];
        $$('.tool-btn').forEach(b => b.classList.toggle('active', b.dataset.tool === activeTool));
        canvasEl.style.cursor = activeTool === 'select' ? '' : 'crosshair';
        return;
      }

      // Delete
      if ((key === 'delete' || key === 'backspace') && selectedId) {
        const found = doc.findById(selectedId);
        // Don't delete root
        if (found && found.parent) {
          doc.removeById(selectedId);
          selectedId = null;
          pushHistory(); render(); renderLayerTree(); renderProps();
        }
        return;
      }

      // Undo/Redo
      if ((e.metaKey || e.ctrlKey) && key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.metaKey || e.ctrlKey) && key === 'z' && e.shiftKey) { e.preventDefault(); redo(); }

      // Save
      if ((e.metaKey || e.ctrlKey) && key === 's') { e.preventDefault(); saveFile(); }

      // Escape
      if (key === 'escape') {
        if (activeTool !== 'select') {
          activeTool = 'select';
          $$('.tool-btn').forEach(b => b.classList.toggle('active', b.dataset.tool === 'select'));
          canvasEl.style.cursor = '';
        } else {
          select(null);
        }
      }

      // Duplicate
      if ((e.metaKey || e.ctrlKey) && key === 'd' && selectedId) {
        e.preventDefault();
        duplicateSelected();
      }
    });

    // Canvas mouse events
    let dragState = null;

    canvasBg.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;

      const canvasRect = canvasEl.getBoundingClientRect();
      const mx = (e.clientX - canvasRect.left) / zoom;
      const my = (e.clientY - canvasRect.top) / zoom;

      // Check if clicking a resize handle
      const handle = e.target.closest('.sel-handle');
      if (handle && selectedId) {
        e.preventDefault();
        const found = doc.findById(selectedId);
        if (!found) return;
        const selDom = canvasEl.querySelector(`[data-id="${selectedId}"]`);
        const r = getRelativeRect(selDom);
        dragState = {
          type: 'resize',
          handle: handle.dataset.handle,
          startX: e.clientX,
          startY: e.clientY,
          origStyle: { ...found.el.style },
          origRect: r,
        };
        return;
      }

      // Drawing tool
      if (activeTool !== 'select') {
        e.preventDefault();
        dragState = {
          type: 'draw',
          tool: activeTool,
          startX: mx,
          startY: my,
          currentX: mx,
          currentY: my,
        };
        return;
      }

      // Select tool: find element under cursor
      const target = e.target.closest('.ce[data-id]');
      if (target) {
        const id = target.dataset.id;
        select(id);

        // Start drag-move
        const selDom = canvasEl.querySelector(`[data-id="${id}"]`);
        const r = getRelativeRect(selDom);
        dragState = {
          type: 'move',
          startX: e.clientX,
          startY: e.clientY,
          origStyle: { ...doc.findById(id).el.style },
          origRect: r,
        };
      } else {
        select(null);
      }
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragState) {
        // Hover detection
        const target = e.target.closest('.ce[data-id]');
        const newHovered = target ? target.dataset.id : null;
        if (newHovered !== hoveredId) {
          hoveredId = newHovered;
          renderSelection();
        }
        return;
      }

      const dx = (e.clientX - dragState.startX) / zoom;
      const dy = (e.clientY - dragState.startY) / zoom;

      if (dragState.type === 'draw') {
        const canvasRect = canvasEl.getBoundingClientRect();
        dragState.currentX = (e.clientX - canvasRect.left) / zoom;
        dragState.currentY = (e.clientY - canvasRect.top) / zoom;
        renderDrawPreview(dragState);
      }

      if (dragState.type === 'move' && selectedId) {
        const found = doc.findById(selectedId);
        if (!found) return;
        const el = found.el;

        // If the element isn't absolutely positioned or has no top/left,
        // we only move via margin or we need to set position
        if (!el.style.position || el.style.position === '' || el.style.position === 'relative') {
          // For flex children, we don't really "move" with top/left
          // For now, let's set position:absolute if dragging
          // Only do this for non-root elements
          if (found.parent) {
            // Keep it in flow for now - skip position change
          }
        }

        // If has position absolute, move with top/left
        if (el.style.position === 'absolute') {
          el.style.left = Math.round((dragState.origStyle.left || 0) + dx);
          el.style.top = Math.round((dragState.origStyle.top || 0) + dy);
          render();
        }
      }

      if (dragState.type === 'resize' && selectedId) {
        const found = doc.findById(selectedId);
        if (!found) return;
        const el = found.el;
        const orig = dragState.origStyle;
        const origR = dragState.origRect;
        const h = dragState.handle;

        let w = typeof orig.width === 'number' ? orig.width : origR.width;
        let ht = typeof orig.height === 'number' ? orig.height : origR.height;

        if (h.includes('e')) w = Math.max(10, w + dx);
        if (h.includes('w')) w = Math.max(10, w - dx);
        if (h.includes('s')) ht = Math.max(10, ht + dy);
        if (h.includes('n')) ht = Math.max(10, ht - dy);

        el.style.width = Math.round(w);
        el.style.height = Math.round(ht);

        // Adjust position for nw/n/ne/w/sw handles
        if (el.style.position === 'absolute') {
          if (h.includes('w')) {
            el.style.left = Math.round((orig.left || 0) + dx);
          }
          if (h.includes('n')) {
            el.style.top = Math.round((orig.top || 0) + dy);
          }
        }

        render();
        renderProps();
      }
    });

    document.addEventListener('mouseup', (e) => {
      if (!dragState) return;

      if (dragState.type === 'draw') {
        finishDraw(dragState);
      }

      if (dragState.type === 'move' || dragState.type === 'resize') {
        pushHistory();
      }

      dragState = null;
      removeDrawPreview();
    });

    // Canvas size inputs
    canvasWInput.addEventListener('change', () => {
      doc.canvas.width = parseInt(canvasWInput.value) || 390;
      pushHistory(); updateCanvasSize(); render();
    });
    canvasHInput.addEventListener('change', () => {
      doc.canvas.height = parseInt(canvasHInput.value) || 844;
      pushHistory(); updateCanvasSize(); render();
    });

    // Device presets
    for (const btn of $$('.device-presets button')) {
      btn.addEventListener('click', () => {
        doc.canvas.width = parseInt(btn.dataset.w);
        doc.canvas.height = parseInt(btn.dataset.h);
        pushHistory(); updateCanvasSize(); render();
      });
    }

    // Zoom
    $('#btn-zoom-in').addEventListener('click', () => setZoom(zoom + 0.1));
    $('#btn-zoom-out').addEventListener('click', () => setZoom(zoom - 0.1));
    $('#btn-zoom-fit').addEventListener('click', () => {
      const area = $('#canvas-area');
      const fitW = (area.clientWidth - 80) / doc.canvas.width;
      const fitH = (area.clientHeight - 80) / doc.canvas.height;
      setZoom(Math.min(fitW, fitH, 1));
    });

    // Mouse wheel zoom
    $('#canvas-area').addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        setZoom(zoom - e.deltaY * 0.002);
      }
    }, { passive: false });

    // Undo/Redo buttons
    $('#btn-undo').addEventListener('click', undo);
    $('#btn-redo').addEventListener('click', redo);

    // File operations
    $('#btn-new').addEventListener('click', newFile);
    $('#btn-open').addEventListener('click', openFile);
    $('#btn-save').addEventListener('click', saveFile);

    // Context menu
    canvasBg.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY);
    });
  }

  // ── Drawing ──

  function renderDrawPreview(state) {
    removeDrawPreview();
    const x = Math.min(state.startX, state.currentX);
    const y = Math.min(state.startY, state.currentY);
    const w = Math.abs(state.currentX - state.startX);
    const h = Math.abs(state.currentY - state.startY);

    if (w < 2 && h < 2) return;

    const preview = document.createElement('div');
    preview.className = 'draw-preview';
    preview.style.left = (x * zoom) + 'px';
    preview.style.top = (y * zoom) + 'px';
    preview.style.width = (w * zoom) + 'px';
    preview.style.height = (h * zoom) + 'px';
    canvasBg.appendChild(preview);
  }

  function removeDrawPreview() {
    const existing = canvasBg.querySelector('.draw-preview');
    if (existing) existing.remove();
  }

  function finishDraw(state) {
    const x = Math.min(state.startX, state.currentX);
    const y = Math.min(state.startY, state.currentY);
    let w = Math.abs(state.currentX - state.startX);
    let h = Math.abs(state.currentY - state.startY);

    // If just clicked (no drag), use defaults
    if (w < 5 && h < 5) {
      w = DEFAULT_STYLES[state.tool]?.width || 100;
      h = DEFAULT_STYLES[state.tool]?.height || 40;
    }

    const el = ViewDocument.createElement(state.tool);
    el.style.width = Math.round(w);
    el.style.height = Math.round(h);

    // Add to selected parent or root
    let parent = null;
    if (selectedId) {
      const found = doc.findById(selectedId);
      if (found && found.el.children) {
        parent = found.el;
      }
    }

    if (!parent && doc.tree.length > 0 && doc.tree[0].children) {
      parent = doc.tree[0]; // Default to root frame
    }

    if (parent) {
      parent.children.push(el);
    } else {
      doc.tree.push(el);
    }

    pushHistory();
    select(el.id);
    render();
    renderLayerTree();

    // Switch back to select tool
    activeTool = 'select';
    $$('.tool-btn').forEach(b => b.classList.toggle('active', b.dataset.tool === 'select'));
    canvasEl.style.cursor = '';
  }

  // ── Duplicate ──

  function duplicateSelected() {
    if (!selectedId) return;
    const found = doc.findById(selectedId);
    if (!found) return;

    const clone = JSON.parse(JSON.stringify(found.el));
    assignNewIds(clone);
    clone.name = clone.name + ' Copy';

    found.siblings.splice(found.index + 1, 0, clone);
    pushHistory();
    select(clone.id);
    render();
    renderLayerTree();
  }

  function assignNewIds(node) {
    node.id = uid();
    if (node.children) node.children.forEach(c => assignNewIds(c));
  }

  // ── Context Menu ──

  function showContextMenu(x, y) {
    closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    const items = [];

    if (selectedId) {
      const found = doc.findById(selectedId);
      if (found) {
        if (found.el.children) {
          items.push({ label: 'Add Frame Inside', action: () => addChildToSelected('frame') });
          items.push({ label: 'Add Text Inside', action: () => addChildToSelected('text') });
          items.push({ label: 'Add Button Inside', action: () => addChildToSelected('button') });
          items.push({ label: 'Add Input Inside', action: () => addChildToSelected('input') });
          items.push({ sep: true });
        }
        items.push({ label: 'Duplicate', shortcut: '⌘D', action: duplicateSelected });
        if (found.parent) {
          items.push({ label: 'Delete', shortcut: '⌫', action: () => {
            doc.removeById(selectedId);
            selectedId = null;
            pushHistory(); render(); renderLayerTree(); renderProps();
          }, danger: true });
        }
      }
    } else {
      items.push({ label: 'Add Frame', action: () => addToRoot('frame') });
      items.push({ label: 'Add Text', action: () => addToRoot('text') });
    }

    for (const item of items) {
      if (item.sep) {
        const sep = document.createElement('div');
        sep.className = 'ctx-separator';
        menu.appendChild(sep);
        continue;
      }
      const div = document.createElement('div');
      div.className = 'ctx-item' + (item.danger ? ' danger' : '');
      div.textContent = item.label;
      if (item.shortcut) {
        const sc = document.createElement('span');
        sc.className = 'shortcut';
        sc.textContent = item.shortcut;
        div.appendChild(sc);
      }
      div.addEventListener('click', () => { closeContextMenu(); item.action(); });
      menu.appendChild(div);
    }

    document.body.appendChild(menu);

    // Close on click outside
    setTimeout(() => {
      document.addEventListener('click', closeContextMenu, { once: true });
    }, 0);
  }

  function closeContextMenu() {
    const existing = document.querySelector('.ctx-menu');
    if (existing) existing.remove();
  }

  function addChildToSelected(type) {
    if (!selectedId) return;
    const found = doc.findById(selectedId);
    if (!found || !found.el.children) return;
    const el = ViewDocument.createElement(type);
    found.el.children.push(el);
    pushHistory(); select(el.id); render(); renderLayerTree();
  }

  function addToRoot(type) {
    const el = ViewDocument.createElement(type);
    if (doc.tree.length > 0 && doc.tree[0].children) {
      doc.tree[0].children.push(el);
    } else {
      doc.tree.push(el);
    }
    pushHistory(); select(el.id); render(); renderLayerTree();
  }

  // ── File I/O (uses Tauri commands) ──

  const invoke = window.__TAURI__?.core?.invoke;
  const tauriDialog = window.__TAURI__?.dialog;

  async function newFile() {
    doc = ViewDocument.createDefault();
    selectedId = null;
    pushHistory();
    updateCanvasSize();
    render();
    renderLayerTree();
    renderProps();
    document.title = 'Vibe — New View';
  }

  async function saveFile() {
    const yaml = doc.toYAML();

    if (invoke) {
      try {
        let path = doc.filePath;
        if (!path) {
          // Use Tauri dialog to pick save location
          path = await tauriDialog.save({
            filters: [{ name: 'View Files', extensions: ['view'] }],
            defaultPath: doc.name.replace(/\s+/g, '-').toLowerCase() + '.view',
          });
        }
        if (path) {
          // Write via Tauri's absolute file write
          // Use write_file if path is relative to base, otherwise write directly
          await invoke('write_file', { path: path, content: yaml });
          doc.filePath = path;
          document.title = 'Vibe — ' + doc.name;
          console.log('Saved to', path);
        }
      } catch (err) {
        console.error('Save failed:', err);
        // Fallback: try writing via the absolute path helper
        try {
          const base = await invoke('get_base_dir');
          const fullPath = doc.filePath || (base + '/' + doc.name.replace(/\s+/g, '-').toLowerCase() + '.view');
          await invoke('write_file', { path: fullPath, content: yaml });
          doc.filePath = fullPath;
          document.title = 'Vibe — ' + doc.name;
        } catch (err2) {
          console.error('Save fallback also failed:', err2);
        }
      }
    } else {
      // No Tauri: browser download fallback
      const blob = new Blob([yaml], { type: 'text/yaml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = doc.name.replace(/\s+/g, '-').toLowerCase() + '.view';
      a.click();
      URL.revokeObjectURL(url);
    }
  }

  async function openFile() {
    if (invoke) {
      try {
        // Use Tauri dialog to pick a .view file
        const path = await tauriDialog.open({
          filters: [{ name: 'View Files', extensions: ['view'] }],
          multiple: false,
        });
        if (path) {
          const content = await invoke('read_file', { path: path });
          doc = ViewDocument.fromYAML(content);
          doc.filePath = path;
          selectedId = null;
          pushHistory();
          updateCanvasSize();
          render();
          renderLayerTree();
          renderProps();
          document.title = 'Vibe — ' + doc.name;
        }
      } catch (err) {
        console.error('Open failed:', err);
      }
    } else {
      // No Tauri: browser file picker fallback
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.view,.yaml,.yml';
      input.addEventListener('change', () => {
        const file = input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            doc = ViewDocument.fromYAML(reader.result);
            doc.filePath = null;
            selectedId = null;
            pushHistory();
            updateCanvasSize();
            render();
            renderLayerTree();
            renderProps();
            document.title = 'Vibe — ' + doc.name;
          } catch (err) {
            alert('Failed to parse .view file: ' + err.message);
          }
        };
        reader.readAsText(file);
      });
      input.click();
    }
  }

  // ── Start ──
  init();

})();
