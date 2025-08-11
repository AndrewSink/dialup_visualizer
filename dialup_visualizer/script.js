// Three.js r140 via import map defined in index.html
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// -------- DOM --------
const container = document.getElementById('canvas-container');
const playBtn = document.getElementById('playBtn');
const resetBtn = document.getElementById('resetBtn');
const fileInput = document.getElementById('fileInput');
const exportBtn = document.getElementById('exportBtn');
const audioEl = document.getElementById('audioEl');

// -------- Audio setup --------
const audioContext = new (window.AudioContext || window.webkitAudioContext)();
const audioSource = audioContext.createMediaElementSource(audioEl);
const analyser = audioContext.createAnalyser();
analyser.fftSize = 1024; // 512 freq bins
analyser.smoothingTimeConstant = 0.85;
audioSource.connect(analyser);
analyser.connect(audioContext.destination);

const freqBinCount = analyser.frequencyBinCount; // 512
const freqData = new Uint8Array(freqBinCount);

// -------- 3D Scene --------
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.setClearColor(0x000000, 1);
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();

// Camera angled for a perspective similar to the reference video
const camera = new THREE.PerspectiveCamera(
  55,
  container.clientWidth / container.clientHeight,
  0.1,
  2000
);
camera.position.set(90, 55, 120);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.minDistance = 30;
controls.maxDistance = 400;
controls.maxPolarAngle = Math.PI * 0.49;
// Mouse mappings: middle to pan, right to orbit
controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
// Avoid browser context menu on right-click when orbiting
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

// Lighting to bring out surface relief
scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const dir = new THREE.DirectionalLight(0xffffff, 0.9);
dir.position.set(1, 2, 1);
scene.add(dir);

// No vertical reference grid; will add a ground grid below instead

// -------- Spectrogram surface --------
// X axis: time (scrolling towards +X). Z axis: frequency bins. Y axis: amplitude.
const pointsPerSlice = 128; // downsample frequency bins for performance
const sliceStride = Math.floor(freqBinCount / pointsPerSlice);
// Visual shaping across frequency axis: spread lows, compress empty highs
const activeFrequencyFraction = 0.75; // show first ~75% of rows; collapse the rest
const frequencyExponent = 0.65; // <1 spreads low/mid frequencies
const noiseFloor = 0.03; // ignore very small magnitudes

const numSlices = 1024; // extended history depth for longer visible timeline
const width = 400; // x extent (time)
const depth = 80; // z extent (frequency)
const heightScale = 0.6; // amplitude scale

let geometry = new THREE.PlaneGeometry(width, depth, numSlices - 1, pointsPerSlice - 1);
geometry.rotateX(-Math.PI / 2); // make Y up

// Starting positions: x from -width/2 .. +width/2, z from -depth/2 .. +depth/2
const positionAttr = geometry.attributes.position;
// Custom color per vertex for a heat map effect
const colors = new Float32Array(positionAttr.count * 3);
geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

const material = new THREE.MeshLambertMaterial({
  side: THREE.DoubleSide,
  vertexColors: true,
  emissive: new THREE.Color(0x0),
});

const surface = new THREE.Mesh(geometry, material);
surface.position.x = 0; // center over ground grid
scene.add(surface);

// Removed helper ground grid

// Precompute Z positions per frequency row with nonlinear mapping and collapse of highs
const zMin = -depth / 2;
const zMax = depth / 2;
const activeRows = Math.max(2, Math.floor(pointsPerSlice * activeFrequencyFraction));
const zRowPositions = new Float32Array(pointsPerSlice);
for (let z = 0; z < pointsPerSlice; z++) {
  if (z < activeRows) {
    const t = z / (activeRows - 1);
    const tExp = Math.pow(t, frequencyExponent);
    zRowPositions[z] = zMin + tExp * (zMax - zMin);
  } else {
    zRowPositions[z] = zMax; // collapse unused high frequencies
  }
}
// Apply to initial geometry Z coordinates
const posArrayInit = positionAttr.array;
for (let z = 0; z < pointsPerSlice; z++) {
  const rowStart = z * numSlices;
  const zVal = zRowPositions[z];
  for (let x = 0; x < numSlices; x++) {
    const i3 = (rowStart + x) * 3;
    posArrayInit[i3 + 2] = zVal;
  }
}
positionAttr.needsUpdate = true;

