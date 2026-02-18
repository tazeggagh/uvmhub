const express = require('express')
const cors    = require('cors')
const { exec } = require('child_process')
const fs      = require('fs')
const path    = require('path')
const { randomUUID } = require('crypto')

const app  = express()
const PORT = process.env.PORT || 3001
const UVM  = '/uvm/src'

app.use(cors())
app.use(express.json({ limit: '1mb' }))

// ── helpers ──────────────────────────────────────────────────────────────────

function cleanup(...files) {
  files.forEach(f => { try { fs.unlinkSync(f) } catch {} })
}

function parseVCD(vcdPath) {
  if (!fs.existsSync(vcdPath)) return null
  const raw  = fs.readFileSync(vcdPath, 'utf8')
  const lines = raw.split('\n')

  const signals = {}   // id → { name, width, values: [{time, val}] }
  let time = 0
  let inDefs = true
  const idMap = {}     // vcd-id → signal name

  for (const line of lines) {
    const t = line.trim()

    if (t.startsWith('$var')) {
      // $var wire 1 ! clk $end
      const m = t.match(/\$var\s+\S+\s+(\d+)\s+(\S+)\s+(\S+)/)
      if (m) {
        const [, width, id, name] = m
        idMap[id] = name
        signals[name] = { width: +width, values: [] }
      }
      continue
    }

    if (t === '$enddefinitions $end') { inDefs = false; continue }
    if (inDefs) continue

    if (t.startsWith('#')) {
      time = parseInt(t.slice(1))
      continue
    }

    // scalar: 0! or 1!
    const scalar = t.match(/^([01xz])(\S+)$/)
    if (scalar) {
      const [, val, id] = scalar
      const name = idMap[id]
      if (name && signals[name]) signals[name].values.push({ time, val })
      continue
    }

    // vector: b0101 !
    const vector = t.match(/^b([01xz]+)\s+(\S+)$/)
    if (vector) {
      const [, val, id] = vector
      const name = idMap[id]
      if (name && signals[name]) signals[name].values.push({ time, val })
    }
  }

  return signals
}

// ── /compile ─────────────────────────────────────────────────────────────────

app.post('/compile', (req, res) => {
  const { code, top = 'tb_top', timescale = '1ns/1ps' } = req.body
  if (!code) return res.status(400).json({ error: 'No code provided' })

  const id      = randomUUID()
  const dir     = `/tmp/${id}`
  const svFile  = `${dir}/design.sv`
  const vvpFile = `${dir}/sim.vvp`
  const vcdFile = `${dir}/dump.vcd`

  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(svFile, code)

  // iverilog: compile SV + UVM
  const ivCmd = [
    'iverilog',
    '-g2012',                          // SystemVerilog 2012
    `-I${UVM}`,                        // UVM include path
    `-DUVM_NO_DPI`,                    // skip DPI for iverilog compat
    '-o', vvpFile,
    `-s ${top}`,                       // top module
    svFile,
    `${UVM}/uvm_pkg.sv`               // UVM package
  ].join(' ')

  exec(ivCmd, { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) {
      cleanup(svFile)
      fs.rmSync(dir, { recursive: true, force: true })
      return res.json({
        success: false,
        stage: 'compile',
        errors: stderr || err.message
      })
    }

    // vvp: simulate and produce VCD
    const vvpCmd = `vvp ${vvpFile} 2>&1`
    exec(vvpCmd, { timeout: 60000, cwd: dir }, (err2, simOut, simErr) => {
      const output  = simOut + (simErr || '')
      const signals = parseVCD(vcdFile)

      fs.rmSync(dir, { recursive: true, force: true })

      res.json({
        success: !err2,
        stage: err2 ? 'runtime' : 'done',
        errors: err2 ? output : null,
        output: output.slice(0, 8000),   // truncate large logs
        signals                           // parsed waveform data
      })
    })
  })
})

// ── /health ───────────────────────────────────────────────────────────────────

app.get('/health', (_, res) => res.json({ status: 'ok' }))

app.listen(PORT, () => console.log(`Simulator API running on :${PORT}`))
