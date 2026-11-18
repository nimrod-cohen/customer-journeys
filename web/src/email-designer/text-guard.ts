// Guard against silently losing a text block's content. A text block saves whatever
// it holds when it loses focus — including nothing — so a select-all + delete (or a
// stray cut) wiped a whole email body and the next send went out without it. The
// editor now notices when a block that had words is saved empty and offers to put
// them back (see TextEl in elements.tsx).

/** Does this HTML show anything — words (merge tags count) or an image? */
function hasContent(html: string): boolean {
  if (/<img\b/i.test(html)) return true;
  const text = html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;| /gi, ' ')
    .trim();
  return text.length > 0;
}

/** True when a block that had content is being saved with none. */
export function textWasCleared(before: string, after: string): boolean {
  return hasContent(before) && !hasContent(after);
}
