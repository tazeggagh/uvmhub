// UVM Simulator Backend v11 — Verilator + UVM-lite + VCD output

const express = require('express')
const cors    = require('cors')
const { exec, execSync } = require('child_process')
const fs   = require('fs')
const path = require('path')

const app  = express()
const PORT = process.env.PORT || 3001

// ─────────────────────────────────────────────────────────────────────────────
// Tool detection
// ─────────────────────────────────────────────────────────────────────────────
const VERILATOR_VERSION = (() => {
  try { return execSync('verilator --version').toString().trim() }
  catch { return 'not found' }
})()

const Z3_VERSION = (() => {
  try { return execSync('z3 --version').toString().trim() }
  catch { return 'not found' }
})()

console.log(`Backend v11 | ${VERILATOR_VERSION}`)
console.log(`Z3: ${Z3_VERSION}`)

// ─────────────────────────────────────────────────────────────────────────────
// Locate UVM
// ─────────────────────────────────────────────────────────────────────────────
const UVM_DIR = (() => {
  const candidates = ['/opt/uvm', '/usr/local/share/verilator/include/uvm-1.0']
  for (const d of candidates) {
    if (fs.existsSync(`${d}/uvm_pkg.sv`)) return d
  }
  try {
    const r = execSync('find /opt /usr/local -name "uvm_pkg.sv" 2>/dev/null | head -1')
      .toString().trim()
    return r ? path.dirname(r) : '/opt/uvm'
  } catch {
    return '/opt/uvm'
  }
})()

const UVM_PKG = `${UVM_DIR}/uvm_pkg.sv`
console.log(`UVM dir: ${UVM_DIR} | uvm_pkg.sv exists: ${fs.existsSync(UVM_PKG)}`)

app.use(cors())
app.use(express.json({ limit: '2mb' }))

// ─────────────────────────────────────────────────────────────────────────────
// Utils
// ─────────────────────────────────────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

function processCode(code, isUVM = false) {
  let out = code
    .replace(/^\s*\$dumpfile\s*\([^)]*\)\s*;\s*$/gm, '// $dumpfile removed by backend')
    .replace(/^\s*\$dumpvars\s*\([^)]*\)\s*;\s*$/gm, '// $dumpvars removed by backend')

  if (isUVM) {
    out = out
      .replace(/^\s*`include\s+"uvm_macros\.svh"\s*$/gm, '')
      .replace(/^\s*import\s+uvm_pkg\s*::\s*\*\s*;\s*$/gm, '')

    const preamble = '`include "uvm_macros.svh"\nimport uvm_pkg::*;\n'

    if (/`timescale/.test(out)) {
      out = out.replace(/(^`timescale[^\n]*\n)/m, `$1${preamble}`)
    } else {
      out = preamble + out
    }
  } else {
    out = out
      .replace(/^\s*import\s+uvm_pkg\s*::\s*\*\s*;\s*$/gm, '')
      .replace(/^\s*`include\s+"uvm_macros\.svh"\s*$/gm, '')
  }

  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// VCD parser  →  { [sigName]: { width, values: [{time, val}] } }
// ─────────────────────────────────────────────────────────────────────────────
function parseVCD(vcdPath) {
  if (!fs.existsSync(vcdPath)) return null

  const lines   = fs.readFileSync(vcdPath, 'utf8').split('\n')
  const signals = {}   // sigName → { width, values }
  const idMap   = {}   // vcd-id  → sigName

  let time    = 0
  let inDefs  = true

  for (const line of lines) {
    const t = line.trim()

    // signal declaration
    if (t.startsWith('$var')) {
      const m = t.match(/\$var\s+\S+\s+(\d+)\s+(\S+)\s+(\S+)/)
      if (m) {
        const [, width, id, name] = m
        idMap[id]      = name
        signals[name]  = { width: +width, values: [] }
      }
      continue
    }

    if (t === '$enddefinitions $end') { inDefs = false; continue }
    if (inDefs) continue

    // timestamp
    if (t.startsWith('#')) { time = parseInt(t.slice(1)); continue }

    // scalar:  0a  1b  xa
    const sc = t.match(/^([01xzXZ])(\S+)$/)
    if (sc) {
      const name = idMap[sc[2]]
      if (name && signals[name]) signals[name].values.push({ time, val: sc[1] })
      continue
    }

    // vector:  b00001010 a
    const vc = t.match(/^b([01xzXZ]+)\s+(\S+)$/)
    if (vc) {
      const name = idMap[vc[2]]
      if (name && signals[name]) signals[name].values.push({ time, val: vc[1] })
    }
  }

  // Remove signals with no transitions (noise)
  for (const k of Object.keys(signals))
    if (!signals[k].values.length) delete signals[k]

  return Object.keys(signals).length ? signals : null
}

// ─────────────────────────────────────────────────────────────────────────────
// Detection helpers
// ─────────────────────────────────────────────────────────────────────────────
function usesUVM(svFiles) {
  for (const f of svFiles) {
    const src = fs.readFileSync(f, 'utf8')
    if (/uvm_(test|component|sequence|driver|monitor|scoreboard|env|agent)\b/.test(src)) return true
    if (/`uvm_(component|object)_utils/.test(src)) return true
    if (/extends\s+uvm_/.test(src)) return true
  }
  return false
}

