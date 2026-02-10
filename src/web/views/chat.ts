import { layout } from "./layout.ts";
import { chatBubble, typingIndicator, emptyState } from "./components.ts";
import { escapeHtml } from "../../shared/html.ts";
import { formatCost } from "../../telegram/format.ts";
import type { ChatMessage, AgentSession } from "../../shared/types.ts";
import { getSessionPreview } from "../../db/queries.ts";

export function chatPage(
  messages: ChatMessage[] = [],
  currentSessionPreview: string | null = null,
  sessions: AgentSession[] = []
): string {
  const messageHtml =
    messages.length > 0
      ? messages
          .map((m) => {
            const meta =
              m.role === "assistant" && m.cost_usd
                ? `$${m.cost_usd.toFixed(4)} / ${((m.duration_ms ?? 0) / 1000).toFixed(1)}s`
                : undefined;
            return chatBubble(m.role, escapeHtml(m.content), meta, m.id);
          })
          .join("\n")
      : emptyState("Send a message to get started");

  const sessionLabel = currentSessionPreview
    ? escapeHtml(currentSessionPreview)
    : "Latest session";

  return layout(
    "Chat",
    "chat",
    `<div class="flex flex-col h-full">
      <div class="shrink-0 border-b border-zinc-800 px-4 py-2 flex items-center gap-2 text-sm">
        <span class="text-zinc-400 truncate flex-1">${sessionLabel}</span>
        <button
          hx-get="/api/sessions"
          hx-target="#session-panel"
          hx-swap="innerHTML"
          class="text-indigo-400 hover:text-indigo-300 text-xs font-medium"
        >Switch</button>
        <button
          hx-post="/api/chat/new-session"
          class="text-zinc-400 hover:text-zinc-300 text-xs font-medium"
        >New</button>
      </div>
      <div id="session-panel"></div>
      <div id="messages" class="chat-messages flex-1 overflow-y-auto p-4">
        ${messageHtml}
      </div>
      <script>
        (function() {
          var msgs = document.getElementById('messages');
          msgs.scrollTop = msgs.scrollHeight;

          var loading = false;
          var exhausted = false;
          msgs.addEventListener('scroll', function() {
            if (loading || exhausted || msgs.scrollTop > 100) return;
            var first = msgs.querySelector('.chat-msg[data-msg-id]');
            if (!first) return;
            var beforeId = first.dataset.msgId;
            loading = true;
            fetch('/api/chat/older?before=' + beforeId)
              .then(function(r) { return r.text(); })
              .then(function(html) {
                if (!html.trim()) { exhausted = true; return; }
                var prevHeight = msgs.scrollHeight;
                var tmp = document.createElement('div');
                tmp.innerHTML = html;
                var frag = document.createDocumentFragment();
                while (tmp.firstChild) frag.appendChild(tmp.firstChild);
                msgs.insertBefore(frag, msgs.firstChild);
                if (typeof renderMarkdown === 'function') renderMarkdown();
                msgs.scrollTop = msgs.scrollHeight - prevHeight;
              })
              .finally(function() { loading = false; });
          });
        })();
      </script>

      <form
        hx-post="/api/chat"
        hx-target="#messages"
        hx-swap="beforeend"
        hx-on::after-request="this.reset(); document.getElementById('messages').scrollTo(0, document.getElementById('messages').scrollHeight)"
        class="shrink-0 border-t border-zinc-800 p-3"
      >
        <div class="flex gap-2">
          <input
            type="text"
            name="message"
            placeholder="Type a message..."
            required
            autocomplete="off"
            class="flex-1 bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
          >
          <button
            type="submit"
            class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2.5 rounded-xl text-sm font-medium transition-colors"
          >Send</button>
        </div>
      </form>
    </div>`
  );
}

