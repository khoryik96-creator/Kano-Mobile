// HTML escaping — faithful lift of popup.js:escHtml. Used by the Owl markdown model
// before any model-supplied text is placed into markup, so a reply can never inject
// HTML. Pure string work; no DOM.

export function escHtml(str: unknown): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
