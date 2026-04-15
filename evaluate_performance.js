const fs = require('fs');
const path = require('path');

// --- Extracted Detection Logic ---

const CHB = ['FP1-F7', 'F7-T7', 'T7-P7', 'P7-O1', 'FP1-F3', 'F3-C3', 'C3-P3', 'P3-O1', 'FP2-F4', 'F4-C4', 'C4-P4', 'P4-O2', 'FP2-F8', 'F8-T8', 'T8-P8', 'P8-O2', 'FZ-CZ', 'CZ-PZ', 'P7-T7', 'T7-FT9', 'FT9-FT10', 'FT10-T8', 'T8-P8'];
const REGION_MAP = { 'Left temporal': ['F7-T7', 'T7-P7', 'T7-FT9', 'FT9-FT10'], 'Right temporal': ['F8-T8', 'T8-P8', 'FT10-T8'], 'Left frontal': ['FP1-F7', 'FP1-F3', 'F3-C3'], 'Right frontal': ['FP2-F4', 'FP2-F8', 'F4-C4'], 'Parietal': ['C3-P3', 'CZ-PZ', 'C4-P4', 'P4-O2'], 'Occipital': ['P3-O1', 'P7-O1', 'P8-O2'] };
const MODEL = { weights: [0.24, 0.11, 0.09, 0.07, 0.05, 0.04, 0.05, 0.15, 0.20], thresholds: [0.38, 0.45, 0.30, 0.42, 0.38, 0.50, 0.44, 0.36, 0.31], cutoff: 0.55 };

function parseEDF(b) {
  const s = (st, l) => { let r = ''; for (let i = st; i < st + l; i++) r += String.fromCharCode(b[i]); return r.trim(); };
  const ns = parseInt(s(252, 4)) || 23;
  const hl = (ns + 1) * 256;
  const nr = parseInt(s(236, 8)) || 3600;
  const rd = parseFloat(s(244, 8)) || 1;
  const cn = []; for (let i = 0; i < ns; i++) cn.push(s(256 + i * 16, 16));
  const sp = []; for (let i = 0; i < ns; i++) sp.push(parseInt(s(256 + ns * 216 + i * 8, 8)) || 256);
  const pm = [], px = [], dm = [], dx = [];
  for (let i = 0; i < ns; i++) {
    pm.push(parseFloat(s(256 + ns * 104 + i * 8, 8)) || -100);
    px.push(parseFloat(s(256 + ns * 112 + i * 8, 8)) || 100);
    dm.push(parseInt(s(256 + ns * 120 + i * 8, 8)) || -32768);
    dx.push(parseInt(s(256 + ns * 128 + i * 8, 8)) || 32767);
  }
  const gain = pm.map((m, i) => (px[i] - m) / ((dx[i] - dm[i]) || 1));
  const off = pm.map((m, i) => m - gain[i] * dm[i]);
  const SR = sp[0] / rd;
  const sigs = cn.map(() => []);
  let pos = hl;
  for (let r = 0; r < Math.min(nr, 14400); r++) {
    for (let ch = 0; ch < ns; ch++) {
      const n = sp[ch] || 256;
      for (let k = 0; k < n; k++) {
        if (pos + 1 < b.length) {
          const v = b[pos] | (b[pos + 1] << 8);
          sigs[ch].push((v > 32767 ? v - 65536 : v) * gain[ch] + off[ch]);
          pos += 2;
        }
      }
    }
  }
  return { channelNames: cn, signals: sigs, numSignals: ns, sampleRate: SR, durationSeconds: sigs[0] ? sigs[0].length / SR : 0, patientId: s(8, 80) };
}

