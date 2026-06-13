<template>
  <section class="tube-map-layout">
    <aside class="controls">
      <section class="control-section control-actions">
        <h2>Config</h2>
        <div class="action-row">
          <button type="button" class="action-btn" @click="exportConfigJson">
            Export config
          </button>
          <button type="button" class="action-btn" @click="triggerImportConfig">
            Import config
          </button>
          <input
            ref="importConfigInputRef"
            class="sr-only"
            type="file"
            accept="application/json,.json"
            @change="onImportConfigFile"
          />
        </div>

        <h2>Export</h2>
        <div class="action-row">
          <button type="button" class="action-btn" @click="exportMapPng">
            Export PNG
          </button>
          <span v-if="exportError" class="action-error">{{ exportError }}</span>
        </div>
      </section>

      <section class="control-section">
        <h2 class="section-title">
          <span>Edges</span>
          <span class="section-title-actions">
            <span v-if="dimmedOverlayCount" class="section-meta">
              {{ dimmedOverlayCount }} grey segments
            </span>
            <button
              type="button"
              class="section-title-btn"
              :class="{ 'is-off': !showStationNames }"
              @click="toggleStationNames"
            >
              Names: {{ showStationNames ? 'On' : 'Off' }}
            </button>
            <button type="button" class="section-title-btn" @click="clearAllEdges">
              Clear all
            </button>
          </span>
        </h2>
        <div ref="edgeComboRef" class="combo">
          <input
            v-model.trim="edgeSearch"
            type="search"
            class="search-input"
            placeholder="Search edges"
            role="combobox"
            aria-autocomplete="list"
            :aria-expanded="edgeDropdownOpen ? 'true' : 'false'"
            aria-haspopup="listbox"
            @focus="openEdgeDropdown"
            @input="openEdgeDropdown"
            @keydown.down.prevent="moveEdgeHighlight(1)"
            @keydown.up.prevent="moveEdgeHighlight(-1)"
            @keydown.enter.prevent="selectHighlightedEdgeOption"
            @keydown.esc.prevent="closeEdgeDropdown"
          />
          <div
            v-if="edgeDropdownOpen && edgeDropdownOptions.length"
            class="combo-dropdown"
            role="listbox"
          >
            <button
              v-for="(opt, idx) in edgeDropdownOptions"
              :key="opt.id"
              type="button"
              class="combo-option"
              :class="{
                'is-highlighted': idx === edgeDropdownHighlight,
                'is-off': !opt.allSelected && !opt.indeterminate,
                'is-mixed': opt.indeterminate,
              }"
              @pointerdown.prevent="selectEdgeOption(opt)"
              @mousemove="edgeDropdownHighlight = idx"
            >
              <span class="combo-option-label">{{ opt.label }}</span>
              <span class="combo-option-meta">
                {{ opt.activeCount }}/1
              </span>
            </button>
          </div>
        </div>

        <div class="pill-list edges-list">
          <button
            v-for="edge in visibleEdgeGroups"
            :key="edge.id"
            type="button"
            class="pill pill-edge"
            :class="{
              'is-off': !edge.allSelected && !edge.indeterminate,
              'is-mixed': edge.indeterminate,
            }"
            @click="toggleEdgeGroup(edge.edgeKeys)"
          >
            <span class="pill-label">{{ edge.label }}</span>
            <span class="pill-meta">{{ edge.activeCount }}/1</span>
          </button>
        </div>
      </section>
    </aside>

    <div class="map-shell">
      <div
        ref="container"
        class="map-root"
        :class="{ 'is-hide-labels': !showStationNames }"
      />
      <div v-if="renderError" class="map-error">
        <div class="map-error-title">Map failed to render</div>
        <div class="map-error-body">{{ renderError }}</div>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import * as d3 from 'd3';
import { tubeMap } from 'd3-tube-map';
import { line as tubeLine } from 'd3-tube-map/src/curve';
import { interchangeShift } from 'd3-tube-map/src/directions';

const container = ref(null);
const edgeComboRef = ref(null);
const importConfigInputRef = ref(null);
const baseData = ref(null);
const renderError = ref('');
const exportError = ref('');
const lastRenderedMap = ref(null);
const dimmedOverlayCount = ref(0);
const defaultMapTransform = ref('');
const edgeGroups = ref([]);
const deselectedEdges = ref(new Set());
const edgeSearch = ref('');
const edgeDropdownOpen = ref(false);
const edgeDropdownHighlight = ref(0);
const showStationNames = ref(true);
let resizeObserver = null;
let pendingResizeFrame = 0;

function unionBBoxes(a, b) {
  if (!a) {
    return b ? { ...b } : null;
  }
  if (!b) {
    return { ...a };
  }

  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.width, b.x + b.width);
  const y2 = Math.max(a.y + a.height, b.y + b.height);

  return { x, y, width: x2 - x, height: y2 - y };
}

function getMapFitBBox(mapGroupEl, includeLabels) {
  // Use stable groups for fitting. Some browsers can report surprising results for
  // getBBox on groups with transformed descendants (notably interchange markers),
  // which then skews centering on small viewports.
  if (!mapGroupEl || typeof mapGroupEl.querySelector !== 'function') {
    return null;
  }

  const selectors = includeLabels ? ['.lines', '.stations', '.labels'] : ['.lines', '.stations'];
  let bbox = null;

  for (const sel of selectors) {
    const el = mapGroupEl.querySelector(sel);
    if (!el || typeof el.getBBox !== 'function') {
      continue;
    }

    try {
      const b = el.getBBox();
      if (b && b.width > 0 && b.height > 0) {
        bbox = unionBBoxes(bbox, b);
      }
    } catch {
      // ignore and keep trying other groups
    }
  }

  return bbox;
}

