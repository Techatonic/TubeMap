<template>
  <section class="tube-map-layout">
    <aside class="controls">
      <section class="control-section">
        <h2>Lines</h2>
        <input
          v-model.trim="lineSearch"
          type="search"
          class="search-input"
          placeholder="Search lines"
        />
        <div class="pill-list">
          <button
            v-for="line in visibleLineNames"
            :key="line"
            type="button"
            class="pill"
            :class="{ 'is-off': deselectedLines.has(line) }"
            @click="toggleLine(line)"
          >
            <span
              class="pill-dot"
              :style="{ background: lineColorByName.get(line) || '#9aa0a6' }"
              aria-hidden="true"
            />
            <span class="pill-label">{{ line }}</span>
          </button>
        </div>
      </section>

      <section class="control-section">
        <h2>
          Stations
          <span v-if="dimmedOverlayCount" class="section-meta">
            {{ dimmedOverlayCount }} grey segments
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
              @mousedown.prevent="selectStationOption(opt)"
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
      <div ref="container" class="map-root" />
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

const container = ref(null);
const stationComboRef = ref(null);
const baseData = ref(null);
const renderError = ref('');
const lastRenderedMap = ref(null);
const dimmedOverlayCount = ref(0);
const lineNames = ref([]);
const lineNameToStations = ref(new Map());
const stationGroups = ref([]);
const stationNameToGroupNames = ref(new Map());
const deselectedLines = ref(new Set());
const deselectedStations = ref(new Set());
const lineSearch = ref('');
const stationSearch = ref('');
const stationDropdownOpen = ref(false);
const stationDropdownHighlight = ref(0);
const lineColorByName = ref(new Map());

const visibleLineNames = computed(() => {
  const needle = lineSearch.value.toLowerCase();
  if (!needle) {
    return lineNames.value;
  }
  return lineNames.value.filter((line) => line.toLowerCase().includes(needle));
});

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

function parseLineName(name) {
  const divider = name.lastIndexOf('__chunk_');
  return divider >= 0 ? name.slice(0, divider) : name;
}

function parseSourceLineName(name) {
  const chunkless = parseLineName(String(name ?? ''));
  const divider = chunkless.lastIndexOf('__src_');
  return divider >= 0 ? chunkless.slice(0, divider) : chunkless;
}

function markerLineNames(markers) {
  if (!Array.isArray(markers)) {
    return [];
  }
  return markers
    .map((m) => parseSourceLineName(m?.line))
    .filter(Boolean);
}

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

function applyWholeLineDeselectionStyles() {
  const rendered = lastRenderedMap.value;
  if (!container.value || !rendered) {
    return;
  }

  const root = d3.select(container.value);
  const svg = root.select('svg');
  if (svg.empty()) {
    return;
  }

  const isLineDeselected = (lineId) =>
    deselectedLines.value.has(parseSourceLineName(lineId));

  svg
    .selectAll('.lines .line')
    .classed('is-line-deselected', (d) => {
      if (!d || !d.name) {
        return false;
      }
      const lineName = parseSourceLineName(d.name);
      return deselectedLines.value.has(lineName);
    });

  // Station tick marks are drawn per-line and have `d.line` set to the source line name.
  svg
    .selectAll('.stations .station')
    .classed('is-line-deselected', (d) => !!d && isLineDeselected(d.line));

  const hasAnyDeselectedMarker = (station) => {
    const lines = markerLineNames(station?.marker);
    return lines.some((line) => deselectedLines.value.has(line));
  };

  const hasAllMarkersDeselected = (station) => {
    const lines = markerLineNames(station?.marker);
    return lines.length > 0 && lines.every((line) => deselectedLines.value.has(line));
  };

  // Labels: data is the station object which contains `marker` entries per visible line at that station.
  svg
    .selectAll('.labels .label')
    .classed('is-line-muted', (d) => !!d && hasAnyDeselectedMarker(d))
    .classed('is-line-deselected', (d) => !!d && hasAllMarkersDeselected(d));

  // Interchange symbols: a single symbol can represent multiple lines, so we mute it if any of its lines are off.
  svg
    .selectAll('.interchanges .interchange')
    .classed('is-line-muted', (d) => !!d && hasAnyDeselectedMarker(d))
    .classed('is-line-deselected', (d) => !!d && hasAllMarkersDeselected(d));
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

  const dimmedPaths = [];
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
        dimmedPaths.push({ key: seg.key, d });
      }
    } catch (err) {
      // Don't let a single bad segment kill the whole overlay.
      console.warn('Failed to draw dim overlay segment', seg.key, err);
    }
  }
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
  applyWholeLineDeselectionStyles();
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
  };
}

