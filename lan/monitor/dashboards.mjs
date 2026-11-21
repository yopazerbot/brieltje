// Writes the two Grafana dashboards of a LAN night's monitoring (lan/monitor/README.md) into grafana/dashboards/:
//   Game night       on a second monitor during the evening: the health tile first, then what predicts lag
//   After the night  the same over the whole evening, with its peaks
// Run after a change: node lan/monitor/dashboards.mjs  (no packages; the JSON files are what Grafana reads).
//
// Laid out as live-ops screens usually are: one verdict at the top (green, orange, red), then the server's own budget
// (the tick against its 50 ms, the event loop), then what the players feel (round trips, the ones over 150 ms, lost
// connections), then the causes (messages, bytes, memory, CPU, garbage collection, HTTP). The game being played is a
// band across every chart (an annotation from brieltje_game_on), so a spike reads against "Zombies started".
import { writeFileSync } from 'node:fs';

const DS = { type: 'prometheus', uid: 'prometheus' };
const GAME = '{job="game"}';
const ORANGE = '#FF9830';
const RED = '#F2495C';
const GREEN = '#73BF69';

const q = (expr, legend, extra = {}) => ({ datasource: DS, expr, legendFormat: legend, range: true, instant: false, ...extra });
const steps = (orange, red) => ({ mode: 'absolute', steps: [{ color: GREEN, value: null }, ...(orange !== undefined ? [{ color: ORANGE, value: orange }] : []), ...(red !== undefined ? [{ color: RED, value: red }] : [])] });
const withRefs = (targets) => targets.map((t, i) => ({ refId: String.fromCharCode(65 + i), ...t }));
/** A series drawn on its own axis to the right (another unit). */
const right = (name, unit, extra = []) => ({
  matcher: { id: 'byName', options: name },
  properties: [{ id: 'unit', value: unit }, { id: 'custom.axisPlacement', value: 'right' }, ...extra],
});
const colour = (name, c) => ({ matcher: { id: 'byName', options: name }, properties: [{ id: 'color', value: { mode: 'fixed', fixedColor: c } }] });

function ts({ id, title, pos, targets, unit = 'short', min = 0, lines, stack = false, overrides = [], description = '', noValue, decimals, softMax }) {
  return {
    id, type: 'timeseries', title, description, gridPos: pos, datasource: DS, targets: withRefs(targets), interval: '2s',
    fieldConfig: {
      defaults: {
        unit, min, decimals, noValue,
        color: { mode: 'palette-classic' },
        thresholds: lines ? steps(...lines) : steps(),
        custom: {
          drawStyle: 'line', lineWidth: 2, fillOpacity: stack ? 35 : 8, gradientMode: 'opacity', showPoints: 'never', spanNulls: 10_000,
          stacking: { mode: stack ? 'normal' : 'none', group: 'A' }, axisSoftMin: 0, axisSoftMax: softMax, axisBorderShow: false,
          thresholdsStyle: { mode: lines ? 'dashed' : 'off' },
        },
      },
      overrides,
    },
    options: { legend: { displayMode: 'list', placement: 'bottom', showLegend: true }, tooltip: { mode: 'multi', sort: 'desc' } },
  };
}

function stat({ id, title, pos, expr, unit = 'short', lines, mappings, description = '', size = 52, decimals, noValue = '–' }) {
  return {
    id, type: 'stat', title, description, gridPos: pos, datasource: DS,
    targets: withRefs([{ datasource: DS, expr, instant: true, range: false, legendFormat: '__auto' }]),
    fieldConfig: { defaults: { unit, decimals, noValue, mappings: mappings ?? [], thresholds: lines ? steps(...lines) : steps(), color: { mode: 'thresholds' } }, overrides: [] },
    options: {
      reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, orientation: 'auto', textMode: 'value', colorMode: 'background',
      graphMode: 'none', justifyMode: 'center', wideLayout: true, showPercentChange: false, text: { valueSize: size },
    },
  };
}

