import { describe, expect, it } from 'vitest'
import { classifyAddresses } from '../src/addresses.ts'
import type { NetworkInterfaceInfo } from 'node:os'

function iface(address: string, internal = false): NetworkInterfaceInfo {
  return { address, family: 'IPv4', internal, mac: '', cidr: `${address}/24` } as NetworkInterfaceInfo
}

describe('classifyAddresses', () => {
  it('过滤回环与 IPv6；LAN 在前、Tailscale(100.64/10) 在后', () => {
    const result = classifyAddresses({
      lo: [iface('127.0.0.1', true), { address: '::1', family: 'IPv6', internal: true, mac: '', cidr: '::1/128' } as NetworkInterfaceInfo],
      eth: [iface('192.168.1.5'), iface('10.0.0.2')],
      ts: [iface('100.101.2.3')],
      cgnEdge: [iface('100.10.0.1')], // 100.0-63 段不在 CGNAT 范围 → LAN
    })
    expect(result).toEqual([
      { ip: '192.168.1.5', kind: 'lan' },
      { ip: '10.0.0.2', kind: 'lan' },
      { ip: '100.10.0.1', kind: 'lan' },
      { ip: '100.101.2.3', kind: 'tailscale' },
    ])
  })
})
