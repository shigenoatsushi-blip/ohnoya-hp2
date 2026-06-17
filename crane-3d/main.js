import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CRANES, OBSTACLE_TYPES } from './dimensions.js';
import { bestLoadAtRadius } from './utils/searchLoad.js';
import {
  getCraneJib, defaultJibSelection, jibOptions, jibLoadAtRadius,
  updateJibSel, formatJibLabel, formatBoomKey, formatOffset,
} from './utils/jibLookup.js';

// 性能データ（全機種）
import * as L_gr130nl from './data/loads/gr130nl.js';
import * as L_gr160n4 from './data/loads/gr160n4.js';
import * as L_gr250n4 from './data/loads/gr250n4.js';
import * as L_gr600n  from './data/loads/gr600n.js';
import * as L_gr700n3 from './data/loads/gr700n3.js';
import * as L_gr1000n from './data/loads/gr1000n.js';

const LOAD_DATA_SETS = {
  gr130nl: L_gr130nl,
  gr160n4: L_gr160n4,
  gr250n4: L_gr250n4,
  gr600n:  L_gr600n,
  gr700n3: L_gr700n3,
  gr1000n: L_gr1000n,
};

// ============ 状態 ============
const state = {
  craneId: 'gr1000n',
  mode: 'sc1_0t',           // 性能チャートのモード
  boomLen: 10.2,
  boomAngle: 60,
  swing: 0,
  jibLen: 0,
  jibOffsetDeg: 5,
  cw: 4.0,
  outrSpread: 7.8,
  setWeight: 5.0,           // 設定荷重 (t)
  jibSel: null,             // ジブ詳細選択 (jibLookup用)
  obstacles: [],
  selectedObstacleId: null,
};

let currentDim = CRANES[state.craneId];

// ============ シーン構築 ============
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a2d42);
scene.fog = new THREE.Fog(0x1a2d42, 80, 250);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
camera.position.set(25, 22, 25);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 5, 0);
controls.minDistance = 4;
controls.maxDistance = 150;
controls.maxPolarAngle = Math.PI * 0.495;

// ============ ライト ============
scene.add(new THREE.AmbientLight(0xffffff, 0.5));
const sun = new THREE.DirectionalLight(0xffffff, 1.0);
sun.position.set(40, 60, 25);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -50;
sun.shadow.camera.right = 50;
sun.shadow.camera.top = 50;
sun.shadow.camera.bottom = -50;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 150;
scene.add(sun);
const fill = new THREE.DirectionalLight(0x84becc, 0.3);
fill.position.set(-25, 20, -15);
scene.add(fill);

// ============ 地面 ============
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(300, 300),
  new THREE.MeshStandardMaterial({ color: 0x2c3e50, roughness: 0.95 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const grid = new THREE.GridHelper(150, 75, 0x3a8bb2, 0x2a4a6b);
grid.position.y = 0.005;
scene.add(grid);

// 距離リング
const distanceRings = new THREE.Group();
scene.add(distanceRings);
function buildDistanceRings() {
  distanceRings.clear();
  for (let r = 5; r <= 60; r += 5) {
    const seg = 80;
    const pts = [];
    for (let i = 0; i <= seg; i++) {
      const t = (i / seg) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(t) * r, 0.015, Math.sin(t) * r));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const ring = new THREE.Line(geo, new THREE.LineBasicMaterial({
      color: r % 10 === 0 ? 0x84becc : 0x3a8bb2,
      opacity: r % 10 === 0 ? 0.6 : 0.3,
      transparent: true,
    }));
    distanceRings.add(ring);
  }
}
buildDistanceRings();

// 旋回中心マーク
const slewCenter = new THREE.Mesh(
  new THREE.CylinderGeometry(0.4, 0.4, 0.06, 24),
  new THREE.MeshStandardMaterial({ color: 0xf59e0b, emissive: 0xf59e0b, emissiveIntensity: 0.3 })
);
slewCenter.position.y = 0.04;
scene.add(slewCenter);

// 作業半径円
let radiusRing = null;
function updateRadiusRing(r) {
  if (radiusRing) { scene.remove(radiusRing); radiusRing.geometry.dispose(); }
  if (r <= 0) return;
  const seg = 96;
  const pts = [];
  for (let i = 0; i <= seg; i++) {
    const t = (i / seg) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(t) * r, 0.05, Math.sin(t) * r));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  radiusRing = new THREE.Line(geo, new THREE.LineDashedMaterial({
    color: 0xf59e0b, dashSize: 0.5, gapSize: 0.3, linewidth: 2,
  }));
  radiusRing.computeLineDistances();
  scene.add(radiusRing);
}

// ============ クレーン構築（機種データから） ============
let craneRoot = new THREE.Group();
scene.add(craneRoot);
let upperGroup, boomGroup, boomLengthAxis, boomMesh, jibPivot, jibMesh, hookGroup, hook, rope, jacks = [];

