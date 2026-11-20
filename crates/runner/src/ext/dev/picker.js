// Bouvio element picker. Served by the preview proxy and injected into HTML
// pages, so the panel can point at an element and hand it to an agent.
(() => {
  if (window.__bouvioPicker || window.parent === window) return;
  window.__bouvioPicker = true;
  const post = (msg) => window.parent.postMessage(msg, "*");
  let on = false;
  let box = null;
  let tag = null;
  let current = null;

  // ---- where we are, so the panel can show the path ----
  const where = () => post({ type: "bouvio:location", href: location.href, path: location.pathname + location.search + location.hash, title: document.title });
  for (const k of ["pushState", "replaceState"]) {
    const orig = history[k];
    history[k] = function (...a) {
      const r = orig.apply(this, a);
      setTimeout(where, 0);
      return r;
    };
  }
  addEventListener("popstate", where);
  addEventListener("hashchange", where);
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", where);
  else where();

  // ---- overlay ----
  function overlay() {
    if (box) return;
    box = document.createElement("div");
    tag = document.createElement("div");
    const base = "position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;";
    box.style.cssText = base + "outline:2px solid #3E63DD;outline-offset:-1px;background:rgba(62,99,221,.08);border-radius:2px;transition:all .08s ease-out;";
    tag.style.cssText = base + "padding:2px 6px;border-radius:4px;background:#3E63DD;color:#fff;font:500 11px/16px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;";
    document.documentElement.append(box, tag);
  }
  function hide() {
    box?.remove();
    tag?.remove();
    box = tag = null;
    current = null;
  }
  function show(el) {
    overlay();
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
    const name = el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "");
    tag.textContent = name + "  " + Math.round(r.width) + "×" + Math.round(r.height);
    const above = r.top > 22;
    tag.style.left = Math.max(2, Math.min(r.left, innerWidth - tag.offsetWidth - 2)) + "px";
    tag.style.top = (above ? r.top - 20 : Math.min(r.bottom + 2, innerHeight - 18)) + "px";
  }

  // ---- a stable, unique CSS path ----
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, "\\$&"));
  const unique = (sel) => {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch {
      return false;
    }
  };
  // Ids and classes that look generated (css-1x2y3z, sc-abc, :r1:) change between builds.
  const generated = (s) => /\d{3,}|^[a-z]{1,3}-[a-z0-9]{5,}$|^:r|^_|__[a-z0-9]{5,}$/i.test(s);
  function selector(el) {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      const t = n.tagName.toLowerCase();
      if (n.id && !generated(n.id)) {
        const withId = ["#" + esc(n.id), ...parts].join(" > ");
        if (unique(withId)) return withId;
      }
      for (const a of ["data-testid", "data-test", "data-cy", "name", "aria-label"]) {
        const v = n.getAttribute(a);
        if (v && v.length < 60) {
          const s = `${t}[${a}="${v.replace(/"/g, '\\"')}"]`;
          if (unique([s, ...parts].join(" > "))) return [s, ...parts].join(" > ");
        }
      }
      let part = t;
      const cls = typeof n.className === "string" ? n.className.trim().split(/\s+/).filter((c) => c && !generated(c)).slice(0, 2) : [];
      if (cls.length) part += "." + cls.map(esc).join(".");
      const p = n.parentElement;
      if (p) {
        const same = [...p.children].filter((c) => c.tagName === n.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(n) + 1})`;
      }
      parts.unshift(part);
      if (unique(parts.join(" > "))) return parts.join(" > ");
    }
    return parts.join(" > ");
  }

  // ---- where it lives in the source ----
  function fiberOf(el) {
    for (const k in el) if (k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")) return el[k];
    return null;
  }
  function fromStack(stack) {
    // React 19 keeps an owner stack instead of _debugSource.
    for (const line of String(stack || "").split("\n").slice(1)) {
      if (/node_modules|react-dom|react\.|jsx-dev-runtime|chunk-/.test(line)) continue;
      const m = line.match(/(?:\(|@|at\s)(?:https?:\/\/[^/]+)?(\/[^?:)]+)(?:\?[^:)]*)?:(\d+):\d+\)?\s*$/);
      if (m) return { fileName: decodeURIComponent(m[1]), lineNumber: +m[2], approximate: true };
    }
    return null;
  }
  function source(el) {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      for (let f = fiberOf(n), i = 0; f && i < 40; i++) {
        const s = f._debugSource || f._debugOwner?._debugSource;
        if (s && s.fileName) return { file: s.fileName, line: s.lineNumber ?? null, column: s.columnNumber ?? null };
        f = f._debugOwner || f.return;
      }
      const attr = n.getAttribute("data-source") || n.getAttribute("data-inspector-relative-path") || n.getAttribute("data-inspector-path");
      if (attr) {
        const line = n.getAttribute("data-inspector-line");
        const m = attr.match(/^(.*?)(?::(\d+))?(?::\d+)?$/);
        return { file: m ? m[1] : attr, line: line ? +line : m && m[2] ? +m[2] : null, column: null };
      }
    }
    for (let f = fiberOf(el), i = 0; f && i < 40; i++, f = f._debugOwner || f.return) {
      const s = f._debugStack && fromStack(f._debugStack.stack);
      if (s) return { file: s.fileName, line: s.lineNumber, column: null, approximate: true };
    }
    return null;
  }

  // ---- picking ----
  const target = (e) => {
    const el = e.target;
    return el && el.nodeType === 1 && el !== box && el !== tag ? el : null;
  };
  function move(e) {
    const el = target(e);
    if (!el || el === current) return;
    current = el;
    show(el);
  }
  function block(e) {
    if (!on) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }
  function click(e) {
    if (!on) return;
    block(e);
    const el = target(e) || current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const html = el.outerHTML;
    post({
      type: "bouvio:picked",
      selector: selector(el),
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300),
      rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      outerHTML: html.length > 2048 ? html.slice(0, 2048) + "…" : html,
      source: source(el),
      path: location.pathname + location.search + location.hash,
    });
    setPicking(false);
  }
  function key(e) {
    if (on && e.key === "Escape") {
      block(e);
      setPicking(false);
      post({ type: "bouvio:pick-cancel" });
    }
  }
  function setPicking(v) {
    if (on === v) return;
    on = v;
    const f = on ? addEventListener : removeEventListener;
    f("mousemove", move, true);
    f("click", click, true);
    for (const t of ["mousedown", "mouseup", "pointerdown", "pointerup", "submit"]) f(t, block, true);
    f("keydown", key, true);
    document.documentElement.style.cursor = on ? "crosshair" : "";
    if (!on) hide();
  }

  addEventListener("message", (e) => {
    const d = e.data;
    if (!d || typeof d !== "object" || e.source !== window.parent) return;
    if (d.type === "bouvio:pick") setPicking(!!d.on);
    else if (d.type === "bouvio:nav") {
      if (d.action === "back") history.back();
      else if (d.action === "forward") history.forward();
      else if (d.action === "reload") location.reload();
    } else if (d.type === "bouvio:where") where();
  });
  post({ type: "bouvio:ready" });
})();
