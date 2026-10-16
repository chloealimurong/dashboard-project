/* global mapboxgl */
mapboxgl.accessToken = 'pk.eyJ1IjoiY2hsb2VhbGltdXJvbmciLCJhIjoiY210dWR0cjcyMDBiNjM0cHFvN2p4b2RpMiJ9.EHtMZkiC7TklHIn836JPoQ';

// Data sources

const ZONING_URL =
  'https://services.arcgis.com/fLeGjb7u4uXqeF9q/arcgis/rest/services/Zoning_BaseDistricts/FeatureServer/0/query';
const OVERLAY_URL =
  'https://services.arcgis.com/fLeGjb7u4uXqeF9q/arcgis/rest/services/Zoning_Overlays/FeatureServer/0/query';
const CARTO_SQL = 'https://phl.carto.com/api/v2/sql';

// distanceM: 0 = point-in-polygon (district tables); >0 = search radius in meters (point tables)
// columns: what to SELECT; describe: turns a row into the text shown in the popup
const HISTORIC_TABLES = [
  {
    table: 'historicdistricts_local',
    columns: 'name',
    distanceM: 0,
    describe: (r) => `Historic district${r.name ? `: ${r.name}` : ''}`,
  },
  {
    table: 'historic_sites_philreg',
    columns: 'loc, district',
    distanceM: 10,
    describe: (r) =>
      `Historic site${r.loc ? `: ${r.loc}` : ''}${r.district ? ` (${r.district} district)` : ''}`,
  },
];

const MIN_ZONING_ZOOM = 15; // don't request zoning when zoomed out further than this

// field names confirmed against the live services
const BASE_FIELDS = ['long_code', 'code']; // e.g. 'RSA-5', falling back to 'RSA5'
const OVERLAY_FIELDS = ['overlay_symbol']; // e.g. '/NE'; supplemental controls are '[N/A]'

// ADU rules from the L&I checklist flowchart
const BLOCK_OVERLAYS_ALWAYS = ['FNE', 'NE']; // not permitted, even for historic structures
const BLOCK_OVERLAYS_OTHER = ['FDO', 'VDO', 'NDO', 'EDO']; // not permitted unless historic
const ALLOWED_BASE = ['RSA-5', 'CMX-1'];

// Map

const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/chloealimurong/cmuyof1fv00l301rwe8m15eoy',
  zoom: 10.5,
  center: [-75.165222, 39.952583],
});
map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'bottom-right');

const EMPTY = { type: 'FeatureCollection', features: [] };

// colors by zoninggroup; anything not listed falls back to gray
const GROUP_COLORS = {
  'Residential/Multi-Family/Residential Mixed-Use': '#a6611a',
  'Commercial/Commercial Mixed-Use': '#dfc27d',
  'Industrial/Industrial Mixed-Use': '#80cdc1',
  'Special Purpose': '#018571',
};
const FALLBACK_COLOR = '#b0b0b0';

const zoningColorExpr = [
  'match', ['get', 'zoninggroup'],
  ...Object.entries(GROUP_COLORS).flat(),
  FALLBACK_COLOR,
];

// Geocoding

async function geocode(query) {
  const url = new URL('https://api.mapbox.com/search/geocode/v6/forward');
  url.search = new URLSearchParams({
    q: query,
    proximity: '-75.165222,39.952583',
    bbox: '-75.28,39.86,-74.95,40.14',
    types: 'address',
    limit: 1,
    access_token: mapboxgl.accessToken,
  });
  const res = await fetch(url);
  if (!res.ok) throw new Error('Geocoding failed: ' + res.status);
  const data = await res.json();
  return data.features[0] || null;
}

// Spatial queries

// ArcGIS FeatureServer (base districts + overlays)
async function queryService(baseUrl, extraParams) {
  const params = new URLSearchParams({
    f: 'geojson',
    where: '1=1',
    inSR: 4326,
    outSR: 4326,
    spatialRel: 'esriSpatialRelIntersects',
    outFields: '*',
    ...extraParams,
  });
  const res = await fetch(`${baseUrl}?${params}`);
  if (!res.ok) throw new Error(`Query failed: ${res.status}`);
  const data = await res.json();
  if (data.type !== 'FeatureCollection') {
    throw new Error('Service did not return GeoJSON: ' + JSON.stringify(data).slice(0, 200));
  }
  return data;
}