// Maintain a continuous scroll by shifting historic columns left
let isCapturing = false;
let hasEnded = false;
const capturedSlices = []; // array of Float32Array(length: pointsPerSlice)
const baseThickness = 4; // export base thickness (units ~ same as scene)
const backThickness = 6; // small back slab thickness along -Z for printability

function updateSurfaceFromFrequencies() {
  analyser.getByteFrequencyData(freqData);

  // Normalize and map to 0..1 with a subtle curve
  const newSlice = new Float32Array(pointsPerSlice);
  for (let i = 0; i < pointsPerSlice; i++) {
    const srcIndex = Math.min(freqBinCount - 1, i * sliceStride);
    let bin = freqData[srcIndex] / 255;
    if (bin < noiseFloor && i >= activeRows) bin = 0; // keep highs zero unless strong
    // Slight emphasis on mid-highs to echo the modem's chirps
    const emphasized = Math.pow(bin, 1.2);
    newSlice[i] = emphasized;
  }

  // Persist the full-resolution slice for export later
  if (isCapturing) {
    capturedSlices.push(newSlice.slice());
  }

  // For each z-row (frequency), left-shift all columns by one and append new slice at the end
  const rowSize = numSlices; // vertices along X
  const posArray = positionAttr.array;
  for (let z = 0; z < pointsPerSlice; z++) {
    const rowStartVertex = z * rowSize;
    // shift left (copy from x+1 -> x)
    for (let x = 0; x < rowSize - 1; x++) {
      const fromV = rowStartVertex + x + 1;
      const toV = rowStartVertex + x;
      // y component is index *3 + 1
      posArray[toV * 3 + 1] = posArray[fromV * 3 + 1];
      const fromC = fromV * 3;
      const toC = toV * 3;
      colors[toC + 0] = colors[fromC + 0];
      colors[toC + 1] = colors[fromC + 1];
      colors[toC + 2] = colors[fromC + 2];
    }

    // insert newest at the rightmost column
    const lastV = rowStartVertex + rowSize - 1;
    const y = newSlice[z] * depth * heightScale;
    posArray[lastV * 3 + 1] = y;

    // Color mapping: reference-style ramp (red/yellow at low, blue at high)
    const t = newSlice[z];
    const color = referenceColorRamp(t);
    const lastC = lastV * 3;
    colors[lastC + 0] = color.r;
    colors[lastC + 1] = color.g;
    colors[lastC + 2] = color.b;
  }

  positionAttr.needsUpdate = true;
  geometry.attributes.color.needsUpdate = true;
}

// Color ramp designed to match the reference look:
// - Lower amplitude → warm reds/oranges/yellows
// - Higher amplitude → cool cyans/blues
function referenceColorRamp(t) {
  const v = Math.min(1, Math.max(0, t));
  const ramp = [
    { s: 0.00, c: [0.55, 0.00, 0.00] }, // deep red
    { s: 0.15, c: [1.00, 0.13, 0.00] }, // red-orange
    { s: 0.30, c: [1.00, 0.75, 0.00] }, // amber
    { s: 0.45, c: [1.00, 1.00, 0.00] }, // yellow
    { s: 0.65, c: [0.12, 0.86, 1.00] }, // cyan
    { s: 0.82, c: [0.00, 0.46, 1.00] }, // blue
    { s: 1.00, c: [0.00, 0.12, 0.70] }, // deep blue
  ];

  // Find segment
  for (let i = 0; i < ramp.length - 1; i++) {
    const a = ramp[i];
    const b = ramp[i + 1];
    if (v >= a.s && v <= b.s) {
      const t01 = (v - a.s) / (b.s - a.s);
      return {
        r: a.c[0] + (b.c[0] - a.c[0]) * t01,
        g: a.c[1] + (b.c[1] - a.c[1]) * t01,
        b: a.c[2] + (b.c[2] - a.c[2]) * t01,
      };
    }
  }
  const last = ramp[ramp.length - 1].c;
  return { r: last[0], g: last[1], b: last[2] };
}

// Removed axis annotation sprites

// -------- Animation loop --------
let isRendering = true;
function animate() {
  if (!isRendering) return;
  requestAnimationFrame(animate);
  if (!audioEl.paused && !hasEnded) {
    updateSurfaceFromFrequencies();
  }
  controls.update();
  renderer.render(scene, camera);
}
animate();