function getMapFitBBoxFromData(rendered, includeLabels) {
  if (!rendered?.data?.lines?.length) {
    return null;
  }

  const { data, width, height, margin } = rendered;
  const geom = computeMapGeometry(data, width, height, margin);
  const { xScale, yScale, lineWidth } = geom;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const line of data.lines) {
    if (!line?.nodes?.length) {
      continue;
    }
    for (const node of line.nodes) {
      const c = node?.coords;
      if (!Array.isArray(c) || c.length < 2) {
        continue;
      }
      const x = xScale(c[0]);
      const y = yScale(c[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        continue;
      }
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return null;
  }

  // Expand bounds to account for strokes/markers, and optionally labels.
  // Keep this proportional to the rendered viewport so mobile exports don't get huge padding.
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const maxSide = Math.max(width, height);
  const strokePad = clamp(Math.round(lineWidth * 1.25), 6, 40);
  const basePad = clamp(Math.round(maxSide * 0.012), 8, 36);
  const labelPad = includeLabels ? clamp(Math.round(maxSide * 0.018), 10, 64) : 0;
  const pad = Math.max(strokePad, basePad) + labelPad;

  return {
    x: minX - pad,
    y: minY - pad,
    width: (maxX - minX) + pad * 2,
    height: (maxY - minY) + pad * 2,
  };
}

const visibleEdgeGroups = computed(() => {
  const needle = edgeSearch.value.toLowerCase();
  const groupsWithState = edgeGroups.value.map((group) => {
    const deselectedCount = group.edgeKeys.reduce(
      (count, edgeKeyValue) => deselectedEdges.value.has(edgeKeyValue) ? count + 1 : count,
      0,
    );
    const activeCount = deselectedCount === group.edgeKeys.length ? 0 : 1;

    return {
      ...group,
      activeCount,
      allSelected: activeCount === 1,
      indeterminate: deselectedCount > 0 && deselectedCount < group.edgeKeys.length,
    };
  });

  if (!needle) {
    return groupsWithState;
  }

  return groupsWithState.filter(
    (group) =>
      group.label.toLowerCase().includes(needle) ||
      group.searchText.toLowerCase().includes(needle),
  );
});

const edgeDropdownOptions = computed(() => visibleEdgeGroups.value.slice(0, 12));

function normalizeStationLabel(label) {
  return String(label).replace(/\s+/g, ' ').trim();
}

function renderedLineName(line, lineIdx) {
  return `${line.name}__src_${lineIdx}__chunk_1`;
}

function edgeKey(lineName, pair) {
  return `${lineName}|${pair.startIdx}-${pair.endIdx}|${pair.startName}->${pair.endName}`;
}

function stationDisplayLabel(data, stationName) {
  return normalizeStationLabel(data.stations?.[stationName]?.label || stationName);
}

function edgeGroupId(startLabel, endLabel) {
  return [startLabel, endLabel]
    .map((label) => label.toLowerCase())
    .sort((a, b) => a.localeCompare(b))
    .join('__');
}

function edgeGroupLabel(startLabel, endLabel) {
  return [startLabel, endLabel]
    .sort((a, b) => a.localeCompare(b))
    .join(' - ');
}

function stationPairs(nodes) {
  const stationIndices = [];

  for (let i = 0; i < nodes.length; i += 1) {
    if (nodes[i].name) {
      stationIndices.push(i);
    }
  }

  const pairs = [];

  for (let i = 0; i < stationIndices.length - 1; i += 1) {
    const startIdx = stationIndices[i];
    const endIdx = stationIndices[i + 1];

    pairs.push({
      startIdx,
      endIdx,
      startName: nodes[startIdx].name,
      endName: nodes[endIdx].name,
    });
  }

  return pairs;
}

function normalizeShiftCoords(shiftCoords) {
  const x = Array.isArray(shiftCoords) && Number.isFinite(shiftCoords[0])
    ? shiftCoords[0]
    : 0;
  const y = Array.isArray(shiftCoords) && Number.isFinite(shiftCoords[1])
    ? shiftCoords[1]
    : 0;
  return [x, y];
}

function cloneNode(node) {
  const next = { ...node };
  if (Object.prototype.hasOwnProperty.call(next, 'shiftCoords')) {
    next.shiftCoords = normalizeShiftCoords(next.shiftCoords);
  }
  return next;
}

function normalizedLine(line, name, nodes) {
  return {
    ...line,
    sourceLineName: line.name,
    name,
    shiftCoords: normalizeShiftCoords(line.shiftCoords),
    shiftNormal: Number.isFinite(line.shiftNormal) ? line.shiftNormal : 0,
    nodes,
  };
}

function buildFilteredData(data) {
  const activeStations = new Set();
  const filteredLines = [];

  for (let lineIdx = 0; lineIdx < data.lines.length; lineIdx += 1) {
    const line = data.lines[lineIdx];
    // Some inputs contain multiple line objects with the same `name` (e.g. branches of the Northern line).
    // Ensure each rendered line id is unique.
    filteredLines.push(
      normalizedLine(
        line,
        renderedLineName(line, lineIdx),
        line.nodes.map((node) => cloneNode(node)),
      ),
    );
  }

  for (const line of filteredLines) {
    for (const node of line.nodes) {
      if (node.name) {
        activeStations.add(node.name);
      }
    }
  }

  // d3-tube-map mutates station objects (markers, coordinates). Clone so each render starts clean.
  // Also: it assumes every station has a `marker` array, so we only include stations referenced by lines.
  const clonedStations = {};
  for (const stationName of activeStations) {
    const station = data.stations[stationName];
    if (station) {
      clonedStations[stationName] = { ...station };
    }
  }

  return {
    ...data,
    stations: clonedStations,
    lines: filteredLines,
  };
}

function applyLineDeselectionStyles() {
  const rendered = lastRenderedMap.value;
  if (!container.value || !rendered) {
    return;
  }

  const { data, width, height, margin } = rendered;
  const root = d3.select(container.value);
  const svg = root.select('svg');
  if (svg.empty()) {
    return;
  }

  const mapGroup = svg.select('g');
  if (mapGroup.empty()) {
    return;
  }

  const dimmedSegments = [];
  for (const line of data.lines) {
    const pairs = stationPairs(line.nodes);
    for (const pair of pairs) {
      const key = edgeKey(line.name, pair);
      if (deselectedEdges.value.has(key)) {
        dimmedSegments.push({
          key,
          line,
          pair,
        });
      }
    }
  }

  let overlay = mapGroup.select('g.segment-dim-overlay');
  if (overlay.empty()) {
    // Keep stations/labels and interchanges above this overlay.
    const before = mapGroup.select('.interchanges').empty()
      ? '.stations'
      : '.interchanges';
    overlay = mapGroup.insert('g', before).attr('class', 'segment-dim-overlay');
  }
  overlay.attr('pointer-events', 'none');

  if (!dimmedSegments.length) {
    overlay.selectAll('path.segment-dim').remove();
    overlay.selectAll('path.segment-mask').remove();
    dimmedOverlayCount.value = 0;
    return;
  }

  const { xScale, yScale, lineWidth, lineWidthTickRatio } = computeMapGeometry(
    data,
    width,
    height,
    margin,
  );

  // Some lines share the same exact geometry over a stretch (e.g. Circle/H&C/Met).
  // If we draw the overlay multiple times, the strokes stack and look brighter.
  // Dedup both layers (mask + grey trace) by the computed SVG path.
  const dimmedPathByD = new Map();
  for (const seg of dimmedSegments) {
    try {
      const nodes = seg.line.nodes.slice(seg.pair.startIdx, seg.pair.endIdx + 1);
      const d = tubeLine(
        {
          nodes,
          shiftNormal: seg.line.shiftNormal,
          shiftCoords: seg.line.shiftCoords,
        },
        xScale,
        yScale,
        lineWidth,
        lineWidthTickRatio,
      );
      if (d) {
        if (!dimmedPathByD.has(d)) {
          dimmedPathByD.set(d, { key: d, d });
        }
      }
    } catch (err) {
      // Don't let a single bad segment kill the whole overlay.
      console.warn('Failed to draw dim overlay segment', seg.key, err);
    }
  }
  const dimmedPaths = [...dimmedPathByD.values()];
  dimmedOverlayCount.value = edgeGroups.value.reduce(
    (count, group) =>
      group.edgeKeys.every((key) => deselectedEdges.value.has(key)) ? count + 1 : count,
    0,
  );

  // Layer 1: "mask" the colored line so the segment becomes mostly invisible.
  overlay
    .selectAll('path.segment-mask')
    .data(dimmedPaths, (d) => d.key)
    .join((enter) =>
      enter
        .append('path')
        .attr('class', 'segment-mask')
        .attr('fill', 'none')
        .attr('stroke-linecap', 'round')
        .attr('stroke-linejoin', 'round'),
    )
    .attr('stroke', '#ffffff')
    .attr('opacity', 0.82)
    .attr('stroke-width', lineWidth * 1.25)
    .attr('d', (d) => d.d);

  // Layer 2: leave a faint grey trace so the segment is still discoverable.
  overlay
    .selectAll('path.segment-dim')
    .data(dimmedPaths, (d) => d.key)
    .join((enter) =>
      enter
        .append('path')
        .attr('class', 'segment-dim')
        .attr('fill', 'none')
        .attr('stroke-linecap', 'round')
        .attr('stroke-linejoin', 'round'),
    )
    .attr('stroke', '#9aa0a6')
    .attr('opacity', 0.16)
    .attr('stroke-width', lineWidth * 0.9)
    .attr('d', (d) => d.d);
}

function localPointerPoint(event, localEl) {
  const ctm = localEl?.getScreenCTM?.();
  if (!ctm) {
    return null;
  }

  if (typeof DOMPoint !== 'undefined') {
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());
    return { x: point.x, y: point.y };
  }

  const svg = localEl.ownerSVGElement;
  if (!svg?.createSVGPoint) {
    return null;
  }
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const transformed = point.matrixTransform(ctm.inverse());
  return { x: transformed.x, y: transformed.y };
}

