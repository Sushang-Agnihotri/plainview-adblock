// PlainView generic element hiding helper.
//
// Rather than making every page parse ~1 MB of CSS with ~28,000 selectors,
// this script reports which class names and ids exist in the page (and only
// names it has not reported before). The background script answers by
// injecting just the hiding rules that can match those names.
//
// It reads class and id attribute names only — never text, form values or URLs —
// and sends them only to PlainView's own background script.
(() => {
  if (window.__plainviewCollector) return;
  window.__plainviewCollector = true;

  const MAX_TOKENS = 20000;
  const seen = new Set();
  let pending = [];
  let timer = 0;
  const start = performance.now();

  function flush() {
    timer = 0;
    if (!pending.length) return;
    const tokens = pending;
    pending = [];
    try {
      chrome.runtime.sendMessage({ type: 'genericLookup', tokens }).catch(() => {});
    } catch {
      observer.disconnect(); // extension was reloaded or removed
    }
  }

  function schedule() {
    if (timer) return;
    // React quickly while the page is loading, then batch more lazily.
    timer = setTimeout(flush, performance.now() - start < 3000 ? 10 : 150);
  }

  function addToken(t) {
    if (seen.has(t) || seen.size >= MAX_TOKENS) return;
    seen.add(t);
    pending.push(t);
  }

  function addElement(el) {
    const id = el.id;
    if (id && typeof id === 'string') addToken(`i:${id}`);
    const cl = el.classList;
    if (cl) for (let i = 0; i < cl.length; i++) addToken(`c:${cl[i]}`);
  }

  function scan(node) {
    if (node.nodeType !== 1) return;
    addElement(node);
    if (node.firstElementChild) {
      const els = node.querySelectorAll('[id],[class]');
      for (let i = 0; i < els.length; i++) addElement(els[i]);
    }
  }

  const observer = new MutationObserver((records) => {
    const before = pending.length;
    for (const r of records) {
      if (r.type === 'attributes') addElement(r.target);
      else for (const n of r.addedNodes) scan(n);
    }
    if (pending.length > before) schedule();
    if (seen.size >= MAX_TOKENS) observer.disconnect();
  });

  const root = document.documentElement;
  if (root) {
    scan(root);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'id'] });
    if (pending.length) schedule();
  }
})();
