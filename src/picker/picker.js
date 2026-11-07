// PlainView element picker. Injected only when the user clicks "Hide an element"
// in the popup, and removed again when they finish or press Escape.
(() => {
  if (window.__plainviewPicker) return;
  window.__plainviewPicker = true;

  const host = document.createElement('plainview-picker');
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .hl { position: fixed; pointer-events: none; z-index: 2147483646; background: rgba(47,111,219,.18);
            outline: 2px solid #2f6fdb; border-radius: 2px; transition: all .05s; }
      .bar { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 2147483647;
             font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: #e8ecf2; background: #161a21;
             border: 1px solid #2d3540; border-radius: 10px; padding: 10px 12px; box-shadow: 0 8px 24px rgba(0,0,0,.35);
             display: flex; align-items: center; gap: 8px; max-width: min(720px, calc(100vw - 32px)); }
      .msg { flex: 1; min-width: 0; }
      code { display: block; font: 12px ui-monospace, Consolas, monospace; color: #9ec1ff; overflow: hidden;
             text-overflow: ellipsis; white-space: nowrap; }
      button { font: inherit; border-radius: 7px; border: 1px solid #2d3540; background: #1f252e; color: inherit;
               padding: 6px 10px; cursor: pointer; white-space: nowrap; }
      button.primary { background: #5b92f0; border-color: #5b92f0; color: #0d1117; }
      [hidden] { display: none !important; }
    </style>
    <div class="hl" hidden></div>
    <div class="bar">
      <div class="msg"><span class="text">Click an element to hide it · Esc to cancel</span><code hidden></code></div>
      <button class="wider" hidden title="Select the parent element">Wider</button>
      <button class="save primary" hidden>Hide permanently</button>
      <button class="cancel">Cancel</button>
    </div>`;
  const hl = root.querySelector('.hl');
  const text = root.querySelector('.text');
  const code = root.querySelector('code');
  const wider = root.querySelector('.wider');
  const save = root.querySelector('.save');
  const cancel = root.querySelector('.cancel');
  document.documentElement.appendChild(host);

  let picking = true;
  let target = null;
  let selector = '';
  const previewStyle = document.createElement('style');

  const cssEscape = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
  const looksGenerated = (s) => /\d{3,}|[0-9a-f]{8,}|^[a-z]{1,2}-[a-z0-9]{5,}$/i.test(s) || s.length > 40;

  function part(el) {
    const tag = el.tagName.toLowerCase();
    if (el.id && !looksGenerated(el.id)) return `#${cssEscape(el.id)}`;
    const classes = [...el.classList].filter((c) => !looksGenerated(c)).slice(0, 3);
    if (classes.length) return tag + classes.map((c) => `.${cssEscape(c)}`).join('');
    const parent = el.parentElement;
    if (!parent) return tag;
    const same = [...parent.children].filter((c) => c.tagName === el.tagName);
    return same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(el) + 1})` : tag;
  }

  function buildSelector(el) {
    const parts = [];
    let cur = el;
    while (cur && cur !== document.documentElement && parts.length < 5) {
      parts.unshift(part(cur));
      const sel = parts.join(' > ');
      try {
        if (document.querySelectorAll(sel).length === 1 || parts[0].startsWith('#')) return sel;
      } catch { /* keep walking */ }
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  function highlight(el) {
    if (!el) { hl.hidden = true; return; }
    const r = el.getBoundingClientRect();
    Object.assign(hl.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    hl.hidden = false;
  }

  function choose(el) {
    target = el;
    selector = buildSelector(el);
    picking = false;
    hl.hidden = true;
    previewStyle.textContent = `${selector}{display:none!important}`;
    document.documentElement.appendChild(previewStyle);
    text.textContent = 'Hide elements matching:';
    code.textContent = selector;
    code.hidden = false;
    save.hidden = false;
    wider.hidden = !target.parentElement || target.parentElement === document.body;
  }

  function cleanup() {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    host.remove();
    window.__plainviewPicker = false;
  }

  function onMove(e) {
    if (!picking) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && el !== host && el !== document.documentElement && el !== document.body) highlight(el);
  }

  function onClick(e) {
    if (e.composedPath().includes(host)) return;
    e.preventDefault();
    e.stopPropagation();
    if (!picking) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && el !== document.documentElement && el !== document.body) choose(el);
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      previewStyle.remove();
      cleanup();
    }
  }

  wider.addEventListener('click', () => {
    if (target?.parentElement && target.parentElement !== document.body) choose(target.parentElement);
  });
  let saved = false;
  cancel.addEventListener('click', () => { if (!saved) previewStyle.remove(); cleanup(); });
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'pickerSave', host: location.hostname, selector });
      if (!res?.ok) throw new Error(res?.error || 'Failed');
      saved = true;
      text.textContent = 'Saved. You can undo this under Settings → Custom filters.';
      code.hidden = true; save.hidden = true; wider.hidden = true; cancel.textContent = 'Close';
      setTimeout(() => { if (host.isConnected) cleanup(); }, 2500);
    } catch (err) {
      text.textContent = `Could not save: ${err.message}`;
      save.disabled = false;
    }
  });

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
})();