function distanceToPath(pathEl, point) {
  const length = pathEl.getTotalLength();
  if (!Number.isFinite(length) || length <= 0) {
    return Infinity;
  }

  let best = Infinity;
  const steps = Math.max(12, Math.ceil(length / 24));

  for (let i = 0; i <= steps; i += 1) {
    const p = pathEl.getPointAtLength((length * i) / steps);
    const dx = p.x - point.x;
    const dy = p.y - point.y;
    best = Math.min(best, (dx * dx) + (dy * dy));
  }

  return best;
}

function closestHitTarget(event, overlayEl) {
  const point = localPointerPoint(event, overlayEl);
  if (!point) {
    return null;
  }

  let closest = null;
  let closestDistance = Infinity;

  for (const pathEl of overlayEl.querySelectorAll('path.segment-hit')) {
    const distance = distanceToPath(pathEl, point);
    if (distance < closestDistance) {
      closestDistance = distance;
      closest = d3.select(pathEl).datum();
    }
  }

  return closest;
}

function applyEdgeHitTargets() {
  const rendered = lastRenderedMap.value;
  if (!container.value || !rendered) {
    return;
  }

  const { data, width, height, margin } = rendered;
  const root = d3.select(container.value);
  const svg = root.select('svg');
  if (svg.empty()) {
    return;
  }

  const mapGroup = svg.select('g');
  if (mapGroup.empty()) {
    return;
  }

  let overlay = mapGroup.select('g.segment-hit-overlay');
  if (overlay.empty()) {
    const before = mapGroup.select('g.segment-dim-overlay').empty()
      ? (mapGroup.select('.interchanges').empty() ? '.stations' : '.interchanges')
      : 'g.segment-dim-overlay';
    overlay = mapGroup.insert('g', before).attr('class', 'segment-hit-overlay');
  }
  overlay.attr('pointer-events', 'stroke');

  const edgeGroupById = new Map(edgeGroups.value.map((group) => [group.id, group]));
  const { xScale, yScale, lineWidth, lineWidthTickRatio } = computeMapGeometry(
    data,
    width,
    height,
    margin,
  );
  const hitTargets = [];

  for (const line of data.lines) {
    const pairs = stationPairs(line.nodes);
    for (const pair of pairs) {
      const startLabel = stationDisplayLabel(data, pair.startName);
      const endLabel = stationDisplayLabel(data, pair.endName);
      const group = edgeGroupById.get(edgeGroupId(startLabel, endLabel));
      if (!group) {
        continue;
      }

      try {
        const nodes = line.nodes.slice(pair.startIdx, pair.endIdx + 1);
        const d = tubeLine(
          {
            nodes,
            shiftNormal: line.shiftNormal,
            shiftCoords: line.shiftCoords,
          },
          xScale,
          yScale,
          lineWidth,
          lineWidthTickRatio,
        );
        if (d) {
          hitTargets.push({
            key: edgeKey(line.name, pair),
            d,
            group,
          });
        }
      } catch (err) {
        console.warn('Failed to draw edge hit target', edgeKey(line.name, pair), err);
      }
    }
  }

  overlay
    .selectAll('path.segment-hit')
    .data(hitTargets, (d) => d.key)
    .join((enter) =>
      enter
        .append('path')
        .attr('class', 'segment-hit')
        .attr('fill', 'none')
        .attr('stroke', 'transparent')
        .attr('stroke-linecap', 'round')
        .attr('stroke-linejoin', 'round')
        .style('cursor', 'pointer')
        .on('pointerdown', (event) => {
          event.stopPropagation();
        })
        .on('click', (event, d) => {
          event.stopPropagation();
          const closest = closestHitTarget(event, overlay.node()) || d;
          toggleEdgeGroup(closest.group.edgeKeys);
        }),
    )
    .attr('stroke-width', Math.max(lineWidth * 1.35, 10))
    .attr('d', (d) => d.d);
}

