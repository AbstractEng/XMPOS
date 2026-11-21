/** An older reader must preserve these files, rather than recover over them. */
export class UnsupportedSongError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedSongError";
  }
}

export function projectReadError(message: string): Error {
  const reason = message.replace(/^Could not open project: /, "");
  return /^(Required project extension |Unsupported (project version |song file version|song edits version))/.test(
    reason,
  )
    ? new UnsupportedSongError(message)
    : new Error(message);
}