const pointParams = (lng, lat) => ({
  geometry: `${lng},${lat}`,
  geometryType: 'esriGeometryPoint',
});

// districts inside the current map view (the colored overlay)
async function loadZoningInView() {
  if (map.getZoom() < MIN_ZONING_ZOOM) return;
  const b = map.getBounds();
  const data = await queryService(ZONING_URL, {
    geometry: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(','),
    geometryType: 'esriGeometryEnvelope',
    resultRecordCount: 2000,
  });
  map.getSource('zoning').setData(data);
}

// 1. base district containing the point
async function zoningAtPoint(lng, lat) {
  const data = await queryService(ZONING_URL, { ...pointParams(lng, lat), resultRecordCount: 1 });
  return data.features[0] || null;
}

// 2. overlay codes at the point, e.g. ['NE']; null if the lookup failed
async function overlaysAtPoint(lng, lat) {
  try {
    const data = await queryService(OVERLAY_URL, pointParams(lng, lat));
    const codes = data.features
      .map((f) => firstField(f.properties, OVERLAY_FIELDS))
      .filter((s) => s && s.startsWith('/')) // skips '[N/A]' supplemental controls
      .map(normalizeOverlay);
    return [...new Set(codes)]; // /CTR etc. come back as many sub-areas
  } catch (err) {
    console.error('Overlay lookup failed', err);
    return null;
  }
}

// 3. historic register hits near the point (CARTO SQL); [] if none, null if a lookup failed
async function historicAtPoint(lng, lat) {
  try {
    const results = await Promise.all(
      HISTORIC_TABLES.map(async (t) => {
        const sql = `SELECT ${t.columns} FROM ${t.table}
          WHERE ST_DWithin(the_geom::geography,
                           ST_SetSRID(ST_MakePoint(${Number(lng)}, ${Number(lat)}), 4326)::geography,
                           ${t.distanceM ?? 0})
          LIMIT 5`;
        const res = await fetch(`${CARTO_SQL}?q=${encodeURIComponent(sql)}`);
        if (!res.ok) throw new Error(`CARTO query failed (${t.table}): ${res.status}`);
        const data = await res.json();
        return data.rows.map(t.describe);
      }),
    );
    return [...new Set(results.flat())];
  } catch (err) {
    console.error('Historic lookup failed', err);
    return null;
  }
}

// ADU logic (walks the L&I flowchart)

