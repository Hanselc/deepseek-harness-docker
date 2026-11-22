'use strict'

/**
 * Same-origin multi-user gateway for the one-container DSH deployment.
 *
 * Traefik/Authelia provide TLS and the authenticated `Remote-User` header. This
 * gateway maps that identity to one per-user DSH loopback process, rewrites DSH
 * cookies so several users can share one browser, and brokers each process's
 * launch token without ever exposing it to the browser.
 */

const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const crypto = require('node:crypto')

const COOKIE_PREFIX = 'dsh-auth-'
const USER_COOKIE_PATTERN = /^dsh-[a-z][a-z0-9-]*-auth-/
const HEALTH_PORT = 8081

function selectAddress(interfaces, requestedInterface, requestedAddress) {
  if (typeof requestedAddress === 'string' && requestedAddress !== '') {
    const family = net.isIP(requestedAddress)
    if (family === 0) throw new Error('DSH_MULTIUSER_LISTEN_ADDRESS must be an IP address')
    return requestedAddress
  }
  const entries = Object.entries(interfaces).filter(([name]) => !requestedInterface || name === requestedInterface)
  const addresses = entries.flatMap(([, rows]) => (rows || []).filter(row => !row.internal))
  const ipv4 = addresses.filter(row => row.family === 'IPv4' && net.isIP(row.address) === 4
    && !row.address.startsWith('127.') && row.address !== '0.0.0.0')
  const ipv6 = addresses.filter(row => row.family === 'IPv6' && net.isIP(row.address) === 6
    && row.address !== '::' && row.address !== '::1' && !row.address.toLowerCase().startsWith('fe80:'))
  const candidates = [...new Set((ipv4.length ? ipv4 : ipv6).map(row => row.address))]
  if (candidates.length !== 1) {
    throw new Error('expected one concrete container address; set DSH_MULTIUSER_LISTEN_INTERFACE or DSH_MULTIUSER_LISTEN_ADDRESS')
  }
  return candidates[0]
}

function bareHost(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`)
  const host = value.trim()
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host)) {
    throw new Error(`${name} must be a bare DNS name or IPv4 address`)
  }
  return host.toLowerCase()
}

function publicConfig(env) {
  const scheme = env.DSH_MULTIUSER_PUBLIC_SCHEME ?? 'https'
  if (scheme !== 'http' && scheme !== 'https') {
    throw new Error('DSH_MULTIUSER_PUBLIC_SCHEME must be http or https')
  }
  const host = bareHost(env.DSH_MULTIUSER_PUBLIC_HOST, 'DSH_MULTIUSER_PUBLIC_HOST')
  let port
  if (env.DSH_MULTIUSER_PUBLIC_PORT !== undefined && env.DSH_MULTIUSER_PUBLIC_PORT !== '') {
    if (!/^\d+$/.test(env.DSH_MULTIUSER_PUBLIC_PORT)) throw new Error('DSH_MULTIUSER_PUBLIC_PORT must be a port number')
    port = Number(env.DSH_MULTIUSER_PUBLIC_PORT)
    if (port < 1 || port > 65535) throw new Error('DSH_MULTIUSER_PUBLIC_PORT must be between 1 and 65535')
  }
  const authority = port === undefined ? host : `${host}:${port}`
  const defaultPort = scheme === 'https' ? 443 : 80
  const effectivePort = port ?? defaultPort
  return {
    scheme,
    host,
    port,
    authority,
    url: `${scheme}://${authority}/`,
    hosts: new Set([host, `${host}:${effectivePort}`]),
  }
}

function normalizedHost(value) {
  if (typeof value !== 'string') return undefined
  const host = value.trim().toLowerCase().replace(/\.$/, '')
  if (host === '' || /[\s,/]/.test(host) || host.startsWith('[')) return undefined
  return host
}

function hostAllowed(value, config) {
  const host = normalizedHost(value)
  if (host === undefined) return false
  return config.hosts.has(host)
}

