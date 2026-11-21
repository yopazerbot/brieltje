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

/**
 * Does this (decoded) path name a file, as opposed to a page of the app? Anything under /assets/ (the build's
 * scripts and styles, each with its content's hash in its name) and any path whose last part has an extension
 * (`/models/town.glb`, `/favicon.ico`, `/wp-login.php`). When such a file is not there the server answers 404, never
 * the app's page: an open page of an older version asks for its own scripts after a deploy, and the app's page
 * with 200 in a script's place was kept by browsers for hours as that script, so the page lost its lazy parts
 * (the houses round the church square, the villagers, the countryside) without a word.
 */
export function namesFile(path) {
  if (path.startsWith('/assets/')) return true;
  const last = path.slice(path.lastIndexOf('/') + 1);
  return /\.[A-Za-z0-9]{1,8}$/.test(last);
}
