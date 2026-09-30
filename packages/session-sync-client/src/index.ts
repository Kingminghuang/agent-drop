/**
 * Session-sync client plugin, node half. The empty apply keeps the browser
 * feature addressable from the host-owned module roster: the row in the web
 * bundle's `cordis.patch.yml` mounts this half, and the client-modules plugin
 * scans the mounted tree to serve `/plugins/<id>/client.js` from the built
 * browser bundle.
 */

/** Host plugin body — the export action exists only in the browser entry. */
export function apply(): void {}