/**
 * 0 green, 1 orange, 2 red from the tick's p99 and the loop's delay, the worst of the last 10 s (a spike holds the colour
 * long enough to be seen, and the tile doesn't flicker); 3 when Prometheus can't read the game.
 */
const TICK10 = 'max(max_over_time(brieltje_tick_seconds{stat="p99"}[10s]))';
const LOOP10 = 'max(max_over_time(brieltje_event_loop_delay_seconds{stat="p99"}[10s]))';
const HEALTH = `max(
  label_replace((${TICK10} > bool 0.03) + (${TICK10} > bool 0.045), "part", "tick", "", "")
  or label_replace((${LOOP10} > bool 0.05) + (${LOOP10} > bool 0.1), "part", "loop", "", "")
  or label_replace(3 * (1 - max(up${GAME})), "part", "up", "", "")
)`;
const HEALTH_TEXT = [{
  type: 'value',
  options: {
    0: { text: 'All good', color: GREEN, index: 0 },
    1: { text: 'Busy', color: ORANGE, index: 1 },
    2: { text: 'Slow', color: RED, index: 2 },
    3: { text: 'No answer', color: RED, index: 3 },
  },
}];

const annotations = {
  list: [
    { builtIn: 1, datasource: { type: 'grafana', uid: '-- Grafana --' }, enable: true, hide: true, iconColor: 'rgba(0, 211, 255, 1)', name: 'Annotations & Alerts', type: 'dashboard' },
    {
      datasource: DS, enable: true, hide: false, iconColor: 'rgba(87, 148, 242, 0.7)', name: 'Game on',
      expr: 'max by (place, kind) (brieltje_game_on)', step: '2s', titleFormat: '{{kind}}', textFormat: 'in the {{place}}', tagKeys: 'kind,place', useValueForTime: false,
      target: { refId: 'Anno', expr: 'max by (place, kind) (brieltje_game_on)', interval: '2s' },
    },
  ],
};

/** The adapters of this PC (windows_exporter), without the virtual ones. */
const templating = {
  list: [{
    name: 'nic', label: 'Network adapter', type: 'query', datasource: DS, query: { query: 'label_values(windows_net_bytes_received_total, nic)', refId: 'nic' },
    definition: 'label_values(windows_net_bytes_received_total, nic)', regex: '/^(?!.*(?:vEthernet|Virtual|Hyper-V|Loopback|isatap|Teredo|Bluetooth|WAN Miniport|Kernel Debug)).*$/',
    includeAll: true, multi: true, current: { selected: true, text: ['All'], value: ['$__all'] }, refresh: 2, sort: 1, hide: 0, options: [],
  }],
};
const PC_NONE = 'windows_exporter not running (lan/monitor/README.md)';

/** `live`: Game night's screen: no time picker, no adapter picker, no band switch (plain ?kiosk then shows only panels). */
function dashboard({ uid, title, time, refresh, panels, description, live = false }) {
  return {
    uid, title, description, tags: ['brieltje', 'lan'], timezone: 'browser', editable: false, graphTooltip: 1, liveNow: false,
    time, refresh, schemaVersion: 41, version: 1, fiscalYearStartMonth: 0, weekStart: 'monday',
    timepicker: { refresh_intervals: ['5s', '10s', '30s', '1m', '5m'], hidden: live },
    annotations: live ? { list: annotations.list.map((a) => ({ ...a, hide: true })) } : annotations,
    templating: live ? { list: templating.list.map((v) => ({ ...v, hide: 2 })) } : templating,
    links: [], panels,
  };
}

// --- Game night: one screen, 1920 by 1080, kiosk mode (?kiosk) ---------------------------------------------------------

