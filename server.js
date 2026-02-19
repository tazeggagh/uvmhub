// UVM Simulator Backend v8 — Verilator 5 + UVM
const express    = require('express')
const cors       = require('cors')
const { exec, execSync } = require('child_process')
const fs         = require('fs')
const path       = require('path')

const app  = express()
const PORT = process.env.PORT || 3001

const VERILATOR_VERSION = (() => {
  try { return execSync('verilator --version').toString().trim() } catch(e) { return 'not found' }
})()

// Find UVM pkg shipped with Verilator 5
const UVM_PKG = (() => {
  try {
    const r = execSync('find /usr/local/share/verilator /usr/share/verilator -name "uvm_pkg.sv" 2>/dev/null | head -1').toString().trim()
    return r || ''
  } catch(e) { return '' }
})()

const UVM_DIR = UVM_PKG ? path.dirname(UVM_PKG) : ''

console.log(`Backend v8 | ${VERILATOR_VERSION}`)
console.log(`UVM pkg: ${UVM_PKG || 'not found'} → exists: ${fs.existsSync(UVM_PKG)}`)

app.use(cors())
app.use(express.json({ limit: '1mb' }))

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

function processCode(c, isUVM = false) {
  // Strip SV-side VCD calls — C++ harness owns tracing
  let out = c
    .replace(/^\s*\$dumpfile\s*\([^)]*\)\s*;\s*$/gm, '// $dumpfile removed by backend')
    .replace(/^\s*\$dumpvars\s*\([^)]*\)\s*;\s*$/gm, '// $dumpvars removed by backend')

  if (isUVM) {
    // Remove any existing UVM includes/imports to avoid duplicates, then prepend clean ones
    out = out
      .replace(/^\s*`include\s+"uvm_macros\.svh"\s*$/gm, '')
      .replace(/^\s*import\s+uvm_pkg\s*::\s*\*\s*;\s*$/gm, '')
    // Prepend after `timescale if present, otherwise at top
    if (/`timescale/.test(out)) {
      out = out.replace(/(^`timescale[^\n]*\n)/, '$1`include "uvm_macros.svh"\nimport uvm_pkg::*;\n')
    } else {
      out = '`include "uvm_macros.svh"\nimport uvm_pkg::*;\n' + out
    }
  } else {
    // Non-UVM: strip any stray UVM directives
    out = out
      .replace(/^\s*import\s+uvm_pkg\s*::\s*\*\s*;\s*$/gm, '')
      .replace(/^\s*`include\s+"uvm_macros\.svh"\s*$/gm, '')
  }
  return out
}

// ── VCD Parser ────────────────────────────────────────────────────────────────
function parseVCD(vcdPath) {
  if (!fs.existsSync(vcdPath)) return null
  const lines = fs.readFileSync(vcdPath, 'utf8').split('\n')
  const signals = {}, idMap = {}
  let time = 0, inDefs = true
  for (const line of lines) {
    const t = line.trim()
    if (t.startsWith('$var')) {
      const m = t.match(/\$var\s+\S+\s+(\d+)\s+(\S+)\s+(\S+)/)
      if (m) { idMap[m[2]] = m[3]; signals[m[3]] = { width: +m[1], values: [] } }
      continue
    }
    if (t === '$enddefinitions $end') { inDefs = false; continue }
    if (inDefs) continue
    if (t.startsWith('#')) { time = parseInt(t.slice(1)); continue }
    const sc = t.match(/^([01xz])(\S+)$/)
    if (sc) { const n = idMap[sc[2]]; if (n && signals[n]) signals[n].values.push({ time, val: sc[1] }); continue }
    const vc = t.match(/^b([01xz]+)\s+(\S+)$/)
    if (vc) { const n = idMap[vc[2]]; if (n && signals[n]) signals[n].values.push({ time, val: vc[1] }) }
  }
  return signals
}

// ── Detect if design uses UVM ─────────────────────────────────────────────────
function usesUVM(svFiles) {
  for (const f of svFiles) {
    const src = fs.readFileSync(f, 'utf8')
    if (/uvm_(test|component|sequence|driver|monitor|scoreboard|env|agent)\b/.test(src)) return true
    if (/`uvm_(component|object)_utils/.test(src)) return true
  }
  return false
}

function hasClkPort(svFiles) {
  for (const f of svFiles) {
    const src = fs.readFileSync(f, 'utf8')
    if (/input\s+(?:logic\s+)?clk\b/.test(src)) return true
  }
  return false
}