const firstField = (props, names) => {
  for (const n of names) if (props?.[n]) return String(props[n]);
  return null;
};
const normalizeOverlay = (s) => s.trim().replace(/^\//, '').toUpperCase();

// Follows the flowchart top to bottom and stops at the first terminal answer.
// answer: 'yes' | 'no' | '' (unanswered). Returns { nodes, end }.
function walk(state) {
  const { base, overlays, historicHits } = state;
  const hit = (list) => overlays?.filter((o) => list.includes(o)) ?? [];
  const slashed = (list) => hit(list).map((o) => '/' + o).join(', ');
  const yn = (b) => (b ? 'yes' : 'no');
  const overlayAnswer = (list) => (overlays === null ? '' : yn(hit(list).length));

  const nodes = [
    {
      id: 'fne',
      question: 'Is the property in the /FNE or /NE overlay?',
      answer: overlayAnswer(BLOCK_OVERLAYS_ALWAYS),
      detail: overlays === null ? 'overlay lookup failed' : slashed(BLOCK_OVERLAYS_ALWAYS),
      stopOn: 'yes',
      stopText: `In the ${slashed(BLOCK_OVERLAYS_ALWAYS)} overlay. No exception, even for historic structures.`,
      blocking: true,
      pendingText: 'Overlay districts could not be loaded, so this cannot be checked automatically.',
    },
    {
      id: 'historic',
      question: 'Is the ADU within a historic structure (14-604(11)(d)(.1))?',
      answer: state.historic,
      manual: true,
      // what the register data suggests; used to flag answers that were changed by hand
      suggested: historicHits?.length ? 'yes' : '',
      detail:
        historicHits === null
          ? 'Register lookup unavailable'
          : historicHits.length
            ? 'Register: ' + historicHits.join('; ')
            : 'No register match found',
      stopOn: 'yes',
      stopStatus: 'yes',
      stopText: 'Historic structure, so the remaining overlay and zoning checks are skipped.',
    },
    {
      id: 'other-overlay',
      question: 'Is the property in the /FDO, /VDO, /NDO or /EDO overlay?',
      answer: overlayAnswer(BLOCK_OVERLAYS_OTHER),
      detail: slashed(BLOCK_OVERLAYS_OTHER),
      stopOn: 'yes',
      stopText: `In the ${slashed(BLOCK_OVERLAYS_OTHER)} overlay.`,
    },
    {
      id: 'base',
      question: 'Is the property in an RSA-5 or CMX-1 zoning district?',
      answer: yn(ALLOWED_BASE.includes(base)),
      detail: base ?? 'unknown',
      stopOn: 'no',
      stopText: `Base district ${base ?? 'unknown'} is not RSA-5 or CMX-1.`,
    },
    {
      id: 'structure',
      question: 'Is the principal structure semi-detached or detached?',
      answer: state.structure,
      manual: true,
      stopOn: 'no',
      stopText: 'Principal structure must be detached or semi-detached.',
      blocking: true,
      pendingText: 'Answer the highlighted question to finish the check.',
    },
    {
      id: 'lot',
      question: 'Is the lot at least 1,600 sq ft AND is no more than one dwelling unit otherwise permitted?',
      answer: state.lot,
      manual: true,
      stopOn: 'no',
      stopText: 'Lot must be at least 1,600 sq ft and allow no more than one dwelling unit.',
      blocking: true,
      pendingText: 'Answer the highlighted question to finish the check.',
    },
  ];

  let end = null;
  for (const n of nodes) {
    n.reached = !end;
    if (end) continue;
    if (n.answer === n.stopOn) {
      end = { status: n.stopStatus ?? 'no', text: n.stopText, at: n.id };
    } else if (n.answer === '' && n.blocking) {
      end = { status: 'unknown', text: n.pendingText, at: n.id };
    }
  }
  if (!end) {
    end = { status: 'yes', text: 'Passed every check in the flowchart.', at: 'end' };
  } else if (end.status === 'no' && end.at !== 'fne' && state.historic === '') {
    end.text += ' Unless the ADU is within a historic structure (answer above).';
  }
  // true once the flowchart says 'permitted' AND every additional requirement is checked
  end.confirmed = end.status === 'yes' && state.step3?.every(Boolean) === true;
  return { nodes, end };
}

// Popup report

const COLORS = { yes: '#2b8a3e', no: '#c92a2a', unknown: '#868e96' };

// 'permitted, pending additional requirements': yellow background, dark text for contrast
const PENDING = { bg: '#ffd43b', text: '#212529', accent: '#b08800' };

// headline shown in the banner at the top of the popup
const HEADLINE = {
  yes: 'ADU permitted, pending additional requirements',
  no: 'ADU not permitted',
  unknown: 'Check incomplete',
};
const HEADLINE_CONFIRMED = 'ADU permitted';

// marker shown in the flow where the path stops (no verdict text, the banner has that)
const END_MARK = {
  yes: 'End of flowchart: confirm the Additional Code Requirements below',
  no: 'End of flowchart',
  unknown: 'Answer this step to continue',
};

let popup = null;
let marker = null;

function el(tag, text, props = {}) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  Object.assign(e, props);
  return e;
}

function yesNoButtons(node, state, rerender) {
  const wrap = el('div');
  wrap.style.cssText = 'display:flex;gap:6px;margin-top:4px;align-items:center;flex-wrap:wrap';
  for (const v of ['yes', 'no']) {
    const on = state[node.id] === v;
    const b = el('button', v === 'yes' ? 'Yes' : 'No', { type: 'button' });
    b.style.cssText =
      `padding:2px 14px;border-radius:.92em;cursor:pointer;font-size:.92em;` +
      `border:1px solid ${COLORS[v]};background:${on ? COLORS[v] : '#fff'};color:${on ? '#fff' : COLORS[v]}`;
    b.addEventListener('click', () => { state[node.id] = on ? '' : v; rerender(); }); // click again to clear
    wrap.append(b);
  }
  return wrap;
}

