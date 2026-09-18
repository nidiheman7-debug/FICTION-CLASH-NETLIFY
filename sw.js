// sw.js
// Combined service worker:
//   1. OneSignal push receiving/display — pulls in OneSignal's own worker
//      logic via importScripts so notifications sent from send-push.js
//      (server-side, via the OneSignal REST API) actually show up on
//      subscribed devices. This is OneSignal's documented pattern for
//      merging their worker into a custom one instead of using a separate
//      OneSignalSDKWorker.js file.
//   2. A minimal app-shell cache so the site is installable as a PWA and
//      keeps working (at least the shell) when offline.
//
// IMPORTANT: this file must be served from the site ROOT (e.g.
// https://yoursite.netlify.app/sw.js) — service worker scope is limited to
// the directory it's served from, and OneSignal's push subscription also
// expects it at the root by default.

importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');

// ---- App-shell caching -----------------------------------------------

// Bump this whenever CACHE_FILES changes, to force old caches to be
// dropped on the next activate.
const CACHE_VERSION = 'v1';
const CACHE_NAME = `app-shell-${CACHE_VERSION}`;

// Keep this list small and static — just what's needed to boot the app
// offline. Update the paths to match your actual build output.
const CACHE_FILES = [
  '/',
  '/index.html',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(CACHE_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Only handle GET; let everything else (POST to Netlify functions, etc.)
  // pass straight through to the network untouched.
  if (event.request.method !== 'GET') return;

  // Never intercept the OneSignal SDK/worker's own network calls.
  if (event.request.url.includes('onesignal')) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          // Only cache successful, same-origin basic responses.
          if (response && response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached); // offline fallback to whatever's cached

      // Cache-first for speed + offline support; falls back to network.
      return cached || network;
    })
  );
});