function applyDeselectionStyles() {
  applyLineDeselectionStyles();
  applyEdgeHitTargets();
}

function computeMapGeometry(data, width, height, margin) {
  const xScale = d3.scaleLinear();
  const yScale = d3.scaleLinear();

  const minX =
    d3.min(data.lines, (line) => d3.min(line.nodes, (node) => node.coords[0])) - 1;
  const maxX =
    d3.max(data.lines, (line) => d3.max(line.nodes, (node) => node.coords[0])) + 1;
  const minY =
    d3.min(data.lines, (line) => d3.min(line.nodes, (node) => node.coords[1])) - 1;
  const maxY =
    d3.max(data.lines, (line) => d3.max(line.nodes, (node) => node.coords[1])) + 1;

  const desiredAspectRatio = (maxX - minX) / (maxY - minY);
  const actualAspectRatio =
    (width - margin.left - margin.right) /
    (height - margin.top - margin.bottom);
  const ratioRatio = actualAspectRatio / desiredAspectRatio;

  // Note that we flip the sense of the y-axis here.
  const maxXRange =
    desiredAspectRatio > actualAspectRatio
      ? width - margin.left - margin.right
      : (width - margin.left - margin.right) / ratioRatio;
  const maxYRange =
    desiredAspectRatio > actualAspectRatio
      ? (height - margin.top - margin.bottom) * ratioRatio
      : height - margin.top - margin.bottom;

  xScale.domain([minX, maxX]).range([margin.left, margin.left + maxXRange]);
  yScale.domain([minY, maxY]).range([margin.top + maxYRange, margin.top]);

  const unitLength = Math.abs(
    xScale(1) - xScale(0) !== 0 ? xScale(1) - xScale(0) : yScale(1) - yScale(0),
  );

  const lineWidthMultiplier = 0.8;
  const lineWidthTickRatio = 3 / 2;

  return {
    xScale,
    yScale,
    lineWidth: lineWidthMultiplier * unitLength,
    lineWidthTickRatio,
    lineWidthMultiplier,
  };
}

function positionInterchanges() {
  const rendered = lastRenderedMap.value;
  if (!container.value || !rendered) {
    return;
  }

  const root = d3.select(container.value);
  const svg = root.select('svg');
  if (svg.empty()) {
    return;
  }

  const { data, width, height, margin } = rendered;
  const { xScale, yScale, lineWidthMultiplier } = computeMapGeometry(
    data,
    width,
    height,
    margin,
  );

  const safeShift = (markers) => {
    try {
      const shift = interchangeShift(markers);
      if (
        Array.isArray(shift) &&
        shift.length === 2 &&
        Number.isFinite(shift[0]) &&
        Number.isFinite(shift[1])
      ) {
        return shift;
      }
    } catch {
      // fall through
    }
    return [0, 0];
  };

  svg.selectAll('.interchanges path.interchange').each(function (d) {
    const el = this;
    const station = d;
    if (!station || !Array.isArray(station.marker) || !station.marker.length) {
      return;
    }

    if (!Number.isFinite(station.x) || !Number.isFinite(station.y)) {
      return;
    }

    const shift = safeShift(station.marker);
    const shiftX = Number.isFinite(station.marker[0].shiftX) ? station.marker[0].shiftX : 0;
    const shiftY = Number.isFinite(station.marker[0].shiftY) ? station.marker[0].shiftY : 0;
    const x = xScale(station.x + (shift[0] + shiftX) * lineWidthMultiplier);
    const y = yScale(station.y + (shift[1] + shiftY) * lineWidthMultiplier);

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return;
    }

    el.setAttribute('transform', `translate(${x},${y})`);
  });
}

