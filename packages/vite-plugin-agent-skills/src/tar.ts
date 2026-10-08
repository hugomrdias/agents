import { gzipSync } from 'node:zlib'

/** A file to pack. */
export interface TarFile {
  content: Uint8Array
  /** Packed with mode `0755` when `true`, `0644` otherwise. */
  executable: boolean
}

/**
 * Pack files into a gzip-compressed ustar archive with every file at the
 * root. The output depends only on the paths, contents, and executable bits:
 * entries are sorted, timestamps are zero, owners are empty, and the gzip
 * header names no operating system. The compressed bytes can still change
 * when Node.js ships a different zlib.
 *
 * @param files - Files by `/`-separated relative path.
 * @see https://www.gnu.org/software/tar/manual/html_node/Standard.html
 * @see https://www.rfc-editor.org/rfc/rfc1952#section-2.3
 */
export function tarGz(files: ReadonlyMap<string, TarFile>): Uint8Array {
  const blocks: Uint8Array[] = []
  for (const path of [...files.keys()].sort()) {
    const file = files.get(path)
    if (file === undefined) {
      continue
    }
    const { content, executable } = file
    blocks.push(tarHeader(path, content.length, executable), content)
    blocks.push(new Uint8Array((512 - (content.length % 512)) % 512))
  }
  // Two empty blocks end the archive.
  blocks.push(new Uint8Array(1024))
  const gzip = gzipSync(Buffer.concat(blocks), { level: 9 })
  // Byte 9 is the OS that wrote the file; 255 means unknown on every host.
  gzip[9] = 255
  return new Uint8Array(gzip)
}

/**
 * Build the 512-byte ustar header of a regular file.
 *
 * @param path - `/`-separated path inside the archive.
 * @param size - File size in bytes.
 * @param executable - Whether the file is executable.
 */
function tarHeader(path: string, size: number, executable: boolean) {
  const header = new Uint8Array(512)
  const encoder = new TextEncoder()
  const { name, prefix } = splitPath(path)
  const write = (value: string, offset: number) => {
    header.set(encoder.encode(value), offset)
  }
  const octal = (value: number, offset: number, length: number) => {
    write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset)
  }
  write(name, 0)
  octal(executable ? 0o755 : 0o644, 100, 8)
  octal(0, 108, 8)
  octal(0, 116, 8)
  octal(size, 124, 12)
  octal(0, 136, 12)
  // The checksum is computed with its own field set to spaces.
  write('        ', 148)
  write('0', 156)
  write('ustar\0', 257)
  write('00', 263)
  write(prefix, 345)
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148)
  return header
}

/**
 * Split a path into the ustar `prefix` and `name` fields, which hold at most
 * 155 and 100 bytes.
 *
 * @param path - `/`-separated path inside the archive.
 */
function splitPath(path: string) {
  const length = (value: string) => new TextEncoder().encode(value).length
  if (length(path) <= 100) {
    return { name: path, prefix: '' }
  }
  const parts = path.split('/')
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join('/')
    const name = parts.slice(i).join('/')
    if (length(prefix) <= 155 && length(name) <= 100) {
      return { name, prefix }
    }
  }
  throw new Error(`${path} is too long for a tar archive`)
}
