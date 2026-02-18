const express    = require('express')
const cors       = require('cors')
const { exec }   = require('child_process')
const fs         = require('fs')
// simple UUID that works on any Node version
const uuidv4 = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
  })

const app  = express()
const PORT = process.env.PORT || 3001
const UVM  = '/uvm/src'

app.use(cors())
app.use(express.json({ limit: '1mb' }))

// ── VCD Parser ───────────────────────────────────────────────────────────────

function parseVCD(vcdPath) {
  if (!fs.existsSync(vcdPath)) return null
  const lines = fs.readFileSync(vcdPath, 'utf8').split('\n')

  const signals = {}
  const idMap   = {}
  let time = 0, inDefs = true

  for (const line of lines) {
    const t = line.trim()

    if (t.startsWith('$var')) {
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

// ── Core simulation logic (shared by both routes) ────────────────────────────

function runSimulation(req, res) {
  const { code, top = 'tb_top' } = req.body
  if (!code) return res.status(400).json({ error: 'No code provided' })

  const id      = randomUUID()
  const dir     = `/tmp/${id}`
  const svFile  = `${dir}/design.sv`
  const vvpFile = `${dir}/sim.vvp`
  const vcdFile = `${dir}/dump.vcd`

  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(svFile, code)

  const ivCmd = [
    'iverilog', '-g2012',
    `-I${UVM}`,
    `-DUVM_NO_DPI`,
    '-o', vvpFile,
    `-s ${top}`,
    svFile,
    `${UVM}/uvm_pkg.sv`
  ].join(' ')

  exec(ivCmd, { timeout: 30000 }, (err, _stdout, stderr) => {
    if (err) {
      fs.rmSync(dir, { recursive: true, force: true })
      return res.json({ success: false, stage: 'compile', errors: stderr || err.message })
    }

    exec(`vvp ${vvpFile} 2>&1`, { timeout: 60000, cwd: dir }, (err2, simOut) => {
      const signals = parseVCD(vcdFile)
      fs.rmSync(dir, { recursive: true, force: true })

      res.json({
        success:  !err2,
        stage:    err2 ? 'runtime' : 'done',
        errors:   err2 ? simOut : null,
        output:   (simOut || '').slice(0, 8000),
        signals
      })
    })
  })
}

// ── Routes ───────────────────────────────────────────────────────────────────

// Primary route — matches what Vercel frontend calls
app.post('/api/simulator/run', runSimulation)

// Alias — backwards compat
app.post('/compile', runSimulation)

// Health check
app.get('/health',          (_, res) => res.json({ status: 'ok' }))
app.get('/api/health',      (_, res) => res.json({ status: 'ok' }))

app.listen(PORT, () => console.log(`Simulator API running on :${PORT}`))