function renderMap() {
  if (!container.value || !baseData.value) {
    return;
  }

  renderError.value = '';
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
  svg.call(zoomHandler.scaleTo, 1);
  svg.call(zoomHandler.translateTo, 830, 450);

  root.selectAll('.lines .line').on('click', (event, lineData) => {
    event.stopPropagation();
    toggleLine(parseSourceLineName(lineData?.name || ''));
  });

  applyDeselectionStyles();
}

function toggleLine(lineName) {
  const stations = lineNameToStations.value.get(lineName);
  if (!stations || stations.size === 0) {
    return;
  }

  const nextStations = new Set(deselectedStations.value);
  const allOff = [...stations].every((name) => nextStations.has(name));

  if (allOff) {
    for (const name of stations) {
      nextStations.delete(name);
    }
  } else {
    for (const name of stations) {
      nextStations.add(name);
    }
  }

  deselectedStations.value = nextStations;
  syncDeselectedLinesFromStations();
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
  syncDeselectedLinesFromStations();
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
  syncDeselectedLinesFromStations();
  applyDeselectionStyles();
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

function syncDeselectedLinesFromStations() {
  const next = new Set();
  for (const [lineName, stations] of lineNameToStations.value.entries()) {
    if (!stations || stations.size === 0) {
      continue;
    }
    const allOff = [...stations].every((name) => deselectedStations.value.has(name));
    if (allOff) {
      next.add(lineName);
    }
  }
  deselectedLines.value = next;
}

onMounted(async () => {
  const mapDataUrl = `${import.meta.env.BASE_URL}london-tube.json`;
  const data = await d3.json(mapDataUrl);
  if (!data) {
    console.error(`Failed to load map data from ${mapDataUrl}`);
    return;
  }
  baseData.value = data;

  const nextLineNames = new Set();
  const nextLineColors = new Map();
  const nextLineStations = new Map();
  for (const line of data.lines) {
    if (!line || !line.name) {
      continue;
    }
    nextLineNames.add(line.name);
    if (!nextLineColors.has(line.name) && line.color) {
      nextLineColors.set(line.name, line.color);
    }
    const current = nextLineStations.get(line.name) || new Set();
    for (const node of line.nodes || []) {
      if (node && node.name) {
        current.add(node.name);
      }
    }
    nextLineStations.set(line.name, current);
  }
  lineNames.value = [...nextLineNames];
  lineColorByName.value = nextLineColors;
  lineNameToStations.value = nextLineStations;
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

  syncDeselectedLinesFromStations();
  renderMap();

  window.addEventListener('pointerdown', onWindowPointerDown, { capture: true });
});

onBeforeUnmount(() => {
  if (container.value) {
    d3.select(container.value).selectAll('*').remove();
  }
  window.removeEventListener('pointerdown', onWindowPointerDown, { capture: true });
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
  overflow: hidden;
  display: grid;
  grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
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
}

.map-shell {
  position: relative;
  min-height: 0;
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

.map-root :deep(.labels .label.is-line-muted text) {
  opacity: 0.28;
  fill: #5f6368 !important;
}

.map-root :deep(.labels .label.is-line-deselected text) {
  opacity: 0.18;
  fill: #5f6368 !important;
}

.map-root :deep(.interchanges .interchange.is-line-muted) {
  opacity: 0.22;
  filter: grayscale(1);
  fill: #9aa0a6 !important;
  stroke: #9aa0a6 !important;
}

.map-root :deep(.interchanges .interchange.is-line-deselected) {
  opacity: 0.14;
  filter: grayscale(1);
  fill: #9aa0a6 !important;
  stroke: #9aa0a6 !important;
}

.map-root :deep(.lines .line.is-line-deselected) {
  stroke: #9aa0a6 !important;
  opacity: 0.14;
}

.map-root :deep(.stations .station.is-line-deselected) {
  stroke: #9aa0a6 !important;
  opacity: 0.10;
}


@media (max-width: 980px) {
  .tube-map-layout {
    grid-template-columns: 1fr;
    grid-template-rows: 320px 1fr;
  }
}
</style>
