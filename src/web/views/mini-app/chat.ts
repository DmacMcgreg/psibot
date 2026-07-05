/**
 * Chat page (P1). Session-aware message thread with streaming assistant
 * replies, a sticky composer, and a header showing the active session/model.
 *
 * All HTML goes through components.ts helpers — no page-local escape/format.
 */
import { miniAppLayout } from "./shell.ts";
import {
  escapeHtml,
  escapeAttr,
  pageHeader,
  emptyState,
  formatDate,
  formatCost,
  button,
} from "./components.ts";
import type { ChatMessage, AgentSession } from "../../../shared/types.ts";

export interface ChatHeaderInfo {
  session: AgentSession | null;
}

function chatHeader(info: ChatHeaderInfo): string {
  const subtitle = info.session
    ? `${escapeHtml(info.session.model)} · ${escapeHtml(info.session.session_id.slice(0, 8))}`
    : "New session";
  const actions = button("New chat", { small: true, attrs: `hx-post="/tma/api/sessions/new" hx-target="#chat-root" hx-swap="outerHTML"` });
  return pageHeader("Chat", { subtitle, actions });
}

/**
 * Full chat page (header + message list + composer).
 *
 * The unauthenticated GET /tma/chat page load has no Telegram identity (auth
 * middleware only covers /api/*, see routes/mini-app/index.ts), so the
 * server cannot know which user is loading the page. Rather than guessing
 * (previously: falling back to the first configured ALLOWED_TELEGRAM_USER_ID,
 * which leaked one user's session history to every other user), the initial
 * render ships an empty/neutral shell and immediately self-hydrates via an
 * authenticated HTMX request — `/api/chat/init` runs behind
 * telegramAuthMiddleware and returns the real per-user chatRoot, which swaps
 * itself in using the caller's actual Telegram identity.
 */
export function tmaChatPage(): string {
  return miniAppLayout("chat", chatRoot([], null, { hydrate: true }));
}

export interface ChatRootOpts {
  /**
   * When true, the root issues an hx-get to /api/chat/init on load to
   * replace itself with the authenticated user's real session/messages.
   * Used only for the initial unauthenticated page shell.
   */
  hydrate?: boolean;
}

/** The swappable root — header + messages + composer. Used for full loads and "New chat". */
export function chatRoot(
  messages: ChatMessage[],
  session: AgentSession | null,
  opts: ChatRootOpts = {},
): string {
  const hydrateAttrs = opts.hydrate
    ? ` hx-get="/tma/api/chat/init" hx-trigger="load" hx-target="this" hx-swap="outerHTML"`
    : "";
  return `<div id="chat-root" class="tma-chat-root"${hydrateAttrs}>
    ${chatHeader({ session })}
    <div id="messages" class="tma-messages">
      ${opts.hydrate ? skeletonMessages() : messageList(messages)}
    </div>
    ${composer()}
  </div>`;
}

function skeletonMessages(): string {
  return `<div class="tma-bubble tma-bubble-assistant"><span class="tma-typing"><span></span><span></span><span></span></span></div>`;
}

function messageList(messages: ChatMessage[]): string {
  if (messages.length === 0) {
    return emptyState("💬", "No messages yet", "Send a message to start the conversation");
  }
  return messages.map(tmaBubble).join("\n");
}

function tmaBubble(m: ChatMessage): string {
  const cls = m.role === "user" ? "tma-bubble-user" : "tma-bubble-assistant";
  const meta =
    m.role === "assistant"
      ? `<div class="tma-bubble-meta">${formatDate(m.created_at)}${m.cost_usd != null ? ` · ${formatCost(m.cost_usd)}` : ""}</div>`
      : `<div class="tma-bubble-meta" style="text-align:right;">${formatDate(m.created_at)}</div>`;
  return `<div class="tma-bubble ${cls}">${escapeHtml(m.content)}</div>
  ${meta}`;
}

function composer(): string {
  return `<form
    id="chat-form"
    class="tma-composer"
    hx-post="/tma/api/chat"
    hx-target="#messages"
    hx-swap="beforeend"
    hx-disabled-elt="#chat-send"
    hx-on::before-request="document.getElementById('chat-send').setAttribute('data-sending','1')"
    hx-on::after-request="this.reset(); document.getElementById('chat-input').style.height='auto'; document.getElementById('chat-send').removeAttribute('data-sending'); var m=document.getElementById('messages'); if (m) m.scrollTop = m.scrollHeight;"
  >
    <textarea
      id="chat-input"
      name="message"
      class="tma-input"
      placeholder="Message…"
      required
      autocomplete="off"
      rows="1"
      oninput="this.style.height='auto'; this.style.height=Math.min(this.scrollHeight,120)+'px';"
      onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault(); this.form.requestSubmit();}"
    ></textarea>
    <button id="chat-send" type="submit" class="tma-btn tma-btn-primary">Send</button>
  </form>`;
}

