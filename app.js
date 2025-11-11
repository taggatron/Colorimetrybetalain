/*
  Colorimeter Simulator — Betalain (Beetroot)
  Beer–Lambert: A = ε(λ) * c * l
  Units: ε in L/(mol·cm), c in mol/L, l in cm
  UI sliders use mM; convert to M for calculations.
*/

// --- Parameters for betalain spectrum (representative, not exact) ---
const LAMBDA_PEAK_NM = 538;         // peak wavelength in nm
const EPSILON_MAX = 60000;          // peak molar absorptivity [L/(mol·cm)]
const SPECTRUM_SIGMA_NM = 35;       // spectral width (standard deviation)
const BASELINE_EPSILON = 150;       // small baseline

// Instrument/noise parameters
const NOISE_STD_A = 0.005;          // absorbance noise std dev
const DETECTOR_MAX = 1.0;           // normalized detector output for 0 absorbance

// Bleaching simulation
let bleaching = false;
let bleachTimer = null;
let bleachStartTime = null;

// --- DOM elements ---
const el = (id) => document.getElementById(id);
const wavelength = el('wavelength');
const concentration = el('concentration');
const wavelengthOut = el('wavelengthOut');
const concentrationOut = el('concentrationOut');
const absorbanceOut = el('absorbanceOut');
const transmittanceOut = el('transmittanceOut');
const detectorOut = el('detectorOut');
const noiseToggle = el('noiseToggle');
const measureBtn = el('measureBtn');
const clearCalibration = el('clearCalibration');
const autoCalibrateBtn = el('autoCalibrateBtn');
const resetAll = el('resetAll');
const downloadData = el('downloadData');
const bleachToggle = el('bleachToggle');
const bleachReset = el('bleachReset');
const bleachRate = el('bleachRate');
const bleachRateOut = el('bleachRateOut');
const calibStats = el('calibStats');
const advancedToggle = el('advancedToggle');
const advancedPanel = el('advancedPanel');

// Visualization elements
const instrumentSVG = el('instrumentSVG');
const beam = el('beam');
const photonsGroup = el('photons');
const solution = el('solution');
const detector = el('detector');

// --- Helpers ---
function gaussian(x, mu, sigma) {
  const a = (x - mu) / sigma;
  return Math.exp(-0.5 * a * a);
}

function epsilonAt(lambdaNm) {
  // Gaussian peak + baseline
  return EPSILON_MAX * gaussian(lambdaNm, LAMBDA_PEAK_NM, SPECTRUM_SIGMA_NM) + BASELINE_EPSILON;
}

function absorbance(lambdaNm, c_mM, l_cm) {
  const c_M = c_mM / 1000; // convert mM to M
  return epsilonAt(lambdaNm) * c_M * l_cm;
}

