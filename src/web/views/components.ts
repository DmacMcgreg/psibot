import { escapeHtml } from "../../shared/html.ts";

export function badge(
  text: string,
  color: "green" | "red" | "yellow" | "blue" | "zinc"
): string {
  const colors = {
    green: "bg-green-900/50 text-green-400 border-green-800",
    red: "bg-red-900/50 text-red-400 border-red-800",
    yellow: "bg-yellow-900/50 text-yellow-400 border-yellow-800",
    blue: "bg-blue-900/50 text-blue-400 border-blue-800",
    zinc: "bg-zinc-800 text-zinc-400 border-zinc-700",
  };
  return `<span class="px-2 py-0.5 text-xs rounded-full border ${colors[color]}">${escapeHtml(text)}</span>`;
}

export function statusBadge(status: string): string {
  switch (status) {
    case "enabled":
      return badge("enabled", "green");
    case "disabled":
      return badge("disabled", "zinc");
    case "completed":
      return badge("completed", "blue");
    case "failed":
      return badge("failed", "red");
    case "running":
      return badge("running", "yellow");
    case "success":
      return badge("success", "green");
    case "error":
      return badge("error", "red");
    case "budget_exceeded":
      return badge("budget exceeded", "red");
    default:
      return badge(status, "zinc");
  }
}

export function emptyState(message: string): string {
  return `<div class="flex items-center justify-center h-full text-zinc-500 text-sm">${escapeHtml(message)}</div>`;
}

export function chatBubble(
  role: "user" | "assistant",
  content: string,
  meta?: string,
  messageId?: number
): string {
  const isUser = role === "user";
  const idAttr = messageId ? ` data-msg-id="${messageId}"` : "";
  const contentDiv = isUser
    ? `<div class="prose prose-invert prose-sm">${content}</div>`
    : `<div class="prose prose-invert prose-sm" data-md>${content}</div>`;
  return `<div class="flex ${isUser ? "justify-end" : "justify-start"} mb-3 chat-msg"${idAttr}>
    <div class="max-w-[85%] ${
      isUser
        ? "bg-indigo-600 text-white rounded-2xl rounded-br-md"
        : "bg-zinc-800 text-zinc-100 rounded-2xl rounded-bl-md"
    } px-4 py-2.5">
      ${contentDiv}
      ${meta ? `<div class="text-xs mt-1 ${isUser ? "text-indigo-200" : "text-zinc-500"}">${meta}</div>` : ""}
    </div>
  </div>`;
}

export function typingIndicator(): string {
  return `<div id="typing" class="flex justify-start mb-3">
    <div class="bg-zinc-800 rounded-2xl rounded-bl-md px-4 py-3">
      <div class="typing-indicator flex gap-1">
        <span class="w-2 h-2 bg-zinc-400 rounded-full"></span>
        <span class="w-2 h-2 bg-zinc-400 rounded-full"></span>
        <span class="w-2 h-2 bg-zinc-400 rounded-full"></span>
      </div>
    </div>
  </div>`;
}

export function button(
  text: string,
  attrs: string = "",
  variant: "primary" | "secondary" | "danger" = "primary"
): string {
  const variants = {
    primary: "bg-indigo-600 hover:bg-indigo-700 text-white",
    secondary: "bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700",
    danger: "bg-red-600 hover:bg-red-700 text-white",
  };
  return `<button class="px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${variants[variant]}" ${attrs}>${escapeHtml(text)}</button>`;
}
