// Kano Owl core — the platform-agnostic chat model: prompt building + the markdown
// render model for assistant replies. A faithful lift of kano_owl.js's pure logic,
// with all DOM and storage side effects left to the mobile UI layer. Runs in Node.

export { escHtml } from './escHtml';
export { owlPlainText, owlStripFormatting, owlInlineMarkdown, owlMarkdownToHtml } from './markdown';
export {
  OWL_MAX_VISIBLE_MESSAGES,
  OWL_MAX_CONTEXT_MESSAGES,
  normalizeOwlUserName,
  makeOwlMessage,
  appendOwlMessage,
  lastOwlReply,
  owlRecentChatForPrompt,
} from './chat';
export type { OwlRole, OwlMessage } from './chat';
export { OWL_SYSTEM_PROMPT, buildOwlPrompt } from './prompt';
export type { OwlPageContext, BuildOwlPromptOptions } from './prompt';
