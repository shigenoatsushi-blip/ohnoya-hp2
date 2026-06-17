// ジブ性能の統一lookup（oncraneから移植・型注釈削除）
// 機種により2系統のジブデータ構造:
//   - 半径ベース (kind='radius'): jibLen → chart → boomKey → offset → {radius: load}
//   - 角度ベース (kind='angle'):  jibLen → boomKey → offset → [{angle,r,w}]

import { JIB_DATA_GR1000N } from '../data/jibs/gr1000n.js';
import { JIB_DATA_GR600N } from '../data/jibs/gr600n.js';
import { JIB_DATA_GR700N3 } from '../data/jibs/gr700n3.js';
import { JIB_ANGLE_DATA_GR250N4 } from '../data/jibs/gr250n4.js';
import { JIB_ANGLE_DATA_GR160N4 } from '../data/jibs/gr160n4.js';
import { JIB_ANGLE_DATA_GR130NL } from '../data/jibs/gr130nl.js';

const JIB_DATA_SETS = {
  gr1000n: JIB_DATA_GR1000N,
  gr600n: JIB_DATA_GR600N,
  gr700n3: JIB_DATA_GR700N3,
};

const JIB_ANGLE_DATA_SETS = {
  gr250n4: JIB_ANGLE_DATA_GR250N4,
  gr160n4: JIB_ANGLE_DATA_GR160N4,
  gr130nl: JIB_ANGLE_DATA_GR130NL,
};

// 機種IDからジブlookupを返す（{kind, data} or null）
export function getCraneJib(craneId) {
  if (!craneId) return null;
  if (JIB_DATA_SETS[craneId]) return { kind: 'radius', data: JIB_DATA_SETS[craneId] };
  if (JIB_ANGLE_DATA_SETS[craneId]) return { kind: 'angle', data: JIB_ANGLE_DATA_SETS[craneId] };
  return null;
}

// 並び順ヘルパー
const parseLen = (k) => {
  const n = parseFloat(k);
  return isNaN(n) ? Infinity : n;
};
const parseBoom = (k) => {
  const m = k.match(/^(\d+(?:\.\d+)?)m(?:_(\d+))?/);
  if (!m) return [Infinity, Infinity];
  return [parseFloat(m[1]), m[2] ? parseInt(m[2], 10) : 0];
};
const parseOff = (k) => {
  const m = k.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : Infinity;
};
const CHART_ORDER = {
  sc: 100,
  sc1_0t: 110, sc1_4t: 111,
  sc2_0t: 120, sc2_4t: 121,
  r360: 200, '360_0t': 210, '360_4t': 211,
};
const parseChart = (k) => CHART_ORDER[k] ?? 999;

export const sortJibLens = (keys) =>
  [...keys].sort((a, b) => parseLen(a) - parseLen(b));
export const sortCharts = (keys) =>
  [...keys].sort((a, b) => parseChart(a) - parseChart(b));
export const sortBoomKeys = (keys) =>
  [...keys].sort((a, b) => {
    const [a1, a2] = parseBoom(a);
    const [b1, b2] = parseBoom(b);
    if (a1 !== b1) return a1 - b1;
    return a2 - b2;
  });
export const sortOffsets = (keys) =>
  [...keys].sort((a, b) => parseOff(a) - parseOff(b));

// 初期選択を返す
export function defaultJibSelection(jib) {
  if (!jib) return { jibLen: '', chart: null, boomKey: '', offset: '' };
  const jibLen = sortJibLens(Object.keys(jib.data))[0] ?? '';
  if (jib.kind === 'radius') {
    const chart = sortCharts(Object.keys(jib.data[jibLen] ?? {}))[0] ?? '';
    const boomKey = sortBoomKeys(Object.keys(jib.data[jibLen]?.[chart] ?? {}))[0] ?? '';
    const offset = sortOffsets(Object.keys(jib.data[jibLen]?.[chart]?.[boomKey] ?? {}))[0] ?? '';
    return { jibLen, chart, boomKey, offset };
  } else {
    const boomKey = sortBoomKeys(Object.keys(jib.data[jibLen] ?? {}))[0] ?? '';
    const offset = sortOffsets(Object.keys(jib.data[jibLen]?.[boomKey] ?? {}))[0] ?? '';
    return { jibLen, chart: null, boomKey, offset };
  }
}

// 選択中の値から、各項目の選択肢を返す
export function jibOptions(jib, sel) {
  if (!jib) return { jibLens: [], charts: [], booms: [], offsets: [] };
  const jibLens = sortJibLens(Object.keys(jib.data));
  if (jib.kind === 'radius') {
    const charts = sel.jibLen ? sortCharts(Object.keys(jib.data[sel.jibLen] ?? {})) : [];
    const booms = sel.jibLen && sel.chart
      ? sortBoomKeys(Object.keys(jib.data[sel.jibLen]?.[sel.chart] ?? {}))
      : [];
    const offsets = sel.jibLen && sel.chart && sel.boomKey
      ? sortOffsets(Object.keys(jib.data[sel.jibLen]?.[sel.chart]?.[sel.boomKey] ?? {}))
      : [];
    return { jibLens, charts, booms, offsets };
  } else {
    const booms = sel.jibLen ? sortBoomKeys(Object.keys(jib.data[sel.jibLen] ?? {})) : [];
    const offsets = sel.jibLen && sel.boomKey
      ? sortOffsets(Object.keys(jib.data[sel.jibLen]?.[sel.boomKey] ?? {}))
      : [];
    return { jibLens, charts: [], booms, offsets };
  }
}

