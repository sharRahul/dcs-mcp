/** Shared response formatting helpers for tools. */
import { z } from "zod";
import { CHARACTER_LIMIT } from "../constants.js";

export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

export const responseFormatField = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable");

export type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** Build a tool result, truncating oversized text and attaching structured data. */
export function buildResult(
  text: string,
  structured?: Record<string, unknown>
): ToolResult {
  let out = text;
  if (out.length > CHARACTER_LIMIT) {
    out = out.slice(0, CHARACTER_LIMIT) + `\n\n... [truncated at ${CHARACTER_LIMIT} characters]`;
  }
  return {
    content: [{ type: "text", text: out }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

/** Build an error result with an actionable message. */
export function errorResult(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/** Render text or JSON based on requested format. */
export function render(
  format: ResponseFormat,
  markdown: () => string,
  structured: Record<string, unknown>
): ToolResult {
  const text = format === ResponseFormat.JSON ? JSON.stringify(structured, null, 2) : markdown();
  return buildResult(text, structured);
}
