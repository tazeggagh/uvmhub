// UVM Simulator Backend v5 — Verilator
const express    = require('express')
const cors       = require('cors')
const { exec, execSync } = require('child_process')
const fs         = require('fs')
const path       = require('path')

const app  = express()
const PORT = process.env.PORT || 3001

// Verilator UVM support path (built-in since v4.020)
const VERILATOR_ROOT = (() => {
  try { return execSync('verilator --getenv VERILATOR_ROOT').toString().trim() } catch(e) { return '/usr/share/verilator' }
})()
const UVM_PKG = `${VERILATOR_ROOT}/include/uvm-1.0/uvm_pkg.sv`

console.log('Verilator root:', VERILATOR_ROOT)
console.log('UVM pkg:', UVM_PKG, '→ exists:', fs.existsSync(UVM_PKG))

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

// ── Core simulation ───────────────────────────────────────────────────────────
function runSimulation(req, res) {
  const { code, files, top = 'tb_top' } = req.body
  if (!code && !files?.length)
    return res.status(400).json({ error: 'No code provided' })

  const dir     = `/tmp/sim_${uid()}`
  const vcdFile = `${dir}/dump.vcd`
  const simBin  = `${dir}/sim`

  fs.mkdirSync(dir, { recursive: true })

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

  // Verilator compile step
  const uvmInclude = fs.existsSync(UVM_PKG)
    ? `--uvm`
    : ''

  const vlCmd = [
    'verilator',
    '--binary',           // compile to executable directly
    '--sv',               // SystemVerilog mode
    '-j 0',              // parallel compile
    '+define+UVM_NO_DPI',
    uvmInclude,
    `--Mdir ${dir}/obj`,
    `-o ${simBin}`,
    `--top-module ${top}`,
    '--trace',            // enable VCD tracing
    '--trace-file dump.vcd',
    '-Wno-fatal',         // warnings don't stop compile
    '-Wno-lint',
    '-Wno-style',
    ...svFiles
  ].filter(Boolean).join(' ')

  console.log('CMD:', vlCmd)

  exec(vlCmd, { timeout: 60000, cwd: dir }, (err, _out, stderr) => {
    if (err) {
      fs.rmSync(dir, { recursive: true, force: true })
      return res.json({ success: false, stage: 'compile', errors: stderr || err.message })
    }

    // Run simulation
    exec(`${simBin} +UVM_TESTNAME=${top}`, { timeout: 60000, cwd: dir }, (err2, simOut, simErr) => {
      const output  = simOut + (simErr || '')
      const signals = parseVCD(vcdFile)
      fs.rmSync(dir, { recursive: true, force: true })
      res.json({
        success: !err2,
        stage:   err2 ? 'runtime' : 'done',
        errors:  err2 ? output : null,
        output:  output.slice(0, 8000),
        signals
      })
    })
  })
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.post('/api/simulator/run', runSimulation)
app.post('/compile',           runSimulation)
app.get('/health', (_, res) => res.json({
  status: 'ok',
  node: process.version,
  verilator: (() => { try { return execSync('verilator --version').toString().trim() } catch(e) { return 'not found' } })(),
  uvm_pkg: UVM_PKG,
  uvm_exists: fs.existsSync(UVM_PKG)
}))
app.get('/api/health', (_, res) => res.json({
  status: 'ok',
  node: process.version,
  verilator: (() => { try { return execSync('verilator --version').toString().trim() } catch(e) { return 'not found' } })(),
  uvm_pkg: UVM_PKG,
  uvm_exists: fs.existsSync(UVM_PKG)
}))

app.listen(PORT, () => console.log(`UVM Simulator Backend v5 (Verilator) on :${PORT}  node ${process.version}`))