function feat(w) {
  const n = w.length; if (!n) return new Array(9).fill(0);
  const mn = w.reduce((a, b) => a + b, 0) / n;
  let v = 0, ll = 0, zc = 0; const d1 = [];
  for (let i = 0; i < n; i++) { v += (w[i] - mn) ** 2; ll += Math.abs(w[i] - (w[i - 1] || 0)); if (i > 0 && (w[i] - mn) * (w[i - 1] - mn) < 0) zc++; if (i > 0) d1.push(w[i] - w[i - 1]); }
  v /= n;
  const d2 = d1.map((_, i) => i > 0 ? d1[i] - d1[i - 1] : 0);
  const vd1 = d1.reduce((a, b) => a + b * b, 0) / d1.length || 1;
  const vd2 = d2.reduce((a, b) => a + b * b, 0) / d2.length || 1;
  const mob = Math.sqrt(vd1 / v), cplx = Math.sqrt(vd2 / vd1) / mob;
  const M = Math.min(n, 64), re = new Float32Array(M), im = new Float32Array(M);
  for (let k = 0; k < M; k++)for (let t = 0; t < M; t++) { re[k] += w[t] * Math.cos(2 * Math.PI * k * t / M); im[k] -= w[t] * Math.sin(2 * Math.PI * k * t / M); }
  const pw = k => (re[k] ** 2 + im[k] ** 2) / M, fr = 256 / M;
  const bp = (lo, hi) => { let s = 0; for (let k = Math.round(lo / fr); k <= Math.min(Math.round(hi / fr), M / 2); k++)s += pw(k); return s; };
  const dl = bp(.5, 4), th = bp(4, 8), be = bp(13, 30), ga = bp(30, 70), tot = (dl + th + be + ga) || 1;
  return [Math.min(ll / n / 100, 1), Math.min(v / 5000, 1), Math.min(zc / 200, 1), Math.min(mob / 10, 1), Math.min(cplx / 5, 1), dl / tot, th / tot, be / tot, ga / tot];
}

function score(f) { let s = 0, w = 0; for (let i = 0; i < 9; i++) { s += MODEL.weights[i] * (f[i] > MODEL.thresholds[i] ? 1 : 0); w += MODEL.weights[i]; } return s / w; }

function analyse(edf) {
  const SR = edf.sampleRate || 256, WIN = 4 * SR, STEP = 2 * SR;
  const nch = Math.min(edf.numSignals, 23);
  const cs = {}; const tl = [];
  const len = (edf.signals[0] || []).length;
  const nw = Math.floor((len - WIN) / STEP);
  for (let wi = 0; wi < nw; wi++) {
    const s0 = wi * STEP; let wmax = 0;
    for (let ch = 0; ch < nch; ch++) {
      const win = (edf.signals[ch] || []).slice(s0, s0 + WIN);
      if (win.length < WIN * .5) continue;
      const sc = score(feat(win));
      const nm = edf.channelNames[ch] || CHB[ch] || 'CH' + (ch + 1);
      if (!cs[nm] || sc > cs[nm]) cs[nm] = sc;
      if (sc > wmax) wmax = sc;
    }
    tl.push({ t: s0 / SR, s: wmax });
  }
  const maxS = Math.max(...Object.values(cs), 0);
  const flagged = Object.values(cs).filter(s => s > 0.6).length;
  const ivs = getIntervals(tl);
  const loc = localize(cs);
  return { cs, maxS, flagged, hasSeizure: maxS > MODEL.cutoff, tl, ivs, loc, dur: edf.durationSeconds, SR };
}

function getIntervals(tl, thr = 0.55) {
  const r = []; let on = false, st = 0;
  for (const p of tl) {
    if (!on && p.s > thr) { on = true; st = p.t; }
    else if (on && p.s < thr - .08) { r.push({ s: st, e: p.t }); on = false; }
  }
  if (on) r.push({ s: st, e: tl[tl.length - 1]?.t || 0 });
  return r.filter(v => v.e - v.s > 4);
}

function localize(cs) {
  const rs = {};
  for (const [reg, chs] of Object.entries(REGION_MAP)) { const v = chs.map(c => cs[c] || 0); rs[reg] = v.reduce((a, b) => a + b, 0) / v.length; }
  const sorted = Object.entries(rs).sort((a, b) => b[1] - a[1]);
  return { primary: sorted[0][0], conf: sorted[0][1], all: rs };
}

// --- Summary Parser and Evaluation ---

