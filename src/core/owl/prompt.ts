import type { OwlMessage } from './chat';
import { normalizeOwlUserName, owlRecentChatForPrompt } from './chat';

// Owl prompt building — faithful lift of kano_owl.js: the system prompt used for the
// chat call and buildKanoOwlPrompt (the user-message envelope: name instruction,
// browse/no-browse guidance, recent chat, optional current-page block, question).
// Pure string work; the caller supplies the message history and any page context.

/** The system prompt sent with an Owl chat call (popup.js askKanoOwlChat). */
export const OWL_SYSTEM_PROMPT = 'You are The Owl, a concise practical recruiter assistant inside Kano for JobAdder.';

/** Extracted page text the user is currently viewing (optional context). */
export interface OwlPageContext {
  url?: string;
  title?: string;
  text?: string;
}

export interface BuildOwlPromptOptions {
  /** Chat history so far; `local` messages are dropped from the prompt. */
  messages?: OwlMessage[];
  /** The user's preferred display name. */
  userName?: string;
  /** Extracted current-page text, when the "read page" toggle is on. */
  pageContext?: OwlPageContext | null;
}

/** Build the full Owl user prompt. Faithful lift of buildKanoOwlPrompt. */
export function buildOwlPrompt(question: string, options: BuildOwlPromptOptions = {}): string {
  const { messages = [], userName, pageContext = null } = options;
  const recent = owlRecentChatForPrompt(messages, userName);
  const displayName = normalizeOwlUserName(userName);
  const nameInstruction = displayName
    ? `The user's preferred name is ${displayName}. Address them naturally as ${displayName} in replies, and avoid opening with generic phrases like hey/you. Do not overuse the name in every sentence.`
    : 'No preferred user name is saved.';
  const pageText = pageContext && String(pageContext.text || '').trim();
  const browseLine = pageText
    ? 'The extracted text of the page the user is currently viewing is provided below under "Current page". Treat it as the live content of that page and answer from it when the user refers to "this page/profile/candidate/job/site". It may be truncated or noisy; do not invent details it does not contain.'
    : 'If the user asks for current public facts, do not claim live browsing; explain that this chat does not browse unless the surrounding app provides data. Do not invent JobAdder screen data that was not provided.';
  const pageBlock = pageText
    ? `\n\nCurrent page:\nURL: ${pageContext?.url || ''}\nTitle: ${pageContext?.title || ''}\n-----\n${pageText}\n-----`
    : '';
  return `You are The Owl, an AI chat assistant inside Kano for JobAdder. The user is a recruiter using Kano for candidate review, CV scanning, salary notes, sourcing, and JobAdder field updates.
${nameInstruction}

Answer practically and concisely. Format for a small floating panel: use compact headings and bullets, avoid excessive blank lines, and do not start with 'Short answer:'. For comparisons, prefer clean bullet sections; only use a markdown table if it is a valid compact table with no blank lines between rows. ${browseLine}

Recent chat:
${recent || 'None'}${pageBlock}

User question:
${question}`;
}