// -------- Events --------
function resize() {
  const { clientWidth, clientHeight } = container;
  renderer.setSize(clientWidth, clientHeight);
  camera.aspect = clientWidth / clientHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

function setPlayButtonState(isPlaying) {
  if (isPlaying) {
    playBtn.textContent = 'Pause';
    playBtn.classList.remove('bg-emerald-600','hover:bg-emerald-500');
    playBtn.classList.add('bg-yellow-500','hover:bg-yellow-400');
  } else {
    playBtn.textContent = 'Play';
    playBtn.classList.remove('bg-yellow-500','hover:bg-yellow-400');
    playBtn.classList.add('bg-emerald-600','hover:bg-emerald-500');
  }
}

playBtn.addEventListener('click', async () => {
  if (audioEl.paused) {
    if (audioContext.state === 'suspended') await audioContext.resume();
    try { await audioEl.play(); } catch (e) { /* ignore */ }
    isCapturing = true;
    setPlayButtonState(true);
  } else {
    audioEl.pause();
    isCapturing = false;
    setPlayButtonState(false);
  }
});

resetBtn.addEventListener('click', () => {
  audioEl.pause();
  audioEl.currentTime = 0;
  setPlayButtonState(false);
  hasEnded = false;
  isCapturing = false;
  capturedSlices.length = 0;
  resetVisualization();
});

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  audioEl.src = url;
  if (audioContext.state === 'suspended') await audioContext.resume();
  audioEl.play();
  isCapturing = true;
});

// Drag & drop support
window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  audioEl.src = url;
  audioEl.play();
  isCapturing = true;
});

// Auto-start visualization when audio starts
audioEl.addEventListener('play', () => {
  if (audioContext.state === 'suspended') audioContext.resume();
  setPlayButtonState(true);
});

audioEl.addEventListener('ended', () => {
  hasEnded = true;
  isCapturing = false;
  finalizeModelGeometry();
  // keep export enabled for partial or full
  setPlayButtonState(false);
});

exportBtn.addEventListener('click', () => {
  if (capturedSlices.length < 2) {
    // If user exports early, synthesize from current displayed geometry
    // by sampling visible vertices so export always works
    synthesizeCapturedFromSurface();
  }
  const { objText, mtlText } = buildOBJFromCaptured();
  downloadTextAsFile('dialup_spectrogram.mtl', mtlText);
  downloadTextAsFile('dialup_spectrogram.obj', objText);
});

// Rebuild the surface geometry to display the full captured model when playback finishes
function finalizeModelGeometry() {
  const slices = capturedSlices.length;
  if (slices < 2) return;
  const dx = width / (numSlices - 1);
  const finalWidth = dx * (slices - 1);
  const newGeo = new THREE.PlaneGeometry(finalWidth, depth, slices - 1, pointsPerSlice - 1);
  newGeo.rotateX(-Math.PI / 2);

  const pos = newGeo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  newGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));

  const z0 = -depth / 2;
  const dz = depth / (pointsPerSlice - 1);
  // Fill Y and color from captured data
  for (let z = 0; z < pointsPerSlice; z++) {
    for (let x = 0; x < slices; x++) {
      const idx = z * slices + x;
      const amp = capturedSlices[x][z];
      const y = amp * depth * heightScale;
      pos.setY(idx, y);
      const color = referenceColorRamp(amp);
      const cIdx = idx * 3;
      col[cIdx + 0] = color.r;
      col[cIdx + 1] = color.g;
      col[cIdx + 2] = color.b;
    }
  }
  pos.needsUpdate = true;
  newGeo.attributes.color.needsUpdate = true;
  surface.geometry.dispose();
  geometry = newGeo;
  surface.geometry = geometry;
}

// If user exports before capture has enough slices, sample the on-screen geometry
function synthesizeCapturedFromSurface() {
  const pos = geometry.attributes.position;
  // Determine current visible slices from geometry's segments along X
  const totalVertices = pos.count;
  const slices = Math.max(2, Math.floor(totalVertices / pointsPerSlice));
  capturedSlices.length = 0;
  for (let x = 0; x < slices; x++) {
    const slice = new Float32Array(pointsPerSlice);
    for (let z = 0; z < pointsPerSlice; z++) {
      const idx = z * slices + x;
      const y = pos.getY(idx);
      slice[z] = Math.max(0, Math.min(1, y / (depth * heightScale)));
    }
    capturedSlices.push(slice);
  }
}