function buildCrane() {
  craneRoot.clear();
  if (hookGroup) scene.remove(hookGroup);
  jacks = [];

  const DIM = currentDim;

  // === 不動: アウトリガジャッキ ===
  const outrigGroup = new THREE.Group();
  craneRoot.add(outrigGroup);
  const jackMat = new THREE.MeshStandardMaterial({ color: 0xcbd5e1, roughness: 0.6, metalness: 0.3 });
  const floatMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.7, metalness: 0.2 });
  for (let i = 0; i < 4; i++) {
    const grp = new THREE.Group();
    const jack = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 1.0, 12), jackMat);
    jack.position.y = 0.5;
    jack.castShadow = true;
    const floatR = (DIM.floatDiameterM || 0.4) / 2 * 1.2;
    const float = new THREE.Mesh(new THREE.CylinderGeometry(floatR, floatR, 0.16, 16), floatMat);
    float.position.y = 0.08;
    float.castShadow = true;
    grp.add(jack);
    grp.add(float);
    outrigGroup.add(grp);
    jacks.push(grp);
  }

  // === 下部フレーム ===
  const lowerGroup = new THREE.Group();
  craneRoot.add(lowerGroup);
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x445566, roughness: 0.6, metalness: 0.4 });
  const lowerFrame = new THREE.Mesh(
    new THREE.BoxGeometry(DIM.slewCenterToFront + DIM.slewCenterToRear, 0.7, DIM.overallWidth * 0.85),
    frameMat
  );
  lowerFrame.position.set((DIM.slewCenterToFront - DIM.slewCenterToRear) / 2, 0.55, 0);
  lowerFrame.castShadow = true;
  lowerFrame.receiveShadow = true;
  lowerGroup.add(lowerFrame);

  // 車輪
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1a2238, roughness: 0.5, metalness: 0.6 });
  const wheelHubMat = new THREE.MeshStandardMaterial({ color: 0xd1d5db, roughness: 0.5, metalness: 0.7 });
  for (const wx of DIM.wheelXs) {
    for (const wz of [-DIM.overallWidth * 0.42, DIM.overallWidth * 0.42]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.4, 20), wheelMat);
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(wx, 0.55, wz);
      wheel.castShadow = true;
      lowerGroup.add(wheel);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.42, 16), wheelHubMat);
      hub.rotation.x = Math.PI / 2;
      hub.position.set(wx, 0.55, wz);
      lowerGroup.add(hub);
    }
  }

  // === 旋回体 ===
  upperGroup = new THREE.Group();
  craneRoot.add(upperGroup);
  const deck = new THREE.Mesh(
    new THREE.BoxGeometry(DIM.slewCenterToFront + DIM.slewCenterToRear - 0.4, 0.4, DIM.overallWidth * 0.85),
    new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.6, metalness: 0.3 })
  );
  deck.position.set((DIM.slewCenterToFront - DIM.slewCenterToRear) / 2, 1.1, 0);
  deck.castShadow = true;
  upperGroup.add(deck);

  const slewBody = new THREE.Mesh(
    new THREE.BoxGeometry(Math.min(3.6, DIM.slewCenterToRear * 1.2), DIM.boomFootHeight - 1.3, Math.min(2.6, DIM.overallWidth * 0.95)),
    new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.55, metalness: 0.35 })
  );
  slewBody.position.set(-1.2, 1.3 + (DIM.boomFootHeight - 1.3) / 2, 0);
  slewBody.castShadow = true;
  upperGroup.add(slewBody);

  // キャブ
  const cab = new THREE.Mesh(
    new THREE.BoxGeometry(1.7, 1.6, 1.3),
    new THREE.MeshStandardMaterial({ color: 0x84becc, roughness: 0.2, opacity: 0.85, transparent: true })
  );
  cab.position.set(0.7, 2.1, 0.4);
  cab.castShadow = true;
  upperGroup.add(cab);
  const cabFrame = new THREE.Mesh(
    new THREE.BoxGeometry(1.75, 1.65, 1.35),
    new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.6, wireframe: true })
  );
  cabFrame.position.copy(cab.position);
  upperGroup.add(cabFrame);

  // カウンタウエイト
  const cwSize = DIM.cwSize;
  if (state.cw > 0) {
    const cwMesh = new THREE.Mesh(
      new THREE.BoxGeometry(cwSize.w, cwSize.h, cwSize.d),
      new THREE.MeshStandardMaterial({ color: 0xdbe2ea, roughness: 0.6, metalness: 0.3 })
    );
    cwMesh.position.set(-DIM.slewCenterToRear + cwSize.w / 2, 1.3 + cwSize.h / 2, 0);
    cwMesh.castShadow = true;
    upperGroup.add(cwMesh);
  }

  // ブーム支点
  const boomPivot = new THREE.Group();
  boomPivot.position.set(DIM.boomFootOffsetFromCenter, DIM.boomFootHeight, 0);
  upperGroup.add(boomPivot);

  boomGroup = new THREE.Group();
  boomPivot.add(boomGroup);

  boomLengthAxis = new THREE.Group();
  boomGroup.add(boomLengthAxis);

  boomMesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 0.65, 0.75),
    new THREE.MeshStandardMaterial({ color: 0x3a8bb2, roughness: 0.45, metalness: 0.35 })
  );
  boomMesh.castShadow = true;
  boomLengthAxis.add(boomMesh);

  const pivotPin = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16, 0.16, 0.9, 16),
    new THREE.MeshStandardMaterial({ color: 0x84becc, roughness: 0.3, metalness: 0.8 })
  );
  pivotPin.rotation.x = Math.PI / 2;
  boomPivot.add(pivotPin);

  jibPivot = new THREE.Group();
  boomLengthAxis.add(jibPivot);
  jibMesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 0.4, 0.5),
    new THREE.MeshStandardMaterial({ color: 0x84becc, roughness: 0.5, metalness: 0.3 })
  );
  jibMesh.castShadow = true;
  jibPivot.add(jibMesh);

  // フック・ロープ（scene直下に置く=ブーム回転の影響を受けず常に垂直）
  hookGroup = new THREE.Group();
  scene.add(hookGroup);
  const ropeGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, -1, 0),
  ]);
  rope = new THREE.Line(ropeGeo, new THREE.LineBasicMaterial({ color: 0xcbd5e1 }));
  hookGroup.add(rope);
  hook = new THREE.Mesh(
    new THREE.TorusGeometry(0.2, 0.07, 8, 16, Math.PI),
    new THREE.MeshStandardMaterial({ color: 0x1a2238, roughness: 0.4, metalness: 0.7 })
  );
  hook.rotation.x = Math.PI / 2;
  hookGroup.add(hook);
}

