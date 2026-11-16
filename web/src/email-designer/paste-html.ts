// Clean HTML pasted into a text block. Google Docs, Word and web pages paste
// their own layout along with the words — wrapper divs with margins and padding,
// line-height:2, fixed fonts, empty paragraphs — which shows up in the email as
// unexplained spacing the editor offers no control to remove. Keep the WORDS and
// the basic formatting the toolbar itself produces (bold/italic/underline, links,
// lists, colour, paragraphs and line breaks); drop everything else.

/** Tags kept as-is (attributes still filtered). Anything else is unwrapped. */
const KEEP = new Set(['p', 'br', 'b', 'strong', 'i', 'em', 'u', 'a', 'ul', 'ol', 'li', 'span']);
/** Block tags that become a paragraph. */
const TO_P = new Set(['div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'section', 'article', 'header', 'footer', 'pre']);
/** Removed together with their content. */
const DROP = new Set(['script', 'style', 'meta', 'link', 'title', 'head', 'iframe', 'object', 'embed', 'svg', 'img', 'video', 'audio', 'template']);
/** The only inline styles kept — formatting, never layout. */
const KEEP_STYLE = ['color', 'background-color', 'font-weight', 'font-style', 'text-decoration', 'text-decoration-line'];
/** Children that make a wrapper a wrapper rather than a paragraph. */
const BLOCK = new Set(['p', 'ul', 'ol', 'li']);
const SAFE_HREF = /^(https?:|mailto:|tel:|\{\{)/i;

/**
 * Return a cleaned version of pasted HTML. `doc` is the Document to parse with
 * (the page's own `document` in the editor).
 */
export function cleanPastedHtml(html: string, doc: Document): string {
  const root = doc.createElement('div');
  // <template> parses without running scripts or loading images.
  const tpl = doc.createElement('template');
  tpl.innerHTML = html.replace(/<!--[\s\S]*?-->/g, '');
  root.appendChild(tpl.content);
  cleanChildren(root, doc);
  trimEmptyEdges(root);
  return root.innerHTML.trim();
}

function cleanChildren(parent: Element, doc: Document): void {
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === 3) continue; // text
    if (node.nodeType !== 1) {
      node.remove();
      continue;
    }
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (DROP.has(tag)) {
      el.remove();
      continue;
    }
    cleanChildren(el, doc);
    // Google Docs wraps the whole paste in <b style="font-weight:normal">.
    const notBold = (tag === 'b' || tag === 'strong') && /font-weight\s*:\s*(normal|[1-4]00)\b/i.test(el.getAttribute('style') ?? '');
    if (TO_P.has(tag)) {
      // A wrapper around paragraphs/lists is just a wrapper; only a block of
      // bare inline content becomes a paragraph of its own.
      if (Array.from(el.children).some((c) => BLOCK.has(c.tagName.toLowerCase()))) unwrap(el);
      else replaceTag(el, 'p', doc);
    } else if (!KEEP.has(tag) || notBold) {
      unwrap(el);
    } else {
      filterAttributes(el, tag);
      // A span left with nothing to say is noise.
      if (tag === 'span' && el.attributes.length === 0) unwrap(el);
    }
  }
}

function filterAttributes(el: Element, tag: string): void {
  const href = tag === 'a' ? (el.getAttribute('href') ?? '').trim() : '';
  const style = keptStyle(el.getAttribute('style') ?? '');
  const dir = el.getAttribute('dir');
  for (const a of Array.from(el.attributes)) el.removeAttribute(a.name);
  if (tag === 'a' && SAFE_HREF.test(href)) el.setAttribute('href', href);
  if (style) el.setAttribute('style', style);
  if (dir === 'rtl' || dir === 'ltr') el.setAttribute('dir', dir);
}

function keptStyle(style: string): string {
  const out: string[] = [];
  for (const decl of style.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const value = decl.slice(i + 1).trim();
    if (!value || !KEEP_STYLE.includes(prop)) continue;
    // Docs states the defaults on every span; keep only what changes something.
    if (prop === 'font-weight' && !/^(bold|bolder|[6-9]00)$/i.test(value)) continue;
    if (prop === 'font-style' && !/^italic$/i.test(value)) continue;
    if (prop.startsWith('text-decoration') && !/underline|line-through/i.test(value)) continue;
    if (prop === 'background-color' && /^(transparent|rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\))$/i.test(value)) continue;
    if (prop === 'color' && /^(#000000|#000|rgb\(\s*0\s*,\s*0\s*,\s*0\s*\)|black|inherit)$/i.test(value)) continue;
    out.push(`${prop}:${value}`);
  }
  return out.join(';');
}

function unwrap(el: Element): void {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

function replaceTag(el: Element, tag: string, doc: Document): void {
  const next = doc.createElement(tag);
  const dir = el.getAttribute('dir');
  if (dir === 'rtl' || dir === 'ltr') next.setAttribute('dir', dir);
  while (el.firstChild) next.appendChild(el.firstChild);
  el.replaceWith(next);
}

/** An element with no text and no line break inside it. */
function isBlank(n: ChildNode): boolean {
  if (n.nodeType === 3) return !(n.textContent ?? '').trim();
  if (n.nodeType !== 1) return true;
  const el = n as Element;
  if (el.tagName.toLowerCase() === 'br') return true;
  return !(el.textContent ?? '').replace(/ /g, ' ').trim();
}

/** Leading/trailing empty paragraphs and <br>s are pure spacing. */
function trimEmptyEdges(root: Element): void {
  while (root.firstChild && isBlank(root.firstChild)) root.removeChild(root.firstChild);
  while (root.lastChild && isBlank(root.lastChild)) root.removeChild(root.lastChild);
  // …and the same inside the first and last paragraph.
  const first = root.firstElementChild;
  if (first && first.tagName.toLowerCase() === 'p') {
    while (first.firstChild && isEdgeBreak(first.firstChild)) first.removeChild(first.firstChild);
  }
  const last = root.lastElementChild;
  if (last && last.tagName.toLowerCase() === 'p') {
    while (last.lastChild && isEdgeBreak(last.lastChild)) last.removeChild(last.lastChild);
  }
}

function isEdgeBreak(n: ChildNode): boolean {
  if (n.nodeType === 3) return !(n.textContent ?? '').replace(/\u00a0/g, ' ').trim();
  return n.nodeType === 1 && (n as Element).tagName.toLowerCase() === 'br';
}
