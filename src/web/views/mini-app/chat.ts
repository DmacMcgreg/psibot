import { miniAppLayout } from "./shell.ts";
import { escapeHtml } from "../../../shared/html.ts";
import type { ChatMessage } from "../../../shared/types.ts";

export function tmaChatPage(messages: ChatMessage[] = []): string {
  const messageHtml = messages.length > 0
    ? messages.map((m) => tmaBubble(m.role, m.content)).join("\n")
    : `<div class="tma-empty">Send a message to get started</div>`;

  return miniAppLayout("chat", `
    <div id="messages" style="display:flex; flex-direction:column; min-height:100%; padding:8px 0; justify-content:flex-end;">
      ${messageHtml}
    </div>
    <form
      id="chat-form"
      hx-post="/tma/api/chat"
      hx-target="#messages"
      hx-swap="beforeend"
      hx-on::after-request="this.reset(); document.getElementById('messages').scrollIntoView({block:'end'})"
      style="position:sticky; bottom:0; padding:8px 16px; padding-bottom:calc(8px + env(safe-area-inset-bottom)); background:var(--tg-theme-bg-color,#fff); border-top:1px solid var(--tg-theme-hint-color,#ccc);"
    >
      <div style="display:flex; gap:8px;">
        <input
          type="text"
          name="message"
          placeholder="Message..."
          required
          autocomplete="off"
          class="tma-input"
          style="flex:1"
        >
        <button type="submit" class="tma-btn">Send</button>
      </div>
    </form>
    <script>
      var msgs = document.getElementById('messages');
      if (msgs) msgs.scrollIntoView({block:'end'});
    </script>
  `);
}

function tmaBubble(role: string, content: string): string {
  const cls = role === "user" ? "tma-bubble-user" : "tma-bubble-assistant";
  return `<div class="tma-bubble ${cls}">${escapeHtml(content)}</div>`;
}

export function tmaChatStreamFragment(streamId: string): string {
  return `<div class="tma-bubble tma-bubble-assistant" id="stream-${streamId}">
    <span class="tma-hint">Thinking...</span>
  </div>
  <script>
    (function() {
      var el = document.getElementById('stream-${streamId}');
      var buf = '';
      var es = new EventSource('/tma/api/chat/stream/${streamId}');
      es.addEventListener('chunk', function(e) {
        try { buf += JSON.parse(e.data); } catch(ex) { buf += e.data; }
        if (el) el.textContent = buf;
      });
      es.addEventListener('meta', function(e) {
        var val;
        try { val = JSON.parse(e.data); } catch(ex) { val = e.data; }
        if (el) {
          var meta = document.createElement('div');
          meta.className = 'tma-meta';
          meta.textContent = val;
          el.appendChild(meta);
        }
      });
      es.addEventListener('done', function() {
        es.close();
        el.scrollIntoView({block:'end'});
      });
      es.onerror = function() { es.close(); };
    })();
  </script>`;
}
