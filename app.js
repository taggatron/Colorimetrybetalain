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
const unknownBtn = el('unknownBtn');
const resetAll = el('resetAll');
const downloadData = el('downloadData');
const bleachToggle = el('bleachToggle');
const bleachReset = el('bleachReset');
const bleachRate = el('bleachRate');
const bleachRateOut = el('bleachRateOut');
const calibStats = el('calibStats');
const advancedToggle = el('advancedToggle');
const advancedPanel = el('advancedPanel');
const unknownOverlay = el('unknownOverlay');

// Visualization elements
const instrumentSVG = el('instrumentSVG');
const beam = el('beam');
const photonsGroup = el('photons');
const solution = el('solution');
const detector = el('detector');
const led = el('led');

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
      maintainAspectRatio: false,
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
      // Decide if this photon is fully absorbed at the cuvette (instant fade)
      const pFull = clamp(0.1 + 0.8 * (1 - T), 0, 0.95); // higher absorption => higher probability
      const fullAbsorb = Math.random() < pFull;
      if (fullAbsorb) {
        c.dataset.absorbFull = '1';
        c.style.setProperty('--after-opacity', '0');
      } else {
        c.dataset.absorbFull = '0';
        // Set post-cuvette opacity: more absorption (lower T) -> lower opacity
        const baseAfter = 0.15 + 0.75 * T; // 0.15..0.9 depending on T
        const jitter = (Math.random()-0.5) * 0.15; // add variety
        c.style.setProperty('--after-opacity', String(clamp(baseAfter + jitter, 0.05, 0.95)));
      }
      c.style.animationDelay = `${-Math.random()*3}s`;
      photonsGroup.appendChild(c);
    }
  } else if (current > targetCount) {
    for (let i = current; i > targetCount; i--) {
      photonsGroup.removeChild(photonsGroup.lastChild);
    }
  }

  // Update existing photons' post-absorption opacity as T changes
  for (let i = 0; i < photonsGroup.childElementCount; i++) {
    const p = photonsGroup.children[i];
    if (p.dataset && p.dataset.absorbFull === '1') {
      p.style.setProperty('--after-opacity', '0');
    } else {
      const baseAfter = 0.15 + 0.75 * T;
      const jitter = (Math.random()-0.5) * 0.1;
      p.style.setProperty('--after-opacity', String(clamp(baseAfter + jitter, 0.05, 0.95)));
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

// Precisely position the unknown overlay arrows and labels to match chart pixels
function positionUnknownOverlay(A_meas, c_est, c_unknown, m, b) {
  if (!unknownOverlay || !calibrationChart) return;
  const canvas = document.getElementById('calibrationChart');
  const svg = unknownOverlay.querySelector('svg');
  const arrowH = unknownOverlay.querySelector('#arrowH');
  const arrowV = unknownOverlay.querySelector('#arrowV');
  const aLbl = unknownOverlay.querySelector('#unknownALabel');
  const cLbl = unknownOverlay.querySelector('#unknownCLabel');
  if (!canvas || !svg || !arrowH || !arrowV || !aLbl || !cLbl) return;

  // Align overlay to exactly cover the canvas area in CSS pixels
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  unknownOverlay.style.inset = 'auto';
  unknownOverlay.style.left = canvas.offsetLeft + 'px';
  unknownOverlay.style.top = canvas.offsetTop + 'px';
  unknownOverlay.style.width = cw + 'px';
  unknownOverlay.style.height = ch + 'px';
  svg.setAttribute('viewBox', `0 0 ${cw} ${ch}`);

  const xScale = calibrationChart.scales.x;
  const yScale = calibrationChart.scales.y;
  if (!xScale || !yScale) return;

  // Clamp estimate within the visible x-range
  const xMin = xScale.min ?? 0;
  const xMax = xScale.max ?? parseFloat(concentration.max || '1');
  const cEstClamped = clamp(c_est, xMin, xMax);

  // Convert values to pixel coordinates (relative to canvas top-left)
  const xData = xScale.getPixelForValue(c_unknown);
  const yA = yScale.getPixelForValue(A_meas);
  const xFit = xScale.getPixelForValue(cEstClamped);
  // Use the line-of-best-fit height at x = ĉ to anchor the elbow precisely on the line
  const yFitAtCEst = yScale.getPixelForValue(m * cEstClamped + b);
  const yAxis0 = yScale.getPixelForValue(0);

  // Update arrow lines
  arrowH.setAttribute('x1', String(xData));
  arrowH.setAttribute('y1', String(yFitAtCEst));
  arrowH.setAttribute('x2', String(xFit));
  arrowH.setAttribute('y2', String(yFitAtCEst));

  arrowV.setAttribute('x1', String(xFit));
  arrowV.setAttribute('y1', String(yFitAtCEst));
  arrowV.setAttribute('x2', String(xFit));
  arrowV.setAttribute('y2', String(yAxis0));

  // Set up stroke-draw: dash equals line length, start fully offset
  const hLen = Math.hypot(xFit - xData, 0);
  const vLen = Math.hypot(0, yAxis0 - yFitAtCEst);
  arrowH.style.strokeDasharray = String(hLen);
  arrowH.style.strokeDashoffset = String(hLen);
  arrowV.style.strokeDasharray = String(vLen);
  arrowV.style.strokeDashoffset = String(vLen);

  // Place labels near arrows with simple clamping to stay inside canvas
  const aText = `A* = ${fmt(A_meas, 3)}`;
  const cText = `ĉ = ${fmt(c_est, 3)} mM`;
  const aX = clamp(Math.min(xData, xFit) - 6, 2, cw - 2);
  const aY = clamp(yFitAtCEst - 6, 10, ch - 10);
  const cX = clamp(xFit + 6, 4, cw - 24);
  const cY = clamp(yAxis0 + 14, 12, ch - 4);
  aLbl.textContent = aText;
  aLbl.setAttribute('x', String(aX));
  aLbl.setAttribute('y', String(aY));
  cLbl.textContent = cText;
  cLbl.setAttribute('x', String(cX));
  cLbl.setAttribute('y', String(cY));
}

function isOverlayVisible() {
  return unknownOverlay && !unknownOverlay.classList.contains('is-hidden');
}

function showUnknownOverlay(A_meas, c_est, c_unknown, m, b) {
  positionUnknownOverlay(A_meas, c_est, c_unknown, m, b);
  unknownOverlay.classList.remove('is-hidden', 'fading');
  // restart animations
  unknownOverlay.classList.remove('unknown-animate');
  void unknownOverlay.offsetWidth;
  unknownOverlay.classList.add('unknown-animate');
}

function hideUnknownOverlay(immediate = false, after) {
  if (!isOverlayVisible()) { if (after) after(); return; }
  if (immediate) {
    unknownOverlay.classList.add('is-hidden');
    unknownOverlay.classList.remove('unknown-animate', 'fading');
    if (after) after();
    return;
  }
  unknownOverlay.classList.add('fading');
  const onEnd = () => {
    unknownOverlay.classList.remove('fading', 'unknown-animate');
    unknownOverlay.classList.add('is-hidden');
    unknownOverlay.removeEventListener('animationend', onEnd);
    if (after) after();
  };
  unknownOverlay.addEventListener('animationend', onEnd);
}

// Brief flash of LED and detector on measurement
function flashMeasurementCue() {
  if (led) {
    led.classList.remove('led-flash');
    void led.offsetWidth; // reflow to restart animation
    led.classList.add('led-flash');
    setTimeout(() => led.classList.remove('led-flash'), 500);
  }
  if (detector) {
    detector.classList.remove('detector-flash');
    void detector.offsetWidth;
    detector.classList.add('detector-flash');
    setTimeout(() => detector.classList.remove('detector-flash'), 600);
  }
}

// --- Event wiring ---
function attachEvents() {
  [wavelength, concentration, noiseToggle].forEach(inp => {
    inp.addEventListener('input', updateAll);
  });

  resetAll.addEventListener('click', () => {
    // Dismiss any visible unknown overlay on reset
    if (isOverlayVisible()) hideUnknownOverlay(false);
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
    flashMeasurementCue();
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

  // Unknown sample: generate a random concentration, add its A at current λ,
  // estimate ĉ from the current fit, and animate overlay arrows.
  unknownBtn.addEventListener('click', () => {
    // If an overlay is already visible, fade it out first before showing a new one
    if (isOverlayVisible()) {
      hideUnknownOverlay(true);
    }
    // If insufficient points, quickly seed two points using current λ
    if (calibrationData.length < 2) {
      const lam = parseFloat(wavelength.value);
      const seeds = [0.0, Math.min(0.6, parseFloat(concentration.max||'1')/2)];
      for (const c_mM of seeds) {
        const Atrue = absorbance(lam, c_mM, 1);
        const A = Math.max(0, noiseToggle.checked ? Atrue + randn()*NOISE_STD_A : Atrue);
        calibrationData.push({ c_mM, A });
      }
      updateCalibrationPlot();
    }

    const lam = parseFloat(wavelength.value);
    // Random unknown concentration within slider range
    const cMax = Math.min(1.0, parseFloat(concentration.max || '1'));
    const cUnknown = +(Math.random() * cMax).toFixed(3);
    const Atrue = absorbance(lam, cUnknown, 1);
    const A_meas = Math.max(0, noiseToggle.checked ? Atrue + randn()*NOISE_STD_A : Atrue);

    // Add to dataset as a special point (but don’t keep it permanently to avoid skewing fit)
    // Show the measurement flash and temporary point
    flashMeasurementCue();
    const tempPoint = { c_mM: cUnknown, A: A_meas, _temp: true };
    calibrationData.push(tempPoint);
    updateCalibrationPlot();

    // Compute current fit parameters
    const fit = linearRegression(calibrationData.filter(p => !p._temp).map(d => ({ x: d.c_mM, y: d.A })));
    const m = fit.m, b = fit.b;
    const c_est = m !== 0 ? (A_meas - b) / m : 0;

    // Show overlay arrows over the chart area and keep visible until next action
    if (unknownOverlay) {
      showUnknownOverlay(A_meas, c_est, cUnknown, m, b);
    }

    // Keep temp point for stability until user performs a new action; then remove on hide
    const scheduleRemoval = () => {
      const idx = calibrationData.indexOf(tempPoint);
      if (idx >= 0) calibrationData.splice(idx, 1);
      updateCalibrationPlot();
    };
    // Attach one-time remover after overlay fades
    const onEndRemove = () => { scheduleRemoval(); unknownOverlay.removeEventListener('animationend', onEndRemove); };
    unknownOverlay.addEventListener('animationend', onEndRemove);
  });

  // Dismiss overlay on next action button press (measure/auto/clear/reset)
  const actionButtons = [measureBtn, autoCalibrateBtn, clearCalibration, resetAll];
  actionButtons.forEach(btn => btn.addEventListener('click', () => {
    if (isOverlayVisible()) hideUnknownOverlay(false);
  }));

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
  // Dismiss overlay when auto calibration starts
  if (isOverlayVisible()) hideUnknownOverlay(false);
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
    flashMeasurementCue();
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
