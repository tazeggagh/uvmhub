// UVM Simulator Backend v3
const express  = require('express')
const cors     = require('cors')
const { exec } = require('child_process')
const fs       = require('fs')

const app  = express()
const PORT = process.env.PORT || 3001

// UVM paths — accellera-official/uvm-core cloned to /uvm
const UVM       = '/uvm/src'
const UVM_MACRO = '/uvm/src/macros/uvm_macros.svh'
const UVM_PKG   = '/uvm/src/uvm_pkg.sv'

console.log('UVM_MACRO exists:', fs.existsSync(UVM_MACRO))
console.log('UVM_PKG   exists:', fs.existsSync(UVM_PKG))

app.use(cors())
app.use(express.json({ limit: '1mb' }))

// ── Inline UUID ───────────────────────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

// ── Strip UVM boilerplate users might include ─────────────────────────────────
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
  const vvpFile = `${dir}/sim.vvp`
  const vcdFile = `${dir}/dump.vcd`

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

  const cmd = [
    'iverilog',
    '-g2012',
    `-I${UVM}`,
    `-I${UVM}/macros`,
    `-I${UVM}/dpi`,
    '-DUVM_NO_DPI',
    '-DUVM_REGEX_NO_DPI',
    '-o', vvpFile,
    '-s', top,
    ...svFiles,
    UVM_MACRO,
    UVM_PKG
  ].join(' ')

  console.log('CMD:', cmd)

  exec(cmd, { timeout: 30000 }, (err, _out, stderr) => {
    if (err) {
      fs.rmSync(dir, { recursive: true, force: true })
      return res.json({ success: false, stage: 'compile', errors: stderr || err.message })
    }
    exec(`vvp ${vvpFile} 2>&1`, { timeout: 60000, cwd: dir }, (err2, simOut) => {
      const signals = parseVCD(vcdFile)
      fs.rmSync(dir, { recursive: true, force: true })
      res.json({
        success: !err2,
        stage:   err2 ? 'runtime' : 'done',
        errors:  err2 ? simOut : null,
        output:  (simOut || '').slice(0, 8000),
        signals
      })
    })
  })
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.post('/api/simulator/run', runSimulation)
app.post('/compile',           runSimulation)
app.get('/health',             (_, res) => res.json({ status: 'ok', node: process.version, uvm_macro: fs.existsSync(UVM_MACRO), uvm_pkg: fs.existsSync(UVM_PKG) }))
app.get('/api/health',         (_, res) => res.json({ status: 'ok', node: process.version, uvm_macro: fs.existsSync(UVM_MACRO), uvm_pkg: fs.existsSync(UVM_PKG) }))

app.listen(PORT, () => console.log(`UVM Simulator Backend v3 on :${PORT}  node ${process.version}`))
