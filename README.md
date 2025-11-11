# Colorimeter Simulator — Betalain (Beetroot)

An interactive, educational web app that simulates a single-beam colorimeter using betalain pigments from beetroot as an example.

- Adjustable wavelength, concentration (mM), and path length (cm)
- Real-time instrument view with animations of the beam, cuvette, and detector
- Spectrum chart: extinction coefficient ε(λ) and resulting absorbance A(λ)
- Calibration chart: A vs concentration with linear regression and R²
- Optional bleaching simulation (first-order photodegradation) and time-course chart
- Export calibration points as CSV

This is for teaching and intuition; numbers are representative rather than exact.

## Run locally

You can open `index.html` directly in a browser. For best results and to avoid any local file limitations, run a tiny static server:

```zsh
# From the project folder
python3 -m http.server 5500
# then open http://localhost:5500/
```

## Notes on the model

- Beer–Lambert law: `A = ε(λ) · c · l`
  - ε(λ): Gaussian peak around 538 nm (betalain) with a small baseline
  - c: concentration in mol/L (UI uses mM and converts internally)
  - l: path length in cm
- Detector signal is normalized: `signal = T`, with `T = 10^{-A}`
- Noise: Gaussian noise added to absorbance (toggleable)
- Bleaching: first-order decay `c(t) = c0 · e^{-k t}` with `k` in 1/min

## Acknowledgements

- Charting by Chart.js
- Betalain pigments inspired by beetroot (Beta vulgaris)