// ============ 更新 ============
function update() {
  const DIM = currentDim;

  upperGroup.rotation.y = -state.swing * Math.PI / 180;

  // アウトリガ位置
  const halfT = state.outrSpread / 2;
  const positions = [
    { x: DIM.outriggerFrontFromCenter, z: halfT },
    { x: DIM.outriggerFrontFromCenter, z: -halfT },
    { x: -DIM.outriggerRearFromCenter, z: halfT },
    { x: -DIM.outriggerRearFromCenter, z: -halfT },
  ];
  jacks.forEach((j, i) => {
    j.position.set(positions[i].x, 0, positions[i].z);
  });

  // ブーム角度
  boomGroup.rotation.z = state.boomAngle * Math.PI / 180;

  // ブーム長
  boomLengthAxis.position.x = state.boomLen / 2;
  boomMesh.scale.set(state.boomLen, 1, 1);

  // ジブ（オフセット角ぶんブームから下向きに開く）
  jibPivot.position.x = state.boomLen / 2;
  jibPivot.rotation.z = -state.jibOffsetDeg * Math.PI / 180;
  if (state.jibLen > 0) {
    jibPivot.visible = true;
    jibMesh.scale.set(state.jibLen, 1, 1);
    jibMesh.position.x = state.jibLen / 2;
  } else {
    jibPivot.visible = false;
  }

  // フック・ロープ（ブーム/ジブ先端のworld座標から垂直に下ろす）
  let tipWorld;
  if (state.jibLen > 0) {
    // ジブ先端の世界座標（jibPivotの回転を考慮）
    tipWorld = new THREE.Vector3(state.jibLen, 0, 0);
    jibPivot.localToWorld(tipWorld);
  } else {
    tipWorld = new THREE.Vector3(state.boomLen, 0, 0);
    boomGroup.localToWorld(tipWorld);
  }

  // hookGroupはscene直下。tipWorldに配置 → 真下にロープを垂らす
  hookGroup.position.copy(tipWorld);
  hookGroup.rotation.set(0, 0, 0);
  const groundY = 0;
  const dropLen = Math.max(0.5, tipWorld.y - groundY - 0.4);
  rope.scale.set(1, dropLen, 1);
  rope.position.set(0, 0, 0);
  hook.position.set(0, -dropLen, 0);

  // 計算（ジブはブーム角度からオフセット角を引いた角度で伸びる）
  const boomRad = state.boomAngle * Math.PI / 180;
  const tipX = DIM.boomFootOffsetFromCenter + Math.cos(boomRad) * state.boomLen;
  const tipH = DIM.boomFootHeight + Math.sin(boomRad) * state.boomLen;
  let endX = tipX, endH = tipH;
  if (state.jibLen > 0) {
    const jibRad = (state.boomAngle - state.jibOffsetDeg) * Math.PI / 180;
    endX += Math.cos(jibRad) * state.jibLen;
    endH += Math.sin(jibRad) * state.jibLen;
  }
  const workRadius = Math.abs(endX);
  updateRadiusRing(workRadius);

  document.getElementById('ovRadius').textContent = workRadius.toFixed(2);
  document.getElementById('ovHeight').textContent = (endH - 1.5).toFixed(2);
  document.getElementById('ovBoom').textContent = state.boomLen.toFixed(1);
  document.getElementById('ovAngle').textContent = state.boomAngle.toFixed(0);

  // 性能判定
  updateCapacityVerdict(workRadius);
}

function updateCapacityVerdict(workRadius) {
  const maxLoadEl = document.getElementById('ovMaxLoad');
  const bestBoomEl = document.getElementById('ovBestBoom');
  const verdictEl = document.getElementById('verdict');
  const verdictTextEl = document.getElementById('verdictText');
  const verdictSubEl = document.getElementById('verdictSub');

  // ジブ使用時：jibLookupでジブ性能判定
  if (state.jibLen > 0) {
    const jib = getCraneJib(state.craneId);
    if (!jib || !state.jibSel) {
      maxLoadEl.textContent = '—';
      bestBoomEl.textContent = '—';
      verdictEl.className = 'verdict warn';
      verdictTextEl.textContent = 'ジブデータなし';
      verdictSubEl.textContent = '';
      return;
    }
    const load = jibLoadAtRadius(jib, state.jibSel, workRadius);
    if (load === null) {
      maxLoadEl.textContent = '—';
      bestBoomEl.textContent = `ジブ ${state.jibSel.jibLen}`;
      verdictEl.className = 'verdict ng';
      verdictTextEl.textContent = '✕ ジブ性能データ範囲外';
      verdictSubEl.textContent = `作業半径 ${workRadius.toFixed(2)}m は本ジブ設定の範囲外`;
      return;
    }
    maxLoadEl.textContent = `${load.toFixed(2)} t`;
    const boomLabel = formatBoomKey(state.jibSel.boomKey);
    const offsetLabel = formatOffset(state.jibSel.offset);
    bestBoomEl.textContent = `ジブ${state.jibSel.jibLen} / ${boomLabel} / ${offsetLabel}`;
    const w = state.setWeight;
    if (load >= w) {
      verdictEl.className = 'verdict ok';
      verdictTextEl.textContent = `✓ 吊上げ可能（ジブ）`;
      verdictSubEl.textContent = `設定 ${w.toFixed(1)}t ≤ 最大 ${load.toFixed(2)}t / ジブ${state.jibSel.jibLen} ${offsetLabel}`;
    } else {
      verdictEl.className = 'verdict ng';
      verdictTextEl.textContent = `✕ 吊上げ不可（ジブ）`;
      verdictSubEl.textContent = `設定 ${w.toFixed(1)}t > 最大 ${load.toFixed(2)}t / ジブ${state.jibSel.jibLen} ${offsetLabel}`;
    }
    return;
  }

  // ブーム性能判定
  const ds = LOAD_DATA_SETS[state.craneId];
  if (!ds || !ds.LOAD_DATA) {
    maxLoadEl.textContent = '—';
    bestBoomEl.textContent = '—';
    verdictEl.className = 'verdict warn';
    verdictTextEl.textContent = 'データなし';
    verdictSubEl.textContent = '';
    return;
  }

  const result = bestLoadAtRadius(ds.LOAD_DATA, ds.BLOCK_ID_MAP, ds.ID_ORDER, state.mode, workRadius);

  if (!result) {
    maxLoadEl.textContent = '—';
    bestBoomEl.textContent = '—';
    verdictEl.className = 'verdict ng';
    verdictTextEl.textContent = '✕ データ範囲外';
    verdictSubEl.textContent = `作業半径 ${workRadius.toFixed(2)}m は性能表の範囲外`;
    return;
  }

  maxLoadEl.textContent = `${result.load.toFixed(2)} t`;
  bestBoomEl.textContent = result.boomLength;

  const w = state.setWeight;
  if (result.load >= w) {
    verdictEl.className = 'verdict ok';
    verdictTextEl.textContent = `✓ 吊上げ可能`;
    verdictSubEl.textContent = `設定 ${w.toFixed(1)}t ≤ 最大 ${result.load.toFixed(2)}t（${result.boomLength}, 半径${result.matchedRadius}m）`;
  } else {
    verdictEl.className = 'verdict ng';
    verdictTextEl.textContent = `✕ 吊上げ不可`;
    verdictSubEl.textContent = `設定 ${w.toFixed(1)}t > 最大 ${result.load.toFixed(2)}t（${result.boomLength}, 半径${result.matchedRadius}m）`;
  }
}

// ============ 障害物（実物風） ============
const obstacleGroup = new THREE.Group();
scene.add(obstacleGroup);

function disposeObj(obj) {
  obj.traverse((c) => {
    if (c.geometry) c.geometry.dispose();
    if (c.material) {
      if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose());
      else c.material.dispose();
    }
  });
}

