import { createServer, request, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { decodeFrame, type RemoteFrame } from '../../core/remote/protocol'

// Test helpers for the Remote View listener: requests with simulated Serve headers, synthetic only.

export const OWNER = 'owner@example.com'
export const HOST = 'synthetic-mac.example-tailnet.ts.net'
/** What Serve sends for the owner: their login and the Mac's tailnet name. */
export const OWNER_HEADERS = { 'Tailscale-User-Login': OWNER, Host: HOST } as const

export interface Reply {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

/** A port that was free a moment ago, from the OS. */
export async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done) => server.listen({ host: '127.0.0.1', port: 0 }, done))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((done) => server.close(() => done()))
  return port
}

export function send(
  port: number,
  options: { path?: string; method?: string; headers?: Record<string, string> } = {}
): Promise<Reply> {
  return new Promise((done, fail) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: options.path ?? '/',
        method: options.method ?? 'GET',
        headers: options.headers ?? { ...OWNER_HEADERS }
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => (body += chunk))
        res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, body }))
      }
    )
    req.on('error', fail)
    req.end()
  })
}

/** Opens the status stream and collects every frame, each checked by the viewer's validator. */
export function subscribe(port: number, headers: Record<string, string> = { ...OWNER_HEADERS }) {
  const frames: RemoteFrame[] = []
  const raw: string[] = []
  let response: IncomingMessage | undefined
  let buffer = ''
  const ended = new Promise<void>((done) => {
    const req = request({ host: '127.0.0.1', port, path: '/v1/status', headers }, (res) => {
      response = res
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        raw.push(chunk)
        buffer += chunk
        let end: number
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const [event, data, ...rest] = buffer.slice(0, end).split('\n')
          buffer = buffer.slice(end + 2)
          if (rest.length > 0 || !event?.startsWith('event: ') || !data?.startsWith('data: ')) {
            throw new Error('Not one Server-Sent Event')
          }
          const decoded = decodeFrame(event.slice(7), data.slice(6))
          if (!decoded.ok) throw new Error(`Invalid frame: ${decoded.error}`)
          frames.push(decoded.frame)
        }
      })
      res.on('end', () => done())
      res.on('close', () => done())
    })
    req.on('error', () => done())
    req.end()
  })
  return {
    frames,
    raw,
    ended,
    response: () => response,
    disconnect: () => response?.destroy()
  }
}

/** Whether something accepts connections on 127.0.0.1 at `port`. */
export function accepts(port: number): Promise<boolean> {
  return send(port).then(
    () => true,
    () => false
  )
}