// 指定半径での荷重(t)を返す。snap-to-≤（直前値スナップ）。範囲外なら null。
export function jibLoadAtRadius(jib, sel, radius) {
  if (!jib) return null;
  if (jib.kind === 'radius') {
    const off = jib.data?.[sel.jibLen]?.[sel.chart ?? '']?.[sel.boomKey]?.[sel.offset];
    if (!off) return null;
    const radii = Object.keys(off).map(Number).sort((a, b) => a - b);
    if (radii.length === 0) return null;
    if (radius > radii[radii.length - 1]) return null;
    let matched = null;
    for (let i = 0; i < radii.length; i++) {
      if (radii[i] === radius) { matched = radii[i]; break; }
      if (radii[i] > radius) { matched = i > 0 ? radii[i - 1] : null; break; }
      matched = radii[i];
    }
    return matched != null ? off[matched] : null;
  } else {
    const list = jib.data?.[sel.jibLen]?.[sel.boomKey]?.[sel.offset];
    if (!list || list.length === 0) return null;
    const sorted = [...list].sort((a, b) => a.r - b.r);
    if (radius > sorted[sorted.length - 1].r) return null;
    let result = null;
    for (const p of sorted) {
      if (p.r <= radius) result = p.w;
      else break;
    }
    return result;
  }
}

// 現在の選択での最大作業半径
export function maxJibRadius(jib, sel) {
  if (!jib) return 0;
  if (jib.kind === 'radius') {
    const off = jib.data?.[sel.jibLen]?.[sel.chart ?? '']?.[sel.boomKey]?.[sel.offset];
    if (!off) return 0;
    const radii = Object.keys(off).map(Number);
    return radii.length ? Math.max(...radii) : 0;
  } else {
    const list = jib.data?.[sel.jibLen]?.[sel.boomKey]?.[sel.offset];
    if (!list || list.length === 0) return 0;
    return Math.max(...list.map((p) => p.r));
  }
}

// 選択変更時に下位を初期値に揃える
export function updateJibSel(jib, sel, field, value) {
  if (!jib) return sel;
  if (field === 'jibLen') {
    if (jib.kind === 'radius') {
      const c = sortCharts(Object.keys(jib.data[value] ?? {}))[0] ?? '';
      const b = sortBoomKeys(Object.keys(jib.data[value]?.[c] ?? {}))[0] ?? '';
      const o = sortOffsets(Object.keys(jib.data[value]?.[c]?.[b] ?? {}))[0] ?? '';
      return { jibLen: value, chart: c, boomKey: b, offset: o };
    }
    const b = sortBoomKeys(Object.keys(jib.data[value] ?? {}))[0] ?? '';
    const o = sortOffsets(Object.keys(jib.data[value]?.[b] ?? {}))[0] ?? '';
    return { jibLen: value, chart: null, boomKey: b, offset: o };
  }
  if (field === 'chart' && jib.kind === 'radius') {
    const b = sortBoomKeys(Object.keys(jib.data[sel.jibLen]?.[value] ?? {}))[0] ?? '';
    const o = sortOffsets(Object.keys(jib.data[sel.jibLen]?.[value]?.[b] ?? {}))[0] ?? '';
    return { ...sel, chart: value, boomKey: b, offset: o };
  }
  if (field === 'boomKey') {
    if (jib.kind === 'radius') {
      const o = sortOffsets(Object.keys(jib.data[sel.jibLen]?.[sel.chart ?? '']?.[value] ?? {}))[0] ?? '';
      return { ...sel, boomKey: value, offset: o };
    }
    const o = sortOffsets(Object.keys(jib.data[sel.jibLen]?.[value] ?? {}))[0] ?? '';
    return { ...sel, boomKey: value, offset: o };
  }
  if (field === 'offset') return { ...sel, offset: value };
  return sel;
}

// 表示用ラベル
export function formatJibLabel(key) {
  if (key === 'sc') return 'Smart Chart';
  if (key === 'r360') return '全周360°';
  if (key === 'sc1_4t') return 'SC1 / CW付';
  if (key === 'sc1_0t') return 'SC1 / CW無';
  if (key === 'sc2_4t') return 'SC2 / CW付';
  if (key === 'sc2_0t') return 'SC2 / CW無';
  if (key === '360_4t') return '全周360° / CW付';
  if (key === '360_0t') return '全周360° / CW無';
  return key;
}
export function formatBoomKey(key) {
  const m = key.match(/^(.+m)_(\d+)$/);
  if (!m) return key;
  const [, boom, mode] = m;
  if (mode === '12') return `${boom} (1,2共通)`;
  return `${boom} MODE ${mode}`;
}
export function formatOffset(key) {
  return key.replace('deg', '°');
}