// 建物（壁＋切妻屋根＋窓格子）
function buildBuilding(w, h, d, color) {
  const grp = new THREE.Group();
  const wallH = h * 0.75;
  const roofH = h * 0.25;
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xf5f5f0, roughness: 0.8 });
  const wall = new THREE.Mesh(new THREE.BoxGeometry(w, wallH, d), wallMat);
  wall.position.y = wallH / 2;
  wall.castShadow = true; wall.receiveShadow = true;
  grp.add(wall);

  // 切妻屋根（三角プリズム）：頂点を直接定義
  const halfW = w / 2, halfD = d / 2;
  const verts = new Float32Array([
    -halfW, 0, -halfD,   halfW, 0, -halfD,   0, roofH, -halfD, // 妻面 後
    -halfW, 0,  halfD,   halfW, 0,  halfD,   0, roofH,  halfD, // 妻面 前
  ]);
  const idx = [
    0, 1, 2,         // 後妻
    3, 5, 4,         // 前妻
    0, 2, 5,  0, 5, 3, // 左斜面
    1, 4, 5,  1, 5, 2, // 右斜面
    0, 3, 4,  0, 4, 1, // 底
  ];
  const roofGeo = new THREE.BufferGeometry();
  roofGeo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  roofGeo.setIndex(idx);
  roofGeo.computeVertexNormals();
  const roof = new THREE.Mesh(roofGeo, new THREE.MeshStandardMaterial({ color: 0x991b1b, roughness: 0.7 }));
  roof.position.y = wallH;
  roof.castShadow = true;
  grp.add(roof);

  // 窓（前後面に格子状、上限を設けて大きな建物でも軽量に）
  const winMat = new THREE.MeshStandardMaterial({ color: 0x4a6b8a, roughness: 0.3, metalness: 0.4 });
  // 1階あたり3.5m、1列あたり4mとして配置、上限は行12・列20
  const winRows = Math.min(12, Math.max(1, Math.floor(wallH / 3.5)));
  const winCols = Math.min(20, Math.max(1, Math.floor(w / 4.0)));
  const winW = Math.min(1.0, w / winCols * 0.4);
  const winH = Math.min(1.4, wallH / winRows * 0.5);
  for (let face = 0; face < 2; face++) {
    const z = face === 0 ? halfD + 0.005 : -halfD - 0.005;
    for (let r = 0; r < winRows; r++) {
      for (let c = 0; c < winCols; c++) {
        const win = new THREE.Mesh(new THREE.PlaneGeometry(winW, winH), winMat);
        win.position.set(
          (c - (winCols - 1) / 2) * (w / winCols),
          (r + 0.5) * (wallH / winRows),
          z
        );
        if (face === 1) win.rotation.y = Math.PI;
        grp.add(win);
      }
    }
  }
  // 左右側面にも窓（奥行が大きい場合）
  if (d > 8) {
    const sideCols = Math.min(20, Math.max(1, Math.floor(d / 4.0)));
    const sideWinW = Math.min(1.0, d / sideCols * 0.4);
    for (let face = 0; face < 2; face++) {
      const x = face === 0 ? halfW + 0.005 : -halfW - 0.005;
      for (let r = 0; r < winRows; r++) {
        for (let c = 0; c < sideCols; c++) {
          const win = new THREE.Mesh(new THREE.PlaneGeometry(sideWinW, winH), winMat);
          win.position.set(
            x,
            (r + 0.5) * (wallH / winRows),
            (c - (sideCols - 1) / 2) * (d / sideCols)
          );
          win.rotation.y = face === 0 ? Math.PI / 2 : -Math.PI / 2;
          grp.add(win);
        }
      }
    }
  }
  return grp;
}

// 樹木（幹＋樹冠）
function buildTree(w, h, d, color) {
  const grp = new THREE.Group();
  const trunkH = h * 0.35;
  const canopyH = h - trunkH;
  const trunkR = Math.min(w, d) * 0.12;
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(trunkR * 0.85, trunkR, trunkH, 10),
    new THREE.MeshStandardMaterial({ color: 0x6b4423, roughness: 0.95 })
  );
  trunk.position.y = trunkH / 2;
  trunk.castShadow = true;
  grp.add(trunk);

  const canopyR = Math.min(w, d) / 2;
  const canopy = new THREE.Mesh(
    new THREE.IcosahedronGeometry(canopyR, 1),
    new THREE.MeshStandardMaterial({ color, roughness: 0.85, flatShading: true })
  );
  canopy.position.y = trunkH + canopyH * 0.45;
  canopy.scale.y = canopyH / (canopyR * 2) * 1.1;
  canopy.castShadow = true;
  grp.add(canopy);

  // 中段の小さい葉群（密度を出す）
  const canopy2 = new THREE.Mesh(
    new THREE.IcosahedronGeometry(canopyR * 0.7, 1),
    new THREE.MeshStandardMaterial({ color: 0x15803d, roughness: 0.85, flatShading: true })
  );
  canopy2.position.set(canopyR * 0.3, trunkH + canopyH * 0.7, 0);
  canopy2.castShadow = true;
  grp.add(canopy2);
  return grp;
}

// 電柱＋電線
function buildElectric(w, h, d, color) {
  const grp = new THREE.Group();
  const poleH = h;
  const poleR = 0.15;
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(poleR, poleR * 1.3, poleH, 12),
    new THREE.MeshStandardMaterial({ color: 0xa1a1aa, roughness: 0.7 })
  );
  pole.position.y = poleH / 2;
  pole.castShadow = true;
  grp.add(pole);

  // 横腕2本
  const armSpan = Math.max(1.5, w);
  for (let i = 0; i < 2; i++) {
    const yArm = poleH - 0.5 - i * 0.8;
    const arm = new THREE.Mesh(
      new THREE.BoxGeometry(armSpan, 0.12, 0.12),
      new THREE.MeshStandardMaterial({ color: 0x71717a, roughness: 0.7 })
    );
    arm.position.set(0, yArm, 0);
    arm.castShadow = true;
    grp.add(arm);
    // 碍子
    for (const side of [-1, 0, 1]) {
      const insulator = new THREE.Mesh(
        new THREE.CylinderGeometry(0.06, 0.06, 0.15, 8),
        new THREE.MeshStandardMaterial({ color: 0xe5e5e5, roughness: 0.5 })
      );
      insulator.position.set(side * armSpan * 0.4, yArm + 0.12, 0);
      grp.add(insulator);
    }
  }

  // 電線（水平に延びる線、奥行きはdで表現）
  const wireMat = new THREE.LineBasicMaterial({ color: 0x1f2937 });
  for (let i = 0; i < 2; i++) {
    for (const side of [-1, 0, 1]) {
      const yWire = poleH - 0.5 - i * 0.8 + 0.2;
      const wireLen = Math.max(d, 8);
      const pts = [
        new THREE.Vector3(side * armSpan * 0.4, yWire, -wireLen / 2),
        new THREE.Vector3(side * armSpan * 0.4, yWire - 0.3, 0),
        new THREE.Vector3(side * armSpan * 0.4, yWire, wireLen / 2),
      ];
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      grp.add(new THREE.Line(geo, wireMat));
    }
  }
  return grp;
}