function renderMap() {
  if (!container.value || !baseData.value) {
    return;
  }

  renderError.value = '';
  exportError.value = '';
  d3.select(container.value).selectAll('*').remove();

  const filteredData = buildFilteredData(baseData.value);
  if (!filteredData.lines.length) {
    return;
  }

  const rect = container.value.getBoundingClientRect();
  const measuredWidth = Math.round(rect.width);
  const measuredHeight = Math.round(rect.height);
  // In some layouts (notably Chrome device emulation), clientWidth/clientHeight can be 0 or stale
  // during the first paint. Defer until we have a real size so "fit to content" is correct.
  if (measuredWidth < 2 || measuredHeight < 2) {
    window.requestAnimationFrame(renderMap);
    return;
  }

  const width = measuredWidth || 1200;
  const height = measuredHeight || 800;
  const margin = {
    top: 20,
    right: 20,
    bottom: 40,
    left: 100,
  };

  const root = d3.select(container.value);
  try {
    const map = tubeMap()
      .width(width)
      .height(height)
      .margin(margin);

    root.datum(filteredData).call(map);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    renderError.value = message;
    console.error('tube-map render error:', err);
    return;
  }

  lastRenderedMap.value = { data: filteredData, width, height, margin };

  const svg = root.select('svg');
  // d3-zoom's default SVG extent uses width/height *attributes* (not CSS).
  // If these are missing, translateTo/scaleTo won't reliably center (notably in Chrome device emulation).
  // Prefer viewBox so the zoom extent is stable even if CSS sizing differs.
  svg
    .attr('width', String(width))
    .attr('height', String(height))
    .attr('viewBox', `0 0 ${width} ${height}`);
  const zoomHandler = d3.zoom().scaleExtent([0.1, 6]).on('zoom', (event) => {
    svg.select('g').attr('transform', event.transform.toString());
  });

  svg.call(zoomHandler);

  // Ensure geometry (notably interchanges) is in final position before fitting to bounds.
  positionInterchanges();

  // Center + fit to the rendered map bounds so mobile/desktop start in a sensible viewport.
  try {
    const g = svg.select('g').node();
    if (g && g.getBBox) {
      const bbox = getMapFitBBox(g, showStationNames.value) || g.getBBox();
      if (bbox.width > 0 && bbox.height > 0) {
        const pad = Math.min(24, Math.round(Math.min(width, height) * 0.06));
        const fitScale = Math.min(
          (width - pad * 2) / bbox.width,
          (height - pad * 2) / bbox.height,
          1,
        );
        const initialScale = Math.max(0.1, Math.min(6, fitScale));
        svg.call(zoomHandler.scaleTo, initialScale);
        svg.call(
          zoomHandler.translateTo,
          bbox.x + bbox.width / 2,
          bbox.y + bbox.height / 2,
        );
      } else {
        svg.call(zoomHandler.scaleTo, 1);
      }
    } else {
      svg.call(zoomHandler.scaleTo, 1);
    }
  } catch (err) {
    console.warn('Failed to fit map to viewport:', err);
    svg.call(zoomHandler.scaleTo, 1);
  }

  defaultMapTransform.value = svg.select('g').attr('transform') || '';

  applyDeselectionStyles();
}

function toggleEdgeGroup(edgeKeys) {
  const next = new Set(deselectedEdges.value);
  const allSelected = edgeKeys.every((key) => !next.has(key));

  if (allSelected) {
    for (const key of edgeKeys) {
      next.add(key);
    }
  } else {
    for (const key of edgeKeys) {
      next.delete(key);
    }
  }

  deselectedEdges.value = next;
  applyDeselectionStyles();
}

function clearAllEdges() {
  if (!edgeGroups.value.length) {
    return;
  }

  const next = new Set();
  for (const group of edgeGroups.value) {
    for (const key of group.edgeKeys) {
      next.add(key);
    }
  }

  deselectedEdges.value = next;
  edgeSearch.value = '';
  edgeDropdownHighlight.value = 0;
  edgeDropdownOpen.value = false;
  applyDeselectionStyles();
}

function toggleStationNames() {
  showStationNames.value = !showStationNames.value;
}

function openEdgeDropdown() {
  edgeDropdownOpen.value = true;
  edgeDropdownHighlight.value = 0;
}

function closeEdgeDropdown() {
  edgeDropdownOpen.value = false;
}

function moveEdgeHighlight(delta) {
  if (!edgeDropdownOpen.value) {
    openEdgeDropdown();
  }
  const opts = edgeDropdownOptions.value;
  if (!opts.length) {
    edgeDropdownHighlight.value = 0;
    return;
  }
  const next =
    (edgeDropdownHighlight.value + delta + opts.length) % opts.length;
  edgeDropdownHighlight.value = next;
}

function selectEdgeOption(option) {
  toggleEdgeGroup(option.edgeKeys);
  edgeSearch.value = '';
  edgeDropdownHighlight.value = 0;
  edgeDropdownOpen.value = false;
}

function selectHighlightedEdgeOption() {
  if (!edgeSearch.value) {
    return;
  }
  if (!edgeDropdownOpen.value) {
    openEdgeDropdown();
  }
  const opts = edgeDropdownOptions.value;
  if (!opts.length) {
    return;
  }
  const idx = Math.min(edgeDropdownHighlight.value, opts.length - 1);
  selectEdgeOption(opts[idx]);
}

