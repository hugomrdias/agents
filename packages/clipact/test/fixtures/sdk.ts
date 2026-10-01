/** A third-party error translated by the fixture's mapError hook. */
export class SdkNotFoundError extends Error {
  /** Creates the error for an ID. */
  constructor(id: string) {
    super(`No artifact ${id}`)
    this.name = 'SdkNotFoundError'
  }
}