// ブロック塀
function buildBlockWall(w, h, d, color) {
  const grp = new THREE.Group();
  const baseH = 0.3;
  const blockMat = new THREE.MeshStandardMaterial({ color: 0xbfbfb8, roughness: 0.9 });
  const base = new THREE.Mesh(new THREE.BoxGeometry(w, baseH, d * 1.2), new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.9 }));
  base.position.y = baseH / 2;
  base.castShadow = true; base.receiveShadow = true;
  grp.add(base);
  const wallH = h - baseH;
  const wall = new THREE.Mesh(new THREE.BoxGeometry(w, wallH, d), blockMat);
  wall.position.y = baseH + wallH / 2;
  wall.castShadow = true; wall.receiveShadow = true;
  grp.add(wall);

  // ブロック目地（線）
  const lineMat = new THREE.LineBasicMaterial({ color: 0x6b7280 });
  const rowH = 0.2;
  const colW = 0.4;
  const rows = Math.max(1, Math.floor(wallH / rowH));
  for (let r = 1; r < rows; r++) {
    const y = baseH + r * (wallH / rows);
    for (const z of [d / 2 + 0.001, -d / 2 - 0.001]) {
      const pts = [new THREE.Vector3(-w / 2, y, z), new THREE.Vector3(w / 2, y, z)];
      grp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat));
    }
  }
  const cols = Math.max(1, Math.floor(w / colW));
  for (let c = 1; c < cols; c++) {
    const x = -w / 2 + c * (w / cols);
    for (const z of [d / 2 + 0.001, -d / 2 - 0.001]) {
      const pts = [new THREE.Vector3(x, baseH, z), new THREE.Vector3(x, baseH + wallH, z)];
      grp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat));
    }
  }
  return grp;
}

// 車両（ボディ＋屋根＋窓＋タイヤ）
function buildVehicle(w, h, d, color) {
  const grp = new THREE.Group();
  const tireR = Math.min(0.45, h * 0.22);
  const groundClearance = tireR * 0.6;
  const bodyH = h * 0.45;
  const roofH = h - bodyH - groundClearance;

  const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.55 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(d * 0.95, bodyH, w * 0.95), bodyMat);
  body.position.y = groundClearance + bodyH / 2;
  body.castShadow = true;
  grp.add(body);

  // キャビン（屋根）
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(d * 0.7, roofH, w * 0.85),
    bodyMat
  );
  cabin.position.y = groundClearance + bodyH + roofH / 2;
  cabin.position.x = d * 0.05;
  cabin.castShadow = true;
  grp.add(cabin);

  // 窓
  const winMat = new THREE.MeshStandardMaterial({ color: 0x111827, transparent: true, opacity: 0.5, roughness: 0.1, metalness: 0.3 });
  const windows = new THREE.Mesh(
    new THREE.BoxGeometry(d * 0.71, roofH * 0.7, w * 0.86),
    winMat
  );
  windows.position.copy(cabin.position);
  grp.add(windows);

  // タイヤ4
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
  const hubMat = new THREE.MeshStandardMaterial({ color: 0xd1d5db, roughness: 0.5, metalness: 0.7 });
  const tireOffsets = [
    { x: -d * 0.32, z: -w * 0.38 },
    { x:  d * 0.32, z: -w * 0.38 },
    { x: -d * 0.32, z:  w * 0.38 },
    { x:  d * 0.32, z:  w * 0.38 },
  ];
  for (const t of tireOffsets) {
    const tire = new THREE.Mesh(new THREE.CylinderGeometry(tireR, tireR, 0.25, 16), tireMat);
    tire.rotation.x = Math.PI / 2;
    tire.position.set(t.x, tireR, t.z);
    tire.castShadow = true;
    grp.add(tire);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(tireR * 0.4, tireR * 0.4, 0.27, 12), hubMat);
    hub.rotation.x = Math.PI / 2;
    hub.position.copy(tire.position);
    grp.add(hub);
  }
  return grp;
}

// その他（汎用箱、半透明）
function buildOther(w, h, d, color) {
  const grp = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.7, opacity: 0.65, transparent: true });
  const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  box.position.y = h / 2;
  box.castShadow = true; box.receiveShadow = true;
  grp.add(box);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(box.geometry),
    new THREE.LineBasicMaterial({ color })
  );
  edges.position.y = h / 2;
  grp.add(edges);
  return grp;
}

function buildObstacleMesh(type, w, h, d) {
  const meta = OBSTACLE_TYPES[type];
  const c = meta.color;
  switch (type) {
    case 'building': return buildBuilding(w, h, d, c);
    case 'tree':     return buildTree(w, h, d, c);
    case 'electric': return buildElectric(w, h, d, c);
    case 'wall':     return buildBlockWall(w, h, d, c);
    case 'vehicle':  return buildVehicle(w, h, d, c);
    default:         return buildOther(w, h, d, c);
  }
}

function tagObstacleMesh(grp, id) {
  grp.userData.obstacleId = id;
  grp.traverse((c) => { if (c.isMesh) c.userData.obstacleId = id; });
}

let obstacleIdSeq = 0;
function addObstacle(type, x = 8, z = 0) {
  const meta = OBSTACLE_TYPES[type];
  const o = {
    id: ++obstacleIdSeq,
    type,
    x, y: 0, z,
    w: meta.defaultSize.w,
    h: meta.defaultSize.h,
    d: meta.defaultSize.d,
  };
  const mesh = buildObstacleMesh(type, o.w, o.h, o.d);
  mesh.position.set(o.x, 0, o.z);
  tagObstacleMesh(mesh, o.id);
  o.mesh = mesh;
  obstacleGroup.add(mesh);
  state.obstacles.push(o);
  refreshObstacleList();
  return o;
}

function deleteObstacle(id) {
  const idx = state.obstacles.findIndex((o) => o.id === id);
  if (idx === -1) return;
  const o = state.obstacles[idx];
  obstacleGroup.remove(o.mesh);
  disposeObj(o.mesh);
  state.obstacles.splice(idx, 1);
  if (state.selectedObstacleId === id) state.selectedObstacleId = null;
  refreshObstacleList();
}