function hasClkPort(svFiles) {
  for (const f of svFiles) {
    const src = fs.readFileSync(f, 'utf8')
    if (/module\s+tb_top\s*\([^)]*input\s+(?:logic\s+)?clk/.test(src)) return true
  }
  return false
}

// ─────────────────────────────────────────────────────────────────────────────
// C++ harness
// ─────────────────────────────────────────────────────────────────────────────
function makeMain(top, driveClk) {
  return `#include "V${top}.h"
#include "verilated.h"
#include "verilated_vcd_c.h"
#include <cstdint>

int main(int argc, char** argv) {
    Verilated::commandArgs(argc, argv);
    V${top}* dut = new V${top};

    Verilated::traceEverOn(true);
    VerilatedVcdC* vcd = new VerilatedVcdC;
    dut->trace(vcd, 99);
    vcd->open("dump.vcd");

    uint64_t t = 0;
    dut->eval();
    vcd->dump(t);

    while (!Verilated::gotFinish() && t < 1000000) {
        t++;
        ${driveClk ? 'dut->clk = (t % 10) >= 5 ? 1 : 0;' : '// self-clocking'}
        dut->eval();
        vcd->dump(t);
    }

    vcd->close();
    dut->final();
    delete vcd;
    delete dut;
    return 0;
}
`
}