function onWindowPointerDown(event) {
  const el = edgeComboRef.value;
  if (!el) {
    return;
  }
  if (event.target instanceof Node && !el.contains(event.target)) {
    closeEdgeDropdown();
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

function exportConfigJson() {
  exportError.value = '';
  const config = {
    schema: 'tube-map-config',
    version: 2,
    exportedAt: new Date().toISOString(),
    deselectedEdges: [...deselectedEdges.value].sort((a, b) => a.localeCompare(b)),
  };
  const blob = new Blob([JSON.stringify(config, null, 2)], {
    type: 'application/json',
  });
  downloadBlob(blob, 'tube-map-config.json');
}

function triggerImportConfig() {
  exportError.value = '';
  const el = importConfigInputRef.value;
  if (!el) {
    return;
  }
  el.value = '';
  el.click();
}

async function onImportConfigFile(event) {
  exportError.value = '';
  const input = event.target;
  const file = input?.files?.[0];
  if (!file) {
    return;
  }

  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed?.deselectedEdges) ? parsed.deselectedEdges : null;
    const legacyStationList = Array.isArray(parsed?.deselectedStations)
      ? parsed.deselectedStations
      : null;
    if (!list) {
      if (!legacyStationList) {
        throw new Error('Invalid config: expected `deselectedEdges` array.');
      }
    }

    const validEdgeKeys = new Set(edgeGroups.value.flatMap((group) => group.edgeKeys));
    const next = new Set();
    if (list) {
      for (const key of list) {
        if (typeof key === 'string' && validEdgeKeys.has(key)) {
          next.add(key);
        }
      }
    } else {
      const legacyStations = new Set(
        legacyStationList.filter((name) => typeof name === 'string' && name),
      );
      for (const group of edgeGroups.value) {
        if (group.stationNames.some((name) => legacyStations.has(name))) {
          for (const key of group.edgeKeys) {
            next.add(key);
          }
        }
      }
    }

    deselectedEdges.value = next;
    applyDeselectionStyles();
  } catch (err) {
    exportError.value = err instanceof Error ? err.message : String(err);
    console.error('Import config failed:', err);
  }
}

function buildExportSvgCss() {
  // Inline a small amount of CSS so exported SVG -> PNG matches the on-screen state.
  return `
    ${showStationNames.value ? '' : '.labels { opacity: 0 !important; }'}
  `;
}

 async function exportMapPng() {
	  exportError.value = '';
	  if (!container.value) {
	    exportError.value = 'Map container missing.';
	    return;
	  }

  const svgEl = container.value.querySelector('svg');
  if (!svgEl) {
    exportError.value = 'Map SVG not found.';
    return;
  }

  // Clone (don’t disturb the live view).
  const clone = svgEl.cloneNode(true);
	  if (!(clone instanceof SVGSVGElement)) {
	    exportError.value = 'Failed to clone SVG.';
	    return;
	  }

	  const rendered = lastRenderedMap.value;
	  // Export should not depend on the user's current zoom/pan.
	  //
	  // Important: we deliberately export with *no* zoom transform applied to the cloned <g>.
	  // On some mobile browsers, getBBox results can differ depending on whether ancestor
	  // transforms are present, which can skew the fitted viewBox and produce a PNG that is
	  // off-center with lots of whitespace.
	  //
	  // We'll:
	  // 1) reset the clone's root <g> to identity transform
	  // 2) mount it offscreen to measure stable content bounds
	  // 3) set a viewBox that tightly fits the content (with padding), which yields a centered PNG.
	  let exportX = 0;
	  let exportY = 0;
	  let width = rendered?.width || Math.round(svgEl.getBoundingClientRect().width) || 1200;
	  let height = rendered?.height || Math.round(svgEl.getBoundingClientRect().height) || 800;

	  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
	  // Temporary size/viewBox for measurement; updated below after we compute content bounds.
	  clone.setAttribute('width', String(width));
	  clone.setAttribute('height', String(height));
	  clone.setAttribute('viewBox', `0 0 ${width} ${height}`);

	  const g = clone.querySelector('g');
	  if (g) {
	    // Ensure export is in the same coordinate system used by bbox fitting.
	    g.setAttribute('transform', '');
	  }

	  try {
	    // Prefer a data-derived bbox to avoid browser-specific SVG getBBox quirks on mobile.
	    const dataBBox = rendered ? getMapFitBBoxFromData(rendered, showStationNames.value) : null;
	    if (dataBBox && dataBBox.width > 0 && dataBBox.height > 0) {
	      exportX = dataBBox.x;
	      exportY = dataBBox.y;
	      width = dataBBox.width;
	      height = dataBBox.height;
	    } else {
	      // Fallback: mount offscreen and measure SVG content bounds.
	      const measureHost = document.createElement('div');
	      measureHost.style.position = 'fixed';
	      measureHost.style.left = '-10000px';
	      measureHost.style.top = '0';
	      measureHost.style.width = '0';
	      measureHost.style.height = '0';
	      measureHost.style.overflow = 'hidden';
	      measureHost.style.opacity = '0';
	      measureHost.style.pointerEvents = 'none';
	      measureHost.appendChild(clone);
	      document.body.appendChild(measureHost);

	      const measureG = clone.querySelector('g');
	      if (measureG && typeof measureG.getBBox === 'function') {
	        const bbox = getMapFitBBox(measureG, showStationNames.value) || measureG.getBBox();
	        if (bbox && bbox.width > 0 && bbox.height > 0) {
	          const xMin = bbox.x;
	          const xMax = bbox.x + bbox.width;
	          const yMin = bbox.y;
	          const yMax = bbox.y + bbox.height;

	          // Keep padding small but non-zero so stroke caps / labels don't get clipped.
	          const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
	          const padX = clamp(Math.round((xMax - xMin) * 0.03), 8, 48);
	          const padY = clamp(Math.round((yMax - yMin) * 0.03), 8, 48);

	          exportX = xMin - padX;
	          exportY = yMin - padY;
	          width = (xMax - xMin) + padX * 2;
	          height = (yMax - yMin) + padY * 2;
	        }
	      }

	      measureHost.remove();
	    }
	  } catch {
	    // If measurement fails, fall back to viewport-sized export.
	  }

	  clone.setAttribute('width', String(width));
	  clone.setAttribute('height', String(height));
	  clone.setAttribute('viewBox', `${exportX} ${exportY} ${width} ${height}`);

	  // White background so transparent areas don’t render black in some viewers.
	  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
	  bg.setAttribute('x', String(exportX));
	  bg.setAttribute('y', String(exportY));
	  bg.setAttribute('width', String(width));
	  bg.setAttribute('height', String(height));
	  bg.setAttribute('fill', '#ffffff');
	  clone.insertBefore(bg, clone.firstChild);

  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  style.textContent = buildExportSvgCss();
  clone.insertBefore(style, clone.firstChild);

  const svgText = new XMLSerializer().serializeToString(clone);
  const svgBlob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);

  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });

	    // Export at a higher DPI by rasterizing into a larger canvas.
	    // Cap to avoid huge canvases on memory-constrained mobile browsers.
	    const requestedScale = Math.max(2, Math.min(4, window.devicePixelRatio || 2));
	    // Ensure a minimum pixel size so mobile exports aren't blurry when zoomed.
	    const minLongSidePx = 3600;
	    const minScaleByOutputSize = minLongSidePx / Math.max(width, height);
	    const desiredScale = Math.max(requestedScale, minScaleByOutputSize);
	    const maxSide = 8192;
	    const maxPixels = 32_000_000; // ~32MP
	    const scaleCapBySide = Math.min(maxSide / width, maxSide / height);
	    const scaleCapByPixels = Math.sqrt(maxPixels / (width * height));
	    const scale = Math.max(1, Math.min(desiredScale, scaleCapBySide, scaleCapByPixels));

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Canvas 2D context unavailable.');
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const pngBlob = await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG export failed.'))), 'image/png');
    });

    downloadBlob(pngBlob, 'tube-map.png');
  } catch (err) {
    exportError.value = err instanceof Error ? err.message : String(err);
    console.error('PNG export failed:', err);
  } finally {
    URL.revokeObjectURL(url);
  }
}

