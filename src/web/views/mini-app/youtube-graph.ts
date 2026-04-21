export function tmaYoutubeGraphPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <link rel="stylesheet" href="/tma/static/tma.css">
  <style>
    html, body { height: 100%; overflow: hidden; background: #09090b; color: #d4d4d8; }
    .yg-wrap { position: fixed; inset: 0; display: flex; flex-direction: column; }

    .yg-topbar {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 10px; border-bottom: 1px solid #27272a;
      background: #09090b; z-index: 5; flex-shrink: 0;
    }
    .yg-back {
      background: #1f1f22; color: #d4d4d8; border: 1px solid #27272a;
      padding: 6px 10px; border-radius: 6px; font-size: 12px; text-decoration: none;
    }
    .yg-tabs {
      display: flex; gap: 4px; overflow-x: auto; flex: 1; scrollbar-width: none;
    }
    .yg-tabs::-webkit-scrollbar { display: none; }
    .yg-tab {
      background: transparent; color: #a1a1aa; border: 1px solid #27272a;
      padding: 6px 10px; border-radius: 999px; font-size: 12px; white-space: nowrap; cursor: pointer;
    }
    .yg-tab-active { background: #4f46e5; color: #fff; border-color: #4f46e5; }

    .yg-stats {
      font-size: 10px; color: #71717a; padding: 4px 10px; flex-shrink: 0;
      border-bottom: 1px solid #27272a; background: #09090b;
      display: flex; justify-content: space-between; align-items: center; gap: 8px;
    }
    .yg-search-btn {
      background: #1f1f22; color: #d4d4d8; border: 1px solid #27272a;
      padding: 4px 8px; border-radius: 6px; font-size: 11px; cursor: pointer;
    }

    .yg-canvas { flex: 1; position: relative; overflow: hidden; background: #09090b; }
    #yg-svg { width: 100%; height: 100%; display: block; touch-action: none; }

    .yg-search-drawer {
      position: absolute; left: 0; right: 0; top: 0;
      background: #09090b; border-bottom: 1px solid #27272a;
      padding: 8px; z-index: 4;
      transform: translateY(-100%); transition: transform 0.2s;
      max-height: 60vh; display: flex; flex-direction: column;
    }
    .yg-search-drawer.open { transform: translateY(0); }
    .yg-search-input {
      width: 100%; padding: 8px 10px; background: #18181b;
      border: 1px solid #27272a; border-radius: 6px; color: #fff; font-size: 14px;
      outline: none;
    }
    .yg-search-input:focus { border-color: #4f46e5; }
    .yg-search-list { overflow-y: auto; margin-top: 8px; }
    .yg-search-item {
      display: flex; align-items: center; gap: 6px; padding: 8px;
      border-radius: 4px; cursor: pointer; font-size: 13px;
    }
    .yg-search-item:active { background: #27272a; }

    .yg-sheet {
      position: absolute; left: 0; right: 0; bottom: 0;
      background: #09090b; border-top: 1px solid #27272a;
      border-top-left-radius: 12px; border-top-right-radius: 12px;
      box-shadow: 0 -4px 20px rgba(0,0,0,0.5);
      max-height: 70vh; display: flex; flex-direction: column;
      transform: translateY(100%); transition: transform 0.22s ease;
      z-index: 6;
    }
    .yg-sheet.open { transform: translateY(0); }
    .yg-sheet-handle {
      width: 36px; height: 4px; background: #3f3f46; border-radius: 2px;
      margin: 8px auto 4px;
    }
    .yg-sheet-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 4px 16px 8px; border-bottom: 1px solid #27272a;
    }
    .yg-sheet-title { font-size: 15px; font-weight: 600; color: #fff; flex: 1; margin-right: 12px; }
    .yg-sheet-close {
      background: transparent; color: #71717a; border: none;
      font-size: 24px; line-height: 1; cursor: pointer;
    }
    .yg-sheet-body { overflow-y: auto; padding: 12px 16px; font-size: 13px; }
    .yg-sheet-body h4 { font-size: 11px; color: #a1a1aa; text-transform: uppercase; margin: 12px 0 6px; font-weight: 700; }
    .yg-sheet-body .row {
      padding: 8px 0; border-bottom: 1px solid #27272a; cursor: pointer;
    }
    .yg-sheet-body .row:last-child { border-bottom: none; }
    .yg-sheet-body .row-sub { color: #71717a; font-size: 11px; margin-top: 2px; }
    .yg-sheet-body a { color: #818cf8; }
    .yg-tag {
      display: inline-block; padding: 2px 8px; background: #27272a; border-radius: 999px;
      font-size: 11px; color: #d4d4d8; margin: 2px;
    }
    .yg-loading { color: #71717a; font-style: italic; }
  </style>
</head>
<body>
  <div class="yg-wrap">
    <div class="yg-topbar">
      <a href="/tma/youtube" class="yg-back">&larr; List</a>
      <div class="yg-tabs">
        <button class="yg-tab yg-tab-active" id="yg-tab-topics" onclick="switchTab('topics')">Topics</button>
        <button class="yg-tab" id="yg-tab-similarity" onclick="switchTab('similarity')">Similarity</button>
        <button class="yg-tab" id="yg-tab-hybrid" onclick="switchTab('hybrid')">Hybrid</button>
      </div>
    </div>
    <div class="yg-stats">
      <span id="yg-stats-text">Loading...</span>
      <button class="yg-search-btn" onclick="toggleSearch()">Search</button>
    </div>

    <div class="yg-canvas">
      <svg id="yg-svg"></svg>

      <div class="yg-search-drawer" id="yg-search-drawer">
        <input type="text" class="yg-search-input" id="yg-search-input" placeholder="Search nodes..." oninput="filterNodes(this.value)">
        <div class="yg-search-list" id="yg-search-list"></div>
      </div>

      <div class="yg-sheet" id="yg-sheet">
        <div class="yg-sheet-handle"></div>
        <div class="yg-sheet-header">
          <div class="yg-sheet-title" id="yg-sheet-title"></div>
          <button class="yg-sheet-close" onclick="closeSheet()">&times;</button>
        </div>
        <div class="yg-sheet-body" id="yg-sheet-body"></div>
      </div>
    </div>
  </div>

  <script>
    var tg = window.Telegram && window.Telegram.WebApp;
    if (tg) { tg.ready(); tg.expand(); tg.BackButton.onClick(function(){ window.history.back(); }); }

    var _origFetch = window.fetch;
    window.fetch = function(url, opts) {
      opts = opts || {}; opts.headers = opts.headers || {};
      if (tg && tg.initData) opts.headers['X-Telegram-Init-Data'] = tg.initData;
      return _origFetch.call(this, url, opts);
    };

    var COLORS = {
      topic: '#818cf8', video: '#34d399', edge: '#3f3f46',
      text: '#d4d4d8', textDim: '#71717a', cluster: '#a5b4fc',
    };
    var CHANNEL_COLORS = [
      '#f87171','#fb923c','#fbbf24','#a3e635','#34d399',
      '#22d3ee','#60a5fa','#a78bfa','#f472b6','#e879f9',
    ];

    var currentTab = 'topics';
    var simulation = null;
    var graphData = null;
    var channelColorMap = {};
    var currentZoom = null;
    var svgG = null;
    var allNodeEls = null;
    var allLinkEls = null;

    function switchTab(tab) {
      currentTab = tab;
      ['topics','similarity','hybrid'].forEach(function(t) {
        var el = document.getElementById('yg-tab-' + t);
        if (el) el.className = 'yg-tab' + (t === tab ? ' yg-tab-active' : '');
      });
      closeSheet();
      closeSearch();
      loadGraph(tab);
    }

    function loadGraph(tab) {
      var endpoints = {
        topics: '/tma/api/youtube/graph/topics',
        similarity: '/tma/api/youtube/graph/similarity',
        hybrid: '/tma/api/youtube/graph/hybrid',
      };
      document.getElementById('yg-stats-text').textContent = 'Loading...';
      fetch(endpoints[tab]).then(function(r) { return r.json(); }).then(function(data) {
        graphData = data;
        document.getElementById('yg-stats-text').textContent =
          data.nodes.length + ' nodes, ' + data.edges.length + ' edges';

        var channels = [];
        data.nodes.forEach(function(n) { if (n.channel && channels.indexOf(n.channel) < 0) channels.push(n.channel); });
        channelColorMap = {};
        channels.forEach(function(ch, i) { channelColorMap[ch] = CHANNEL_COLORS[i % CHANNEL_COLORS.length]; });

        buildSearchList(data);
        renderGraph(data);
      }).catch(function(err) {
        console.error('Failed to load graph:', err);
        document.getElementById('yg-stats-text').textContent = 'Error loading graph';
      });
    }

    function buildSearchList(data) {
      var list = document.getElementById('yg-search-list');
      var sorted = data.nodes.slice().sort(function(a, b) { return a.label.localeCompare(b.label); });
      list.innerHTML = sorted.map(function(n) {
        var dot = n.type === 'topic'
          ? '<span style="color:' + COLORS.topic + '">&#9670;</span>'
          : '<span style="color:' + getNodeColor(n) + '">&#9679;</span>';
        return '<div class="yg-search-item" data-label="' + escapeAttr(n.label.toLowerCase()) + '" onclick="focusNode(' + JSON.stringify(n.id) + ')">'
          + dot + '<span>' + escapeHtml(n.label) + '</span></div>';
      }).join('');
    }

    function filterNodes(q) {
      q = (q || '').toLowerCase();
      document.querySelectorAll('.yg-search-item').forEach(function(el) {
        var label = el.getAttribute('data-label') || '';
        el.style.display = label.indexOf(q) >= 0 ? '' : 'none';
      });
    }

    function toggleSearch() {
      var drawer = document.getElementById('yg-search-drawer');
      drawer.classList.toggle('open');
      if (drawer.classList.contains('open')) {
        document.getElementById('yg-search-input').focus();
      }
    }
    function closeSearch() {
      document.getElementById('yg-search-drawer').classList.remove('open');
    }

    function getNodeColor(n) {
      if (n.type === 'topic') return COLORS.topic;
      return n.channel ? (channelColorMap[n.channel] || COLORS.video) : COLORS.video;
    }

    function focusNode(nodeId) {
      if (!graphData || !simulation) return;
      var node = graphData.nodes.find(function(n) { return n.id === nodeId; });
      if (!node || node.x == null) return;

      highlightConnections(node, graphData, allLinkEls, allNodeEls);

      var svg = d3.select('#yg-svg');
      var container = svg.node().getBoundingClientRect();
      var scale = 1.4;
      var tx = container.width / 2 - node.x * scale;
      var ty = container.height / 2 - node.y * scale;

      svg.transition().duration(500).call(
        currentZoom.transform,
        d3.zoomIdentity.translate(tx, ty).scale(scale)
      );

      closeSearch();
      showDetail(node);
    }

    function renderGraph(data) {
      var svg = d3.select('#yg-svg');
      svg.selectAll('*').remove();

      var bbox = svg.node().getBoundingClientRect();
      var width = bbox.width, height = bbox.height;

      if (data.nodes.length === 0) {
        svg.attr('viewBox', [0, 0, width, height]);
        svg.append('text')
          .attr('x', width / 2).attr('y', height / 2)
          .attr('text-anchor', 'middle').attr('fill', COLORS.textDim)
          .attr('font-size', '13px')
          .text('No graph data. Process some videos first.');
        return;
      }

      svg.attr('viewBox', [0, 0, width, height]);
      svgG = svg.append('g');
      var g = svgG;

      currentZoom = d3.zoom()
        .scaleExtent([0.05, 5])
        .on('zoom', function(event) { g.attr('transform', event.transform); });
      svg.call(currentZoom);

      svg.on('click', function(event) {
        if (event.target === this || event.target.tagName === 'svg') {
          resetHighlight(allLinkEls, allNodeEls);
        }
      });

      if (simulation) simulation.stop();

      var weights = data.edges.map(function(e) { return e.weight; });
      var maxWeight = weights.length > 0 ? Math.max.apply(null, weights) : 1;
      if (maxWeight <= 0) maxWeight = 1;

      simulation = d3.forceSimulation(data.nodes)
        .force('link', d3.forceLink(data.edges).id(function(d) { return d.id; })
          .distance(function(d) { return 100 - (d.weight / maxWeight) * 50; })
          .strength(function(d) { return 0.3 + (d.weight / maxWeight) * 0.7; })
        )
        .force('charge', d3.forceManyBody().strength(function(d) { return d.type === 'topic' ? -180 : -80; }))
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('collision', d3.forceCollide().radius(function(d) { return d.size + 4; }));

      var clusterLayer = g.append('g').attr('class', 'cluster-labels');

      var link = g.append('g').selectAll('line').data(data.edges).join('line')
        .attr('stroke', COLORS.edge)
        .attr('stroke-width', function(d) { return Math.max(0.5, Math.min(4, d.weight / maxWeight * 4)); })
        .attr('stroke-opacity', 0.4);
      allLinkEls = link;

      var node = g.append('g').selectAll('g').data(data.nodes).join('g')
        .call(d3.drag().on('start', dragstarted).on('drag', dragged).on('end', dragended))
        .on('click', function(event, d) {
          event.stopPropagation();
          highlightConnections(d, data, link, node);
          showDetail(d);
        })
        .style('cursor', 'pointer');
      allNodeEls = node;

      node.each(function(d) {
        var el = d3.select(this);
        if (d.type === 'topic') {
          var s = d.size;
          el.append('polygon')
            .attr('points', '0,' + (-s) + ' ' + s + ',0 0,' + s + ' ' + (-s) + ',0')
            .attr('fill', COLORS.topic).attr('fill-opacity', 0.8)
            .attr('stroke', COLORS.topic).attr('stroke-width', 1.5);
        } else {
          var color = getNodeColor(d);
          el.append('circle').attr('r', d.size)
            .attr('fill', color).attr('fill-opacity', 0.7)
            .attr('stroke', color).attr('stroke-width', 1.5);
        }
      });

      node.filter(function(d) { return (d.type === 'topic' && (d.videoCount || 0) >= 2) || d.size > 20; })
        .append('text')
        .text(function(d) { return d.label; })
        .attr('text-anchor', 'middle')
        .attr('dy', function(d) { return d.size + 13; })
        .attr('fill', COLORS.text).attr('font-size', '10px')
        .attr('pointer-events', 'none');

      simulation.on('tick', function() {
        link.attr('x1', function(d) { return d.source.x; })
          .attr('y1', function(d) { return d.source.y; })
          .attr('x2', function(d) { return d.target.x; })
          .attr('y2', function(d) { return d.target.y; });
        node.attr('transform', function(d) { return 'translate(' + d.x + ',' + d.y + ')'; });
      });

      simulation.on('end', function() { addClusterLabels(data, clusterLayer); });

      setTimeout(function() {
        addClusterLabels(data, clusterLayer);
        var bounds = g.node().getBBox();
        if (bounds.width > 0 && bounds.height > 0) {
          var pad = 40;
          var scale = Math.min(
            width / (bounds.width + pad * 2),
            height / (bounds.height + pad * 2),
            1.5
          );
          var tx = width / 2 - (bounds.x + bounds.width / 2) * scale;
          var ty = height / 2 - (bounds.y + bounds.height / 2) * scale;
          svg.transition().duration(500).call(
            currentZoom.transform,
            d3.zoomIdentity.translate(tx, ty).scale(scale)
          );
        }
      }, 2000);
    }

    function addClusterLabels(data, layer) {
      layer.selectAll('*').remove();
      var adj = {};
      data.nodes.forEach(function(n) { adj[n.id] = []; });
      data.edges.forEach(function(e) {
        var src = typeof e.source === 'object' ? e.source.id : e.source;
        var tgt = typeof e.target === 'object' ? e.target.id : e.target;
        if (adj[src]) adj[src].push(tgt);
        if (adj[tgt]) adj[tgt].push(src);
      });
      var visited = new Set();
      var components = [];
      data.nodes.forEach(function(n) {
        if (visited.has(n.id)) return;
        var comp = [];
        var queue = [n.id];
        while (queue.length > 0) {
          var cur = queue.shift();
          if (visited.has(cur)) continue;
          visited.add(cur);
          comp.push(cur);
          (adj[cur] || []).forEach(function(x) { if (!visited.has(x)) queue.push(x); });
        }
        components.push(comp);
      });
      var nodeMap = {};
      data.nodes.forEach(function(n) { nodeMap[n.id] = n; });
      components.forEach(function(comp) {
        if (comp.length < 3) return;
        var bestNode = null, bestScore = -1, cx = 0, cy = 0, count = 0;
        comp.forEach(function(id) {
          var n = nodeMap[id];
          if (!n || n.x == null) return;
          cx += n.x; cy += n.y; count++;
          var score = (n.videoCount || 0) * 10 + (adj[id] || []).length;
          if (score > bestScore) { bestScore = score; bestNode = n; }
        });
        if (!bestNode || count === 0) return;
        cx /= count; cy /= count;
        var label = bestNode.label;
        if (!label || label === 'General Content') return;
        layer.append('text').attr('x', cx).attr('y', cy - 25)
          .attr('text-anchor', 'middle').attr('fill', COLORS.cluster)
          .attr('fill-opacity', 0.35)
          .attr('font-size', Math.min(22, 10 + comp.length * 0.5) + 'px')
          .attr('font-weight', 'bold').attr('pointer-events', 'none')
          .text(label);
      });
    }

    function highlightConnections(d, data, link, node) {
      var connectedIds = new Set();
      connectedIds.add(d.id);
      data.edges.forEach(function(e) {
        var src = typeof e.source === 'object' ? e.source.id : e.source;
        var tgt = typeof e.target === 'object' ? e.target.id : e.target;
        if (src === d.id) connectedIds.add(tgt);
        if (tgt === d.id) connectedIds.add(src);
      });
      node.style('opacity', function(n) { return connectedIds.has(n.id) ? 1 : 0.1; });
      link.style('opacity', function(e) {
        var src = typeof e.source === 'object' ? e.source.id : e.source;
        var tgt = typeof e.target === 'object' ? e.target.id : e.target;
        return (src === d.id || tgt === d.id) ? 0.8 : 0.02;
      });
    }
    function resetHighlight(link, node) {
      if (!link || !node) return;
      node.style('opacity', 1);
      link.style('opacity', 0.4);
    }

    function dragstarted(event, d) {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      d.fx = d.x; d.fy = d.y;
    }
    function dragged(event, d) { d.fx = event.x; d.fy = event.y; }
    function dragended(event, d) {
      if (!event.active) simulation.alphaTarget(0);
      d.fx = null; d.fy = null;
    }

    function showDetail(d) {
      var sheet = document.getElementById('yg-sheet');
      var title = document.getElementById('yg-sheet-title');
      var body = document.getElementById('yg-sheet-body');
      sheet.classList.add('open');
      title.textContent = d.label;
      body.innerHTML = '<div class="yg-loading">Loading...</div>';

      if (d.type === 'topic') {
        var topicId = String(d.id).replace('t-', '');
        fetch('/tma/api/youtube/graph/topic/' + topicId)
          .then(function(r) { return r.json(); })
          .then(function(data) { body.innerHTML = renderTopicDetail(data); })
          .catch(function() { body.innerHTML = '<div style="color:#f87171;">Failed to load</div>'; });
      } else {
        var videoId = String(d.id).replace('v-', '');
        fetch('/tma/api/youtube/graph/video/' + videoId)
          .then(function(r) { return r.json(); })
          .then(function(data) {
            body.innerHTML = renderVideoDetail(data);
            if (typeof marked !== 'undefined') {
              body.querySelectorAll('[data-md]').forEach(function(el) {
                var raw = el.getAttribute('data-md-src') || '';
                el.innerHTML = marked.parse(raw);
              });
            }
          })
          .catch(function() { body.innerHTML = '<div style="color:#f87171;">Failed to load</div>'; });
      }
    }

    function renderTopicDetail(data) {
      var html = '<div style="color:#a1a1aa;">' + escapeHtml(data.description || 'No description') + '</div>';
      html += '<div style="color:#71717a; font-size:11px; margin-top:4px;">' + data.video_count + ' videos</div>';
      if (data.related_topics && data.related_topics.length > 0) {
        html += '<h4>Related Topics</h4>';
        html += data.related_topics.map(function(r) {
          return '<div class="row" onclick="focusNode(' + JSON.stringify('t-' + r.id) + ')">'
            + escapeHtml(r.display_name)
            + '<div class="row-sub">' + r.co_occurrence_count + ' shared</div></div>';
        }).join('');
      }
      if (data.videos && data.videos.length > 0) {
        html += '<h4>Videos</h4>';
        html += data.videos.map(function(v) {
          return '<div class="row"><div style="color:#fff;">' + escapeHtml(v.title) + '</div>'
            + '<div class="row-sub">' + escapeHtml(v.channel_title) + '</div></div>';
        }).join('');
      }
      return html;
    }

    function renderVideoDetail(data) {
      var html = '<div style="color:#71717a; font-size:11px;">' + escapeHtml(data.channel_title) + '</div>';
      html += '<a href="' + escapeAttr(data.url) + '" target="_blank" rel="noopener" style="font-size:12px;">Watch on YouTube</a>';
      if (data.tags && data.tags.length > 0) {
        html += '<div style="margin-top:8px;">' + data.tags.map(function(t) {
          return '<span class="yg-tag">' + escapeHtml(t) + '</span>';
        }).join('') + '</div>';
      }
      if (data.summary) {
        html += '<h4>Summary</h4><div data-md data-md-src="' + escapeAttr(data.summary) + '"></div>';
      }
      if (data.themes && data.themes.length > 0) {
        html += '<h4>Themes</h4>';
        html += data.themes.map(function(t) {
          return '<div class="row"><span style="color:#fff;">' + escapeHtml(t.name) + '</span>: '
            + escapeHtml(t.summary) + '</div>';
        }).join('');
      }
      if (data.related && data.related.length > 0) {
        html += '<h4>Related Videos</h4>';
        html += data.related.map(function(r) {
          return '<div class="row" onclick="focusNode(' + JSON.stringify('v-' + r.video_id) + ')">'
            + escapeHtml(r.title)
            + '<div class="row-sub">' + r.shared_topic_count + ' topics</div></div>';
        }).join('');
      }
      return html;
    }

    function closeSheet() {
      document.getElementById('yg-sheet').classList.remove('open');
    }

    function escapeHtml(s) {
      if (!s) return '';
      var div = document.createElement('div'); div.textContent = String(s); return div.innerHTML;
    }
    function escapeAttr(s) {
      return String(s == null ? '' : s)
        .replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')
        .replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    window.switchTab = switchTab;
    window.toggleSearch = toggleSearch;
    window.filterNodes = filterNodes;
    window.closeSheet = closeSheet;
    window.focusNode = focusNode;

    loadGraph('topics');
  </script>
</body>
</html>`;
}