// ─────────────────────────────────────────────────────────────────────────────
// Core simulation
// ─────────────────────────────────────────────────────────────────────────────
function runSimulation(req, res) {
  const { code, files, top = 'tb_top' } = req.body

  if (!code && !files?.length)
    return res.status(400).json({ error: 'No code provided' })

  const dir    = `/tmp/sim_${uid()}`
  const objDir = `${dir}/obj`
  const simBin = `${objDir}/V${top}`
  const vcdFile = `${dir}/dump.vcd`

  fs.mkdirSync(objDir, { recursive: true })

  // ── Write source files ────────────────────────────────────────────────────
  let svFiles = []
  if (files?.length) {
    for (const f of files) {
      const p = `${dir}/${f.name}`
      fs.writeFileSync(p, f.code)
      svFiles.push(p)
    }
  } else {
    const p = `${dir}/design.sv`
    fs.writeFileSync(p, code)
    svFiles.push(p)
  }

  const isUVM    = usesUVM(svFiles)
  const driveClk = hasClkPort(svFiles)
  console.log(`isUVM=${isUVM} driveClk=${driveClk}`)

  // Rewrite with UVM preamble / cleanup
  for (const p of svFiles)
    fs.writeFileSync(p, processCode(fs.readFileSync(p, 'utf8'), isUVM))

  // ── Write C++ harness ─────────────────────────────────────────────────────
  const mainFile = `${dir}/main.cpp`
  fs.writeFileSync(mainFile, makeMain(top, driveClk))

  const uvmSvFiles = isUVM && fs.existsSync(UVM_PKG) ? [UVM_PKG] : []

  const uvmFlags = isUVM ? [
    '--timing', '--assert',
    `+incdir+${UVM_DIR}`,
    `+incdir+${UVM_DIR}/macros`,
    `-I${UVM_DIR}`,
    '+define+UVM_NO_DPI',
    '+define+UVM_REGEX_NO_DPI',
    '+define+UVM_OBJECT_MUST_HAVE_CONSTRUCTOR',
    '+define+UVM_NO_DEPRECATED',
    '-Wno-UNOPTFLAT', '-Wno-MULTIDRIVEN',
    '-Wno-TIMESCALEMOD', '-Wno-DEFOVERRIDE',
  ] : []

  // ── Verilate ──────────────────────────────────────────────────────────────
  const vlCmd = [
    'verilator', '--cc', '--sv', '--trace',
    '--exe', mainFile,
    '-Wno-fatal', '-Wno-lint', '-Wno-style',
    `--Mdir ${objDir}`,
    `--top-module ${top}`,
    ...uvmFlags,
    ...uvmSvFiles,
    ...svFiles,
  ].join(' ')

  console.log('VERILATE:', vlCmd)

  exec(vlCmd, { timeout: 60000, cwd: dir }, (e1, _o, stderr) => {
    if (e1) {
      fs.rmSync(dir, { recursive: true, force: true })
      return res.json({ success: false, stage: 'compile', errors: stderr || e1.message })
    }

    // ── Build ───────────────────────────────────────────────────────────────
    const makeCmd = `make -C ${objDir} -f V${top}.mk V${top} -j$(nproc)`
    exec(makeCmd, { timeout: 120000 }, (e2, _o2, makeErr) => {
      if (e2) {
        fs.rmSync(dir, { recursive: true, force: true })
        return res.json({ success: false, stage: 'build', errors: makeErr || e2.message })
      }

      // ── Simulate ─────────────────────────────────────────────────────────
      exec(simBin, { timeout: 60000, cwd: dir }, (e3, simOut, simErr) => {
        const output  = (simOut || '') + (simErr || '')
        const signals = parseVCD(vcdFile)

        // ── Read raw VCD for GTKWave download ─────────────────────────────
        let vcd = null
        if (fs.existsSync(vcdFile)) {
          const stat = fs.statSync(vcdFile)
          // Only return VCD if it's under 4 MB — larger files should be
          // streamed via a separate endpoint
          if (stat.size < 4 * 1024 * 1024)
            vcd = fs.readFileSync(vcdFile, 'utf8')
        }

        fs.rmSync(dir, { recursive: true, force: true })

        res.json({
          success: !e3 || output.includes('$finish'),
          stage:   'done',
          errors:  e3 && !output.includes('$finish') ? output : null,
          output:  output.slice(0, 8000),
          signals,   // parsed signal map for in-browser WaveformViewer
          vcd,       // raw VCD string for GTKWave download (null if >4 MB)
        })
      })
    })
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/simulator/run', runSimulation)
app.post('/compile',           runSimulation)

app.get('/health',     healthHandler)
app.get('/api/health', healthHandler)

function healthHandler(_, res) {
  res.json({
    status:          'ok',
    version:         'v11',
    node:            process.version,
    verilator:       VERILATOR_VERSION,
    z3:              Z3_VERSION,
    uvm_support:     'lite-2017',
    uvm_dir:         UVM_DIR,
    uvm_pkg_exists:  fs.existsSync(UVM_PKG),
  })
}

app.listen(PORT, () =>
  console.log(`Backend v11 on :${PORT} | ${VERILATOR_VERSION}`)
)
