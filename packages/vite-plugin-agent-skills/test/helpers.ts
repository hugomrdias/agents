import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after } from 'node:test'

/** Temporary directory for one test file, removed after its tests. */
export const temp = await mkdtemp(join(tmpdir(), 'agent-skills-'))
after(() => rm(temp, { recursive: true, force: true }))

let count = 0

/**
 * Write a new skills directory from file contents keyed by relative path.
 *
 * @param files - File contents by path, such as `fil/SKILL.md`.
 * @returns The directory path.
 */
export async function skillsDir(files: Record<string, string>) {
  const dir = join(temp, `skills-${count++}`)
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content)
  }
  return dir
}

/**
 * `SKILL.md` contents with a name and a description.
 *
 * @param name - Skill name.
 */
export function skillMd(name: string) {
  return `---\nname: ${name}\ndescription: Does ${name} things.\n---\n\n# ${name}\n`
}