// Build a watertight OBJ + MTL. Colors are assigned per-face via materials.
function buildOBJFromCaptured() {
  const slices = capturedSlices.length;
  const activeRowsCount = Math.max(2, Math.floor(pointsPerSlice * activeFrequencyFraction));
  // Use only the active frequency band plus one front boundary row to avoid degenerate cells
  const bins = activeRowsCount + 1;
  const dx = width / (numSlices - 1);
  const dz = depth / (bins - 1);
  const exportWidth = dx * (slices - 1);
  const x0 = -exportWidth / 2;
  const z0 = -depth / 2;
  const backZ = z0 - backThickness;

  const v = [];
  const f = [];
  const vx = []; const vy = []; const vz = [];
  const indexTop = Array.from({ length: slices }, () => new Array(bins));
  const yTop = Array.from({ length: slices }, () => new Array(bins));

  // Material palette (quantized RGB -> material)
  const materials = new Map(); // key -> { name, r, g, b }
  function materialNameForColor(color) {
    const ir = Math.round(Math.max(0, Math.min(1, color.r)) * 255);
    const ig = Math.round(Math.max(0, Math.min(1, color.g)) * 255);
    const ib = Math.round(Math.max(0, Math.min(1, color.b)) * 255);
    const key = `${ir}_${ig}_${ib}`;
    if (!materials.has(key)) {
      const name = `c_${key}`;
      materials.set(key, { name, r: ir / 255, g: ig / 255, b: ib / 255 });
    }
    return materials.get(key).name;
  }
  const baseColor = { r: 0.7, g: 0.7, b: 0.7 };
  const baseMat = materialNameForColor(baseColor);

  function pushV(x, y, z, r, g, b) {
    v.push(`v ${x.toFixed(5)} ${y.toFixed(5)} ${z.toFixed(5)}`);
    vx.push(x); vy.push(y); vz.push(z);
    return v.length; // 1-based index
  }

  function emitFace(i1, i2, i3, desired, matName) {
    // Orient triangle so its normal generally points along 'desired'
    const a = i1 - 1, b = i2 - 1, c = i3 - 1;
    const abx = vx[b] - vx[a], aby = vy[b] - vy[a], abz = vz[b] - vz[a];
    const acx = vx[c] - vx[a], acy = vy[c] - vy[a], acz = vz[c] - vz[a];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const dot = nx * desired.x + ny * desired.y + nz * desired.z;
    f.push(`usemtl ${matName}`);
    if (dot >= 0) {
      f.push(`f ${i1} ${i2} ${i3}`);
    } else {
      f.push(`f ${i1} ${i3} ${i2}`);
    }
  }

  const OUT_TOP = { x: 0, y: 1, z: 0 };
  const OUT_BOTTOM = { x: 0, y: -1, z: 0 };
  const OUT_FRONT = { x: 0, y: 0, z: 1 };
  const OUT_BACK = { x: 0, y: 0, z: -1 };
  const OUT_LEFT = { x: -1, y: 0, z: 0 };
  const OUT_RIGHT = { x: 1, y: 0, z: 0 };

  // Top vertices with color (clamp near-flat to exact 0 to enable merging)
  const flatEps = 0.02 * depth * heightScale;
  for (let i = 0; i < slices; i++) {
    const x = x0 + dx * i;
    const slice = capturedSlices[i];
    for (let j = 0; j < bins; j++) {
      // Use same nonlinear Z placement used in the live view
      let z;
      if (j < activeRowsCount) {
        const t = j / (activeRowsCount - 1);
        const tExp = Math.pow(t, frequencyExponent);
        z = z0 + tExp * depth;
      } else {
        z = z0 + depth;
      }
      const amp = j < activeRowsCount ? slice[j] : 0; // collapse highs
      let y = amp * depth * heightScale;
      if (y < flatEps) y = 0;
      yTop[i][j] = y;
      const c = referenceColorRamp(amp);
      indexTop[i][j] = pushV(x, y, z, c.r, c.g, c.b);
    }
  }

  // Base bottom vertices: polyline along back (dense, manifold with back wall), and one row along front
  const baseBack = new Array(slices);
  for (let i = 0; i < slices; i++) {
    const x = x0 + dx * i;
    baseBack[i] = pushV(x, -baseThickness, z0, baseColor.r, baseColor.g, baseColor.b);
  }
  const baseFront = new Array(slices);
  for (let i = 0; i < slices; i++) {
    const x = x0 + dx * i;
    baseFront[i] = pushV(x, -baseThickness, z0 + depth, baseColor.r, baseColor.g, baseColor.b);
  }

  // Back printable slab: thin wall behind the rear plane
  const slabZ = z0 - backThickness;
  const slabTop = new Array(slices);
  const slabBottom = new Array(slices);
  for (let i = 0; i < slices; i++) {
    const x = x0 + dx * i;
    slabTop[i] = pushV(x, 0, slabZ, baseColor.r, baseColor.g, baseColor.b);
    slabBottom[i] = pushV(x, -baseThickness, slabZ, baseColor.r, baseColor.g, baseColor.b);
  }
  // Back top zero-height edge along z0 to square off rear faces (horizontal shelf start)
  const backZero = new Array(slices);
  for (let i = 0; i < slices; i++) {
    const x = x0 + dx * i;
    backZero[i] = pushV(x, 0, z0, baseColor.r, baseColor.g, baseColor.b);
  }

  // Triangulate top surface with coplanar merge on near-flat regions
  // Build a boolean grid of flat cells
  const flatCell = Array.from({ length: slices - 1 }, () => new Array(bins - 1).fill(false));
  for (let i = 0; i < slices - 1; i++) {
    for (let j = 0; j < bins - 1; j++) {
      const y00 = yTop[i][j];
      const y10 = yTop[i + 1][j];
      const y01 = yTop[i][j + 1];
      const y11 = yTop[i + 1][j + 1];
      flatCell[i][j] = y00 === 0 && y10 === 0 && y01 === 0 && y11 === 0;
    }
  }
  const visited = Array.from({ length: slices - 1 }, () => new Array(bins - 1).fill(false));
  for (let j = 0; j < bins - 1; j++) {
    for (let i = 0; i < slices - 1; i++) {
      if (visited[i][j]) continue;
      if (!flatCell[i][j]) {
        // Emit normal two triangles for this single non-flat cell
        const a = indexTop[i][j];
        const bIdx = indexTop[i + 1][j];
        const cIdx = indexTop[i + 1][j + 1];
        const d = indexTop[i][j + 1];
        // Face colors from average height (approx amplitude)
        const scale = depth * heightScale;
        const t1 = (yTop[i][j] + yTop[i + 1][j] + yTop[i + 1][j + 1]) / (3 * scale);
        const t2 = (yTop[i][j] + yTop[i + 1][j + 1] + yTop[i][j + 1]) / (3 * scale);
        const c1 = referenceColorRamp(Math.max(0, Math.min(1, t1)));
        const c2 = referenceColorRamp(Math.max(0, Math.min(1, t2)));
        emitFace(a, bIdx, cIdx, OUT_TOP, materialNameForColor(c1));
        emitFace(a, cIdx, d, OUT_TOP, materialNameForColor(c2));
        visited[i][j] = true;
        continue;
      }
      // Flat cell: grow a rectangle (i..iW, j..jH)
      let iW = i;
      while (iW + 1 < slices - 1 && flatCell[iW + 1][j] && !visited[iW + 1][j]) iW++;
      let jH = j;
      let grow = true;
      while (grow && jH + 1 < bins - 1) {
        for (let k = i; k <= iW; k++) {
          if (!flatCell[k][jH + 1] || visited[k][jH + 1]) { grow = false; break; }
        }
        if (grow) jH++;
      }
      // Emit two triangles covering the rectangle
      const a = indexTop[i][j];
      const bIdx = indexTop[iW + 1][j];
      const cIdx = indexTop[iW + 1][jH + 1];
      const d = indexTop[i][jH + 1];
      emitFace(a, bIdx, cIdx, OUT_TOP, baseMat);
      emitFace(a, cIdx, d, OUT_TOP, baseMat);
      // Mark visited
      for (let jj = j; jj <= jH; jj++) {
        for (let ii = i; ii <= iW; ii++) visited[ii][jj] = true;
      }
    }
  }

  // Close the front seam at the nonlinear-mapping boundary to avoid gaps
  const jBoundary = Math.max(0, Math.min(bins - 2, activeRowsCount - 1));
  for (let i = 0; i < slices - 1; i++) {
    const a0 = indexTop[i][jBoundary];
    const a1 = indexTop[i + 1][jBoundary];
    const b0 = indexTop[i][jBoundary + 1];
    const b1 = indexTop[i + 1][jBoundary + 1];
    emitFace(a0, a1, b1, OUT_FRONT, baseMat);
    emitFace(a0, b1, b0, OUT_FRONT, baseMat);
  }

  // Triangulate bottom surface as a single strip (2*(slices-1) triangles)
  for (let i = 0; i < slices - 1; i++) {
    const b0 = baseBack[i];
    const b1 = baseBack[i + 1];
    const f0 = baseFront[i];
    const f1 = baseFront[i + 1];
    emitFace(b0, b1, f1, OUT_BOTTOM, baseMat);
    emitFace(b0, f1, f0, OUT_BOTTOM, baseMat);
  }

  // Side walls: connect top borders to base back/front strips
  // Back edge z = z0 → vertical wall using baseBack[i]
  for (let i = 0; i < slices - 1; i++) {
    const aTop = indexTop[i][0];
    const bTop = indexTop[i + 1][0];
    const aBot = baseBack[i];
    const bBot = baseBack[i + 1];
    // Consistent diagonal aTop -> bBot
    emitFace(aTop, aBot, bBot, OUT_BACK, baseMat);
    emitFace(aTop, bBot, bTop, OUT_BACK, baseMat);
  }
  // Square off the back: vertical cap from top edge down to y=0 at z0, then a horizontal shelf from z0 to slabZ at y=0
  // Vertical cap at z0
  for (let i = 0; i < slices - 1; i++) {
    const t0 = indexTop[i][0];
    const t1 = indexTop[i + 1][0];
    const e0 = backZero[i];
    const e1 = backZero[i + 1];
    emitFace(t0, e0, e1, OUT_BACK, baseMat);
    emitFace(t0, e1, t1, OUT_BACK, baseMat);
  }
  // Horizontal shelf from z0 to slabZ at y=0
  for (let i = 0; i < slices - 1; i++) {
    const e0 = backZero[i];
    const e1 = backZero[i + 1];
    const s0 = slabTop[i];
    const s1 = slabTop[i + 1];
    emitFace(e0, e1, s1, OUT_TOP, baseMat);
    emitFace(e0, s1, s0, OUT_TOP, baseMat);
  }
  // Close slab back rectangle and connect to base
  for (let i = 0; i < slices - 1; i++) {
    const st0 = slabTop[i];
    const st1 = slabTop[i + 1];
    const sb0 = slabBottom[i];
    const sb1 = slabBottom[i + 1];
    emitFace(st0, st1, sb1, OUT_BACK, baseMat);
    emitFace(st0, sb1, sb0, OUT_BACK, baseMat);
  }
  // Join slab bottom with base back edge
  for (let i = 0; i < slices - 1; i++) {
    const sb0 = slabBottom[i];
    const sb1 = slabBottom[i + 1];
    const bb0 = baseBack[i];
    const bb1 = baseBack[i + 1];
    emitFace(bb0, sb0, sb1, OUT_BOTTOM, baseMat);
    emitFace(bb0, sb1, bb1, OUT_BOTTOM, baseMat);
  }

  // Close left and right side faces of the squared back shelf (top and bottom)
  // Left side (x = x0)
  (function() {
    const e = backZero[0];
    const st = slabTop[0];
    const sb = slabBottom[0];
    const bb = baseBack[0];
    // Vertical outer face on the side of the shelf
    emitFace(e, st, sb, OUT_LEFT, baseMat);
    emitFace(e, sb, bb, OUT_LEFT, baseMat);
  })();
  // Right side (x = x0 + exportWidth)
  ;(function() {
    const e = backZero[slices - 1];
    const st = slabTop[slices - 1];
    const sb = slabBottom[slices - 1];
    const bb = baseBack[slices - 1];
    emitFace(e, sb, st, OUT_RIGHT, baseMat);
    emitFace(e, bb, sb, OUT_RIGHT, baseMat);
  })();
  // Front edge z = z0 + depth → vertical wall using baseFront[i]
  for (let i = 0; i < slices - 1; i++) {
    const aTop = indexTop[i][bins - 1];
    const bTop = indexTop[i + 1][bins - 1];
    const aBot = baseFront[i];
    const bBot = baseFront[i + 1];
    // Consistent diagonal aTop -> bBot
    emitFace(aTop, aBot, bBot, OUT_FRONT, baseMat);
    emitFace(aTop, bBot, bTop, OUT_FRONT, baseMat);
  }
  // Side walls (left and right) with per-row bottoms to avoid giant triangles
  // Precompute side bottoms along Z
  const sideBottomLeft = new Array(bins);
  const sideBottomRight = new Array(bins);
  const activeRows = bins - 1; // since we truncated to active band + boundary
  for (let j = 0; j < bins; j++) {
    let z;
    if (j < activeRows) {
      const t = j / (activeRows - 1);
      const tExp = Math.pow(t, frequencyExponent);
      z = z0 + tExp * depth;
    } else {
      z = z0 + depth;
    }
    sideBottomLeft[j] = pushV(x0, -baseThickness, z, baseColor.r, baseColor.g, baseColor.b);
    sideBottomRight[j] = pushV(x0 + exportWidth, -baseThickness, z, baseColor.r, baseColor.g, baseColor.b);
  }
  // Left wall
  for (let j = 0; j < bins - 1; j++) {
    const aTop = indexTop[0][j];
    const bTop = indexTop[0][j + 1];
    const aBot = sideBottomLeft[j];
    const bBot = sideBottomLeft[j + 1];
    // Consistent diagonal aTop -> bBot
    emitFace(aTop, aBot, bBot, OUT_LEFT, baseMat);
    emitFace(aTop, bBot, bTop, OUT_LEFT, baseMat);
  }
  // Ensure seam closed at top/bottom of left wall
  emitFace(indexTop[0][bins - 2], indexTop[0][bins - 1], sideBottomLeft[bins - 1], OUT_LEFT, baseMat);
  emitFace(indexTop[0][bins - 2], sideBottomLeft[bins - 1], sideBottomLeft[bins - 2], OUT_LEFT, baseMat);
  // Right wall
  for (let j = 0; j < bins - 1; j++) {
    const aTop = indexTop[slices - 1][j];
    const bTop = indexTop[slices - 1][j + 1];
    const aBot = sideBottomRight[j];
    const bBot = sideBottomRight[j + 1];
    // Consistent diagonal aTop -> bBot
    emitFace(aTop, aBot, bBot, OUT_RIGHT, baseMat);
    emitFace(aTop, bBot, bTop, OUT_RIGHT, baseMat);
  }
  emitFace(indexTop[slices - 1][bins - 2], sideBottomRight[bins - 2], indexTop[slices - 1][bins - 1], OUT_RIGHT, baseMat);
  emitFace(indexTop[slices - 1][bins - 1], sideBottomRight[bins - 2], sideBottomRight[bins - 1], OUT_RIGHT, baseMat);

  // No extra projection behind the rear plane; clipped at z0

  const header = [
    '# Dial-up spectrogram export',
    'mtllib dialup_spectrogram.mtl',
    'g spectrogram',
  ];
  const objText = header.concat(v).concat(f).join('\n');

  // Build MTL text from used materials
  const mtlLines = ['# Materials'];
  // Ensure baseMat defined
  const baseKey = `${Math.round(baseColor.r*255)}_${Math.round(baseColor.g*255)}_${Math.round(baseColor.b*255)}`;
  if (!materials.has(baseKey)) materials.set(baseKey, { name: baseMat, r: baseColor.r, g: baseColor.g, b: baseColor.b });
  for (const { name, r, g, b } of materials.values()) {
    mtlLines.push(`newmtl ${name}`);
    mtlLines.push(`Kd ${r.toFixed(6)} ${g.toFixed(6)} ${b.toFixed(6)}`);
    mtlLines.push('Ka 0 0 0');
    mtlLines.push('Ks 0 0 0');
    mtlLines.push('illum 1');
    mtlLines.push('d 1');
    mtlLines.push('');
  }
  const mtlText = mtlLines.join('\n');
  return { objText, mtlText };
}

function downloadTextAsFile(filename, text) {
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Clear the current visualization back to a flat plane and base color
function resetVisualization() {
  const posArray = geometry.attributes.position.array;
  const baseColor = referenceColorRamp(0);
  for (let i = 0; i < positionAttr.count; i++) {
    posArray[i * 3 + 1] = 0; // y
    const ci = i * 3;
    colors[ci + 0] = baseColor.r;
    colors[ci + 1] = baseColor.g;
    colors[ci + 2] = baseColor.b;
  }
  positionAttr.needsUpdate = true;
  geometry.attributes.color.needsUpdate = true;
}

// Cleanup on hot reload
window.addEventListener('beforeunload', () => {
  isRendering = false;
  try { audioEl.pause(); } catch {}
});