// ── C++ main ──────────────────────────────────────────────────────────────────
function makeMain(top, driveClk) {
  const clkLine = driveClk
    ? `dut->clk = (t % 10) >= 5 ? 1 : 0;`
    : `// self-clocking design`
  return `#include "V${top}.h"
#include "verilated.h"
#include "verilated_vcd_c.h"

int main(int argc, char** argv) {
    Verilated::commandArgs(argc, argv);
    V${top}* dut = new V${top};
    Verilated::traceEverOn(true);
    VerilatedVcdC* vcd = new VerilatedVcdC;
    dut->trace(vcd, 99);
    vcd->open("dump.vcd");
    uint64_t t = 0;
    // Initial eval + dump at t=0
    dut->eval();
    vcd->dump(t);
    while (!Verilated::gotFinish() && t < 1000000) {
        t++;
        ${clkLine}
        dut->eval();
        vcd->dump(t);
    }
    vcd->close();
    dut->final();
    delete vcd; delete dut;
    return 0;
}
`
}

// ── Core simulation ───────────────────────────────────────────────────────────
function runSimulation(req, res) {
  const { code, files, top = 'tb_top' } = req.body
  if (!code && !files?.length)
    return res.status(400).json({ error: 'No code provided' })

  const dir     = `/tmp/sim_${uid()}`
  const objDir  = `${dir}/obj`
  const simBin  = `${objDir}/V${top}`
  const vcdFile = `${dir}/dump.vcd`

  fs.mkdirSync(objDir, { recursive: true })

  // Write raw files first so usesUVM() / hasClkPort() can scan them
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
  if (isUVM) {
    const uvmCheck = UVM_DIR || '/usr/local/share/verilator/include/uvm-1.0'
    console.log(`UVM incdir: ${uvmCheck} | uvm_pkg.sv exists: ${fs.existsSync(uvmCheck + '/uvm_pkg.sv')}`)
  }

  // Now process with correct isUVM flag
  for (const p of svFiles) {
    fs.writeFileSync(p, processCode(fs.readFileSync(p, 'utf8'), isUVM))
  }

  const mainFile = `${dir}/main.cpp`
  fs.writeFileSync(mainFile, makeMain(top, driveClk))

  // Build verilator command
  // Verilator 5.020 does NOT have --uvm flag; include UVM manually via -I and +incdir
  const uvmIncDir = UVM_DIR || '/usr/local/share/verilator/include/uvm-1.0'
  const uvmFlags = isUVM
    ? [
        `+incdir+${uvmIncDir}`,
        `-I${uvmIncDir}`,
        '+define+UVM_NO_DPI',
        '+define+UVM_REGEX_NO_DPI',
        '-Wno-UNOPTFLAT',
      ]
    : []

  // For UVM: explicitly prepend uvm_pkg.sv so Verilator compiles the package
  const uvmIncDir = isUVM ? (UVM_DIR || '/usr/local/share/verilator/include/uvm-1.0') : ''
  const uvmPkgFile = isUVM ? `${uvmIncDir}/uvm_pkg.sv` : ''
  const uvmSvFiles = (isUVM && fs.existsSync(uvmPkgFile)) ? [uvmPkgFile] : []

  const vlCmd = [
    'verilator', '--cc', '--sv', '--trace',
    '--exe', mainFile,
    '-Wno-fatal', '-Wno-lint', '-Wno-style',
    `--Mdir ${objDir}`,
    `--top-module ${top}`,
    ...uvmFlags,
    ...uvmSvFiles,
    ...svFiles
  ].join(' ')

  console.log('VERILATE:', vlCmd)

  exec(vlCmd, { timeout: 60000, cwd: dir }, (e1, _o, stderr) => {
    if (e1) {
      fs.rmSync(dir, { recursive: true, force: true })
      return res.json({ success: false, stage: 'compile', errors: stderr || e1.message })
    }

    const makeCmd = `make -C ${objDir} -f V${top}.mk V${top} -j$(nproc)`
    exec(makeCmd, { timeout: 120000 }, (e2, _o2, makeErr) => {
      if (e2) {
        fs.rmSync(dir, { recursive: true, force: true })
        return res.json({ success: false, stage: 'build', errors: makeErr || e2.message })
      }

      exec(simBin, { timeout: 60000, cwd: dir }, (e3, simOut, simErr) => {
        const output  = (simOut || '') + (simErr || '')
        const signals = parseVCD(vcdFile)
        fs.rmSync(dir, { recursive: true, force: true })
        res.json({
          success: !e3 || output.includes('$finish'),
          stage:   'done',
          errors:  e3 && !output.includes('$finish') ? output : null,
          output:  output.slice(0, 8000),
          signals
        })
      })
    })
  })
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.post('/api/simulator/run', runSimulation)
app.post('/compile',           runSimulation)
app.get('/health', (_, res) => res.json({
  status: 'ok', version: 'v8',
  node: process.version,
  verilator: VERILATOR_VERSION,
  uvm_pkg: UVM_PKG,
  uvm_exists: fs.existsSync(UVM_PKG)
}))
app.get('/api/health', (_, res) => res.json({
  status: 'ok', version: 'v8',
  node: process.version,
  verilator: VERILATOR_VERSION,
  uvm_pkg: UVM_PKG,
  uvm_exists: fs.existsSync(UVM_PKG)
}))

app.listen(PORT, () => console.log(`Backend v8 on :${PORT} | ${VERILATOR_VERSION}`))