// small tag shown when the answer differs from what the data suggested
function manualTag() {
  const tag = el('span', 'manually set', {
    title: 'This answer differs from what the register data suggests',
  });
  tag.style.cssText =
    'font-size:.75em;font-weight:600;padding:1px 7px;border-radius:.75em;' +
    'background:#fff4e6;color:#d9480f;border:1px solid #ffa94d';
  return tag;
}

function answerChip(node) {
  const label = node.answer === 'yes' ? 'Yes' : node.answer === 'no' ? 'No' : 'Unavailable';
  const blocked = node.answer === node.stopOn && (node.stopStatus ?? 'no') === 'no';
  const bg = blocked ? COLORS.no : node.answer ? '#495057' : COLORS.unknown;

  const chip = el('span', node.detail ? `${label} — ${node.detail}` : label);
  chip.style.cssText =
    `display:inline-block;margin-top:4px;padding:2px .75em;border-radius:.92em;` +
    `font-size:.92em;color:#fff;background:${bg}`;
  return chip;
}

// draws the flowchart into `box`; returns { nodes, end }
function renderFlow(box, state, rerender) {
  const flow = walk(state);
  box.replaceChildren();

  flow.nodes.forEach((n, i) => {
    const row = el('div');
    const active = n.reached && flow.end.at === n.id && flow.end.status === 'unknown';
    row.style.cssText =
      `border-left:3px solid ${n.reached ? '#1971c2' : '#ced4da'};margin-left:6px;padding:4px 0 .75em .75em;` +
      `opacity:${n.reached ? 1 : 0.4};${active ? 'background:#fff9db;' : ''}`;

    const q = el('div', `${i + 1}. ${n.question}`);
    q.style.cssText = 'font-size:1em;font-weight:600';
    row.append(q);

    if (!n.reached) {
      const skip = el('div', 'not reached');
      skip.style.cssText = 'font-size:.85em;color:#868e96';
      row.append(skip);
    } else if (n.manual) {
      const buttons = yesNoButtons(n, state, rerender);
      // flag answers that disagree with the data (only steps that have a data suggestion)
      if (n.suggested !== undefined && n.answer && n.answer !== n.suggested) {
        buttons.append(manualTag());
      }
      row.append(buttons);
      if (n.detail) {
        const d = el('div', n.detail);
        d.style.cssText = 'font-size:.85em;color:#666;margin-top:3px';
        row.append(d);
      }
    } else {
      row.append(answerChip(n));
    }
    box.append(row);

    // end marker goes right after the step that stopped the walk
    if (flow.end.at === n.id) box.append(endBox(flow.end));
  });
  if (flow.end.at === 'end') box.append(endBox(flow.end));
  return flow;
}

function endBox(end) {
  const pending = end.status === 'yes' && !end.confirmed;
  const color = pending ? PENDING.accent : COLORS[end.status];
  const text =
    end.status === 'yes' && end.confirmed
      ? 'End of flowchart: all additional requirements confirmed'
      : END_MARK[end.status];
  const b = el('div', '→ ' + text);
  b.style.cssText =
    `margin:2px 0 8px 6px;padding:6px .75em;border-radius:.75em;font-size:.92em;font-weight:600;` +
    `border:1.5px dashed ${color};color:${color};background:transparent`;
  return b;
}

// Additional Code Requirements checklist

const STEP3_ITEMS = [
  { group: 'Owner occupied', text: 'The owner lives in the principal unit or the ADU' },
  { group: 'Owner occupied', text: 'Owner will record an affidavit and deed restriction before final occupancy' },
  { group: 'Maximum of one ADU', text: 'No more than one ADU on the lot' },
  {
    group: 'Floor area',
    text: 'The ADU is 800 sq ft or less',
    historicText: 'The ADU may exceed 800 sq ft (historic structure)',
  },
  {
    group: 'Number of entrances',
    text: 'Only one entrance on the street-facing front façade, unless the building already had an additional one before the ADU',
  },
  {
    group: 'Location',
    text: 'The ADU is inside the principal building or an existing detached accessory building (e.g. a detached garage)',
  },
];

