// @ts-check
// Third-party files the report page loads at view time. Each is pinned to an exact version and
// carries a subresource-integrity hash, so a browser refuses a file the CDN changed or a third
// party tampered with. Both CDNs send Access-Control-Allow-Origin: *, which integrity checking
// needs (tags carry crossorigin="anonymous"). This module is the only place these pins live:
// a version bump replaces url and integrity together, computed from the exact file served.
export const CDN = {
  hljs: {
    url: 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.12.0/highlight.min.js',
    integrity: 'sha384-wjfDDhOPPdjtva8vWBhWeVprSpmxisEu5aYT3q1JyACqXpdKpo3PWZTMVq24MBix',
  },
  hljsLight: {
    url: 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.12.0/styles/github.min.css',
    integrity: 'sha384-eFTL69TLRZTkNfYZOLM+G04821K1qZao/4QLJbet1pP4tcF+fdXq/9CdqAbWRl/L',
  },
  hljsDark: {
    url: 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.12.0/styles/github-dark.min.css',
    integrity: 'sha384-wH75j6z1lH97ZOpMOInqhgKzFkAInZPPSPlZpYKYTOqsaizPvhQZmAtLcPKXpLyH',
  },
  mermaid: {
    url: 'https://cdn.jsdelivr.net/npm/mermaid@12.1.0/dist/mermaid.min.js',
    integrity: 'sha384-EbBpjO7rlR6eqZEcG7GaPpyk9H9WrMyPWX4d3KvPYltgt8Z8l0z6R56B1qP40pR4',
  },
};

/**
 * @typedef {object} CdnFile
 * @property {string} url
 * @property {string} integrity subresource-integrity hash of the file at url
 */

// The attributes every pinned tag carries.
/**
 * @param {CdnFile} file
 * @returns {string}
 */
export const pin = (file) => `integrity="${file.integrity}" crossorigin="anonymous"`;
