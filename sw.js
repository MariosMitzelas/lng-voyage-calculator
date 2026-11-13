"use strict";

const CACHE = "voyagecalc-shell-v10";
const SHELL = ["./", "./index.html", "./css/style.css", "./js/ports.js", "./js/app.js", "./js/operations.js", "./js/charter.js", "./js/calibration.js", "./js/transfer.js", "./js/ramp.js"];
const shellUrls = new Set(SHELL.map((path) => new URL(path, self.registration.scope).href));

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith("voyagecalc-shell-") && key !== CACHE).map((key) => caches.delete(key))
  )));
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  url.search = "";
  if (!shellUrls.has(url.href)) return;
  event.respondWith(caches.open(CACHE).then(async (cache) => {
    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(url.href, response.clone());
      return response;
    } catch {
      return (await cache.match(url.href)) || Response.error();
    }
  }));
});
