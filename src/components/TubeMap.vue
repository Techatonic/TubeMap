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
          <span>Stations</span>
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
            <button type="button" class="section-title-btn" @click="clearAllStations">
              Clear all
            </button>
          </span>
        </h2>
        <div ref="stationComboRef" class="combo">
          <input
            v-model.trim="stationSearch"
            type="search"
            class="search-input"
            placeholder="Search stations"
            role="combobox"
            aria-autocomplete="list"
            :aria-expanded="stationDropdownOpen ? 'true' : 'false'"
            aria-haspopup="listbox"
            @focus="openStationDropdown"
            @input="openStationDropdown"
            @keydown.down.prevent="moveStationHighlight(1)"
            @keydown.up.prevent="moveStationHighlight(-1)"
            @keydown.enter.prevent="selectHighlightedStationOption"
            @keydown.esc.prevent="closeStationDropdown"
          />
          <div
            v-if="stationDropdownOpen && stationDropdownOptions.length"
            class="combo-dropdown"
            role="listbox"
          >
            <button
              v-for="(opt, idx) in stationDropdownOptions"
              :key="opt.label"
              type="button"
              class="combo-option"
              :class="{
                'is-highlighted': idx === stationDropdownHighlight,
                'is-off': !opt.allSelected && !opt.indeterminate,
                'is-mixed': opt.indeterminate,
              }"
              @pointerdown.prevent="selectStationOption(opt)"
              @mousemove="stationDropdownHighlight = idx"
            >
              <span class="combo-option-label">{{ opt.label }}</span>
              <span class="combo-option-meta">
                {{ opt.activeCount }}/{{ opt.names.length }}
              </span>
            </button>
          </div>
        </div>

        <div class="pill-list stations-list">
          <button
            v-for="station in visibleStationGroups"
            :key="station.label"
            type="button"
            class="pill pill-station"
            :class="{
              'is-off': !station.allSelected && !station.indeterminate,
              'is-mixed': station.indeterminate,
            }"
            @click="toggleStationGroup(station.names)"
          >
            <span class="pill-label">{{ station.label }}</span>
            <span class="pill-meta">{{ station.activeCount }}/{{ station.names.length }}</span>
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
const stationComboRef = ref(null);
const importConfigInputRef = ref(null);
const baseData = ref(null);
const renderError = ref('');
const exportError = ref('');
const lastRenderedMap = ref(null);
const dimmedOverlayCount = ref(0);
const defaultMapTransform = ref('');
const stationGroups = ref([]);
const stationNameToGroupNames = ref(new Map());
const deselectedStations = ref(new Set());
const stationSearch = ref('');
const stationDropdownOpen = ref(false);
const stationDropdownHighlight = ref(0);
const showStationNames = ref(true);
let resizeObserver = null;
let pendingResizeFrame = 0;

const visibleStationGroups = computed(() => {
  const needle = stationSearch.value.toLowerCase();
  const groupsWithState = stationGroups.value.map((group) => {
    const activeCount = group.names.reduce(
      (count, stationName) =>
        deselectedStations.value.has(stationName) ? count : count + 1,
      0,
    );

    return {
      ...group,
      activeCount,
      allSelected: activeCount === group.names.length,
      indeterminate: activeCount > 0 && activeCount < group.names.length,
    };
  });

  if (!needle) {
    return groupsWithState;
  }

  return groupsWithState.filter(
    (group) =>
      group.label.toLowerCase().includes(needle) ||
      group.names.some((name) => name.toLowerCase().includes(needle)),
  );
});

const stationDropdownOptions = computed(() => visibleStationGroups.value.slice(0, 12));

