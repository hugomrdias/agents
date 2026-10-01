import { readdir, stat } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { CliError } from 'clipact'

/** A local file to upload. */
export interface LocalFile {
  path: string
  size: number
}

/**
 * Expands files and folders into a sorted list of upload paths (relative
 * to each folder, or the file name), failing with
 * `file_not_found` for every missing path at once.
 */
export async function collectFiles(paths: string[]): Promise<LocalFile[]> {
  const files: LocalFile[] = []
  const missing: string[] = []
  for (const path of paths) {
    const info = await stat(path).catch(() => undefined)
    if (!info) {
      missing.push(path)
    } else if (info.isDirectory()) {
      const entries = await readdir(path, {
        recursive: true,
        withFileTypes: true,
      })
      for (const entry of entries) {
        if (entry.isFile()) {
          const full = join(entry.parentPath, entry.name)
          files.push({
            path: relative(path, full),
            size: (await stat(full)).size,
          })
        }
      }
    } else {
      files.push({ path: basename(path), size: info.size })
    }
  }
  if (missing.length > 0) {
    throw new CliError({
      code: 'file_not_found',
      message: `Cannot find ${missing.join(', ')}.`,
      details: missing.map((path) => ({
        path,
        message: 'No such file or folder',
      })),
    })
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}