const night = [
  stat({ id: 1, title: 'The server', pos: { x: 0, y: 0, w: 6, h: 5 }, expr: HEALTH, mappings: HEALTH_TEXT, lines: [1, 2], size: 64,
    description: 'The worst of the last 10 s. Green: all good. Orange: the tick or the event loop is busy; nothing to do yet. Red for more than a few seconds: see lan/cheatsheet.html.' }),
  stat({ id: 2, title: 'Tick p99, last 10 s', pos: { x: 6, y: 0, w: 3, h: 5 }, expr: TICK10, unit: 's', lines: [0.03, 0.045], decimals: 1,
    description: 'The slowest 1 % of the game\'s ticks, the worst 2 s of the last 10 s. Its budget is 50 ms.' }),
  stat({ id: 3, title: 'Event loop, last 10 s', pos: { x: 9, y: 0, w: 3, h: 5 }, expr: LOOP10, unit: 's', lines: [0.05, 0.1], decimals: 0 }),
  stat({ id: 4, title: 'Players', pos: { x: 12, y: 0, w: 2, h: 5 }, expr: 'sum(brieltje_players)', decimals: 0, lines: [] }),
  stat({ id: 5, title: 'Round trip p95', pos: { x: 14, y: 0, w: 3, h: 5 }, expr: 'max(brieltje_link_rtt_seconds{stat="p95"})', unit: 's', lines: [0.1, 0.15], decimals: 0,
    description: '95 % of the players\' connections are this fast or faster (WebSocket ping, every 2 s).' }),
  stat({ id: 6, title: 'Over 150 ms', pos: { x: 17, y: 0, w: 3, h: 5 }, expr: 'max(brieltje_link_slow_players)', lines: [1, 3], decimals: 0,
    description: 'Players whose round trip is over 150 ms now. Who: the host page.' }),
  {
    id: 7, type: 'alertlist', title: 'Alerts', gridPos: { x: 20, y: 0, w: 4, h: 5 },
    options: {
      viewMode: 'list', groupMode: 'default', groupBy: [], maxItems: 10, sortOrder: 3, dashboardAlerts: false, alertName: '', alertInstanceLabelFilter: '',
      datasource: '', folder: '', showInstances: false,
      stateFilter: { firing: true, pending: true, noData: true, normal: true, error: true, recovering: true },
    },
  },

  ts({ id: 10, title: 'The game\'s tick and the event loop (budget 50 ms)', pos: { x: 0, y: 5, w: 12, h: 8 }, unit: 's', lines: [0.03, 0.05], softMax: 0.06,
    description: 'Each game ticks 20 times a second. Past 50 ms everyone stutters. The bands are the games played.',
    targets: [q(`max(brieltje_tick_seconds{stat="max"})`, 'tick, slowest'), q(`max(brieltje_tick_seconds{stat="p99"})`, 'tick p99'), q(`max(brieltje_tick_seconds{stat="mean"})`, 'tick, mean'), q(`max(brieltje_event_loop_delay_seconds{stat="p99"})`, 'event loop delay p99')],
    overrides: [colour('tick p99', ORANGE), colour('tick, slowest', RED), colour('tick, mean', GREEN), colour('event loop delay p99', '#5794F2')] }),
  ts({ id: 20, title: 'Round trip to the players', pos: { x: 12, y: 5, w: 12, h: 8 }, unit: 's', lines: [0.1, 0.15], softMax: 0.2,
    description: 'From the server to each page and back, every 2 s: the middle player, the 95th percentile, the slowest. Over 150 ms a player feels it.',
    targets: [q('max(brieltje_link_rtt_seconds{stat="max"})', 'slowest'), q('max(brieltje_link_rtt_seconds{stat="p95"})', 'p95'), q('max(brieltje_link_rtt_seconds{stat="median"})', 'median'), q('max(brieltje_link_slow_players)', 'players over 150 ms')],
    overrides: [colour('slowest', RED), colour('p95', ORANGE), colour('median', GREEN), right('players over 150 ms', 'none', [{ id: 'custom.drawStyle', value: 'bars' }, { id: 'custom.fillOpacity', value: 40 }, { id: 'color', value: { mode: 'fixed', fixedColor: '#B877D9' } }, { id: 'decimals', value: 0 }])] }),

  ts({ id: 30, title: 'Players and connections', pos: { x: 0, y: 13, w: 6, h: 7 }, decimals: 0,
    targets: [q('sum by (place) (brieltje_players)', 'players, {{place}}'), q('max(brieltje_watchers)', 'watch views'), q('sum(increase(brieltje_ws_closed_total{why="lost"}[10s]))', 'lost in 10 s'), q('sum(increase(brieltje_reconnects_total[10s]))', 'back in 10 s')],
    overrides: [colour('lost in 10 s', RED), colour('back in 10 s', ORANGE)] }),
  ts({ id: 40, title: 'Messages in a second, by type', pos: { x: 6, y: 13, w: 6, h: 7 }, unit: 'short', decimals: 0,
    targets: [q('sum(rate(brieltje_messages_in_total[10s]))', 'all'), q('sum by (type) (rate(brieltje_messages_in_total[10s])) > 1', '{{type}}')],
    overrides: [colour('all', '#CCCCDC')] }),
  ts({ id: 50, title: 'Sent: the game\'s messages, its files, the network', pos: { x: 12, y: 13, w: 6, h: 7 }, unit: 'Bps',
    targets: [q('sum(rate(brieltje_bytes_out_total[10s]))', 'game messages'), q('sum(rate(brieltje_static_bytes_total[10s]))', 'game files'), q('sum by (nic) (rate(windows_net_bytes_sent_total{nic=~"$nic"}[10s]))', 'PC sent, {{nic}}')] }),
  ts({ id: 60, title: 'Dropped and unanswered', pos: { x: 18, y: 13, w: 6, h: 7 }, unit: 'short', decimals: 1, softMax: 5,
    description: 'Messages a page sent too fast (the rate limits), and pings a page did not answer in 2 s.',
    targets: [q('sum(rate(brieltje_messages_dropped_total[10s]))', 'messages dropped /s'), q('sum(rate(brieltje_link_pongs_missed_total[10s]))', 'pings missed /s')],
    overrides: [colour('messages dropped /s', ORANGE), colour('pings missed /s', RED)] }),

  ts({ id: 70, title: 'Memory', pos: { x: 0, y: 20, w: 6, h: 7 }, unit: 'bytes',
    targets: [q('max(process_resident_memory_bytes)', 'game, resident'), q('max(brieltje_heap_used_bytes)', 'game, heap used'), q('max(brieltje_external_bytes)', 'game, buffers'), q('1 - max(windows_memory_available_bytes) / max(windows_memory_physical_total_bytes)', 'PC, in use')],
    overrides: [right('PC, in use', 'percentunit', [{ id: 'max', value: 1 }])] }),
  ts({ id: 80, title: 'Processor', pos: { x: 6, y: 20, w: 6, h: 7 }, unit: 'percentunit', lines: [0.7, 0.9],
    description: 'The game: its share of one core (it runs on one). The PC: all its cores together.',
    targets: [q('sum(rate(process_cpu_user_seconds_total[10s]) + rate(process_cpu_system_seconds_total[10s]))', 'game, of one core'), q('max(brieltje_event_loop_utilization)', 'game, event loop busy'), q('1 - avg(rate(windows_cpu_time_seconds_total{mode="idle"}[10s]))', 'PC, all cores')] }),
  ts({ id: 90, title: 'Garbage collection', pos: { x: 12, y: 20, w: 6, h: 7 }, unit: 's',
    description: 'The longest pause since the last scrape, and the time spent collecting each second.',
    targets: [q('max(brieltje_gc_pause_max_seconds)', 'longest pause'), q('sum(rate(brieltje_gc_seconds_total[10s]))', 'time collecting /s')] }),
  ts({ id: 100, title: 'HTTP: the first load of every phone', pos: { x: 18, y: 20, w: 6, h: 7 }, unit: 'reqps', stack: true,
    targets: [q('sum by (code) (rate(brieltje_http_requests_total[10s])) > 0', '{{code}}')],
    overrides: [colour('2xx', GREEN), colour('3xx', '#5794F2'), colour('4xx', ORANGE), colour('5xx', RED)] }),

  {
    id: 200, type: 'row', title: 'This PC (windows_exporter)', collapsed: true, gridPos: { x: 0, y: 27, w: 24, h: 1 },
    panels: [
      ts({ id: 201, title: 'PC processor', pos: { x: 0, y: 28, w: 6, h: 7 }, unit: 'percentunit', lines: [0.7, 0.9], noValue: PC_NONE, targets: [q('1 - avg(rate(windows_cpu_time_seconds_total{mode="idle"}[10s]))', 'all cores')] }),
      ts({ id: 202, title: 'PC memory', pos: { x: 6, y: 28, w: 6, h: 7 }, unit: 'bytes', noValue: PC_NONE, targets: [q('max(windows_memory_physical_total_bytes) - max(windows_memory_available_bytes)', 'in use'), q('max(windows_memory_available_bytes)', 'available')] }),
      ts({ id: 203, title: 'PC network', pos: { x: 12, y: 28, w: 6, h: 7 }, unit: 'bps', noValue: PC_NONE, targets: [q('8 * sum by (nic) (rate(windows_net_bytes_sent_total{nic=~"$nic"}[10s]))', 'sent, {{nic}}'), q('8 * sum by (nic) (rate(windows_net_bytes_received_total{nic=~"$nic"}[10s]))', 'received, {{nic}}')] }),
      ts({ id: 204, title: 'PC disk C:', pos: { x: 18, y: 28, w: 6, h: 7 }, unit: 'Bps', noValue: PC_NONE, targets: [q('sum(rate(windows_logical_disk_write_bytes_total{volume="C:"}[10s]))', 'written'), q('sum(rate(windows_logical_disk_read_bytes_total{volume="C:"}[10s]))', 'read'), q('max(windows_logical_disk_free_bytes{volume="C:"})', 'free')], overrides: [right('free', 'bytes')] }),
    ],
  },
];