onMounted(async () => {
  const mapDataUrl = `${import.meta.env.BASE_URL}london-tube.json`;
  const data = await d3.json(mapDataUrl);
  if (!data) {
    console.error(`Failed to load map data from ${mapDataUrl}`);
    return;
  }
  baseData.value = data;
  const edgeGroupsById = new Map();

  for (let lineIdx = 0; lineIdx < data.lines.length; lineIdx += 1) {
    const line = data.lines[lineIdx];
    const lineName = renderedLineName(line, lineIdx);

    for (const pair of stationPairs(line.nodes || [])) {
      const startLabel = stationDisplayLabel(data, pair.startName);
      const endLabel = stationDisplayLabel(data, pair.endName);
      const id = edgeGroupId(startLabel, endLabel);
      const key = edgeKey(lineName, pair);
      const existing = edgeGroupsById.get(id);

      if (existing) {
        existing.edgeKeys.push(key);
        existing.lineNames.add(line.name);
        existing.stationNames.add(pair.startName);
        existing.stationNames.add(pair.endName);
        existing.searchText = [
          existing.label,
          [...existing.lineNames].sort((a, b) => a.localeCompare(b)).join(' '),
          [...existing.stationNames].sort((a, b) => a.localeCompare(b)).join(' '),
        ].join(' ');
      } else {
        edgeGroupsById.set(id, {
          id,
          label: edgeGroupLabel(startLabel, endLabel),
          searchText: `${edgeGroupLabel(startLabel, endLabel)} ${line.name} ${pair.startName} ${pair.endName}`,
          lineNames: new Set([line.name]),
          stationNames: new Set([pair.startName, pair.endName]),
          edgeKeys: [key],
        });
      }
    }
  }

  edgeGroups.value = [...edgeGroupsById.values()]
    .map((group) => ({
      ...group,
      edgeKeys: [...group.edgeKeys].sort((a, b) => a.localeCompare(b)),
      lineNames: [...group.lineNames].sort((a, b) => a.localeCompare(b)),
      stationNames: [...group.stationNames].sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  renderMap();

  window.addEventListener('pointerdown', onWindowPointerDown, { capture: true });

  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      if (pendingResizeFrame) {
        return;
      }
      pendingResizeFrame = window.requestAnimationFrame(() => {
        pendingResizeFrame = 0;
        renderMap();
      });
    });
    if (container.value) {
      resizeObserver.observe(container.value);
    }
  }
});

onBeforeUnmount(() => {
  if (container.value) {
    d3.select(container.value).selectAll('*').remove();
  }
  window.removeEventListener('pointerdown', onWindowPointerDown, { capture: true });

  if (pendingResizeFrame) {
    window.cancelAnimationFrame(pendingResizeFrame);
    pendingResizeFrame = 0;
  }
  if (resizeObserver) {
    try {
      resizeObserver.disconnect();
    } catch {
      // ignore
    }
    resizeObserver = null;
  }
});
</script>

<style scoped>
.tube-map-layout {
  display: grid;
  grid-template-columns: 280px 1fr;
  gap: 1rem;
  width: 100%;
  height: 100%;
  min-height: 0;
}

.controls {
  border: 1px solid rgba(0, 0, 0, 0.08);
  background:
    radial-gradient(1200px 500px at -20% -30%, rgba(31, 90, 255, 0.12), transparent 60%),
    radial-gradient(900px 500px at 120% 10%, rgba(255, 61, 0, 0.10), transparent 55%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.75), rgba(248, 248, 248, 0.7));
  padding: 0.85rem;
  overflow: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 0.75rem;
  height: 100%;
  min-height: 0;
  border-radius: 14px;
  box-shadow:
    0 10px 30px rgba(0, 0, 0, 0.08),
    0 1px 0 rgba(255, 255, 255, 0.8) inset;
}

h2 {
  font-size: 0.95rem;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: rgba(0, 0, 0, 0.72);
  margin: 0;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
}

.section-title-actions {
  display: inline-flex;
  align-items: baseline;
  gap: 0.5rem;
}

.section-title-btn {
  border: 1px solid rgba(0, 0, 0, 0.14);
  background: rgba(255, 255, 255, 0.9);
  border-radius: 999px;
  padding: 0.2rem 0.5rem;
  font-size: 0.78rem;
  letter-spacing: 0;
  text-transform: none;
  cursor: pointer;
  transition:
    transform 120ms ease,
    box-shadow 120ms ease,
    border-color 120ms ease;
}

.section-title-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 10px 22px rgba(0, 0, 0, 0.10);
}

.section-title-btn:active {
  transform: translateY(0);
}

.section-title-btn.is-off {
  opacity: 0.65;
}

