function hammingDistance(a: bigint, b: bigint): number {
  let xor = a ^ b
  let count = 0
  while (xor > 0n) {
    count += Number(xor & 1n)
    xor >>= 1n
  }
  return count
}

export function clusterByHash(
  hashMap: Map<string, bigint>,
  threshold: number
): Map<string, string> {
  const urls = Array.from(hashMap.keys())
  const parent = new Map<string, string>(urls.map(u => [u, u]))

  function find(u: string): string {
    if (parent.get(u) !== u) parent.set(u, find(parent.get(u)!))
    return parent.get(u)!
  }
  function union(a: string, b: string) {
    parent.set(find(a), find(b))
  }

  for (let i = 0; i < urls.length; i++) {
    for (let j = i + 1; j < urls.length; j++) {
      const ha = hashMap.get(urls[i])!
      const hb = hashMap.get(urls[j])!
      if (hammingDistance(ha, hb) <= threshold) {
        union(urls[i], urls[j])
      }
    }
  }

  return new Map(urls.map(u => [u, find(u)]))
}
