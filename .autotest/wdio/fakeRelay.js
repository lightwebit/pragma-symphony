/**
* A fake noema.tools relay for the E2E suite: just enough of the SignalR JSON hub protocol
 * for Pragma's bridge to open a room, and for the test to play the part of the relay — send it
 * requests, read its answers, drop the connection. It never forwards anything anywhere: the
 * point is to drive the real bridge inside the real app, not to test the relay (that lives in
 * the site repository, with its own integration tests).
 */
import http from 'node:http'
import { WebSocketServer } from 'ws'

const RS = '\x1e'
const HUB_PATH = '/hubs/pragma-live'

export async function startFakeRelay({ secret }) {
  const state = {
    opens: [],        // OpenRoom arguments, in order
    publishes: [],    // Publish arguments
    setCommands: [],  // SetCommandsEnabled arguments
    sockets: new Set(),
  }
  const waiting = new Map() // rid -> resolve
  let conn = 0
  let rid = 0

  const server = http.createServer((req, res) => {
    // The app's webview is another origin: the SignalR client negotiates with CORS.
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
    if (req.url.startsWith(`${HUB_PATH}/negotiate`)) {
      const id = `c${++conn}`
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        negotiateVersion: 1, connectionId: id, connectionToken: id,
        availableTransports: [{ transport: 'WebSockets', transferFormats: ['Text', 'Binary'] }],
      }))
      return
    }
    res.writeHead(404)
    res.end()
  })

  const wss = new WebSocketServer({ server, path: HUB_PATH })
  wss.on('connection', (ws) => {
    state.sockets.add(ws)
    let handshaken = false
    const send = (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg) + RS)
    const ping = setInterval(() => send({ type: 6 }), 5_000)
    ws.on('close', () => { clearInterval(ping); state.sockets.delete(ws) })

    ws.on('message', (data) => {
      for (const frame of data.toString().split(RS)) {
        if (!frame) continue
        const msg = JSON.parse(frame)
        if (!handshaken) { handshaken = true; ws.send('{}' + RS); continue }
        if (msg.type !== 1) continue // pings, closes
        const [arg] = msg.arguments ?? []
        let result = null
        switch (msg.target) {
          case 'OpenRoom':
            state.opens.push(arg)
            result = arg.hostSecret === secret ? { ok: true } : { ok: false, error: 'unauthorized' }
            break
          case 'Publish': state.publishes.push(arg); break
          case 'SetCommandsEnabled': state.setCommands.push(arg); break
          case 'Respond': waiting.get(arg.rid)?.(arg); waiting.delete(arg.rid); break
          default: break
        }
        if (msg.invocationId !== undefined) send({ type: 3, invocationId: msg.invocationId, result })
      }
    })
    ws.__send = send
  })

  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  return {
    state,
    hubUrl: `http://127.0.0.1:${port}${HUB_PATH}`,
    /** Sends a Request to the bridge as the relay would, and resolves with its Respond. */
    request(cmd, args = {}) {
      const id = `r${++rid}`
      const ws = [...state.sockets].at(-1)
      if (!ws) throw new Error('no host connected')
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no answer to ${cmd}`)), 15_000)
        waiting.set(id, (m) => { clearTimeout(timer); resolve(m) })
        ws.__send({ type: 1, target: 'Request', arguments: [{ rid: id, cmd, args }] })
      })
    },
    /** The network between the PC and the relay goes away (the PC reconnects on its own). */
    dropAll() { for (const ws of state.sockets) ws.terminate() },
    close() {
      for (const ws of state.sockets) ws.terminate()
      wss.close()
      server.close()
    },
  }
}