// returns { box, update(end) }; checked boxes are remembered in state.step3
// onChange is called after any checkbox changes so the banner and flow can refresh
function buildStep3(state, onChange) {
  state.step3 = state.step3 ?? STEP3_ITEMS.map(() => false);

  const box = el('div');
  box.style.cssText = 'margin-top:.75em;border-top:1px solid #dee2e6;padding-top:8px';

  const title = el('div');
  title.style.cssText = 'font-size:1em;font-weight:600';
  const hint = el('div', 'Available once the flowchart above says an ADU is permitted.');
  hint.style.cssText = 'font-size:.85em;color:#868e96;margin:2px 0 4px';
  const list = el('div');
  box.append(title, hint, list);

  const checkboxes = [];
  const labels = [];
  let lastGroup = null;

  STEP3_ITEMS.forEach((item, i) => {
    if (item.group !== lastGroup) {
      const h = el('div', item.group);
      h.style.cssText = 'font-size:.85em;font-weight:600;color:#495057;margin:6px 0 0;text-transform:uppercase';
      list.append(h);
      lastGroup = item.group;
    }
    const label = el('label');
    label.style.cssText = 'display:flex;gap:6px;align-items:flex-start;font-size:.92em;margin:3px 0 3px 2px';
    const cb = el('input', null, { type: 'checkbox', checked: state.step3[i] });
    cb.addEventListener('change', () => { state.step3[i] = cb.checked; onChange(); });
    const text = el('span', item.text);
    label.append(cb, text);
    list.append(label);
    checkboxes.push(cb);
    labels.push(text);
  });

  function update(end) {
    const open = end.status === 'yes';
    const done = state.step3.filter(Boolean).length;
    const all = done === STEP3_ITEMS.length;

    title.textContent = `Additional Code Requirements (${done}/${STEP3_ITEMS.length})`;
    title.style.color = open && all ? COLORS.yes : '#212529';
    hint.style.display = open ? 'none' : 'block';
    list.style.opacity = open ? 1 : 0.45;
    checkboxes.forEach((cb) => { cb.disabled = !open; });

    // the 800 sq ft limit doesn't apply to historic structures
    STEP3_ITEMS.forEach((item, i) => {
      if (item.historicText) labels[i].textContent = state.historic === 'yes' ? item.historicText : item.text;
    });
  }

  return { box, update };
}

// true when there's room to open the report beside the pin
const hasSideRoom = () => map.getContainer().clientWidth >= 700;

function showReport({ place, lngLat, zoning, overlays, historicHits }) {
  if (popup) popup.remove();
  if (marker) marker.remove();

  const root = el('div');
  root.style.cssText =
    'font-family:sans-serif;font-size:17px;width:min(560px, 85vw);max-height:68vh;overflow-y:auto;padding-right:4px';

  if (!zoning) {
    root.append(el('p', place ? 'No zoning district found at that address.' : 'Address not found in Philadelphia.'));
  } else {
    const base = firstField(zoning.properties, BASE_FIELDS);
    // a register match pre-fills 'yes'; no match leaves it unanswered (register data may be incomplete)
    const state = { base, overlays, historicHits, historic: historicHits?.length ? 'yes' : '', structure: '', lot: '' };

    root.append(el('h3', place?.properties?.full_address ?? 'Zoning report'));

    const facts = el('p');
    facts.style.cssText = 'font-size:1em;margin:4px 0';
    facts.append(
      el('strong', 'Base district: '), base ?? 'unknown', el('br'),
      el('strong', 'Overlays: '),
      overlays === null ? 'unavailable' : overlays.length ? overlays.map((o) => '/' + o).join(', ') : 'none',
    );

    // summary banner: headline + one line of reasoning, visible without scrolling
    const verdict = el('div');
    verdict.style.cssText = 'padding:8px;border-radius:4px;margin:8px 0';

    const flow = el('div');
    const step3 = buildStep3(state, () => rerender());

    const rerender = () => {
      const { end } = renderFlow(flow, state, rerender);
      const pending = end.status === 'yes' && !end.confirmed;

      verdict.replaceChildren();
      const headline = el('div', end.confirmed ? HEADLINE_CONFIRMED : HEADLINE[end.status]);
      headline.style.cssText = 'font-size:1.15em;font-weight:700';
      const reason = el(
        'div',
        end.confirmed
          ? 'All additional code requirements confirmed. L&I verifies these during review.'
          : end.text,
      );
      reason.style.cssText = 'font-size:.92em;margin-top:2px';
      verdict.append(headline, reason);

      verdict.style.background = pending ? PENDING.bg : COLORS[end.status];
      verdict.style.color = pending ? PENDING.text : '#fff';
      step3.update(end);
    };

    const note = el('p', 'Historic status is confirmed by the Historical Commission during L&I review.');
    note.style.cssText = 'font-size:.85em;color:#666;margin:6px 0';

    root.append(facts, verdict, flow, step3.box, note);
    rerender();
  }

  popup = new mapboxgl.Popup({
    closeOnClick: false,
    maxWidth: 'none',
    anchor: hasSideRoom() ? 'left' : undefined, // 'left' = box opens to the right of the pin
  }).setDOMContent(root);

  if (place) {
    // pin on the address, report box opens beside it
    marker = new mapboxgl.Marker({ color: '#f1b6da' })
      .setLngLat(lngLat)
      .setPopup(popup)
      .addTo(map);
    marker.togglePopup();
  } else {
    // address not found: no pin, just show the message at the map center
    popup.setLngLat(lngLat).addTo(map);
  }
}

