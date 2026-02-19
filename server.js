// UVM Simulator Backend v5 — Verilator
const express    = require('express')
const cors       = require('cors')
const { exec, execSync } = require('child_process')
const fs         = require('fs')
const path       = require('path')

const app  = express()
const PORT = process.env.PORT || 3001

const VERILATOR_VERSION = (() => {
  try { return execSync('verilator --version').toString().trim() } catch(e) { return 'unknown' }
})()

console.log('Verilator:', VERILATOR_VERSION)

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
  const lines   = fs.readFileSync(vcdPath, 'utf8').split('\n')
  const signals = {}
  const idMap   = {}
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
    const scalar = t.match(/^([01xz])(\S+)$/)
    if (scalar) {
      const name = idMap[scalar[2]]
      if (name && signals[name]) signals[name].values.push({ time, val: scalar[1] })
      continue
    }
    const vector = t.match(/^b([01xz]+)\s+(\S+)$/)
    if (vector) {
      const name = idMap[vector[2]]
      if (name && signals[name]) signals[name].values.push({ time, val: vector[1] })
    }
  }
  return signals
}

// ── C++ main template for Verilator ──────────────────────────────────────────
function makeMain(top) {
  return `
#include "V${top}.h"
#include "verilated.h"
#include "verilated_vcd_c.h"

int main(int argc, char** argv) {
    Verilated::commandArgs(argc, argv);
    V${top}* top = new V${top};

    VerilatedVcdC* vcd = new VerilatedVcdC;
    Verilated::traceEverOn(true);
    top->trace(vcd, 99);
    vcd->open("dump.vcd");

    vluint64_t t = 0;
    while (!Verilated::gotFinish() && t < 100000) {
        top->eval();
        vcd->dump(t);
        t++;
    }

    vcd->close();
    top->final();
    delete top;
    return 0;
}
`
}

// ── Core simulation ───────────────────────────────────────────────────────────
function runSimulation(req, res) {
  const { code, files, top = 'tb_top' } = req.body
  if (!code && !files?.length)
    return res.status(400).json({ error: 'No code provided' })

  const dir    = `/tmp/sim_${uid()}`
  const objDir = `${dir}/obj`
  const simBin = `${objDir}/V${top}`
  const vcdFile = `${dir}/dump.vcd`

  fs.mkdirSync(objDir, { recursive: true })

  // Write user SV files
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

  // Write C++ main
  const mainFile = `${dir}/main.cpp`
  fs.writeFileSync(mainFile, makeMain(top))

  // Step 1: verilator — generate C++
  const vlCmd = [
    'verilator',
    '--cc',
    '--sv',
    '--trace',
    '--exe', mainFile,
    '-Wno-fatal', '-Wno-lint', '-Wno-style',
    `--Mdir ${objDir}`,
    `--top-module ${top}`,
    ...svFiles
  ].join(' ')

  console.log('VERILATE:', vlCmd)

  exec(vlCmd, { timeout: 30000, cwd: dir }, (err, _out, stderr) => {
    if (err) {
      fs.rmSync(dir, { recursive: true, force: true })
      return res.json({ success: false, stage: 'compile', errors: stderr || err.message })
    }

    // Step 2: make — compile C++ to binary
    const makeCmd = `make -C ${objDir} -f V${top}.mk V${top} -j2`
    console.log('MAKE:', makeCmd)

    exec(makeCmd, { timeout: 60000 }, (err2, _o, makeErr) => {
      if (err2) {
        fs.rmSync(dir, { recursive: true, force: true })
        return res.json({ success: false, stage: 'build', errors: makeErr || err2.message })
      }

      // Step 3: run simulation
      exec(`${simBin}`, { timeout: 60000, cwd: dir }, (err3, simOut, simErr) => {
        const output  = simOut + (simErr || '')
        const signals = parseVCD(vcdFile)
        fs.rmSync(dir, { recursive: true, force: true })
        res.json({
          success: !err3,
          stage:   err3 ? 'runtime' : 'done',
          errors:  err3 ? output : null,
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
app.get('/health', (_, res) => res.json({ status: 'ok', node: process.version, verilator: VERILATOR_VERSION }))
app.get('/api/health', (_, res) => res.json({ status: 'ok', node: process.version, verilator: VERILATOR_VERSION }))

app.listen(PORT, () => console.log(`UVM Simulator Backend v5 (Verilator) on :${PORT}  node ${process.version}`))
