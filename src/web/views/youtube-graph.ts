import { layout } from "./layout.ts";

export function youtubeGraphPage(): string {
  return layout("Knowledge Graph", "graph", graphBody());
}

function graphBody(): string {
  return `
<div class="flex flex-col h-full">
  <!-- Tab bar -->
  <div class="flex gap-1 px-4 py-2 border-b border-zinc-800 shrink-0">
    <button onclick="switchTab('topics')" id="tab-topics" class="tab-btn px-3 py-1.5 rounded text-sm font-medium bg-indigo-600 text-white">Topic Clusters</button>
    <button onclick="switchTab('similarity')" id="tab-similarity" class="tab-btn px-3 py-1.5 rounded text-sm font-medium text-zinc-400 hover:text-white hover:bg-zinc-800">Video Similarity</button>
    <button onclick="switchTab('hybrid')" id="tab-hybrid" class="tab-btn px-3 py-1.5 rounded text-sm font-medium text-zinc-400 hover:text-white hover:bg-zinc-800">Knowledge Graph</button>
    <div class="flex-1"></div>
    <span id="graph-stats" class="text-xs text-zinc-500 self-center"></span>
  </div>

  <div class="flex flex-1 overflow-hidden relative">
    <!-- Left sidebar: search + stats -->
    <div id="sidebar" class="w-64 border-r border-zinc-800 flex flex-col shrink-0 bg-zinc-950">
      <!-- Search -->
      <div class="p-3 border-b border-zinc-800">
        <input id="node-search" type="text" placeholder="Search nodes..."
          oninput="filterSidebar(this.value)"
          class="w-full px-2.5 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-sm text-white placeholder-zinc-500 outline-none focus:border-indigo-500" />
      </div>
      <!-- Stats section -->
      <div id="stats-section" class="p-3 border-b border-zinc-800 space-y-2 shrink-0">
        <h4 class="text-xs font-bold text-zinc-400 uppercase">Top Topics</h4>
        <div id="stats-topics" class="space-y-0.5"></div>
      </div>
      <!-- Node list -->
      <div id="node-list" class="flex-1 overflow-y-auto p-1"></div>
    </div>

    <!-- Graph canvas -->
    <div id="graph-container" class="flex-1 overflow-hidden relative">
      <svg id="graph-svg" class="w-full h-full"></svg>
    </div>

    <!-- Detail panel (right) -->
    <div id="detail-panel" class="hidden w-80 border-l border-zinc-800 overflow-y-auto p-4 shrink-0 bg-zinc-950">
      <div class="flex justify-between items-center mb-3">
        <h3 id="detail-title" class="text-sm font-bold text-white truncate"></h3>
        <button onclick="closeDetail()" class="text-zinc-500 hover:text-white text-lg leading-none">&times;</button>
      </div>
      <div id="detail-content" class="text-sm text-zinc-300 space-y-3"></div>
    </div>
  </div>
</div>

<!-- D3.js -->
<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>

<script>
const COLORS = {
  topic: '#818cf8',
  video: '#34d399',
  edge: '#3f3f46',
  edgeHover: '#a5b4fc',
  text: '#d4d4d8',
  textDim: '#71717a',
  bg: '#09090b',
  cluster: '#a5b4fc',
};

const CHANNEL_COLORS = [
  '#f87171', '#fb923c', '#fbbf24', '#a3e635', '#34d399',
  '#22d3ee', '#60a5fa', '#a78bfa', '#f472b6', '#e879f9',
];

let currentTab = 'topics';
let simulation = null;
let graphData = null;
let channelColorMap = {};
let currentZoom = null;
let svgG = null;
let allNodeEls = null;
let allLinkEls = null;

// --- Tab switching ---

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.className = 'tab-btn px-3 py-1.5 rounded text-sm font-medium ' +
      (b.id === 'tab-' + tab ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:text-white hover:bg-zinc-800');
  });
  closeDetail();
  loadGraph(tab);
}

// --- Load graph data ---

async function loadGraph(tab) {
  const endpoints = {
    topics: '/api/youtube/graph/topics',
    similarity: '/api/youtube/graph/similarity',
    hybrid: '/api/youtube/graph/hybrid',
  };

  try {
    const res = await fetch(endpoints[tab]);
    graphData = await res.json();
    document.getElementById('graph-stats').textContent =
      graphData.nodes.length + ' nodes, ' + graphData.edges.length + ' edges';

    // Build channel color map
    const channels = [...new Set(graphData.nodes.filter(n => n.channel).map(n => n.channel))];
    channelColorMap = {};
    channels.forEach((ch, i) => { channelColorMap[ch] = CHANNEL_COLORS[i % CHANNEL_COLORS.length]; });

    buildSidebar(graphData, tab);
    renderGraph(graphData, tab);
  } catch (err) {
    console.error('Failed to load graph:', err);
    document.getElementById('graph-stats').textContent = 'Error loading graph data';
  }
}

// --- Sidebar ---

function buildSidebar(data, tab) {
  const statsEl = document.getElementById('stats-topics');
  const listEl = document.getElementById('node-list');
  document.getElementById('node-search').value = '';

  // Build adjacency for degree counting
  const degree = {};
  data.nodes.forEach(n => { degree[n.id] = 0; });
  data.edges.forEach(e => {
    const src = typeof e.source === 'object' ? e.source.id : e.source;
    const tgt = typeof e.target === 'object' ? e.target.id : e.target;
    degree[src] = (degree[src] || 0) + 1;
    degree[tgt] = (degree[tgt] || 0) + 1;
  });

  // Stats: top items by degree or video count
  const sorted = [...data.nodes].sort((a, b) => {
    if (a.videoCount && b.videoCount) return b.videoCount - a.videoCount;
    return (degree[b.id] || 0) - (degree[a.id] || 0);
  });

  const topItems = sorted.slice(0, 8);
  statsEl.innerHTML = topItems.map(n => {
    const meta = n.videoCount ? n.videoCount + ' videos' : (degree[n.id] || 0) + ' connections';
    const dot = n.type === 'topic'
      ? '<span style="color:' + COLORS.topic + '">&#9670;</span>'
      : '<span style="color:' + getNodeColor(n) + '">&#9679;</span>';
    return '<div class="sidebar-item flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer hover:bg-zinc-800 text-xs" data-node-id="' + n.id + '" onclick="focusNode(\\'' + n.id + '\\')">'
      + dot + ' <span class="truncate flex-1 text-zinc-200">' + escapeHtml(n.label) + '</span>'
      + '<span class="text-zinc-500 shrink-0">' + meta + '</span></div>';
  }).join('');

  // Full node list sorted alphabetically
  const allSorted = [...data.nodes].sort((a, b) => a.label.localeCompare(b.label));
  listEl.innerHTML = allSorted.map(n => {
    const dot = n.type === 'topic'
      ? '<span style="color:' + COLORS.topic + '">&#9670;</span>'
      : '<span style="color:' + getNodeColor(n) + '">&#9679;</span>';
    return '<div class="sidebar-item flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer hover:bg-zinc-800 text-xs" data-node-id="' + n.id + '" data-label="' + escapeHtml(n.label.toLowerCase()) + '" onclick="focusNode(\\'' + n.id + '\\')">'
      + dot + ' <span class="truncate text-zinc-300">' + escapeHtml(n.label) + '</span></div>';
  }).join('');
}

function filterSidebar(query) {
  const q = query.toLowerCase();
  document.querySelectorAll('#node-list .sidebar-item').forEach(el => {
    const label = el.getAttribute('data-label') || '';
    el.style.display = label.includes(q) ? '' : 'none';
  });
}

function getNodeColor(n) {
  if (n.type === 'topic') return COLORS.topic;
  return n.channel ? (channelColorMap[n.channel] || COLORS.video) : COLORS.video;
}

// --- Focus / zoom to node ---

function focusNode(nodeId) {
  if (!graphData || !simulation) return;
  const node = graphData.nodes.find(n => n.id === nodeId);
  if (!node || node.x == null) return;

  // Highlight
  highlightConnections(node, graphData, allLinkEls, allNodeEls);

  // Zoom to node
  const svg = d3.select('#graph-svg');
  const container = document.getElementById('graph-container');
  const scale = 1.5;
  const tx = container.clientWidth / 2 - node.x * scale;
  const ty = container.clientHeight / 2 - node.y * scale;

  svg.transition().duration(600).call(
    currentZoom.transform,
    d3.zoomIdentity.translate(tx, ty).scale(scale)
  );

  // Highlight sidebar item
  document.querySelectorAll('.sidebar-item').forEach(el => {
    el.classList.toggle('bg-zinc-800', el.getAttribute('data-node-id') === nodeId);
  });

  // Open detail
  showDetail(node);
}

// --- Render D3 force graph ---

function renderGraph(data, tab) {
  const svg = d3.select('#graph-svg');
  svg.selectAll('*').remove();

  if (data.nodes.length === 0) {
    const container = document.getElementById('graph-container');
    svg.attr('viewBox', [0, 0, container.clientWidth, container.clientHeight]);
    svg.append('text')
      .attr('x', container.clientWidth / 2)
      .attr('y', container.clientHeight / 2)
      .attr('text-anchor', 'middle')
      .attr('fill', COLORS.textDim)
      .attr('font-size', '14px')
      .text('No graph data available. Process some videos first.');
    return;
  }

  const container = document.getElementById('graph-container');
  const width = container.clientWidth;
  const height = container.clientHeight;

  svg.attr('viewBox', [0, 0, width, height]);

  svgG = svg.append('g');
  const g = svgG;

  // Zoom
  currentZoom = d3.zoom()
    .scaleExtent([0.05, 5])
    .on('zoom', (event) => g.attr('transform', event.transform));
  svg.call(currentZoom);

  // Click on background to reset highlight
  svg.on('click', function(event) {
    if (event.target === this || event.target.tagName === 'svg') {
      resetHighlight(allLinkEls, allNodeEls);
    }
  });

  // Force simulation
  if (simulation) simulation.stop();

  const maxWeight = Math.max(...data.edges.map(e => e.weight), 1);

  simulation = d3.forceSimulation(data.nodes)
    .force('link', d3.forceLink(data.edges)
      .id(d => d.id)
      .distance(d => 120 - (d.weight / maxWeight) * 60)
      .strength(d => 0.3 + (d.weight / maxWeight) * 0.7)
    )
    .force('charge', d3.forceManyBody()
      .strength(d => d.type === 'topic' ? -200 : -100)
    )
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide().radius(d => d.size + 4));

  // Cluster label layer (behind everything)
  const clusterLayer = g.append('g').attr('class', 'cluster-labels');

  // Edges
  const link = g.append('g')
    .selectAll('line')
    .data(data.edges)
    .join('line')
    .attr('stroke', COLORS.edge)
    .attr('stroke-width', d => Math.max(0.5, Math.min(4, d.weight / maxWeight * 4)))
    .attr('stroke-opacity', 0.4);
  allLinkEls = link;

  // Nodes
  const node = g.append('g')
    .selectAll('g')
    .data(data.nodes)
    .join('g')
    .call(d3.drag()
      .on('start', dragstarted)
      .on('drag', dragged)
      .on('end', dragended)
    )
    .on('click', (event, d) => {
      event.stopPropagation();
      highlightConnections(d, data, link, node);
      showDetail(d);
    })
    .style('cursor', 'pointer');
  allNodeEls = node;

  // Node shapes
  node.each(function(d) {
    const el = d3.select(this);
    if (d.type === 'topic') {
      const s = d.size;
      el.append('polygon')
        .attr('points', '0,' + (-s) + ' ' + s + ',0 0,' + s + ' ' + (-s) + ',0')
        .attr('fill', COLORS.topic)
        .attr('fill-opacity', 0.8)
        .attr('stroke', COLORS.topic)
        .attr('stroke-width', 1.5);
    } else {
      const color = getNodeColor(d);
      el.append('circle')
        .attr('r', d.size)
        .attr('fill', color)
        .attr('fill-opacity', 0.7)
        .attr('stroke', color)
        .attr('stroke-width', 1.5);
    }
  });

  // Labels on topic nodes with enough video count, or large nodes
  node.filter(d => (d.type === 'topic' && (d.videoCount || 0) >= 2) || d.size > 20)
    .append('text')
    .text(d => d.label)
    .attr('text-anchor', 'middle')
    .attr('dy', d => d.size + 14)
    .attr('fill', COLORS.text)
    .attr('font-size', '10px')
    .attr('pointer-events', 'none');

  // Tooltip
  const tooltip = d3.select('body').selectAll('.graph-tooltip').data([0]).join('div')
    .attr('class', 'graph-tooltip')
    .style('position', 'fixed')
    .style('pointer-events', 'none')
    .style('background', '#27272a')
    .style('border', '1px solid #3f3f46')
    .style('border-radius', '6px')
    .style('padding', '8px 12px')
    .style('font-size', '12px')
    .style('color', '#fafafa')
    .style('z-index', '1000')
    .style('display', 'none')
    .style('max-width', '300px');

  node
    .on('mouseenter', function(event, d) {
      let html = '<strong>' + escapeHtml(d.label) + '</strong>';
      if (d.channel) html += '<br><span style="color:#a1a1aa">Channel: ' + escapeHtml(d.channel) + '</span>';
      if (d.videoCount) html += '<br><span style="color:#a1a1aa">' + d.videoCount + ' videos</span>';
      tooltip.html(html).style('display', 'block');
    })
    .on('mousemove', function(event) {
      tooltip.style('left', (event.clientX + 12) + 'px').style('top', (event.clientY - 12) + 'px');
    })
    .on('mouseleave', function() {
      tooltip.style('display', 'none');
    });

  // Tick
  simulation.on('tick', () => {
    link
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y);

    node.attr('transform', d => 'translate(' + d.x + ',' + d.y + ')');
  });

  // After simulation settles, add cluster labels and zoom to fit
  simulation.on('end', () => {
    addClusterLabels(data, clusterLayer);
  });

  // Also add cluster labels after a timeout in case simulation takes long
  setTimeout(() => {
    addClusterLabels(data, clusterLayer);

    // Zoom to fit
    const bounds = g.node().getBBox();
    if (bounds.width > 0 && bounds.height > 0) {
      const pad = 60;
      const scale = Math.min(
        width / (bounds.width + pad * 2),
        height / (bounds.height + pad * 2),
        1.5
      );
      const tx = width / 2 - (bounds.x + bounds.width / 2) * scale;
      const ty = height / 2 - (bounds.y + bounds.height / 2) * scale;
      svg.transition().duration(500).call(
        currentZoom.transform,
        d3.zoomIdentity.translate(tx, ty).scale(scale)
      );
    }
  }, 2000);
}

// --- Cluster labels ---

function addClusterLabels(data, layer) {
  layer.selectAll('*').remove();

  // Build adjacency
  const adj = {};
  data.nodes.forEach(n => { adj[n.id] = []; });
  data.edges.forEach(e => {
    const src = typeof e.source === 'object' ? e.source.id : e.source;
    const tgt = typeof e.target === 'object' ? e.target.id : e.target;
    if (adj[src]) adj[src].push(tgt);
    if (adj[tgt]) adj[tgt].push(src);
  });

  // Find connected components via BFS
  const visited = new Set();
  const components = [];

  for (const n of data.nodes) {
    if (visited.has(n.id)) continue;
    const component = [];
    const queue = [n.id];
    while (queue.length > 0) {
      const current = queue.shift();
      if (visited.has(current)) continue;
      visited.add(current);
      component.push(current);
      for (const neighbor of (adj[current] || [])) {
        if (!visited.has(neighbor)) queue.push(neighbor);
      }
    }
    components.push(component);
  }

  // For each component with 3+ nodes, find centroid and best label
  const nodeMap = {};
  data.nodes.forEach(n => { nodeMap[n.id] = n; });

  for (const comp of components) {
    if (comp.length < 3) continue;

    // Find the "best" node: highest videoCount for topics, highest degree for videos
    let bestNode = null;
    let bestScore = -1;
    let cx = 0, cy = 0, count = 0;

    for (const id of comp) {
      const n = nodeMap[id];
      if (!n || n.x == null) continue;
      cx += n.x;
      cy += n.y;
      count++;

      const score = (n.videoCount || 0) * 10 + (adj[id] || []).length;
      if (score > bestScore) {
        bestScore = score;
        bestNode = n;
      }
    }

    if (!bestNode || count === 0) continue;
    cx /= count;
    cy /= count;

    // Only label clusters with a meaningful name
    const label = bestNode.label;
    if (!label || label === 'General Content') continue;

    layer.append('text')
      .attr('x', cx)
      .attr('y', cy - 30)
      .attr('text-anchor', 'middle')
      .attr('fill', COLORS.cluster)
      .attr('fill-opacity', 0.35)
      .attr('font-size', Math.min(24, 10 + comp.length * 0.5) + 'px')
      .attr('font-weight', 'bold')
      .attr('pointer-events', 'none')
      .text(label);
  }
}

// --- Highlight connected nodes ---

function highlightConnections(d, data, link, node) {
  const connectedIds = new Set();
  connectedIds.add(d.id);
  data.edges.forEach(e => {
    const src = typeof e.source === 'object' ? e.source.id : e.source;
    const tgt = typeof e.target === 'object' ? e.target.id : e.target;
    if (src === d.id) connectedIds.add(tgt);
    if (tgt === d.id) connectedIds.add(src);
  });

  node.style('opacity', n => connectedIds.has(n.id) ? 1 : 0.1);
  link.style('opacity', e => {
    const src = typeof e.source === 'object' ? e.source.id : e.source;
    const tgt = typeof e.target === 'object' ? e.target.id : e.target;
    return (src === d.id || tgt === d.id) ? 0.8 : 0.02;
  });
}

function resetHighlight(link, node) {
  if (!link || !node) return;
  node.style('opacity', 1);
  link.style('opacity', 0.4);
  document.querySelectorAll('.sidebar-item').forEach(el => el.classList.remove('bg-zinc-800'));
}

// --- Drag handlers ---

function dragstarted(event, d) {
  if (!event.active) simulation.alphaTarget(0.3).restart();
  d.fx = d.x;
  d.fy = d.y;
}

function dragged(event, d) {
  d.fx = event.x;
  d.fy = event.y;
}

function dragended(event, d) {
  if (!event.active) simulation.alphaTarget(0);
  d.fx = null;
  d.fy = null;
}

// --- Detail panel ---

async function showDetail(d) {
  const panel = document.getElementById('detail-panel');
  const title = document.getElementById('detail-title');
  const content = document.getElementById('detail-content');

  panel.classList.remove('hidden');
  title.textContent = d.label;
  content.innerHTML = '<p class="text-zinc-500">Loading...</p>';

  try {
    if (d.type === 'topic') {
      const topicId = d.id.replace('t-', '');
      const res = await fetch('/api/youtube/graph/topic/' + topicId);
      const data = await res.json();

      let html = '<p class="text-zinc-400">' + escapeHtml(data.description || 'No description') + '</p>';
      html += '<p class="text-xs text-zinc-500 mt-1">' + data.video_count + ' videos</p>';

      if (data.related_topics && data.related_topics.length > 0) {
        html += '<div class="mt-3"><h4 class="text-xs font-bold text-zinc-400 uppercase mb-1">Related Topics</h4>';
        html += data.related_topics.map(r =>
          '<div class="text-xs py-1 border-b border-zinc-800 cursor-pointer hover:text-indigo-300" onclick="focusNode(\\'t-' + r.id + '\\')">'
          + escapeHtml(r.display_name) + ' <span class="text-zinc-500">(' + r.co_occurrence_count + ' shared)</span></div>'
        ).join('');
        html += '</div>';
      }

      if (data.videos && data.videos.length > 0) {
        html += '<div class="mt-3"><h4 class="text-xs font-bold text-zinc-400 uppercase mb-1">Videos</h4>';
        html += data.videos.map(v =>
          '<div class="text-xs py-1.5 border-b border-zinc-800"><div class="text-white">' + escapeHtml(v.title) + '</div><div class="text-zinc-500">' + escapeHtml(v.channel_title) + '</div></div>'
        ).join('');
        html += '</div>';
      }

      content.innerHTML = html;
    } else {
      const videoId = d.id.replace('v-', '');
      const res = await fetch('/api/youtube/graph/video/' + videoId);
      const data = await res.json();

      let html = '<div class="text-xs text-zinc-500">' + escapeHtml(data.channel_title) + '</div>';
      html += '<a href="' + escapeHtml(data.url) + '" target="_blank" class="text-xs text-indigo-400 hover:underline">Watch on YouTube</a>';

      if (data.tags && data.tags.length > 0) {
        html += '<div class="flex flex-wrap gap-1 mt-2">';
        html += data.tags.map(t => '<span class="px-1.5 py-0.5 bg-zinc-800 rounded text-xs text-zinc-300">' + escapeHtml(t) + '</span>').join('');
        html += '</div>';
      }

      if (data.summary) {
        html += '<div class="mt-3 prose prose-invert prose-sm" data-md>' + escapeHtml(data.summary) + '</div>';
      }

      if (data.themes && data.themes.length > 0) {
        html += '<div class="mt-3"><h4 class="text-xs font-bold text-zinc-400 uppercase mb-1">Themes</h4>';
        html += data.themes.map(t =>
          '<div class="text-xs py-1 border-b border-zinc-800"><span class="text-white">' + escapeHtml(t.name) + '</span>: ' + escapeHtml(t.summary) + '</div>'
        ).join('');
        html += '</div>';
      }

      if (data.related && data.related.length > 0) {
        html += '<div class="mt-3"><h4 class="text-xs font-bold text-zinc-400 uppercase mb-1">Related Videos</h4>';
        html += data.related.map(r =>
          '<div class="text-xs py-1 border-b border-zinc-800 cursor-pointer hover:text-indigo-300" onclick="focusNode(\\'v-' + r.video_id + '\\')">'
          + escapeHtml(r.title) + ' <span class="text-zinc-500">(' + r.shared_topic_count + ' topics)</span></div>'
        ).join('');
        html += '</div>';
      }

      content.innerHTML = html;
      renderMarkdown();
    }
  } catch (err) {
    content.innerHTML = '<p class="text-red-400">Failed to load details</p>';
  }
}

function closeDetail() {
  document.getElementById('detail-panel').classList.add('hidden');
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Init ---
loadGraph('topics');
</script>`;
}