function updateObstacleMesh(o) {
  const newMesh = buildObstacleMesh(o.type, o.w, o.h, o.d);
  newMesh.position.copy(o.mesh.position);
  tagObstacleMesh(newMesh, o.id);
  obstacleGroup.remove(o.mesh);
  disposeObj(o.mesh);
  o.mesh = newMesh;
  obstacleGroup.add(newMesh);
  refreshSelection();
}

function refreshObstacleList() {
  const list = document.getElementById('obsList');
  list.innerHTML = '';
  if (state.obstacles.length === 0) {
    list.innerHTML = '<div class="obs-empty">障害物なし。上のボタンから追加できます。</div>';
    document.getElementById('obsSizePanel').style.display = 'none';
    return;
  }
  state.obstacles.forEach((o) => {
    const meta = OBSTACLE_TYPES[o.type];
    const row = document.createElement('div');
    row.className = 'obs-row' + (state.selectedObstacleId === o.id ? ' selected' : '');
    row.innerHTML = `
      <span class="obs-dot" style="background:#${meta.color.toString(16).padStart(6, '0')}"></span>
      <span class="obs-name">${meta.label}#${o.id}</span>
      <span class="obs-pos">x:${o.x.toFixed(1)} z:${o.z.toFixed(1)} ${o.w}×${o.h}×${o.d}m</span>
      <button class="obs-del" data-id="${o.id}">×</button>
    `;
    row.querySelector('.obs-del').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteObstacle(o.id);
    });
    row.addEventListener('click', () => {
      state.selectedObstacleId = state.selectedObstacleId === o.id ? null : o.id;
      refreshSelection();
      refreshObstacleList();
    });
    list.appendChild(row);
  });
  refreshSizePanel();
}

function refreshSizePanel() {
  const panel = document.getElementById('obsSizePanel');
  const o = state.obstacles.find((x) => x.id === state.selectedObstacleId);
  if (!o) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block';
  const meta = OBSTACLE_TYPES[o.type];
  document.getElementById('sizeTitle').textContent = `${meta.label}#${o.id}`;

  // 種類別のサイズ上限を適用
  const limits = meta.sizeLimits || { w: 20, h: 30, d: 20 };

  ['w', 'h', 'd'].forEach((k) => {
    const slider = document.getElementById(`size_${k}`);
    const val = document.getElementById(`sizeV_${k}`);
    slider.max = limits[k];
    // ステップは大きい範囲で 0.5m、小さい範囲で 0.1m
    slider.step = limits[k] >= 30 ? 0.5 : 0.1;
    slider.value = o[k];
    val.textContent = `${parseFloat(o[k]).toFixed(1)} m`;
    slider.oninput = () => {
      o[k] = parseFloat(slider.value);
      val.textContent = `${o[k].toFixed(1)} m`;
      updateObstacleMesh(o);
      refreshObstacleList();
    };
  });
}

function refreshSelection() {
  state.obstacles.forEach((o) => {
    const isSel = o.id === state.selectedObstacleId;
    o.mesh.traverse((c) => {
      if (c.isMesh && c.material) {
        c.material.emissive = new THREE.Color(isSel ? 0xf59e0b : 0x000000);
        c.material.emissiveIntensity = isSel ? 0.25 : 0;
      }
    });
  });
}

// ============ ドラッグで障害物を移動 ============
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let dragTarget = null;
let dragOffset = new THREE.Vector3();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