function normalizeStationLabel(label) {
  return String(label).replace(/\s+/g, ' ').trim();
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
    const sourceKey = `${line.name}__src_${lineIdx}`;

    filteredLines.push(
      normalizedLine(
        line,
        `${sourceKey}__chunk_1`,
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

function applyStationDeselectionStyles() {
  if (!container.value) {
    return;
  }

  const root = d3.select(container.value);
  const svg = root.select('svg');
  if (svg.empty()) {
    return;
  }

  // d3-tube-map binds station objects containing `.name` to both the marker and label groups.
  svg
    .selectAll('.stations .station')
    .classed('is-deselected', (d) => !!d && deselectedStations.value.has(d.name));
  svg
    .selectAll('.labels .label')
    .classed('is-deselected', (d) => !!d && deselectedStations.value.has(d.name));
  svg
    .selectAll('.interchanges .interchange')
    .classed('is-deselected', (d) => !!d && deselectedStations.value.has(d.name));
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
      if (
        deselectedStations.value.has(pair.startName) ||
        deselectedStations.value.has(pair.endName)
      ) {
        dimmedSegments.push({
          key: `${line.name}|${pair.startIdx}-${pair.endIdx}`,
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
  dimmedOverlayCount.value = dimmedPaths.length;

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

function applyDeselectionStyles() {
  applyStationDeselectionStyles();
  applyLineDeselectionStyles();
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

  const width = container.value.clientWidth || 1200;
  const height = container.value.clientHeight || 800;
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
      .margin(margin)
      .on('click', (stationName) => {
        if (!stationName) {
          return;
        }
        const groupNames = stationNameToGroupNames.value.get(stationName);
        if (groupNames && groupNames.length) {
          toggleStationGroup(groupNames);
        } else {
          toggleStation(stationName);
        }
      });

    root.datum(filteredData).call(map);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    renderError.value = message;
    console.error('tube-map render error:', err);
    return;
  }

  lastRenderedMap.value = { data: filteredData, width, height, margin };

  const svg = root.select('svg');
  const zoomHandler = d3.zoom().scaleExtent([0.1, 6]).on('zoom', (event) => {
    svg.select('g').attr('transform', event.transform.toString());
  });

  svg.call(zoomHandler);

  // Center + fit to the rendered map bounds so mobile/desktop start in a sensible viewport.
  try {
    const g = svg.select('g').node();
    if (g && g.getBBox) {
      const bbox = g.getBBox();
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

  positionInterchanges();
  applyDeselectionStyles();
}

function toggleStation(stationName) {
  const next = new Set(deselectedStations.value);

  if (next.has(stationName)) {
    next.delete(stationName);
  } else {
    next.add(stationName);
  }

  deselectedStations.value = next;
  applyDeselectionStyles();
}

function toggleStationGroup(stationNames) {
  const next = new Set(deselectedStations.value);
  const allSelected = stationNames.every((name) => !next.has(name));

  if (allSelected) {
    for (const name of stationNames) {
      next.add(name);
    }
  } else {
    for (const name of stationNames) {
      next.delete(name);
    }
  }

  deselectedStations.value = next;
  applyDeselectionStyles();
}

function clearAllStations() {
  if (!stationGroups.value.length) {
    return;
  }

  const next = new Set();
  for (const group of stationGroups.value) {
    for (const name of group.names) {
      next.add(name);
    }
  }

  deselectedStations.value = next;
  stationSearch.value = '';
  stationDropdownHighlight.value = 0;
  stationDropdownOpen.value = false;
  applyDeselectionStyles();
}

function toggleStationNames() {
  showStationNames.value = !showStationNames.value;
}

function openStationDropdown() {
  stationDropdownOpen.value = true;
  stationDropdownHighlight.value = 0;
}

function closeStationDropdown() {
  stationDropdownOpen.value = false;
}

function moveStationHighlight(delta) {
  if (!stationDropdownOpen.value) {
    openStationDropdown();
  }
  const opts = stationDropdownOptions.value;
  if (!opts.length) {
    stationDropdownHighlight.value = 0;
    return;
  }
  const next =
    (stationDropdownHighlight.value + delta + opts.length) % opts.length;
  stationDropdownHighlight.value = next;
}

function selectStationOption(option) {
  toggleStationGroup(option.names);
  stationSearch.value = '';
  stationDropdownHighlight.value = 0;
  stationDropdownOpen.value = false;
}

function selectHighlightedStationOption() {
  if (!stationSearch.value) {
    return;
  }
  if (!stationDropdownOpen.value) {
    openStationDropdown();
  }
  const opts = stationDropdownOptions.value;
  if (!opts.length) {
    return;
  }
  const idx = Math.min(stationDropdownHighlight.value, opts.length - 1);
  selectStationOption(opts[idx]);
}

function onWindowPointerDown(event) {
  const el = stationComboRef.value;
  if (!el) {
    return;
  }
  if (event.target instanceof Node && !el.contains(event.target)) {
    closeStationDropdown();
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
    version: 1,
    exportedAt: new Date().toISOString(),
    deselectedStations: [...deselectedStations.value].sort((a, b) => a.localeCompare(b)),
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
    const list = Array.isArray(parsed?.deselectedStations) ? parsed.deselectedStations : null;
    if (!list) {
      throw new Error('Invalid config: expected `deselectedStations` array.');
    }

    const next = new Set();
    for (const name of list) {
      if (typeof name === 'string' && name) {
        next.add(name);
      }
    }

    deselectedStations.value = next;
    applyDeselectionStyles();
  } catch (err) {
    exportError.value = err instanceof Error ? err.message : String(err);
    console.error('Import config failed:', err);
  }
}

function buildExportSvgCss() {
  // Inline a small amount of CSS so exported SVG -> PNG matches the on-screen state.
  return `
    .stations .station.is-deselected { opacity: 0.28; filter: grayscale(1); }
    .labels .label.is-deselected text { opacity: 0.32; fill: #2b2b2b; }
    .interchanges .interchange.is-deselected { opacity: 0.22; filter: grayscale(1); }
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

  // Clone and force default zoom transform (don’t disturb the live view).
  const clone = svgEl.cloneNode(true);
  if (!(clone instanceof SVGSVGElement)) {
    exportError.value = 'Failed to clone SVG.';
    return;
  }

  const rendered = lastRenderedMap.value;
  const width = rendered?.width || Math.round(svgEl.getBoundingClientRect().width) || 1200;
  const height = rendered?.height || Math.round(svgEl.getBoundingClientRect().height) || 800;

  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  if (!clone.getAttribute('viewBox')) {
    clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
  }

  const g = clone.querySelector('g');
  if (g && defaultMapTransform.value) {
    g.setAttribute('transform', defaultMapTransform.value);
  }

  // White background so transparent areas don’t render black in some viewers.
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('x', '0');
  bg.setAttribute('y', '0');
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

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Canvas 2D context unavailable.');
    }
    ctx.drawImage(img, 0, 0, width, height);

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
  const groups = new Map();

  for (const [name, station] of Object.entries(data.stations)) {
    const rawLabel = station?.label || name;
    const label = normalizeStationLabel(rawLabel);
    const existing = groups.get(label);

    if (existing) {
      existing.names.push(name);
    } else {
      groups.set(label, { label, names: [name] });
    }
  }

  stationGroups.value = [...groups.values()]
    .map((group) => ({
      ...group,
      names: [...group.names].sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const nameToGroup = new Map();
  for (const group of stationGroups.value) {
    for (const stationName of group.names) {
      nameToGroup.set(stationName, group.names);
    }
  }
  stationNameToGroupNames.value = nameToGroup;
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

.stations-list {
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

/* SVG styling for dimmed stations (still visible). */
.map-root :deep(.stations .station.is-deselected) {
  opacity: 0.28;
  filter: grayscale(1);
}

.map-root :deep(.labels .label.is-deselected text) {
  opacity: 0.32;
  fill: #2b2b2b;
}

.map-root :deep(.interchanges .interchange.is-deselected) {
  opacity: 0.22;
  filter: grayscale(1);
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
