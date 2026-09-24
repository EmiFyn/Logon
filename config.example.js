/**
 * A template. The real file next to this one is called config.js, and it is the only
 * file in the project that belongs to your installation rather than to the version.
 *
 * You should not have to touch either of them: the admin program writes config.js
 * from the Worker address it already knows, and checks it before publishing. This
 * exists so that a fresh copy of the project has something to copy from, and so you
 * can see what the file is meant to look like.
 *
 * If you do edit it by hand, the address must be exactly as Cloudflare printed it -
 * no trailing slash, and every letter of the subdomain. A single wrong character
 * gives every phone "Failed to fetch" and nothing else to go on.
 */
window.WA_CONFIG = {
  API_BASE: 'https://whereabouts.YOURNAME.workers.dev',
};