// Address search

async function searchAddress(query) {
  const place = await geocode(query);
  if (!place) {
    return showReport({ place: null, lngLat: map.getCenter(), zoning: null });
  }

  const [lng, lat] = place.geometry.coordinates;
  map.flyTo({
    center: [lng, lat],
    zoom: 18,
    padding: {
      right: hasSideRoom() ? Math.min(620, Math.round(map.getContainer().clientWidth * 0.55)) : 0,
    },
  });

  const [zoning, overlays, historicHits] = await Promise.all([
    zoningAtPoint(lng, lat),
    overlaysAtPoint(lng, lat),
    historicAtPoint(lng, lat),
  ]);
  map.getSource('selected-zoning').setData(zoning || EMPTY);
  showReport({ place, lngLat: [lng, lat], zoning, overlays, historicHits });
}

const input = document.querySelector('[name=address-search]');
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && input.value.trim()) {
    searchAddress(input.value.trim()).catch(console.error);
  }
});

// Map setup

map.on('load', () => {
  // hide road-number shields; they log a Mapbox expression warning on some tiles
  map.getStyle().layers.forEach((layer) => {
    if (layer.type === 'symbol' && /shield/i.test(layer.id)) {
      map.setLayoutProperty(layer.id, 'visibility', 'none');
    }
  });

  // all districts in view
  map.addSource('zoning', { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'zoning-fill',
    type: 'fill',
    source: 'zoning',
    paint: { 'fill-color': zoningColorExpr, 'fill-opacity': 0.6 },
  });
  map.addLayer({
    id: 'zoning-outline',
    type: 'line',
    source: 'zoning',
    paint: { 'line-color': '#999', 'line-width': 0.5 },
  });

  // the district found by address search
  map.addSource('selected-zoning', { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'selected-zoning-outline',
    type: 'line',
    source: 'selected-zoning',
    paint: { 'line-color': '#f1b6da', 'line-width': 3 },
  });

  map.on('moveend', () => loadZoningInView().catch(console.error));
});

// Legend

const legend = document.createElement('div');
legend.style.cssText =
  'position:absolute;bottom:30px;right:50px;background:#fff;padding:.7em .9em;border-radius:6px;' +
  'font:14px sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.3)';

function legendRow(color, label) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:.6em;margin:.25em 0';
  const swatch = document.createElement('span');
  swatch.style.cssText = `flex:none;width:1em;height:1em;border-radius:2px;background:${color}`;
  row.append(swatch, label);
  return row;
}

// one row per zoning group
for (const [name, color] of Object.entries(GROUP_COLORS)) {
  legend.append(legendRow(color, name.split('/')[0])); // 'Residential', 'Commercial', ...
}

map.getContainer().append(legend);

window.map = map;
