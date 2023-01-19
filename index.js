const Hyperbee = require('hyperbee')
const debug = require('debug')('autobee')

module.exports.Autobee = class Autobee {
  constructor (autobase, opts = {}) {
    this.opts = opts
    this.autobase = autobase

    this._abid = opts.abid !== undefined
      ? opts.abid
      : Math.ceil(Math.random() * 100000)

    this.autobase.start({
      unwrap: true,
      apply: async (bee, batch, clocks, change) => {
        await applyAutobeeBatch.call(this, bee, batch, clocks, change, {

        })
      },
      view: core => {
        return new Hyperbee(core.unwrap(), {
          ...opts,
          extension: false
        })
      }
    })

    this.bee = this.autobase.view
  }

  ready () {
    return this.autobase.ready()
  }

  async put (key, value, opts) {
    const op = Buffer.from(JSON.stringify({ type: 'put', key, value }))
    return await this.autobase.append(op, opts)
  }

  async del (key, opts) {
    const op = Buffer.from(JSON.stringify({ type: 'del', key }))
    return await this.autobase.append(op, opts)
  }

  async get (key) {
    const node = await this.bee.get(key)
    if (!node) {
      return null
    }

    node.value = decode(node.value).value
    return node
  }
}

async function applyAutobeeBatch (bee, batch, clocks, change, opts = {}) {
  const b = bee.batch({ update: false })

  for (const node of batch) {
    const val = node.value.toString()
    let op = null

    try {
      op = JSON.parse(val)
    } catch (e) {
      continue
    }

    const strategy = opts.applyStrategy || 'default'

    if (typeof strategy === 'string') {
      if (STRATEGIES[strategy]) {
        await STRATEGIES[strategy].call(this, b, node, change, clocks, op, {})
      } else {
        throw new Error('Autobee: strategy not found')
      }
    } else if (typeof strategy === 'function') {
      await opts.applyStrategy.call(this, b, node, change, clocks, op, {})
    } else {
      throw new Error('Autobee: strategy not found')
    }
  }

  return await b.flush()
}

const STRATEGIES = {
  default: applyStrategyDefault,
  local: applyStrategyLocal
}

async function applyStrategyDefault (b, node, change, clocks, op, opts = {}) {
  if (op.type === 'put') {
    const incoming = encode(op.value, change, node.seq)
    await b.put(op.key, incoming)
  } else if (op.type === 'del') {
    await b.del(op.key)
  }
}

function isLocalWinner (clock, change, seq) {
  return clock.has(change) && (clock.get(change) >= seq)
}

async function applyStrategyLocal (b, node, change, clocks, op, opts = {}) {
  const localClock = clocks.local

  if (op.type === 'put') {
    const existing = await b.get(op.key, { update: false })
    const incoming = encode(op.value, change, node.seq)

    await b.put(op.key, incoming)

    if (!existing) {
      return
    }

    await handleConflict.call(this, op.type, op.key, incoming, existing.value)
  } else if (op.type === 'del') {
    await b.del(op.key)
  }

  async function handleConflict (type, key, incoming, existing) {
    const inVal = decode(incoming)
    const exVal = decode(existing)

    if (inVal.value === exVal.value) {
      return
    }

    debug(`conflict[${this._abid}]: inVal=${JSON.stringify(inVal)}, exVal=${JSON.stringify(exVal)}`)
    const { change: existingChange, seq: existingSeq } = exVal

    if (isLocalWinner(localClock, existingChange, existingSeq)) {
      await b.put(key, existing)
    }
  }
}

function encode (value, change, seq) {
  return JSON.stringify({ value, change: change.toString('hex'), seq })
}

function decode (raw) {
  return JSON.parse(raw)
}

module.exports.decode = decode
module.exports.encode = decode