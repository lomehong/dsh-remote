/**
 * 反向代理核心：网关 → 回环 dsh webserver。
 * - Host 改写为 upstream authority（dsh 的 browser-trust 围栏据此天然放行）
 * - Origin/Referer 里的网关 authority 同步改写（保 dsh 与插件的同源 CSRF 检查成立）
 * - hop-by-hop 头剥离；正文/响应头（含多值 Set-Cookie）原样透传；正文不改写
 */
import { request as httpRequest } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

export interface Upstream {
  host: string
  port: number
}

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

export function upstreamAuthority(upstream: Upstream): string {
  return `${upstream.host}:${upstream.port}`
}

export function rewriteForwardHeaders(
  req: Pick<IncomingMessage, 'headers'>,
  upstream: Upstream,
): Record<string, string | string[] | undefined> {
  const headers: Record<string, string | string[] | undefined> = { ...req.headers }
  const gatewayHost = typeof req.headers.host === 'string' ? req.headers.host : undefined
  const authority = upstreamAuthority(upstream)
  headers.host = authority
  if (gatewayHost !== undefined) {
    for (const name of ['origin', 'referer']) {
      const value = headers[name]
      if (typeof value === 'string' && value.includes(gatewayHost)) {
        headers[name] = value.replaceAll(gatewayHost, authority)
      }
    }
  }
  for (const name of HOP_BY_HOP) delete headers[name]
  return headers
}

export function proxyRequest(upstream: Upstream, req: IncomingMessage, res: ServerResponse): void {
  const client = httpRequest({
    host: upstream.host,
    port: upstream.port,
    method: req.method,
    path: req.url,
    headers: rewriteForwardHeaders(req, upstream),
  })
  client.on('response', (ures) => {
    const headers: Record<string, string | string[] | undefined> = {}
    for (const [name, value] of Object.entries(ures.headers)) {
      if (HOP_BY_HOP.has(name.toLowerCase())) continue
      headers[name] = value
    }
    res.writeHead(ures.statusCode ?? 502, headers)
    ures.pipe(res)
    ures.on('error', () => res.destroy())
  })
  client.on('error', (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    }
    res.end(`远程网关无法连接本地 dsh（${upstreamAuthority(upstream)}）：${error.message}`)
  })
  req.pipe(client)
  req.on('error', () => client.destroy())
}

/** WebSocket upgrade 转发：握手请求原样转发（connection/upgrade 头恢复），双向字节透传。 */
export function proxyUpgrade(upstream: Upstream, req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const headers = rewriteForwardHeaders(req, upstream)
  headers.connection = 'upgrade'
  headers.upgrade = String(req.headers.upgrade ?? 'websocket')
  const client = httpRequest({
    host: upstream.host,
    port: upstream.port,
    method: req.method,
    path: req.url,
    headers,
  })
  const teardown = (): void => {
    socket.destroy()
  }
  client.on('upgrade', (ures, usocket, uhead) => {
    let front = `HTTP/1.1 ${ures.statusCode ?? 101} ${ures.statusMessage ?? ''}\r\n`
    for (const [name, value] of Object.entries(ures.headers)) {
      if (value === undefined) continue
      for (const v of Array.isArray(value) ? value : [value]) front += `${name}: ${v}\r\n`
    }
    socket.write(`${front}\r\n`)
    if (uhead.length > 0) socket.write(uhead)
    usocket.pipe(socket)
    socket.pipe(usocket)
    usocket.on('error', teardown)
    socket.on('error', teardown)
    usocket.on('close', teardown)
    socket.on('close', teardown)
  })
  client.on('response', (ures) => {
    // upstream 拒绝升级：原样回状态码后断开
    const front = `HTTP/1.1 ${ures.statusCode ?? 502} ${ures.statusMessage ?? ''}\r\nConnection: close\r\n\r\n`
    socket.write(front)
    socket.end()
  })
  client.on('error', teardown)
  client.end(head.length > 0 ? head : undefined)
}