// --- After the night: the whole evening, its peaks per minute -----------------------------------------------------------

const R = '$__range';
const after = [
  stat({ id: 1, title: 'Most players at once', pos: { x: 0, y: 0, w: 4, h: 4 }, expr: `max_over_time(sum(brieltje_players)[${R}:10s])`, decimals: 0, lines: [], size: 44 }),
  stat({ id: 2, title: 'Worst tick p99', pos: { x: 4, y: 0, w: 4, h: 4 }, expr: `max_over_time(max(brieltje_tick_seconds{stat="p99"})[${R}:])`, unit: 's', lines: [0.03, 0.045], decimals: 1, size: 44 }),
  stat({ id: 3, title: 'Ticks over 50 ms', pos: { x: 8, y: 0, w: 4, h: 4 }, expr: `sum(increase(brieltje_ticks_slow_total{over="50ms"}[${R}]))`, decimals: 0, lines: [1, 20], size: 44 }),
  stat({ id: 4, title: 'Connections lost', pos: { x: 12, y: 0, w: 4, h: 4 }, expr: `sum(increase(brieltje_ws_closed_total{why="lost"}[${R}]))`, decimals: 0, lines: [5, 20], size: 44 }),
  stat({ id: 5, title: 'Worst round trip p95', pos: { x: 16, y: 0, w: 4, h: 4 }, expr: `max_over_time(max(brieltje_link_rtt_seconds{stat="p95"})[${R}:])`, unit: 's', lines: [0.1, 0.15], decimals: 0, size: 44 }),
  stat({ id: 6, title: 'Game files sent', pos: { x: 20, y: 0, w: 4, h: 4 }, expr: `sum(increase(brieltje_static_bytes_total[${R}]))`, unit: 'bytes', decimals: 1, lines: [], size: 44 }),
  // The evening as one band of colour, as the health tile was each minute (the worst of that minute).
  {
    id: 7, type: 'state-timeline', title: 'The server over the evening', gridPos: { x: 0, y: 4, w: 24, h: 3 }, datasource: DS, interval: '1m',
    targets: withRefs([q(`max_over_time((${HEALTH})[1m:10s])`, 'server')]),
    fieldConfig: { defaults: { mappings: HEALTH_TEXT, thresholds: steps(1, 2), color: { mode: 'thresholds' }, custom: { fillOpacity: 85, lineWidth: 0 } }, overrides: [] },
    options: { showValue: 'never', rowHeight: 0.8, mergeValues: true, alignValue: 'left', legend: { showLegend: false }, tooltip: { mode: 'single' } },
  },

  ts({ id: 10, title: 'The game\'s tick per minute (budget 50 ms)', pos: { x: 0, y: 7, w: 12, h: 8 }, unit: 's', lines: [0.03, 0.05],
    targets: [q('max(max_over_time(brieltje_tick_seconds{stat="max"}[1m]))', 'slowest'), q('histogram_quantile(0.99, sum by (le) (rate(brieltje_tick_duration_seconds_bucket[1m])))', 'p99'), q('histogram_quantile(0.5, sum by (le) (rate(brieltje_tick_duration_seconds_bucket[1m])))', 'median'), q('max(max_over_time(brieltje_event_loop_delay_seconds{stat="p99"}[1m]))', 'event loop delay p99')],
    overrides: [colour('slowest', RED), colour('p99', ORANGE), colour('median', GREEN), colour('event loop delay p99', '#5794F2')] }),
  ts({ id: 20, title: 'Round trip per minute', pos: { x: 12, y: 7, w: 12, h: 8 }, unit: 's', lines: [0.1, 0.15],
    targets: [q('max(max_over_time(brieltje_link_rtt_seconds{stat="max"}[1m]))', 'slowest'), q('max(max_over_time(brieltje_link_rtt_seconds{stat="p95"}[1m]))', 'p95'), q('max(avg_over_time(brieltje_link_rtt_seconds{stat="median"}[1m]))', 'median'), q('max(max_over_time(brieltje_link_slow_players[1m]))', 'players over 150 ms')],
    overrides: [colour('slowest', RED), colour('p95', ORANGE), colour('median', GREEN), right('players over 150 ms', 'none', [{ id: 'decimals', value: 0 }, { id: 'color', value: { mode: 'fixed', fixedColor: '#B877D9' } }])] }),
  ts({ id: 30, title: 'Players, and connections lost per minute', pos: { x: 0, y: 15, w: 12, h: 8 }, decimals: 0,
    targets: [q('sum by (place) (max_over_time(brieltje_players[1m]))', 'players, {{place}}'), q('sum(increase(brieltje_ws_closed_total{why="lost"}[1m]))', 'lost'), q('sum(increase(brieltje_reconnects_total[1m]))', 'back')],
    overrides: [colour('lost', RED), colour('back', ORANGE)] }),
  ts({ id: 40, title: 'Messages in a second, by type', pos: { x: 12, y: 15, w: 12, h: 8 }, decimals: 0,
    targets: [q('sum(rate(brieltje_messages_in_total[1m]))', 'all'), q('sum by (type) (rate(brieltje_messages_in_total[1m])) > 1', '{{type}}'), q('sum(rate(brieltje_messages_dropped_total[1m]))', 'dropped')],
    overrides: [colour('all', '#CCCCDC'), colour('dropped', RED)] }),
  ts({ id: 50, title: 'Sent: the game\'s messages, its files, the network', pos: { x: 0, y: 23, w: 12, h: 8 }, unit: 'Bps',
    targets: [q('sum(rate(brieltje_bytes_out_total[1m]))', 'game messages'), q('sum(rate(brieltje_static_bytes_total[1m]))', 'game files'), q('sum by (nic) (rate(windows_net_bytes_sent_total{nic=~"$nic"}[1m]))', 'PC sent, {{nic}}')] }),
  ts({ id: 60, title: 'HTTP by status', pos: { x: 12, y: 23, w: 12, h: 8 }, unit: 'reqps', stack: true,
    targets: [q('sum by (code) (rate(brieltje_http_requests_total[1m])) > 0', '{{code}}')],
    overrides: [colour('2xx', GREEN), colour('3xx', '#5794F2'), colour('4xx', ORANGE), colour('5xx', RED)] }),
  ts({ id: 70, title: 'Memory', pos: { x: 0, y: 31, w: 8, h: 8 }, unit: 'bytes',
    targets: [q('max(process_resident_memory_bytes)', 'game, resident'), q('max(brieltje_heap_used_bytes)', 'game, heap used'), q('max(windows_memory_physical_total_bytes) - max(windows_memory_available_bytes)', 'PC, in use')] }),
  ts({ id: 80, title: 'Processor', pos: { x: 8, y: 31, w: 8, h: 8 }, unit: 'percentunit', lines: [0.7, 0.9],
    targets: [q('sum(rate(process_cpu_user_seconds_total[1m]) + rate(process_cpu_system_seconds_total[1m]))', 'game, of one core'), q('1 - avg(rate(windows_cpu_time_seconds_total{mode="idle"}[1m]))', 'PC, all cores')] }),
  ts({ id: 90, title: 'Garbage collection', pos: { x: 16, y: 31, w: 8, h: 8 }, unit: 's',
    targets: [q('max(max_over_time(brieltje_gc_pause_max_seconds[1m]))', 'longest pause'), q('sum(rate(brieltje_gc_seconds_total[1m]))', 'time collecting /s')] }),
  ts({ id: 100, title: 'PC network', pos: { x: 0, y: 39, w: 12, h: 8 }, unit: 'bps', noValue: PC_NONE,
    targets: [q('8 * sum by (nic) (rate(windows_net_bytes_sent_total{nic=~"$nic"}[1m]))', 'sent, {{nic}}'), q('8 * sum by (nic) (rate(windows_net_bytes_received_total{nic=~"$nic"}[1m]))', 'received, {{nic}}')] }),
  ts({ id: 110, title: 'PC disk C:', pos: { x: 12, y: 39, w: 12, h: 8 }, unit: 'Bps', noValue: PC_NONE,
    targets: [q('sum(rate(windows_logical_disk_write_bytes_total{volume="C:"}[1m]))', 'written'), q('sum(rate(windows_logical_disk_read_bytes_total{volume="C:"}[1m]))', 'read'), q('max(windows_logical_disk_free_bytes{volume="C:"})', 'free')], overrides: [right('free', 'bytes')] }),
];

const here = new URL('./grafana/dashboards/', import.meta.url);
const write = (file, d) => writeFileSync(new URL(file, here), JSON.stringify(d, null, 2) + '\n');
write('game-night.json', dashboard({ uid: 'brieltje-game-night', title: 'Game night', time: { from: 'now-30m', to: 'now' }, refresh: '5s', panels: night, live: true,
  description: 'The LAN night live, for a second monitor: open with ?kiosk. Green, orange, red at the top left.' }));
write('after-the-night.json', dashboard({ uid: 'brieltje-after-the-night', title: 'After the night', time: { from: 'now-12h', to: 'now' }, refresh: '', panels: after,
  description: 'The whole evening, per minute. Pick the evening\'s hours at the top right.' }));
console.log('wrote game-night.json and after-the-night.json');
