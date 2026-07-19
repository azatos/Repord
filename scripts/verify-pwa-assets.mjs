import { access, readFile } from 'node:fs/promises'

const requiredFiles = [
  'public/manifest.webmanifest',
  'public/sw.js',
  'public/icons/icon-192.png',
  'public/icons/icon-512.png',
  'public/icons/apple-touch-icon.png',
]

await Promise.all(requiredFiles.map((file) => access(file)))

const manifest = JSON.parse(
  await readFile('public/manifest.webmanifest', 'utf8'),
)

if (
  manifest.display !== 'standalone' ||
  manifest.start_url !== './' ||
  manifest.scope !== './'
) {
  throw new Error('Manifest must use standalone display with relative scope/start URL')
}

const expectedIcons = new Map([
  ['icons/icon-192.png', [192, 192]],
  ['icons/icon-512.png', [512, 512]],
])

for (const icon of manifest.icons ?? []) {
  const expected = expectedIcons.get(icon.src)
  if (!expected) continue
  if (icon.sizes !== expected.join('x') || icon.type !== 'image/png') {
    throw new Error(`Manifest metadata does not match ${icon.src}`)
  }
  expectedIcons.delete(icon.src)
}

if (expectedIcons.size > 0) {
  throw new Error(`Manifest is missing icons: ${[...expectedIcons.keys()].join(', ')}`)
}

async function verifyPng(path, expectedWidth, expectedHeight) {
  const buffer = await readFile(path)
  const signature = buffer.subarray(0, 8).toString('hex')
  if (signature !== '89504e470d0a1a0a') throw new Error(`${path} is not a PNG`)

  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  if (width !== expectedWidth || height !== expectedHeight) {
    throw new Error(`${path} is ${width}x${height}, expected ${expectedWidth}x${expectedHeight}`)
  }
}

await verifyPng('public/icons/icon-192.png', 192, 192)
await verifyPng('public/icons/icon-512.png', 512, 512)
await verifyPng('public/icons/apple-touch-icon.png', 180, 180)

const index = await readFile('index.html', 'utf8')
for (const requiredReference of ['manifest.webmanifest', 'apple-touch-icon.png']) {
  if (!index.includes(requiredReference)) {
    throw new Error(`index.html does not reference ${requiredReference}`)
  }
}
