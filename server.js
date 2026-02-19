// UVM Simulator Backend v6 — Verilator
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
console.log('Backend v6 starting. Verilator:', VERILATOR_VERSION)

app.use(cors())
app.use(express.json({ limit: '1mb' }))

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

function processCode(c) {
  return c
    .replace(/^\s*import\s+uvm_pkg\s*::\s*\*\s*;\s*$/gm, '')
    .replace(/^\s*`include\s+"uvm_macros\.svh"\s*$/gm, '')
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

// ── C++ main — drives clk, includes sc_time_stamp ────────────────────────────
// Check if top module has a clk port by scanning the SV source
function hasClkPort(svFiles) {
  for (const f of svFiles) {
    const src = fs.readFileSync(f, 'utf8')
    if (/input\s+(?:logic\s+)?clk\b/.test(src)) return true
  }
  return false
}

function makeMain(top, driveClk) {
  const clkLine = driveClk
    ? `dut->clk = (t % 10) >= 5 ? 1 : 0;`
    : `// no clk port — design drives its own clock`
  return `#include "V${top}.h"
#include "verilated.h"
#include "verilated_vcd_c.h"

double sc_time_stamp() { return 0; }

int main(int argc, char** argv) {
    Verilated::commandArgs(argc, argv);
    V${top}* dut = new V${top};

    Verilated::traceEverOn(true);
    VerilatedVcdC* vcd = new VerilatedVcdC;
    dut->trace(vcd, 99);
    vcd->open("dump.vcd");

    dut->eval();

    vluint64_t t = 0;
    while (!Verilated::gotFinish() && t < 1000000) {
        ${clkLine}
        dut->eval();
        vcd->dump(t);
        t++;
    }

    vcd->close();
    dut->final();
    delete vcd;
    delete dut;
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

  let svFiles = []
  if (files?.length) {
    for (const f of files) {
      const p = `${dir}/${f.name}`
      fs.writeFileSync(p, processCode(f.code))
      svFiles.push(p)
    }
  } else {
    const p = `${dir}/design.sv`
    fs.writeFileSync(p, processCode(code))
    svFiles.push(p)
  }

  const driveClk = hasClkPort(svFiles)
  const mainFile = `${dir}/main.cpp`
  fs.writeFileSync(mainFile, makeMain(top, driveClk))
  console.log('driveClk:', driveClk)

  // Step 1: verilate
  const vlCmd = [
    'verilator', '--cc', '--sv', '--trace',
    '--exe', mainFile,
    '-Wno-fatal', '-Wno-lint', '-Wno-style',
    `--Mdir ${objDir}`,
    `--top-module ${top}`,
    ...svFiles
  ].join(' ')

  console.log('VERILATE:', vlCmd)

  exec(vlCmd, { timeout: 30000, cwd: dir }, (e1, _o, stderr) => {
    if (e1) {
      fs.rmSync(dir, { recursive: true, force: true })
      return res.json({ success: false, stage: 'compile', errors: stderr || e1.message })
    }

    // Step 2: make
    const makeCmd = `make -C ${objDir} -f V${top}.mk V${top} -j2`
    console.log('MAKE:', makeCmd)

    exec(makeCmd, { timeout: 60000 }, (e2, _o2, makeErr) => {
      if (e2) {
        fs.rmSync(dir, { recursive: true, force: true })
        return res.json({ success: false, stage: 'build', errors: makeErr || e2.message })
      }

      // Step 3: run
      exec(simBin, { timeout: 60000, cwd: dir }, (e3, simOut, simErr) => {
        const output  = (simOut || '') + (simErr || '')
        const signals = parseVCD(vcdFile)
        fs.rmSync(dir, { recursive: true, force: true })
        res.json({
          success: !e3 || output.includes('$finish'),
          stage:   'done',
          errors:  e3 ? output : null,
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
app.get('/health',     (_, res) => res.json({ status: 'ok', version: 'v6', node: process.version, verilator: VERILATOR_VERSION }))
app.get('/api/health', (_, res) => res.json({ status: 'ok', version: 'v6', node: process.version, verilator: VERILATOR_VERSION }))

app.listen(PORT, () => console.log(`Backend v6 on :${PORT}  node ${process.version}  ${VERILATOR_VERSION}`))
