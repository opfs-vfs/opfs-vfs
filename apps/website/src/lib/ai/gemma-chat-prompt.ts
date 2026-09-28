// Adapted from frachter-app/opfs-vfs bash-console at 4d881496, at the owner’s request.
import { sanitizeGemmaChatOutput } from './gemma-chat-output.ts';

export interface GemmaChatPromptMessage {
  role: 'assistant' | 'user';
  text: string;
}

interface BuildGemmaChatPromptOptions {
  history: GemmaChatPromptMessage[];
  latestUserPrompt: string;
  maxHistoryTurns?: number;
  systemInstructions?: string;
}

const GEMMA_STARTER_SYSTEM_INSTRUCTIONS = [
  'You are Just Bash AI, a local assistant running inside a browser workspace.',
  'Answer clearly and concisely.',
  'Treat short follow-ups like "another one", "continue", or "what about that" as references to the earlier conversation.',
  'Do not claim to have inspected files, code, or the system unless that content is already in the conversation.',
  'Do not repeat words, lines, or whole sentences.',
  'If the request is unclear, ask one short clarifying question.',
  'Use Markdown when structure helps.',
].join('\n');

const DEFAULT_MAX_HISTORY_TURNS = 8;
// Gemma 4 has its own turn format; MediaPipe consumes this raw prompt.
// https://ai.google.dev/gemma/docs/core/prompt-formatting-gemma4
const GEMMA_USER_TURN_PREFIX = '<|turn>user\n';
const GEMMA_MODEL_TURN_PREFIX = '<|turn>model\n';
const GEMMA_TURN_SUFFIX = '<turn|>\n';

function normalizeTurnText(text: string) {
  return (
    text
      .trim()
      .replace(/\r\n?/g, '\n')
      // User text and file observations cannot inject model control tokens.
      .replace(/<\|[^<>]*>|<[^<>]*\|>|<\/?(?:start_of_turn|end_of_turn)>|<eos>/g, (token) => token.replace('<', '＜'))
  );
}

function selectRecentHistory(history: GemmaChatPromptMessage[], maxHistoryTurns: number) {
  const selectedHistory = history.slice(-maxHistoryTurns);

  while (selectedHistory[0]?.role === 'assistant') {
    selectedHistory.shift();
  }

  while (selectedHistory[selectedHistory.length - 1]?.role === 'user') {
    selectedHistory.pop();
  }

  return selectedHistory;
}

export function buildGemmaChatPrompt({
  history,
  latestUserPrompt,
  maxHistoryTurns = DEFAULT_MAX_HISTORY_TURNS,
  systemInstructions = GEMMA_STARTER_SYSTEM_INSTRUCTIONS,
}: BuildGemmaChatPromptOptions) {
  const normalizedLatestPrompt = normalizeTurnText(latestUserPrompt);
  const selectedHistory = selectRecentHistory(
    history
      .map((message) => ({
        ...message,
        text:
          message.role === 'assistant'
            ? normalizeTurnText(sanitizeGemmaChatOutput(message.text))
            : normalizeTurnText(message.text),
      }))
      .filter((message) => message.text.length > 0),
    maxHistoryTurns,
  );
  const normalizedSystemInstructions = normalizeTurnText(systemInstructions);
  const promptTurns: GemmaChatPromptMessage[] = [
    ...selectedHistory,
    {
      role: 'user',
      text: normalizedLatestPrompt,
    },
  ];

  const prompt = promptTurns
    .map(
      (turn) =>
        `${turn.role === 'assistant' ? GEMMA_MODEL_TURN_PREFIX : GEMMA_USER_TURN_PREFIX}${turn.text}${GEMMA_TURN_SUFFIX}`,
    )
    .join('');

  return `<|turn>system\n${normalizedSystemInstructions}${GEMMA_TURN_SUFFIX}${prompt}${GEMMA_MODEL_TURN_PREFIX}`;
}