function getPointerPos(e) {
  const rect = canvas.getBoundingClientRect();
  const cx = e.touches ? e.touches[0].clientX : e.clientX;
  const cy = e.touches ? e.touches[0].clientY : e.clientY;
  pointer.x = ((cx - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((cy - rect.top) / rect.height) * 2 + 1;
}

canvas.addEventListener('pointerdown', (e) => {
  getPointerPos(e);
  raycaster.setFromCamera(pointer, camera);
  const intersects = raycaster.intersectObjects(obstacleGroup.children, true);
  if (intersects.length > 0) {
    let obj = intersects[0].object;
    while (obj && obj.userData.obstacleId === undefined) obj = obj.parent;
    if (!obj) return;
    const id = obj.userData.obstacleId;
    const o = state.obstacles.find((x) => x.id === id);
    if (o) {
      dragTarget = o;
      state.selectedObstacleId = id;
      refreshSelection();
      refreshObstacleList();
      const groundHit = new THREE.Vector3();
      raycaster.ray.intersectPlane(groundPlane, groundHit);
      dragOffset.set(o.x - groundHit.x, 0, o.z - groundHit.z);
      controls.enabled = false;
      canvas.setPointerCapture(e.pointerId);
    }
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (!dragTarget) return;
  getPointerPos(e);
  raycaster.setFromCamera(pointer, camera);
  const groundHit = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(groundPlane, groundHit)) {
    dragTarget.x = Math.round((groundHit.x + dragOffset.x) * 10) / 10;
    dragTarget.z = Math.round((groundHit.z + dragOffset.z) * 10) / 10;
    dragTarget.mesh.position.set(dragTarget.x, 0, dragTarget.z);
    refreshObstacleList();
  }
});

canvas.addEventListener('pointerup', (e) => {
  if (dragTarget) {
    dragTarget = null;
    controls.enabled = true;
    canvas.releasePointerCapture(e.pointerId);
  }
});

// ============ リサイズ ============
function resize() {
  const wrap = canvas.parentElement;
  renderer.setSize(wrap.clientWidth, wrap.clientHeight, false);
  camera.aspect = wrap.clientWidth / wrap.clientHeight;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas.parentElement);

// ============ アニメ ============
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

// ============ 機種切替 ============
function setCrane(id) {
  state.craneId = id;
  currentDim = CRANES[id];

  // モード選択肢を再構築
  const modes = currentDim.modes || [];
  const modeContainer = document.getElementById('modeChips');
  modeContainer.innerHTML = '';
  if (modes.length > 0) {
    state.mode = modes[0].key;
    modes.forEach((m, idx) => {
      const btn = document.createElement('button');
      btn.className = 'chip' + (idx === 0 ? ' active' : '');
      btn.dataset.mode = m.key;
      btn.textContent = m.label;
      btn.title = m.label;
      btn.addEventListener('click', () => {
        modeContainer.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
        btn.classList.add('active');
        state.mode = m.key;
        applyCwFromMode(m.key);
        buildCrane();
        update();
      });
      modeContainer.appendChild(btn);
    });
  }

  // スライダー範囲更新
  const boomLenEl = document.getElementById('boomLen');
  boomLenEl.min = currentDim.boomMin;
  boomLenEl.max = currentDim.boomMax;
  boomLenEl.step = 0.1;
  state.boomLen = Math.min(state.boomLen, currentDim.boomMax);
  state.boomLen = Math.max(state.boomLen, currentDim.boomMin);
  boomLenEl.value = state.boomLen;
  document.getElementById('vBoomLen').textContent = state.boomLen.toFixed(1);

  const angleEl = document.getElementById('boomAngle');
  angleEl.max = currentDim.boomMaxAngle;
  state.boomAngle = Math.min(state.boomAngle, currentDim.boomMaxAngle);
  angleEl.value = state.boomAngle;
  document.getElementById('vBoomAngle').textContent = state.boomAngle.toFixed(0);

  // ジブ長は0で初期化（ジブUIはrebuildJibDetailUiで構築）
  state.jibLen = 0;

  // カウンタウエイトはmodeから自動判定
  applyCwFromMode(state.mode);

  // アウトリガ選択肢
  rebuildChips('outrChips', currentDim.outriggerSpreadOptions, 'outr', 'outrSpread', (v) => `${v}m`, null);
  state.outrSpread = currentDim.outriggerSpreadOptions[currentDim.outriggerSpreadOptions.length - 1];

  buildCrane();
  state.jibSel = null;
  rebuildJibDetailUi();
  update();
}

// モード/チャートキーからCW有無を判定して state.cw に反映
function applyCwFromMode(key) {
  if (!key) {
    state.cw = currentDim.defaultCw;
    return;
  }
  if (key.includes('_0t')) {
    state.cw = 0;
  } else if (key.includes('_4t')) {
    state.cw = currentDim.counterweightOptions.find((v) => v > 0) ?? currentDim.defaultCw;
  } else {
    // mode1, mode2, og47_full などは機種のデフォルトCW
    state.cw = currentDim.defaultCw;
  }
}

function rebuildChips(containerId, options, dataAttr, stateKey, labelFn, valId) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  options.forEach((v, idx) => {
    const btn = document.createElement('button');
    btn.className = 'chip' + (
      (stateKey === 'jibLen' ? v === 0 :
       stateKey === 'cw' ? v === currentDim.defaultCw :
       stateKey === 'outrSpread' ? idx === options.length - 1 : false)
      ? ' active' : ''
    );
    btn.dataset[dataAttr] = v;
    btn.textContent = labelFn(v);
    btn.addEventListener('click', () => {
      container.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      btn.classList.add('active');
      state[stateKey] = parseFloat(btn.dataset[dataAttr]);
      if (valId) document.getElementById(valId).textContent = labelFn(state[stateKey]);
      if (stateKey === 'cw') buildCrane();
      if (stateKey === 'jibLen') rebuildJibDetailUi();
      update();
    });
    container.appendChild(btn);
  });
}

// ジブ詳細選択UI（ジブ長/チャート/ブーム/オフセット）を再構築
function rebuildJibDetailUi() {
  const panel = document.getElementById('jibDetailPanel');
  panel.style.display = 'block';

  const jibLenContainer = document.getElementById('jibLenChips');
  const chartRow = document.getElementById('jibChartRow');
  const boomRow = document.getElementById('jibBoomRow');
  const offsetRow = document.getElementById('jibOffsetRow');
  const note = document.getElementById('jibDetailNote');

  // ジブ長chip構築（機種仕様から「なし」+ジブ長）
  jibLenContainer.innerHTML = '';
  (currentDim.jibLengths || [0]).forEach((len) => {
    const btn = document.createElement('button');
    btn.className = 'chip' + (state.jibLen === len ? ' active' : '');
    btn.textContent = len === 0 ? 'なし' : `${len}m`;
    btn.addEventListener('click', () => {
      state.jibLen = len;
      rebuildJibDetailUi();
      update();
    });
    jibLenContainer.appendChild(btn);
  });

  // ジブなし
  if (state.jibLen <= 0) {
    chartRow.style.display = 'none';
    boomRow.style.display = 'none';
    offsetRow.style.display = 'none';
    note.style.display = 'none';
    state.jibSel = null;
    return;
  }

  const jib = getCraneJib(state.craneId);
  if (!jib) {
    chartRow.style.display = 'none';
    boomRow.style.display = 'none';
    offsetRow.style.display = 'none';
    note.style.display = 'none';
    state.jibSel = null;
    return;
  }

  chartRow.style.display = '';
  boomRow.style.display = '';
  offsetRow.style.display = '';
  note.style.display = '';

  // 現在のジブ長を文字列キーに変換（'8.4m'など）
  const jibLenKey = `${state.jibLen}m`;
  if (!state.jibSel || state.jibSel.jibLen !== jibLenKey) {
    state.jibSel = defaultJibSelection(jib);
    state.jibSel = updateJibSel(jib, state.jibSel, 'jibLen', jibLenKey);
  }

  const opts = jibOptions(jib, state.jibSel);

  // チャート（半径ベース機のみ）
  if (jib.kind === 'radius' && opts.charts.length > 0) {
    chartRow.style.display = '';
    const cc = document.getElementById('jibChartChips');
    cc.innerHTML = '';
    opts.charts.forEach((c) => {
      const btn = document.createElement('button');
      btn.className = 'chip' + (c === state.jibSel.chart ? ' active' : '');
      btn.textContent = formatJibLabel(c);
      btn.addEventListener('click', () => {
        state.jibSel = updateJibSel(jib, state.jibSel, 'chart', c);
        // ジブのチャートでもCW判別を反映
        applyCwFromMode(c);
        buildCrane();
        rebuildJibDetailUi();
        update();
      });
      cc.appendChild(btn);
    });
  } else {
    chartRow.style.display = 'none';
  }

  // ブームキー（選択するとメインの state.boomLen も追従）
  const bc = document.getElementById('jibBoomChips');
  bc.innerHTML = '';
  opts.booms.forEach((b) => {
    const btn = document.createElement('button');
    btn.className = 'chip' + (b === state.jibSel.boomKey ? ' active' : '');
    btn.textContent = formatBoomKey(b);
    btn.addEventListener('click', () => {
      state.jibSel = updateJibSel(jib, state.jibSel, 'boomKey', b);
      // boomKey から数値を取り出してメインのブーム長スライダーも追従させる
      const m = b.match(/^(\d+(?:\.\d+)?)m/);
      if (m) {
        const boomLen = parseFloat(m[1]);
        state.boomLen = boomLen;
        const boomLenEl = document.getElementById('boomLen');
        // スライダー範囲外でも一時的に反映
        if (boomLen < parseFloat(boomLenEl.min)) boomLenEl.min = boomLen;
        if (boomLen > parseFloat(boomLenEl.max)) boomLenEl.max = boomLen;
        boomLenEl.value = boomLen;
        document.getElementById('vBoomLen').textContent = boomLen.toFixed(1);
      }
      rebuildJibDetailUi();
      update();
    });
    bc.appendChild(btn);
  });

  // オフセット（5/25/45/60を常に表示。性能表に無い組合せは灰色表示）
  const oc = document.getElementById('jibOffsetChips');
  oc.innerHTML = '';
  const FIXED_OFFSETS = ['5deg', '25deg', '45deg', '60deg'];
  const availableSet = new Set(opts.offsets);
  FIXED_OFFSETS.forEach((o) => {
    const btn = document.createElement('button');
    const available = availableSet.has(o);
    btn.className = 'chip' + (o === state.jibSel.offset ? ' active' : '') + (available ? '' : ' chip-disabled');
    btn.textContent = formatOffset(o);
    btn.title = available ? '' : '※ この組合せの性能データは未収録（3D表示のみ反映）';
    btn.addEventListener('click', () => {
      // 性能表にある場合は selection を更新（chart/boomKeyを保つ）
      if (available) {
        state.jibSel = updateJibSel(jib, state.jibSel, 'offset', o);
      } else {
        // 性能表に無い場合は selection のオフセットだけ仮設定（判定はデータ無しになる）
        state.jibSel = { ...state.jibSel, offset: o };
      }
      // 3D表示のジブ角度に反映
      const m = o.match(/^(\d+)/);
      if (m) state.jibOffsetDeg = parseInt(m[1], 10);
      rebuildJibDetailUi();
      update();
    });
    oc.appendChild(btn);
  });
}

// ============ UI バインド ============
function bindRange(id, valId, key, formatter) {
  const el = document.getElementById(id);
  const valEl = document.getElementById(valId);
  el.addEventListener('input', () => {
    state[key] = parseFloat(el.value);
    valEl.textContent = formatter(state[key]);
    update();
  });
}
bindRange('boomLen', 'vBoomLen', 'boomLen', (v) => v.toFixed(1));
bindRange('boomAngle', 'vBoomAngle', 'boomAngle', (v) => v.toFixed(0));
bindRange('swing', 'vSwing', 'swing', (v) => v.toFixed(0));

// 設定荷重: 数値入力 + ±ボタン + プリセット
function setWeightValue(v) {
  const clamped = Math.max(0.05, Math.min(200, parseFloat(v) || 0));
  state.setWeight = clamped;
  document.getElementById('setWeightNum').value = clamped.toFixed(2).replace(/\.?0+$/, '');
  update();
}
document.getElementById('setWeightNum').addEventListener('input', (e) => {
  const v = parseFloat(e.target.value);
  if (!isNaN(v) && v >= 0.05) {
    state.setWeight = Math.min(200, v);
    update();
  }
});
document.getElementById('setWeightNum').addEventListener('blur', (e) => {
  setWeightValue(e.target.value);
});
document.getElementById('weightMinus').addEventListener('click', () => {
  // 小さい荷重なら0.05刻み、大きいなら0.5刻み
  const step = state.setWeight <= 2 ? 0.05 : state.setWeight <= 10 ? 0.5 : 1;
  setWeightValue(state.setWeight - step);
});
document.getElementById('weightPlus').addEventListener('click', () => {
  const step = state.setWeight < 2 ? 0.05 : state.setWeight < 10 ? 0.5 : 1;
  setWeightValue(state.setWeight + step);
});
document.querySelectorAll('.weight-preset').forEach((btn) => {
  btn.addEventListener('click', () => {
    setWeightValue(btn.dataset.w);
  });
});

// 機種切替
document.querySelectorAll('#craneChips .chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('#craneChips .chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    setCrane(chip.dataset.crane);
  });
});