function transmittanceFromA(A) {
  // T = 10^{-A}
  return Math.pow(10, -A);
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function fmt(num, digits=3) { return Number.parseFloat(num).toFixed(digits); }

// --- Chart setup ---
let spectrumChart, calibrationChart, timeChart;
let calibrationData = []; // {c_mM, A}
let timeSeries = [];      // {t_min, c_mM}
let spectrumInitialized = false;
let timeChartInitialized = false;
let autoRunning = false;
let autoTimer = null;

function initCharts() {
  const labelColor = '#37474f';
  const gridColor = 'rgba(0,0,0,0.06)';

  // Calibration
  const calibCtx = document.getElementById('calibrationChart');
  calibrationChart = new Chart(calibCtx, {
    type: 'scatter',
    data: { datasets: [
      { label: 'Measurements', data: [], borderColor: '#3949ab', backgroundColor: 'rgba(63,81,181,.25)', showLine: false, pointRadius: 4 },
      { label: 'Fit', data: [], borderColor: '#ef6c00', backgroundColor: 'transparent', showLine: true, pointRadius: 0 }
    ]},
    options: {
      responsive: true,
      animation: { duration: 200 },
      plugins: { legend: { labels: { color: labelColor } } },
      scales: {
        x: { title: { text: 'Concentration (mM)', display: true, color: labelColor }, grid: { color: gridColor }, ticks: { color: labelColor } },
        y: { title: { text: 'Absorbance A', display: true, color: labelColor }, grid: { color: gridColor }, ticks: { color: labelColor }, suggestedMin: 0 }
      }
    }
  });

  // Spectrum and Time charts will be lazily initialized when their panels are opened
  function ensureSpectrumChart() {
    if (spectrumInitialized) return;
    const specCtx = document.getElementById('spectrumChart');
    spectrumChart = new Chart(specCtx, {
      type: 'line',
      data: { datasets: [
        { label: 'ε(λ) [L/(mol·cm)]', data: [], yAxisID: 'y1', borderColor: '#7e57c2', tension: .2, pointRadius: 0 },
        { label: 'A(λ)', data: [], yAxisID: 'y', borderColor: '#ef5350', tension: .2, pointRadius: 0 }
      ]},
      options: {
        responsive: true,
        animation: { duration: 300 },
        plugins: { legend: { labels: { color: labelColor } } },
        scales: {
          x: { title: { text: 'Wavelength (nm)', display: true, color: labelColor }, min: 380, max: 700, grid: { color: gridColor }, ticks: { color: labelColor } },
          y: { title: { text: 'Absorbance A', display: true, color: labelColor }, grid: { color: gridColor }, ticks: { color: labelColor }, suggestedMin: 0 },
          y1: { position: 'right', title: { text: 'ε', display: true, color: labelColor }, grid: { drawOnChartArea: false }, ticks: { color: labelColor }, suggestedMin: 0 }
        }
      }
    });
    spectrumInitialized = true;
    updateSpectrum();
  }

  function ensureTimeChart() {
    if (timeChartInitialized) return;
    const timeCtx = document.getElementById('timeChart');
    timeChart = new Chart(timeCtx, {
      type: 'line',
      data: { datasets: [
        { label: 'c(t) [mM]', data: [], borderColor: '#00897b', backgroundColor: 'rgba(0,137,123,.15)', tension: .2, pointRadius: 0 }
      ]},
      options: {
        responsive: true,
        animation: { duration: 0 },
        plugins: { legend: { labels: { color: labelColor } } },
        scales: {
          x: { title: { text: 'Time (min)', display: true, color: labelColor }, grid: { color: gridColor }, ticks: { color: labelColor } },
          y: { title: { text: 'Concentration (mM)', display: true, color: labelColor }, grid: { color: gridColor }, ticks: { color: labelColor }, suggestedMin: 0 }
        }
      }
    });
    timeChartInitialized = true;
    updateTimePlot();
  }

  // expose to other handlers
  initCharts.ensureSpectrumChart = ensureSpectrumChart;
  initCharts.ensureTimeChart = ensureTimeChart;
}

// Linear regression y = m x + b
function linearRegression(points) {
  const n = points.length;
  if (n < 2) return { m: 0, b: 0, r2: 0 };
  let sumx=0, sumy=0, sumxy=0, sumx2=0, sumy2=0;
  for (const p of points) {
    sumx += p.x; sumy += p.y; sumxy += p.x*p.y; sumx2 += p.x*p.x; sumy2 += p.y*p.y;
  }
  const denom = (n*sumx2 - sumx*sumx);
  const m = denom !== 0 ? (n*sumxy - sumx*sumy) / denom : 0;
  const b = (sumy - m*sumx) / n;
  const r_num = (n*sumxy - sumx*sumy);
  const r_den = Math.sqrt((n*sumx2 - sumx*sumx) * (n*sumy2 - sumy*sumy));
  const r = r_den !== 0 ? r_num / r_den : 0;
  return { m, b, r2: r*r };
}

function updateSpectrum() {
  if (!spectrumChart) return; // not initialized yet
  const l_cm = 1; // fixed path length (cm)
  const c_mM = parseFloat(concentration.value);
  const labels = [];
  const epsilonData = [];
  const Adata = [];
  for (let lam = 380; lam <= 700; lam += 2) {
    labels.push(lam);
    const eps = epsilonAt(lam);
    epsilonData.push({ x: lam, y: eps });
    Adata.push({ x: lam, y: absorbance(lam, c_mM, l_cm) });
  }
  spectrumChart.data.labels = labels;
  spectrumChart.data.datasets[0].data = epsilonData;
  spectrumChart.data.datasets[1].data = Adata;
  spectrumChart.update('none');
}

function updateCalibrationPlot() {
  const points = calibrationData.map(d => ({ x: d.c_mM, y: d.A }));
  calibrationChart.data.datasets[0].data = points;
  if (points.length >= 2) {
    const { m, b, r2 } = linearRegression(points);
    const xs = points.map(p => p.x);
    const minx = Math.min(...xs, 0);
    const maxx = Math.max(...xs, parseFloat(concentration.max));
    calibrationChart.data.datasets[1].data = [ { x: minx, y: m*minx + b }, { x: maxx, y: m*maxx + b } ];
    calibStats.textContent = `m = ${fmt(m,3)}, b = ${fmt(b,3)}, R² = ${fmt(r2,3)}`;
  } else {
    calibrationChart.data.datasets[1].data = [];
    calibStats.textContent = 'm = —, b = —, R² = —';
  }
  calibrationChart.update('none');
}

function updateTimePlot() {
  if (!timeChart) return; // not initialized yet
  timeChart.data.datasets[0].data = timeSeries.map(d => ({ x: d.t_min, y: d.c_mM }));
  timeChart.update('none');
}

function updateVisualization(A, T) {
  // Adjust beam opacity with T (more A => less T => lower opacity)
  const beamOpacity = clamp(0.15 + 0.85 * T, 0.05, 1);
  beam.style.opacity = beamOpacity.toString();

  // Solution color/opacity roughly tracks concentration (magenta hue)
  const c_mM = parseFloat(concentration.value);
  const hue = 275; // purple
  const sat = clamp(30 + c_mM * 25, 30, 95);
  const light = clamp(42 - c_mM * 10, 20, 60);
  solution.setAttribute('fill', `hsl(${hue} ${sat}% ${light}%)`);
  solution.setAttribute('opacity', `${clamp(0.5 + c_mM/3, 0.4, 0.9)}`);

  // Detector brightness
  const detectorOpacity = clamp(0.35 + 0.65 * T, 0.1, 1);
  detector.style.opacity = detectorOpacity.toString();
  if (T > 0.6) detector.classList.add('detector-glow'); else detector.classList.remove('detector-glow');

  // Photon dots: density based on T
  const targetCount = Math.round(12 + 80 * T);
  const current = photonsGroup.childElementCount;
  if (current < targetCount) {
    for (let i = current; i < targetCount; i++) {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('class', 'photon');
      c.setAttribute('cx', String(120 + Math.random()*520));
      c.setAttribute('cy', String(120 + (Math.random()-0.5)*24));
      c.setAttribute('r', String(1.5 + Math.random()*2.5));
      c.style.animationDuration = `${2.2 + Math.random()*1.8}s`;
      c.style.animationDelay = `${-Math.random()*3}s`;
      photonsGroup.appendChild(c);
    }
  } else if (current > targetCount) {
    for (let i = current; i > targetCount; i--) {
      photonsGroup.removeChild(photonsGroup.lastChild);
    }
  }
}

function updateAll() {
  const lam = parseFloat(wavelength.value);
  const c_mM = parseFloat(concentration.value);
  const l_cm = 1; // fixed path length (cm)

  const trueA = absorbance(lam, c_mM, l_cm);
  const noisyA = noiseToggle.checked ? trueA + randn() * NOISE_STD_A : trueA;
  const A = Math.max(0, noisyA);
  const T = transmittanceFromA(A);
  const signal = DETECTOR_MAX * T; // normalized

  wavelengthOut.textContent = `${Math.round(lam)}`;
  concentrationOut.textContent = fmt(c_mM, 2);
  absorbanceOut.textContent = fmt(A, 3);
  transmittanceOut.textContent = `${fmt(T*100,1)}%`;
  detectorOut.textContent = fmt(signal, 3);

  updateSpectrum();
  updateVisualization(A, T);
}

function randn() { // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// --- Event wiring ---
function attachEvents() {
  [wavelength, concentration, noiseToggle].forEach(inp => {
    inp.addEventListener('input', updateAll);
  });

  resetAll.addEventListener('click', () => {
    wavelength.value = 538;
    concentration.value = 0.5;
  // path length fixed at 1 cm
    noiseToggle.checked = true;
    calibrationData = [];
    updateCalibrationPlot();
    timeSeries = [];
    updateTimePlot();
    stopBleaching();
    updateAll();
  });

  measureBtn.addEventListener('click', () => {
    const lam = parseFloat(wavelength.value);
    const c_mM = parseFloat(concentration.value);
  const l_cm = 1; // fixed path length (cm)
    let A = absorbance(lam, c_mM, l_cm);
    if (noiseToggle.checked) A += randn() * NOISE_STD_A;
    A = Math.max(0, A);
    calibrationData.push({ c_mM, A });
    updateCalibrationPlot();
  });

  clearCalibration.addEventListener('click', () => {
    calibrationData = [];
    updateCalibrationPlot();
  });

  // Auto calibration
  autoCalibrateBtn.addEventListener('click', () => {
    if (autoRunning) {
      stopAutoCalibration();
    } else {
      startAutoCalibration();
    }
  });

  downloadData.addEventListener('click', () => {
    const rows = [['concentration_mM','absorbance_A'], ...calibrationData.map(d => [d.c_mM, d.A])];
    const csv = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'calibration.csv'; a.click();
    URL.revokeObjectURL(url);
  });

  // Bleaching controls
  bleachRate.addEventListener('input', () => {
    bleachRateOut.textContent = fmt(parseFloat(bleachRate.value), 3);
  });

  bleachToggle.addEventListener('click', () => {
    if (bleaching) stopBleaching(); else startBleaching();
  });

  bleachReset.addEventListener('click', () => {
    stopBleaching();
    concentration.value = 0.5;
    timeSeries = [];
    updateTimePlot();
    updateAll();
  });

  // Advanced toggle
  advancedToggle.addEventListener('click', () => {
    const isHidden = advancedPanel.classList.contains('is-hidden');
    if (isHidden) {
      advancedPanel.classList.remove('is-hidden');
      advancedToggle.setAttribute('aria-expanded', 'true');
    } else {
      // Hide and stop any ongoing bleaching
      stopBleaching();
      advancedPanel.classList.add('is-hidden');
      advancedToggle.setAttribute('aria-expanded', 'false');
    }
  });

  // Sub toggles: Spectrum and Bleaching
  const toggleSpectrum = document.getElementById('toggleSpectrum');
  const spectrumPanel = document.getElementById('spectrumPanel');
  toggleSpectrum.addEventListener('click', () => {
    const hidden = spectrumPanel.classList.contains('is-hidden');
    if (hidden) {
      spectrumPanel.classList.remove('is-hidden');
      toggleSpectrum.setAttribute('aria-expanded', 'true');
      initCharts.ensureSpectrumChart();
      // Resize after panel opens
      setTimeout(() => spectrumChart && spectrumChart.resize(), 0);
      updateAll();
    } else {
      spectrumPanel.classList.add('is-hidden');
      toggleSpectrum.setAttribute('aria-expanded', 'false');
    }
  });

  const toggleBleaching = document.getElementById('toggleBleaching');
  const bleachingPanel = document.getElementById('bleachingPanel');
  toggleBleaching.addEventListener('click', () => {
    const hidden = bleachingPanel.classList.contains('is-hidden');
    if (hidden) {
      bleachingPanel.classList.remove('is-hidden');
      toggleBleaching.setAttribute('aria-expanded', 'true');
      initCharts.ensureTimeChart();
      setTimeout(() => timeChart && timeChart.resize(), 0);
    } else {
      stopBleaching();
      bleachingPanel.classList.add('is-hidden');
      toggleBleaching.setAttribute('aria-expanded', 'false');
    }
  });
}

function startBleaching() {
  if (bleaching) return;
  bleaching = true;
  bleachToggle.textContent = 'Stop bleaching';
  bleachStartTime = performance.now();
  const c0 = parseFloat(concentration.value);
  timeSeries = [{ t_min: 0, c_mM: c0 }];
  const k = parseFloat(bleachRate.value); // 1/min
  const startTs = performance.now();
  let lastTs = startTs;
  bleachTimer = setInterval(() => {
    const now = performance.now();
    const dt_min = (now - lastTs) / 60000; // ms -> min
    lastTs = now;
    const c = parseFloat(concentration.value);
    const cNew = c * Math.exp(-k * dt_min);
    concentration.value = String(cNew);

    const t_min = (now - startTs) / 60000;
    timeSeries.push({ t_min, c_mM: cNew });
    if (timeSeries.length > 600) timeSeries.shift();
    updateTimePlot();
    updateAll();
  }, 250);
}

function stopBleaching() {
  if (!bleaching) return;
  bleaching = false;
  bleachToggle.textContent = 'Start bleaching';
  clearInterval(bleachTimer);
  bleachTimer = null;
}

// --- Auto calibration sequence ---
function startAutoCalibration() {
  if (autoRunning) return;
  autoRunning = true;
  autoCalibrateBtn.textContent = '⏹ Stop auto';
  autoCalibrateBtn.setAttribute('aria-pressed', 'true');
  // Disable conflicting actions
  measureBtn.disabled = true;
  clearCalibration.disabled = true;
  wavelength.disabled = true;

  // Build concentrations from 0 to slider max (or 1.0 mM if larger), 11 steps
  const cMax = Math.min(1.0, parseFloat(concentration.max || '1'));
  const steps = 11;
  const targets = Array.from({ length: steps }, (_, i) => +(cMax * i / (steps - 1)).toFixed(3));

  // Start with a fresh calibration
  calibrationData = [];
  updateCalibrationPlot();

  const originalC = parseFloat(concentration.value);
  const lam = parseFloat(wavelength.value);
  let idx = 0;
  autoTimer = setInterval(() => {
    if (idx >= targets.length) {
      stopAutoCalibration(originalC);
      return;
    }
    const c_mM = targets[idx++];
    concentration.value = String(c_mM);
    updateAll(); // animate instrument view with new T
    const Atrue = absorbance(lam, c_mM, 1);
    const A = Math.max(0, noiseToggle.checked ? Atrue + randn()*NOISE_STD_A : Atrue);
    calibrationData.push({ c_mM, A });
    updateCalibrationPlot();
  }, 300);
}

function stopAutoCalibration(restoreC = null) {
  if (!autoRunning) return;
  autoRunning = false;
  clearInterval(autoTimer);
  autoTimer = null;
  autoCalibrateBtn.textContent = '📈 Auto calibrate';
  autoCalibrateBtn.setAttribute('aria-pressed', 'false');
  // Re-enable controls
  measureBtn.disabled = false;
  clearCalibration.disabled = false;
  wavelength.disabled = false;
  if (restoreC != null) {
    concentration.value = String(restoreC);
    updateAll();
  }
}

// --- Boot ---
window.addEventListener('DOMContentLoaded', () => {
  initCharts();
  attachEvents();
  updateAll();
});
