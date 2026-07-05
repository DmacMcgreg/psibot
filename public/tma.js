/* ==========================================================================
   Telegram Mini App — shared client JS
   Loaded once via /tma/static/tma.js. Owns: Telegram init, per-page BackButton,
   auth-header injection, HTMX error toasts, toast helper, markdown render +
   toggle, haptics, and the generic tmaFilter list helper.
   Keep global function names (renderMarkdown, showToast, toggleMdView,
   tmaFilter) stable — page views reference them.
   ========================================================================== */
(function () {
  "use strict";

  var tg = window.Telegram && window.Telegram.WebApp;
  window.tg = tg;

  // ---- Haptics ------------------------------------------------------------
  function haptic(type) {
    try {
      if (!tg || !tg.HapticFeedback) return;
      if (type === "success" || type === "error" || type === "warning") {
        tg.HapticFeedback.notificationOccurred(type);
      } else {
        tg.HapticFeedback.impactOccurred(type || "light");
      }
    } catch (e) {
      /* haptics unsupported — ignore */
    }
  }
  window.tmaHaptic = haptic;

  // ---- Telegram init + per-page BackButton --------------------------------
  // A page is "primary" (no back button) when its shell root carries
  // data-tma-root. Secondary/detail pages omit it and get a BackButton.
  function syncBackButton() {
    if (!tg || !tg.BackButton) return;
    var isPrimary = !!document.querySelector("[data-tma-root]");
    if (isPrimary) {
      tg.BackButton.hide();
    } else {
      tg.BackButton.show();
    }
  }

  if (tg) {
    try {
      tg.ready();
      tg.expand();
    } catch (e) {}
    try {
      tg.BackButton.onClick(function () {
        window.history.back();
      });
    } catch (e) {}

    // Inject Telegram auth header on every HTMX request.
    document.body.addEventListener("htmx:configRequest", function (e) {
      e.detail.headers["X-Telegram-Init-Data"] = tg.initData || "";
    });
  }

  // Inject auth header for plain fetch() too.
  var _origFetch = window.fetch;
  window.fetch = function (url, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    if (tg && tg.initData) {
      opts.headers["X-Telegram-Init-Data"] = tg.initData;
    }
    return _origFetch.call(this, url, opts);
  };

  // ---- Toast --------------------------------------------------------------
  // showToast(msg)                 -> success toast
  // showToast(msg, 'error')        -> error toast
  window.showToast = function (msg, variant) {
    var isError = variant === "error";
    var existing = document.querySelector(".tma-toast");
    if (existing) existing.remove();
    var el = document.createElement("div");
    el.className = "tma-toast " + (isError ? "tma-toast-error" : "tma-toast-success");
    el.textContent = (isError ? "⚠ " : "✓ ") + msg;
    document.body.appendChild(el);
    haptic(isError ? "error" : "success");
    setTimeout(function () {
      if (el.parentNode) el.remove();
    }, 2600);
  };

  // ---- HTMX error handling ------------------------------------------------
  // No more silent failures: surface an error toast on network/response errors.
  document.body.addEventListener("htmx:responseError", function (e) {
    var status = (e.detail && e.detail.xhr && e.detail.xhr.status) || "";
    window.showToast("Request failed" + (status ? " (" + status + ")" : ""), "error");
  });
  document.body.addEventListener("htmx:sendError", function () {
    window.showToast("Network error — check connection", "error");
  });
  document.body.addEventListener("htmx:timeout", function () {
    window.showToast("Request timed out", "error");
  });

  // ---- Haptics on taps ----------------------------------------------------
  document.body.addEventListener(
    "click",
    function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      if (t.closest(".tma-btn, .tma-tab, .tma-list-row, .tma-chip, .tma-filter-btn")) {
        haptic("light");
      }
    },
    true,
  );

  // ---- Markdown rendering -------------------------------------------------
  // Strip <script>/<style>/<iframe>/<object>/<embed> tags, event-handler
  // attributes (onclick=...), and javascript: URLs from marked.parse() output
  // before it is written to innerHTML. Stored markdown (library items, memory
  // entries, skills, synthesis files, youtube summaries) flows through LLM
  // pipelines and is treated as untrusted; marked emits embedded raw HTML
  // verbatim, so this is the guard against stored-HTML XSS.
  function sanitizeHtml(html) {
    var doc = document.implementation.createHTMLDocument("");
    doc.body.innerHTML = String(html == null ? "" : html);
    doc.body.querySelectorAll("script, style, iframe, object, embed").forEach(function (el) {
      el.remove();
    });
    var all = doc.body.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      for (var j = el.attributes.length - 1; j >= 0; j--) {
        var attr = el.attributes[j];
        var name = attr.name.toLowerCase();
        var value = attr.value || "";
        if (name.indexOf("on") === 0) {
          el.removeAttribute(attr.name);
          continue;
        }
        if ((name === "href" || name === "src") && /^\s*javascript:/i.test(value)) {
          el.removeAttribute(attr.name);
        }
      }
    }
    return doc.body.innerHTML;
  }
  window.tmaSanitizeHtml = sanitizeHtml;

  // Renders [data-md] elements. Raw source may live in data-md-src or textContent.
  window.renderMarkdown = function () {
    if (typeof marked === "undefined") return;
    document.querySelectorAll("[data-md]:not([data-md-done])").forEach(function (el) {
      var raw = el.getAttribute("data-md-src") || el.textContent || "";
      try {
        el.innerHTML = sanitizeHtml(marked.parse(raw));
      } catch (err) {
        /* leave raw text on parse failure */
      }
      el.classList.add("tma-md");
      el.setAttribute("data-md-done", "1");
    });
  };

  // Toggle rendered <-> raw within a [data-md-toggle-root] container.
  window.toggleMdView = function (btn) {
    var root = btn.closest("[data-md-toggle-root]");
    if (!root) return;
    var rendered = root.querySelector(".md-rendered");
    var raw = root.querySelector(".md-raw");
    if (!rendered || !raw) return;
    var isRaw = raw.style.display !== "none";
    raw.style.display = isRaw ? "none" : "block";
    rendered.style.display = isRaw ? "block" : "none";
    btn.textContent = isRaw ? "Raw" : "Rendered";
  };

  // ---- Generic client-side list filter ------------------------------------
  // Attach via oninput="tmaFilter(this)". Filters sibling rows within the
  // input's [data-tma-filter-scope] ancestor (or the input's parent's next
  // container). Rows to filter carry [data-tma-filter-item]; matching is
  // against the item's textContent (case-insensitive).
  window.tmaFilter = function (inputEl) {
    var q = (inputEl.value || "").trim().toLowerCase();
    var scope =
      inputEl.closest("[data-tma-filter-scope]") ||
      inputEl.parentElement ||
      document;
    var items = scope.querySelectorAll("[data-tma-filter-item]");
    var shown = 0;
    items.forEach(function (item) {
      var hay = (
        item.getAttribute("data-tma-filter-text") ||
        item.textContent ||
        ""
      ).toLowerCase();
      var match = !q || hay.indexOf(q) !== -1;
      item.style.display = match ? "" : "none";
      if (match) shown++;
    });
    var empty = scope.querySelector("[data-tma-filter-empty]");
    if (empty) empty.style.display = shown === 0 ? "" : "none";
  };

  // Chip-based filtering: clicking a [data-tma-filter] chip toggles active
  // state and filters items whose [data-<name>] value matches.
  document.body.addEventListener("click", function (e) {
    var chip = e.target.closest && e.target.closest("[data-tma-filter][data-tma-value]");
    if (!chip) return;
    var name = chip.getAttribute("data-tma-filter");
    var value = chip.getAttribute("data-tma-value");
    var row = chip.closest(".tma-chip-row");
    if (row) {
      row.querySelectorAll("[data-tma-filter='" + name + "']").forEach(function (c) {
        c.classList.toggle("tma-chip-active", c === chip);
      });
    }
    var scope = chip.closest("[data-tma-filter-scope]") || document;
    scope.querySelectorAll("[data-tma-filter-item]").forEach(function (item) {
      var itemVal = item.getAttribute("data-" + name);
      var match = value === "all" || value == null || itemVal === value;
      item.style.display = match ? "" : "none";
    });
  });

  // ---- Lifecycle wiring ---------------------------------------------------
  function onReady() {
    window.renderMarkdown();
    syncBackButton();
  }
  document.addEventListener("htmx:afterSwap", window.renderMarkdown);
  document.addEventListener("htmx:load", window.renderMarkdown);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", onReady);
  } else {
    onReady();
  }
})();
