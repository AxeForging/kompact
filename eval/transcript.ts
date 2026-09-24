/**
 * Reading Claude Code's own session JSONL into the `Message[]` the library
 * consumes. Kept apart from `extract-labels.ts`, which runs as a script on
 * import, so tests can read a transcript without triggering an extraction.
 */
import { readFileSync } from 'node:fs';
import type { Message, ToolResult, ToolUse } from '../src/index.js';

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: string; text?: string } => typeof b === 'object' && b !== null)
    .map((b) => (b.type === 'text' ? (b.text ?? '') : ''))
    .join('\n');
}

/**
 * Claude Code's session JSONL to the `Message[]` the library consumes.
 *
 * Sidechain rows belong to subagents, and mixing them into their parent would
 * interleave two conversations. But a subagent's own transcript file is made
 * *entirely* of sidechain rows, so dropping them unconditionally throws those
 * files away whole. Hence: skip sidechain rows only when the file has non-
 * sidechain rows to keep.
 */
export function readTranscript(path: string): Message[] {
  const lines = readFileSync(path, 'utf8').split('\n');
  const rows: any[] = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* a session being written to can end mid-line */
    }
  }
  const conversational = rows.filter((row) => row.type === 'assistant' || row.type === 'user');
  const skipSidechain = conversational.some((row) => !row.isSidechain);

  const messages: Message[] = [];
  for (const row of rows) {
    if (row.type !== 'assistant' && row.type !== 'user') continue;
    if (skipSidechain && row.isSidechain) continue;
    const content = row.message?.content;
    const blocks = Array.isArray(content) ? content : [];
    const toolUses: ToolUse[] = blocks
      .filter((b: any) => b?.type === 'tool_use')
      .map((b: any) => ({ tool_use_id: b.id, tool: b.name, input: b.input ?? {} }));
    const toolResults: ToolResult[] = blocks
      .filter((b: any) => b?.type === 'tool_result')
      .map((b: any) => ({
        tool_use_id: b.tool_use_id,
        text: typeof b.content === 'string' ? b.content : textOf(b.content),
        isError: b.is_error === true,
      }));
    const thinking = blocks
      .filter((b: any) => b?.type === 'thinking')
      .map((b: any) => b.thinking ?? '')
      .join('\n');
    const message: Message = {
      role: row.type,
      text: [textOf(content), thinking].filter(Boolean).join('\n'),
      toolUses,
    };
    if (toolResults.length > 0) message.toolResults = toolResults;
    messages.push(message);
  }
  return messages;
}