// 障害物追加ボタン
document.querySelectorAll('#obsAddBtns .obs-add').forEach((btn) => {
  btn.addEventListener('click', () => {
    addObstacle(btn.dataset.type);
    update();
  });
});

// ズーム
function zoom(factor) {
  const dir = new THREE.Vector3().subVectors(camera.position, controls.target);
  dir.multiplyScalar(factor);
  const newPos = new THREE.Vector3().addVectors(controls.target, dir);
  const newDist = newPos.distanceTo(controls.target);
  if (newDist >= controls.minDistance && newDist <= controls.maxDistance) {
    camera.position.copy(newPos);
    controls.update();
  }
}
document.getElementById('zoomIn').addEventListener('click', () => zoom(0.8));
document.getElementById('zoomOut').addEventListener('click', () => zoom(1.25));

// 視点プリセット
document.getElementById('viewIso').addEventListener('click', () => {
  camera.position.set(25, 22, 25);
  controls.target.set(0, 5, 0);
  controls.update();
});
document.getElementById('viewFront').addEventListener('click', () => {
  camera.position.set(40, 10, 0);
  controls.target.set(0, 5, 0);
  controls.update();
});
document.getElementById('viewSide').addEventListener('click', () => {
  camera.position.set(0, 10, 40);
  controls.target.set(0, 5, 0);
  controls.update();
});
document.getElementById('viewTop').addEventListener('click', () => {
  camera.position.set(0, 60, 0.01);
  controls.target.set(0, 0, 0);
  controls.update();
});

// プリセット角度
document.getElementById('presetBoom').addEventListener('click', () => {
  state.boomAngle = 0;
  document.getElementById('boomAngle').value = 0;
  document.getElementById('vBoomAngle').textContent = '0';
  update();
});
document.getElementById('presetMid').addEventListener('click', () => {
  state.boomAngle = 60;
  document.getElementById('boomAngle').value = 60;
  document.getElementById('vBoomAngle').textContent = '60';
  update();
});
document.getElementById('presetUp').addEventListener('click', () => {
  const a = currentDim.boomMaxAngle;
  state.boomAngle = a;
  document.getElementById('boomAngle').value = a;
  document.getElementById('vBoomAngle').textContent = a.toFixed(0);
  update();
});

// PDF印刷
document.getElementById('printBtn').addEventListener('click', () => window.print());

// ヘルプ
const help = document.getElementById('help');
document.getElementById('helpToggle').addEventListener('click', () => {
  help.classList.toggle('show');
});

// キーボード
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if (k === 'r') document.getElementById('viewIso').click();
  else if (k === 'f') document.getElementById('viewFront').click();
  else if (k === 's') document.getElementById('viewSide').click();
  else if (k === 't') document.getElementById('viewTop').click();
  else if (k === 'delete' && state.selectedObstacleId) deleteObstacle(state.selectedObstacleId);
});

// 初期化
setCrane('gr1000n');
resize();
refreshObstacleList();
animate();