function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function rewriteRequestCookies(cookieHeader, user) {
  if (typeof cookieHeader !== 'string' || cookieHeader === '') return undefined
  const out = []
  for (const part of cookieHeader.split(';')) {
    const item = part.trim()
    if (item === '') continue
    const eq = item.indexOf('=')
    if (eq <= 0) continue
    let name = item.slice(0, eq)
    const value = item.slice(eq + 1)
    if (name.startsWith(`dsh-${user}-auth-`)) {
      // Undo the per-user prefix before forwarding to the DSH process.
      name = `dsh-${name.slice(`dsh-${user}-`.length)}`
    } else if (USER_COOKIE_PATTERN.test(name)) {
      // A DSH cookie scoped to another user must never reach this process.
      continue
    }
    out.push(`${name}=${value}`)
  }
  return out.length > 0 ? out.join('; ') : undefined
}

function rewriteSetCookies(setCookie, user, secure) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie === undefined ? [] : [setCookie]
  return values.map(value => {
    const eq = value.indexOf('=')
    if (eq <= 0) return value
    let name = value.slice(0, eq)
    const rest = value.slice(eq)
    if (name.startsWith(COOKIE_PREFIX)) name = `dsh-${user}-${name.slice(4)}`
    let result = name + rest
    if (secure && name.startsWith(`dsh-${user}-auth-`) && !/;\s*secure(?:;|$)/i.test(result)) {
      result += '; Secure'
    }
    return result
  })
}

function withToken(path, token) {
  const url = new URL(path ?? '/', 'http://dsh.invalid')
  url.searchParams.set('token', token)
  return `${url.pathname}${url.search}`
}

function hasToken(path) {
  try {
    return new URL(path ?? '/', 'http://dsh.invalid').searchParams.has('token')
  } catch {
    return false
  }
}

function requestPathname(path) {
  try {
    return new URL(path ?? '/', 'http://dsh.invalid').pathname
  } catch {
    return '/'
  }
}

function stripIdentityHeaders(headers, config) {
  const result = { ...headers }
  for (const name of [
    'authorization',
    'proxy-authorization',
    'remote-user',
    'remote-groups',
    'remote-email',
    'remote-name',
    'x-forwarded-user',
    'x-authenticated-user',
    config.proxyHeader.toLowerCase(),
  ]) {
    delete result[name]
  }
  return result
}

function upstreamHeaders(req, config, user, cookie) {
  const headers = stripIdentityHeaders(req.headers, config)
  if (cookie === undefined) delete headers.cookie
  else headers.cookie = cookie
  headers.host = req.headers.host
  headers['x-forwarded-proto'] = config.public.scheme
  headers['x-forwarded-host'] = config.public.authority
  return headers
}

