/**
 * Address helpers used by dsh-tailscale-serve.
 * Zero dependencies so the package stays installable anywhere Node 22+ runs.
 */

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** Strip IPv6 zone ids and IPv4-mapped prefixes. */
export function normalizeAddress (value) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const noZone = raw.split('%')[0]
  return noZone.startsWith('::ffff:') && noZone.includes('.') ? noZone.slice(7) : noZone
}

export function parseIPv4 (value) {
  const m = V4.exec(normalizeAddress(value))
  if (!m) return null
  return m.slice(1).map((part) => {
    const n = Number(part)
    return n >= 0 && n <= 255 ? n : -1
  })
}

/** Expand an IPv6 address into 16 bytes, or null when unparseable. */
export function parseIPv6 (value) {
  const addr = normalizeAddress(value).toLowerCase()
  if (!addr.includes(':')) return null
  const halves = addr.split('::')
  if (halves.length > 2) return null
  const parsePart = (part) => {
    if (!part) return []
    const groups = part.split(':')
    const out = []
    for (const group of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null
      out.push(parseInt(group, 16))
    }
    return out
  }
  const head = parsePart(halves[0])
  const tail = halves.length === 2 ? parsePart(halves[1]) : []
  if (head === null || tail === null) return null
  const fill = 8 - head.length - tail.length
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return null
  const words = halves.length === 2 ? [...head, ...Array(fill).fill(0), ...tail] : head
  const bytes = []
  for (const word of words) bytes.push((word >> 8) & 0xff, word & 0xff)
  return bytes
}

function bytesOf (value) {
  const v4 = parseIPv4(value)
  if (v4) return { version: 4, bytes: v4 }
  const v6 = parseIPv6(value)
  if (v6) return { version: 6, bytes: v6 }
  return null
}

/** Tailscale uses 100.64.0.0/10 for IPv4 and fd7a:115c:a1e0::/48 for IPv6. */
export function isTailnetAddress (value) {
  const parsed = bytesOf(value)
  if (!parsed) return false
  if (parsed.version === 4) return inCidrBytes(parsed.bytes, cidrBytes('100.64.0.0/10'))
  return inCidrBytes(parsed.bytes, cidrBytes('fd7a:115c:a1e0::/48'))
}

function cidrBytes (cidr) {
  const [base, prefix] = String(cidr).split('/')
  const bits = Number(prefix)
  const parsed = bytesOf(base)
  if (!parsed || Number.isNaN(bits)) return null
  return { bits: parsed.version === 4 ? Math.min(bits, 32) : Math.min(bits, 128), bytes: parsed.bytes }
}

function inCidrBytes (bytes, cidr) {
  if (!cidr || bytes.length !== cidr.bytes.length) return false
  const full = Math.floor(cidr.bits / 8)
  for (let i = 0; i < full; i++) if (bytes[i] !== cidr.bytes[i]) return false
  const rest = cidr.bits % 8
  if (rest === 0) return true
  const mask = 0xff << (8 - rest)
  return (bytes[full] & mask) === (cidr.bytes[full] & mask)
}

/** Accepts a single address or CIDR; returns false for anything malformed. */
export function addressMatches (value, rule) {
  const spec = String(rule ?? '').trim()
  if (!spec) return false
  if (!spec.includes('/')) return normalizeAddress(value) === normalizeAddress(spec)
  const cidr = cidrBytes(spec)
  const parsed = bytesOf(value)
  if (!cidr || !parsed) return false
  return inCidrBytes(parsed.bytes, cidr)
}

/** Empty list means "no restriction"; invalid entries are ignored, never widened. */
export function peerAllowed (remoteAddress, rules) {
  const list = Array.isArray(rules) ? rules.map((r) => String(r).trim()).filter(Boolean) : []
  if (list.length === 0) return true
  return list.some((rule) => addressMatches(remoteAddress, rule))
}