function parseSummary(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const files = {};
  let currentFile = null;

  lines.forEach(line => {
    const fileNameMatch = line.match(/File Name:\s*(.+)/);
    if (fileNameMatch) {
      currentFile = fileNameMatch[1].trim();
      files[currentFile] = { seizures: [] };
    }
    const seizureStartMatch = line.match(/Seizure \d+ Start Time:\s*(\d+) seconds/);
    if (seizureStartMatch && currentFile) {
      files[currentFile].seizures.push({ start: parseInt(seizureStartMatch[1]) });
    }
    const seizureEndMatch = line.match(/Seizure \d+ End Time:\s*(\d+) seconds/);
    if (seizureEndMatch && currentFile && files[currentFile].seizures.length > 0) {
      files[currentFile].seizures[files[currentFile].seizures.length - 1].end = parseInt(seizureEndMatch[1]);
    }
  });
  return files;
}

function evaluate(dataDir) {
  const participants = fs.readdirSync(dataDir).filter(f => fs.statSync(path.join(dataDir, f)).isDirectory());
  let globalStats = { tp: 0, fp: 0, fn: 0, totalDuration: 0, totalFiles: 0 };

  console.log(`\nEvaluating seizure detector on ${participants.length} participants...\n`);
  console.log(''.padEnd(100, '-'));
  console.log(`${'File'.padEnd(30)} | ${'Status'.padEnd(12)} | ${'GT Sz'.padEnd(6)} | ${'Det Sz'.padEnd(6)} | ${'TP'.padEnd(3)} | ${'FP'.padEnd(3)} | ${'FN'.padEnd(3)}`);
  console.log(''.padEnd(100, '-'));

  participants.forEach(p => {
    const pDir = path.join(dataDir, p);
    const summaryFiles = fs.readdirSync(pDir).filter(f => f.toLowerCase().includes('summary.txt'));
    if (summaryFiles.length === 0) return;

    const summary = parseSummary(path.join(pDir, summaryFiles[0]));

    Object.keys(summary).forEach(edfName => {
      const edfPath = path.join(pDir, edfName);
      if (!fs.existsSync(edfPath)) return;

      globalStats.totalFiles++;
      const buffer = fs.readFileSync(edfPath);
      const edf = parseEDF(buffer);
      const result = analyse(edf);

      const gt = summary[edfName].seizures;
      const det = result.ivs;

      let tp = 0;
      let fn = 0;
      let fp = 0;

      // Match detections to ground truth
      const matchedGt = new Set();
      const matchedDet = new Set();

      det.forEach((d, di) => {
        gt.forEach((g, gi) => {
          // Overlap check
          if (Math.max(d.s, g.start) < Math.min(d.e, g.end)) {
            matchedGt.add(gi);
            matchedDet.add(di);
          }
        });
      });

      tp = matchedGt.size;
      fn = gt.length - matchedGt.size;
      fp = det.length - matchedDet.size;

      globalStats.tp += tp;
      globalStats.fp += fp;
      globalStats.fn += fn;
      globalStats.totalDuration += edf.durationSeconds;

      const status = result.hasSeizure ? 'SZ DETECTED' : 'CLEAR';
      console.log(`${edfName.padEnd(30)} | ${status.padEnd(12)} | ${String(gt.length).padEnd(6)} | ${String(det.length).padEnd(6)} | ${String(tp).padEnd(3)} | ${String(fp).padEnd(3)} | ${String(fn).padEnd(3)}`);
    });
  });

  console.log(''.padEnd(100, '-'));
  const sensitivity = globalStats.tp / (globalStats.tp + globalStats.fn) || 0;
  const precision = globalStats.tp / (globalStats.tp + globalStats.fp) || 0;
  const fph = (globalStats.fp / (globalStats.totalDuration / 3600)) || 0;

  console.log(`\nOVERALL SUMMARY`);
  console.log(`Total Files processed: ${globalStats.totalFiles}`);
  console.log(`Total Duration:        ${(globalStats.totalDuration / 3600).toFixed(2)} hours`);
  console.log(`Total Seizures (GT):   ${globalStats.tp + globalStats.fn}`);
  console.log(`Sensitivity (Recall):  ${(sensitivity * 100).toFixed(1)}%`);
  console.log(`Precision:             ${(precision * 100).toFixed(1)}%`);
  console.log(`False Positives / hr:  ${fph.toFixed(3)}`);
  console.log('');
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.log('Usage: node evaluate_performance.js <data_directory>');
  process.exit(1);
}

evaluate(args[0]);