function writeError(res, status, message) {
  const body = `${message}\n`
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function writeUpstreamResponse(upstream, res, user, secure) {
  const headers = { ...upstream.headers }
  if (headers['set-cookie'] !== undefined) {
    headers['set-cookie'] = rewriteSetCookies(headers['set-cookie'], user, secure)
  }
  res.writeHead(upstream.statusCode ?? 502, headers)
  upstream.pipe(res)
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host, port }, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

class MultiUserGateway {
  constructor(options) {
    this.public = options.public
    this.proxySecret = options.proxySecret
    this.proxyHeader = options.proxyHeader
    this.authHeader = options.authHeader
    this.groupsHeader = options.groupsHeader
    this.users = options.users
    this.tokenFor = options.tokenFor
    this.isReady = options.isReady
    this.logger = options.logger ?? (() => {})
    this.listenPort = options.listenPort
    this.sockets = new Set()
    this.agent = new http.Agent({ keepAlive: true, maxSockets: 128 })
    this.server = http.createServer((req, res) => this.#handleHttp(req, res))
    this.server.on('connection', socket => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    })
    this.server.on('upgrade', (req, socket, head) => this.#handleUpgrade(req, socket, head))
    this.server.on('clientError', (error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    })
    this.server.requestTimeout = 0
    this.server.headersTimeout = 65_000
    this.server.keepAliveTimeout = 65_000
    this.healthServer = http.createServer((req, res) => this.#handleHealth(req, res))
  }

  async listen() {
    const host = selectAddress(
      os.networkInterfaces(),
      process.env.DSH_MULTIUSER_LISTEN_INTERFACE,
      process.env.DSH_MULTIUSER_LISTEN_ADDRESS,
    )
    await listen(this.server, host, this.listenPort)
    await listen(this.healthServer, '127.0.0.1', HEALTH_PORT)
    this.logger(`multiuser gateway listening on ${host}:${this.listenPort}; health on 127.0.0.1:${HEALTH_PORT}`)
  }

  async close() {
    this.agent.destroy()
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    await Promise.all([
      new Promise(resolve => this.server.close(resolve)),
      new Promise(resolve => this.healthServer.close(resolve)),
    ])
  }

  #admit(req) {
    if (!hostAllowed(req.headers.host, this.public)) {
      return { error: { status: 421, message: 'unexpected Host' } }
    }
    const secret = req.headers[this.proxyHeader.toLowerCase()]
    if (typeof secret !== 'string' || !constantTimeEqual(secret, this.proxySecret)) {
      return { error: { status: 403, message: 'proxy authentication required' } }
    }
    const authUser = req.headers[this.authHeader.toLowerCase()]
    if (typeof authUser !== 'string' || authUser.trim() === '' || authUser.includes(',')) {
      return { error: { status: 401, message: 'authenticated user required' } }
    }
    const user = this.users.find(candidate => candidate.authUser === authUser.trim())
    if (user === undefined || user.error !== undefined) {
      return { error: { status: 403, message: 'user is not allowed' } }
    }
    if (Array.isArray(user.allowedGroups) && user.allowedGroups.length > 0) {
      const groupsHeader = req.headers[this.groupsHeader.toLowerCase()]
      const groups = typeof groupsHeader === 'string'
        ? groupsHeader.split(',').map(group => group.trim()).filter(Boolean)
        : []
      if (!groups.some(group => user.allowedGroups.includes(group))) {
        return { error: { status: 403, message: 'user is not in an allowed group' } }
      }
    }
    if (!this.isReady(user)) {
      return { error: { status: 503, message: 'user instance is starting' } }
    }
    return { user }
  }

  #handleHttp(req, res) {
    const admitted = this.#admit(req)
    if (admitted.error !== undefined) {
      writeError(res, admitted.error.status, admitted.error.message)
      return
    }
    const user = admitted.user
    const cookie = rewriteRequestCookies(req.headers.cookie, user.name)
    const headers = upstreamHeaders(req, this, user, cookie)
    const root = req.method === 'GET' && requestPathname(req.url) === '/'
    this.#proxyHttp(req, res, user, headers, req.url, root && !hasToken(req.url), false)
  }

  #proxyHttp(req, res, user, headers, path, allowRetry, retried) {
    const upstream = http.request({
      host: '127.0.0.1',
      port: user.internalPort,
      method: req.method,
      path,
      headers,
      agent: this.agent,
    }, upstreamResponse => {
      const status = upstreamResponse.statusCode ?? 502
      if (allowRetry && status === 401) {
        upstreamResponse.resume()
        const token = this.tokenFor(user)
        if (token === undefined) {
          writeError(res, 503, 'user instance is starting')
          return
        }
        this.#proxyHttp(req, res, user, headers, withToken(path, token), false, true)
        return
      }
      writeUpstreamResponse(upstreamResponse, res, user.name, this.public.scheme === 'https')
    })
    upstream.on('error', error => {
      this.logger(`proxy error for ${user.name}: ${error.message}`)
      if (!res.headersSent) writeError(res, 502, 'upstream instance unavailable')
      else res.destroy()
    })
    req.on('aborted', () => upstream.destroy())
    if (req.readableEnded || req.method === 'GET' || req.method === 'HEAD') upstream.end()
    else req.pipe(upstream)
  }

  #rejectUpgrade(socket, status, message) {
    if (!socket.writable) return
    const body = `${message}\n`
    socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? 'Error'}\r\n`
      + 'cache-control: no-store\r\ncontent-type: text/plain; charset=utf-8\r\n'
      + `content-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`)
  }

  #handleUpgrade(req, socket, head) {
    const admitted = this.#admit(req)
    if (admitted.error !== undefined) {
      this.#rejectUpgrade(socket, admitted.error.status, admitted.error.message)
      return
    }
    const user = admitted.user
    const headers = upstreamHeaders(req, this, user, rewriteRequestCookies(req.headers.cookie, user.name))
    headers.connection = 'Upgrade'
    headers.upgrade = req.headers.upgrade ?? 'websocket'
    delete headers['content-length']
    const lines = [`${req.method} ${req.url} HTTP/1.1`]
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) continue
      if (Array.isArray(value)) {
        for (const item of value) lines.push(`${name}: ${item}`)
      } else {
        lines.push(`${name}: ${value}`)
      }
    }
    const upstream = net.connect({ host: '127.0.0.1', port: user.internalPort }, () => {
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head !== undefined && head.length > 0) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    upstream.on('error', error => {
      this.logger(`websocket proxy error for ${user.name}: ${error.message}`)
      socket.destroy()
    })
    socket.on('error', () => upstream.destroy())
  }

  #handleHealth(req, res) {
    if (req.method !== 'GET' || (req.url ?? '/') !== '/healthz') {
      writeError(res, 404, 'not found')
      return
    }
    const body = JSON.stringify({
      ok: true,
      users: this.users.map(user => ({
        name: user.name,
        ready: this.isReady(user),
        error: user.error ?? null,
      })),
    })
    res.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }
}

function gatewayConfigFromEnv(env) {
  const proxySecret = env.DSH_MULTIUSER_PROXY_SECRET
  if (typeof proxySecret !== 'string' || proxySecret.length < 32) {
    throw new Error('DSH_MULTIUSER_PROXY_SECRET must be at least 32 characters')
  }
  const proxyHeader = env.DSH_MULTIUSER_PROXY_HEADER ?? 'X-DSH-Proxy-Secret'
  const authHeader = env.DSH_MULTIUSER_AUTH_HEADER ?? 'Remote-User'
  const groupsHeader = env.DSH_MULTIUSER_GROUPS_HEADER ?? 'Remote-Groups'
  for (const [name, value] of [['DSH_MULTIUSER_PROXY_HEADER', proxyHeader], ['DSH_MULTIUSER_AUTH_HEADER', authHeader], ['DSH_MULTIUSER_GROUPS_HEADER', groupsHeader]]) {
    if (!/^[A-Za-z0-9-]+$/.test(value)) throw new Error(`${name} must be an HTTP header name`)
  }
  const listenPort = env.DSH_MULTIUSER_LISTEN_PORT === undefined || env.DSH_MULTIUSER_LISTEN_PORT === ''
    ? 8080
    : Number(env.DSH_MULTIUSER_LISTEN_PORT)
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
    throw new Error('DSH_MULTIUSER_LISTEN_PORT must be a valid port')
  }
  return {
    public: publicConfig(env),
    proxySecret,
    proxyHeader,
    authHeader,
    groupsHeader,
    listenPort,
  }
}

module.exports = {
  COOKIE_PREFIX,
  HEALTH_PORT,
  MultiUserGateway,
  constantTimeEqual,
  gatewayConfigFromEnv,
  hasToken,
  hostAllowed,
  normalizedHost,
  publicConfig,
  rewriteRequestCookies,
  rewriteSetCookies,
  selectAddress,
  withToken,
  writeError,
}
