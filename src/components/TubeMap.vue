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
        <div class="control-list">
          <label
            v-for="line in visibleLineNames"
            :key="line"
            class="control-item"
          >
            <input
              type="checkbox"
              :checked="!deselectedLines.has(line)"
              @change="toggleLine(line)"
            />
            <span>{{ line }}</span>
          </label>
        </div>
      </section>

      <section class="control-section">
        <h2>Stations</h2>
        <input
          v-model.trim="stationSearch"
          type="search"
          class="search-input"
          placeholder="Search stations"
        />
        <div class="control-list stations-list">
          <label
            v-for="station in visibleStationGroups"
            :key="station.label"
            class="control-item"
          >
            <input
              type="checkbox"
              :checked="station.allSelected"
              :indeterminate.prop="station.indeterminate"
              @change="toggleStationGroup(station.names)"
            />
            <span>{{ station.label }}</span>
          </label>
        </div>
      </section>
    </aside>

    <div ref="container" class="map-root" />
  </section>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import * as d3 from 'd3';
import { tubeMap } from 'd3-tube-map';

const container = ref(null);
const baseData = ref(null);
const lineNames = ref([]);
const stationGroups = ref([]);
const stationNameToGroupNames = ref(new Map());
const deselectedLines = ref(new Set());
const deselectedStations = ref(new Set());
const lineSearch = ref('');
const stationSearch = ref('');

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

function parseLineName(name) {
  const divider = name.lastIndexOf('__chunk_');
  return divider >= 0 ? name.slice(0, divider) : name;
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
  const hasStationFiltering = deselectedStations.value.size > 0;

  for (let lineIdx = 0; lineIdx < data.lines.length; lineIdx += 1) {
    const line = data.lines[lineIdx];
    // Some inputs contain multiple line objects with the same `name` (e.g. branches of the Northern line).
    // Ensure each rendered line id is unique, even when we aren't chunking for station filtering.
    const sourceKey = `${line.name}__src_${lineIdx}`;

    if (deselectedLines.value.has(line.name)) {
      continue;
    }

    const lineHasDeselectedStation =
      hasStationFiltering &&
      line.nodes.some(
        (node) => node.name && deselectedStations.value.has(node.name),
      );

    if (!lineHasDeselectedStation) {
      filteredLines.push(
        normalizedLine(
          line,
          `${sourceKey}__chunk_1`,
          line.nodes.map((node) => cloneNode(node)),
        ),
      );
      continue;
    }

    const pairs = stationPairs(line.nodes);
    let currentChunkNodes = null;
    let chunkCount = 0;

    const flushChunk = () => {
      if (!currentChunkNodes || currentChunkNodes.length < 2) {
        currentChunkNodes = null;
        return;
      }

      chunkCount += 1;
      filteredLines.push(
        normalizedLine(line, `${sourceKey}__chunk_${chunkCount}`, currentChunkNodes),
      );
      currentChunkNodes = null;
    };

    for (const pair of pairs) {
      const removePair =
        deselectedStations.value.has(pair.startName) ||
        deselectedStations.value.has(pair.endName);

      if (removePair) {
        flushChunk();
        continue;
      }

      if (!currentChunkNodes) {
        currentChunkNodes = line.nodes
          .slice(pair.startIdx, pair.endIdx + 1)
          .map((node) => cloneNode(node));
      } else {
        const continuation = line.nodes
          .slice(pair.startIdx + 1, pair.endIdx + 1)
          .map((node) => cloneNode(node));
        currentChunkNodes.push(...continuation);
      }
    }

    flushChunk();
  }

  for (const line of filteredLines) {
    for (const node of line.nodes) {
      if (node.name) {
        activeStations.add(node.name);
      }
    }
  }

  const filteredStations = {};

  for (const stationName of activeStations) {
    if (data.stations[stationName]) {
      filteredStations[stationName] = { ...data.stations[stationName] };
    }
  }

  return {
    ...data,
    stations: filteredStations,
    lines: filteredLines,
  };
}

function renderMap() {
  if (!container.value || !baseData.value) {
    return;
  }

  d3.select(container.value).selectAll('*').remove();

  const filteredData = buildFilteredData(baseData.value);
  if (!filteredData.lines.length) {
    return;
  }

  const width = container.value.clientWidth || 1200;
  const height = container.value.clientHeight || 800;

  const map = tubeMap()
    .width(width)
    .height(height)
    .margin({
      top: 20,
      right: 20,
      bottom: 40,
      left: 100,
    })
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

  const root = d3.select(container.value);
  root.datum(filteredData).call(map);

  const svg = root.select('svg');
  const zoomHandler = d3.zoom().scaleExtent([0.1, 6]).on('zoom', (event) => {
    svg.select('g').attr('transform', event.transform.toString());
  });

  svg.call(zoomHandler);
  svg.call(zoomHandler.scaleTo, 1);
  // svg.call(zoomHandler.translateTo, -800, -200);

  root.selectAll('.lines .line').on('click', (event, lineData) => {
    event.stopPropagation();
    toggleLine(parseLineName(lineData.sourceLineName || lineData.name));
  });
}

function toggleLine(lineName) {
  const next = new Set(deselectedLines.value);

  if (next.has(lineName)) {
    next.delete(lineName);
  } else {
    next.add(lineName);
  }

  deselectedLines.value = next;
  renderMap();
}

function toggleStation(stationName) {
  const next = new Set(deselectedStations.value);

  if (next.has(stationName)) {
    next.delete(stationName);
  } else {
    next.add(stationName);
  }

  deselectedStations.value = next;
  renderMap();
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
  renderMap();
}

onMounted(async () => {
  const mapDataUrl = `${import.meta.env.BASE_URL}london-tube.json`;
  const data = await d3.json(mapDataUrl);
  if (!data) {
    console.error(`Failed to load map data from ${mapDataUrl}`);
    return;
  }
  baseData.value = data;

  lineNames.value = [...new Set(data.lines.map((line) => line.name))];
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
});

onBeforeUnmount(() => {
  if (container.value) {
    d3.select(container.value).selectAll('*').remove();
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
  border: 1px solid #ddd;
  background: #f8f8f8;
  padding: 0.75rem;
  overflow: hidden;
  display: grid;
  grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
  gap: 0.75rem;
  height: 100%;
  min-height: 0;
}

h2 {
  font-size: 1rem;
  margin: 0;
}

.control-section {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  overflow: hidden;
  min-height: 0;
}

.search-input {
  width: 100%;
  border: 1px solid #ccc;
  border-radius: 6px;
  padding: 0.4rem 0.5rem;
  font-size: 0.875rem;
}

.control-list {
  display: flex;
  flex-direction: column;
  flex: 1;
  gap: 0.25rem;
  overflow: auto;
  min-height: 0;
}

.stations-list {
  flex: 1;
}

.control-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
}

.map-root {
  width: 100%;
  height: 100%;
  min-height: 0;
  border: 1px solid #ddd;
  background: #fff;
}

@media (max-width: 980px) {
  .tube-map-layout {
    grid-template-columns: 1fr;
    grid-template-rows: 320px 1fr;
  }
}
</style>