/** User bubble fragment appended immediately on submit (optimistic echo). */
export function tmaUserBubble(content: string, createdAt: string | Date = new Date()): string {
  return tmaBubble({
    id: 0,
    session_id: "",
    role: "user",
    content,
    source: "mini-app",
    source_id: null,
    cost_usd: null,
    duration_ms: null,
    created_at: typeof createdAt === "string" ? createdAt : createdAt.toISOString(),
  });
}

/**
 * Streaming assistant placeholder + SSE wiring. `retryPrompt` is the original
 * user message, carried on a `data-retry` attribute (escapeAttr-encoded) so
 * the error bubble's Retry button can re-POST it without ever interpolating
 * untrusted text into a `<script>` body (JSON.stringify does not escape
 * `</script>`, which would otherwise allow HTML/script injection via a
 * crafted chat message — see security review finding).
 */
export function tmaChatStreamFragment(streamId: string, retryPrompt: string): string {
  return `<div class="tma-bubble tma-bubble-assistant" id="stream-${escapeAttr(streamId)}" data-run-id="" data-retry="${escapeAttr(retryPrompt)}">
    <span class="tma-typing"><span></span><span></span><span></span></span>
  </div>
  <div class="tma-bubble-meta" id="stream-meta-${escapeAttr(streamId)}"></div>
  <script>
    (function() {
      var el = document.getElementById('stream-${streamId}');
      var metaEl = document.getElementById('stream-meta-${streamId}');
      var buf = '';
      var gotChunk = false;
      var main = document.getElementById('messages');
      function scrollBottom() { if (main) main.scrollTop = main.scrollHeight; }
      function showCancel() {
        if (!el || el.querySelector('.tma-cancel-btn')) return;
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tma-btn tma-btn-secondary tma-btn-sm tma-cancel-btn';
        btn.textContent = 'Cancel';
        btn.onclick = function() {
          fetch('/tma/api/chat/cancel/${streamId}', { method: 'POST' });
          btn.disabled = true;
          btn.textContent = 'Cancelling…';
        };
        el.appendChild(btn);
      }
      showCancel();
      var es = new EventSource('/tma/api/chat/stream/${streamId}');
      es.addEventListener('chunk', function(e) {
        var val;
        try { val = JSON.parse(e.data); } catch(ex) { val = e.data; }
        if (!gotChunk && el) { el.innerHTML = ''; gotChunk = true; }
        buf += val;
        if (el) el.textContent = buf;
        scrollBottom();
      });
      es.addEventListener('meta', function(e) {
        var val;
        try { val = JSON.parse(e.data); } catch(ex) { val = e.data; }
        if (metaEl) metaEl.textContent = val;
      });
      es.addEventListener('done', function(e) {
        es.close();
        var status;
        try { status = JSON.parse(e.data); } catch(ex) { status = e.data; }
        if (el) {
          var cancelBtn = el.querySelector('.tma-cancel-btn');
          if (cancelBtn) cancelBtn.remove();
          if (status === 'error' || status === 'cancelled') {
            el.classList.remove('tma-bubble-assistant');
            el.classList.add('tma-bubble-error');
            if (!gotChunk) {
              el.textContent = status === 'cancelled' ? 'Cancelled.' : 'Something went wrong.';
            }
            var retry = document.createElement('button');
            retry.type = 'button';
            retry.className = 'tma-btn tma-btn-secondary tma-btn-sm';
            retry.style.marginTop = '8px';
            retry.style.display = 'block';
            retry.textContent = 'Retry';
            retry.onclick = function() {
              var input = document.getElementById('chat-input');
              if (input) { input.value = el.getAttribute('data-retry') || ''; document.getElementById('chat-form').requestSubmit(); }
            };
            el.appendChild(retry);
            if (window.showToast) window.showToast('Message failed', 'error');
          }
        }
        scrollBottom();
      });
      es.onerror = function() {
        es.close();
        if (el && !gotChunk) {
          el.classList.remove('tma-bubble-assistant');
          el.classList.add('tma-bubble-error');
          el.textContent = 'Connection lost.';
        }
        if (window.showToast) window.showToast('Connection lost', 'error');
      };
    })();
  </script>`;
}
