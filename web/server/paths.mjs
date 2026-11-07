// A request path as a file name (server.mjs serveFile).

/**
 * The path with its %-escapes decoded, or null when one is broken (`/%`, `/%zz`, `/%E0%A4%A`): the server answers
 * 400 to that, quietly. decodeURIComponent throws on such a path, which made a 500 and a log line for each request.
 */
export function decodePath(pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}