.section-meta {
  font-size: 0.78rem;
  text-transform: none;
  letter-spacing: 0;
  color: rgba(0, 0, 0, 0.55);
  font-variant-numeric: tabular-nums;
}

.control-section {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  overflow: hidden;
  min-height: 0;
  padding: 0.6rem;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.7);
  border: 1px solid rgba(0, 0, 0, 0.06);
}

.control-actions {
  min-height: auto;
}

.action-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
}

.action-btn {
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.14);
  background: rgba(255, 255, 255, 0.9);
  padding: 0.5rem 0.65rem;
  font-size: 0.875rem;
  cursor: pointer;
  transition:
    transform 120ms ease,
    box-shadow 120ms ease,
    border-color 120ms ease;
}

.action-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 10px 22px rgba(0, 0, 0, 0.10);
}

.action-btn:active {
  transform: translateY(0);
}

.action-error {
  font-size: 0.85rem;
  color: rgba(180, 35, 24, 0.85);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.search-input {
  width: 100%;
  border: 1px solid rgba(0, 0, 0, 0.14);
  border-radius: 12px;
  padding: 0.5rem 0.65rem;
  font-size: 0.875rem;
  background: rgba(255, 255, 255, 0.9);
  outline: none;
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.8) inset;
}

.search-input:focus {
  border-color: rgba(31, 90, 255, 0.45);
  box-shadow:
    0 0 0 4px rgba(31, 90, 255, 0.12),
    0 1px 0 rgba(255, 255, 255, 0.85) inset;
}

.combo {
  position: relative;
}

.combo-dropdown {
  position: absolute;
  top: calc(100% + 0.35rem);
  left: 0;
  right: 0;
  z-index: 5;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.98);
  border: 1px solid rgba(0, 0, 0, 0.1);
  box-shadow:
    0 18px 50px rgba(0, 0, 0, 0.14),
    0 1px 0 rgba(255, 255, 255, 0.8) inset;
  padding: 0.35rem;
  max-height: 260px;
  overflow: auto;
}

.combo-option {
  width: 100%;
  text-align: left;
  border: 1px solid transparent;
  background: transparent;
  border-radius: 12px;
  padding: 0.5rem 0.6rem;
  font-size: 0.875rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  cursor: pointer;
  color: rgba(0, 0, 0, 0.82);
}

.combo-option.is-highlighted {
  background: rgba(31, 90, 255, 0.10);
  border-color: rgba(31, 90, 255, 0.25);
}

.combo-option.is-off {
  color: rgba(0, 0, 0, 0.55);
}

.combo-option.is-mixed {
  background: rgba(0, 0, 0, 0.04);
}

.combo-option-meta {
  font-variant-numeric: tabular-nums;
  color: rgba(0, 0, 0, 0.55);
  white-space: nowrap;
}

.pill-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
  overflow: auto;
  flex: 1;
  min-height: 0;
  padding: 0.25rem;
  align-content: flex-start;
}

.edges-list {
  flex: 1;
}

.pill {
  border-radius: 999px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  background: rgba(255, 255, 255, 0.8);
  padding: 0.38rem 0.55rem;
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  cursor: pointer;
  user-select: none;
  transition:
    transform 120ms ease,
    background-color 120ms ease,
    border-color 120ms ease,
    box-shadow 120ms ease,
    color 120ms ease,
    opacity 120ms ease;
  color: rgba(0, 0, 0, 0.86);
}

.pill:hover {
  transform: translateY(-1px);
  box-shadow: 0 8px 18px rgba(0, 0, 0, 0.08);
}

.pill:active {
  transform: translateY(0);
}

.pill.is-off {
  opacity: 0.55;
  background: rgba(255, 255, 255, 0.55);
}

.pill.is-mixed {
  border-style: dashed;
  background: rgba(0, 0, 0, 0.035);
}

.pill-dot {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  box-shadow:
    0 0 0 2px rgba(255, 255, 255, 0.9) inset,
    0 1px 2px rgba(0, 0, 0, 0.15);
  flex: 0 0 auto;
}

.pill-label {
  white-space: nowrap;
}

.pill-meta {
  font-variant-numeric: tabular-nums;
  color: rgba(0, 0, 0, 0.55);
  white-space: nowrap;
}

.map-root {
  width: 100%;
  height: 100%;
  min-height: 0;
  border-radius: 14px;
  border: 1px solid rgba(0, 0, 0, 0.08);
  background:
    radial-gradient(800px 500px at 20% 0%, rgba(0, 0, 0, 0.03), transparent 55%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(255, 255, 255, 0.86));
  box-shadow:
    0 12px 40px rgba(0, 0, 0, 0.10),
    0 1px 0 rgba(255, 255, 255, 0.8) inset;
  overflow: hidden;
  touch-action: none;
}

.map-shell {
  position: relative;
  min-height: 0;
}

.map-root :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
  touch-action: none;
}

.map-error {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 1rem;
  background: rgba(255, 255, 255, 0.88);
  backdrop-filter: blur(8px);
}

.map-error-title {
  font-weight: 700;
  letter-spacing: 0.01em;
  margin-bottom: 0.35rem;
}

.map-error-body {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono',
    'Courier New', monospace;
  font-size: 0.85rem;
  color: rgba(0, 0, 0, 0.75);
  max-width: 52ch;
  text-align: center;
}

.map-root.is-hide-labels :deep(.labels) {
  opacity: 0;
  pointer-events: none;
}


@media (max-width: 980px) {
  .tube-map-layout {
    grid-template-columns: 1fr;
    grid-template-rows: clamp(220px, 42vh, 420px) 1fr;
  }

  .controls {
    padding: 0.75rem;
  }
}

@supports (height: 1svh) {
  @media (max-width: 980px) {
    .tube-map-layout {
      grid-template-rows: clamp(220px, 42svh, 420px) 1fr;
    }
  }
}

@media (max-width: 520px) {
  /* iOS Safari zooms focused inputs under 16px; keep the search input at 16px on phones. */
  .search-input {
    font-size: 16px;
  }
}
</style>
