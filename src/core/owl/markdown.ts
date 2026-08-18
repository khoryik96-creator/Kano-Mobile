import { escHtml } from './escHtml';

// The Owl markdown model — faithful lift of kano_owl.js:
//   kanoOwlPlainText · kanoOwlStripFormatting · kanoOwlInlineMarkdown · kanoOwlMarkdownToHtml
//
// Renders an assistant reply (a small, constrained markdown dialect: bold/italic/code,
// bullet + ordered lists, up-to-h4 headings, and compact tables) to safe HTML. Every
// text span is escaped by escHtml first, so nothing the model writes can inject markup.
// Pure string work — no DOM — so it runs in Node and drives whatever the RN UI renders
// with (a WebView, or a markdown-to-RN converter).
//
// The `⟦ja:<id>|<label>⟧` marker is a DELIBERATELY restricted candidate-link syntax,
// not general markdown links: the id is digits-only and the href is not taken from the
// message, so a model can never emit a javascript:/data: URL. JobAdder lookup is not in
// mobile v1 (so the marker should not appear), but the renderer handles it faithfully
// for parity with the extension.

/** Collapse candidate-link markers to their bare label (for plain-text copy). */
export function owlPlainText(text: unknown): string {
  return String(text || '').replace(/⟦ja:\d{1,20}\|([^⟧]*)⟧/g, '$1');
}

/** Plain-text form with inline emphasis markers removed too. */
export function owlStripFormatting(text: unknown): string {
  return owlPlainText(text)
    .replace(/\*\*(.+?)\*\*/g, '$1') // **bold** -> bold
    .replace(/(^|\s)\*([^*\n]{1,80})\*(?=\s|$|[.,;:!?])/g, '$1$2') // *italic* -> italic
    .replace(/`([^`]+)`/g, '$1'); // `code` -> code
}

/** Inline markdown (bold/italic/code + candidate links) to HTML, text pre-escaped. */
export function owlInlineMarkdown(text: unknown): string {
  return escHtml(text || '')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)\*([^*\n]{2,80})\*(?=\s|$|[.,;:!?])/g, '$1<em>$2</em>')
    .replace(
      /⟦ja:(\d{1,20})\|([^⟧]*)⟧/g,
      (_m, id, label) =>
        '<a href="#" class="kano-ja-link" data-ja-candidate="' + id + '" title="Open this candidate in JobAdder">' + label + '</a>',
    );
}

/** Full block-level markdown to HTML. */
export function owlMarkdownToHtml(text: unknown): string {
  const rawLines = String(text || '')
    .replace(/```(?:markdown|md|text)?/gi, '')
    .replace(/```/g, '')
    .split(/\r?\n/);

  // Drop blank lines wedged between table rows (models emit them and break the table).
  const lines: string[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const cur = String(rawLines[i] || '').trim();
    if (!cur) {
      const prev = String(lines[lines.length - 1] || '').trim();
      const next = String(rawLines.slice(i + 1).find((x) => String(x || '').trim()) || '').trim();
      if (prev.includes('|') && next.includes('|')) continue;
    }
    lines.push(rawLines[i] ?? '');
  }

  let html = '';
  let list: string[] = [];
  let ordered = false;
  const flush = () => {
    if (!list.length) return;
    html +=
      (ordered ? '<ol>' : '<ul>') +
      list.map((x) => '<li>' + owlInlineMarkdown(x) + '</li>').join('') +
      (ordered ? '</ol>' : '</ul>');
    list = [];
    ordered = false;
  };

  const isTableRow = (line: unknown) => /^\s*\|.*\|\s*$/.test(String(line || ''));
  const isTableSep = (line: unknown) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(String(line || ''));
  const splitTableRow = (line: unknown) =>
    String(line || '')
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
  const renderTable = (rows: string[]) => {
    if (rows.length < 2) return '';
    const header = splitTableRow(rows[0]);
    const bodyRows = rows
      .slice(isTableSep(rows[1]) ? 2 : 1)
      .map(splitTableRow)
      .filter((r) => r.some(Boolean));
    if (!header.length || !bodyRows.length) return '';
    const head = '<thead><tr>' + header.map((c) => '<th>' + owlInlineMarkdown(c) + '</th>').join('') + '</tr></thead>';
    const body =
      '<tbody>' +
      bodyRows
        .map((row) => '<tr>' + header.map((_h, idx) => '<td>' + owlInlineMarkdown(row[idx] || '') + '</td>').join('') + '</tr>')
        .join('') +
      '</tbody>';
    return '<table>' + head + body + '</table>';
  };

  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] || '').trim();
    if (!line) {
      flush();
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && (isTableSep(lines[i + 1]) || isTableRow(lines[i + 1]))) {
      flush();
      const rows: string[] = [];
      while (i < lines.length && (isTableRow(lines[i]) || isTableSep(lines[i]))) {
        rows.push(String(lines[i] || '').trim());
        i++;
      }
      i--;
      const tableHtml = renderTable(rows);
      if (tableHtml) {
        html += tableHtml;
        continue;
      }
    }
    const bullet = line.match(/^[-*•]\s+(.+)$/);
    if (bullet) {
      if (ordered) flush();
      ordered = false;
      list.push((bullet[1] ?? '').trim());
      continue;
    }
    const numbered = line.match(/^\d+[.)]\s+(.+)$/);
    if (numbered) {
      if (list.length && !ordered) flush();
      ordered = true;
      list.push((numbered[1] ?? '').trim());
      continue;
    }
    flush();
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) html += '<h4>' + owlInlineMarkdown((heading[2] ?? '').replace(/#+$/, '').trim()) + '</h4>';
    else html += '<p>' + owlInlineMarkdown(line) + '</p>';
  }
  flush();
  return html || '<p></p>';
}