export function sessionListPanel(
  sessions: AgentSession[],
  activeSessionId: string | null
): string {
  if (sessions.length === 0) {
    return `<div class="p-3 text-sm text-zinc-500">No sessions yet.</div>`;
  }

  const rows = sessions
    .map((s) => {
      const preview = s.label ?? getSessionPreview(s.session_id) ?? "(empty)";
      const shortId = s.session_id.slice(0, 8);
      const date = s.updated_at.split(" ")[0];
      const cost = formatCost(s.total_cost_usd);
      const isActive = s.session_id === activeSessionId;
      const activeBorder = isActive ? "border-indigo-500" : "border-zinc-700";

      return `<div class="flex items-center gap-2 p-2 rounded-lg border ${activeBorder} hover:border-zinc-500 transition-colors">
        <div class="flex-1 min-w-0">
          <div class="text-sm text-zinc-200 truncate">${escapeHtml(preview)}</div>
          <div class="text-xs text-zinc-500">${shortId} | ${date} | ${s.message_count} msgs | ${cost}</div>
        </div>
        <form class="shrink-0">
          <input type="hidden" name="sessionId" value="${s.session_id}">
          <button
            hx-post="/api/chat/switch-session"
            hx-include="closest form"
            class="text-xs text-indigo-400 hover:text-indigo-300 px-2 py-1"
          >${isActive ? "Active" : "Switch"}</button>
        </form>
        <form class="shrink-0">
          <input type="hidden" name="sessionId" value="${s.session_id}">
          <button
            hx-post="/api/chat/fork-session"
            hx-include="closest form"
            class="text-xs text-amber-400 hover:text-amber-300 px-2 py-1"
          >Fork</button>
        </form>
      </div>`;
    })
    .join("\n");

  return `<div class="border-b border-zinc-800 p-3 space-y-2 max-h-64 overflow-y-auto bg-zinc-900/50">
    <div class="flex items-center justify-between mb-1">
      <span class="text-xs text-zinc-400 font-medium uppercase tracking-wide">Sessions</span>
      <button onclick="document.getElementById('session-panel').innerHTML=''" class="text-xs text-zinc-500 hover:text-zinc-300">Close</button>
    </div>
    ${rows}
  </div>`;
}

export function chatStreamFragment(streamId: string): string {
  return `${typingIndicator()}
  <div id="response-${streamId}" class="flex justify-start mb-3">
    <div class="max-w-[85%] bg-zinc-800 text-zinc-100 rounded-2xl rounded-bl-md px-4 py-2.5">
      <div id="md-${streamId}" class="prose prose-invert prose-sm"></div>
      <div id="tools-${streamId}"></div>
      <div id="meta-${streamId}" class="text-xs mt-1 text-zinc-500"></div>
    </div>
  </div>
  <script>
    (function() {
      var buf = '';
      var mdEl = document.getElementById('md-${streamId}');
      var toolsEl = document.getElementById('tools-${streamId}');
      var metaEl = document.getElementById('meta-${streamId}');
      var typing = document.getElementById('typing');
      var msgs = document.getElementById('messages');
      var es = new EventSource('/api/chat/stream/${streamId}');

      es.addEventListener('chunk', function(e) {
        if (typing) { typing.remove(); typing = null; }
        try { buf += JSON.parse(e.data); } catch { buf += e.data; }
        if (mdEl && typeof marked !== 'undefined') {
          mdEl.innerHTML = marked.parse(buf);
        }
        if (msgs) msgs.scrollTop = msgs.scrollHeight;
      });

      es.addEventListener('tool', function(e) {
        var name;
        try { name = JSON.parse(e.data); } catch { name = e.data; }
        if (toolsEl) {
          var d = document.createElement('div');
          d.className = 'text-xs text-zinc-500 italic mb-1';
          d.textContent = 'Using ' + name + '...';
          toolsEl.appendChild(d);
        }
      });

      es.addEventListener('meta', function(e) {
        var val;
        try { val = JSON.parse(e.data); } catch { val = e.data; }
        if (metaEl) metaEl.textContent = val;
      });

      es.addEventListener('done', function() {
        es.close();
        if (typing) typing.remove();
        if (msgs) msgs.scrollTop = msgs.scrollHeight;
      });

      es.onerror = function() {
        es.close();
        if (typing) typing.remove();
      };
    })();
  </script>`;
}

export function chatToolIndicator(toolName: string): string {
  return escapeHtml(toolName);
}
