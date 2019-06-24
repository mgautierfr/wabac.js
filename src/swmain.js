"use strict";

import { Collection } from './collection.js';
import { HARCache } from './harcache.js';
import { RemoteArchiveCache } from './remotearchive.js'
import { WARCCache } from './warccache.js';
import { WarcParser } from './warcparse.js';


self.prefix = self.registration.scope;

self.collections = {};

//importScripts("/parse5.js", "/rewrite.js", "/harcache.js", "/collection.js");

self.addEventListener('install', function(event) {
    event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', function(event) {
    event.waitUntil(self.clients.claim());
    console.log("Activate!");
});

self.addEventListener('fetch', function(event) {
	event.respondWith(getResponseFor(event.request));
});


async function initCollection(data) {
	let cache = null;
	let sourceName = null;

	if (data.files) {
		// TODO: multiple files
		let file = data.files[0];

		if (file.url) {
			const resp = await fetch(file.url);

			if (file.name.endsWith(".har")) {
				const har = await resp.json();
				cache = new HARCache(har);

			} else if (file.name.endsWith(".warc") || file.name.endsWith(".warc.gz")) {
		        const ab = await resp.arrayBuffer();
		        cache = new WARCCache();

		        const parser = new WarcParser();
		        await parser.parse(ab, cache.index.bind(cache));
		    }
		    sourceName = "file://" + file.name;
	    }
	} else if (data.remote) {
		cache = new RemoteArchiveCache(data.remote);
		sourceName = data.remote.replayPrefix;
	}

	if (!cache) {
		console.log("No Valid Cache!");
		return null;
	}
	
	return new Collection(data.name, cache, self.prefix, data.root, sourceName);
}

function doListAll(source)
{
	let msgData = [];
	for (let coll of Object.values(self.collections)) {
		msgData.push({"name": coll.name,
					  "prefix": coll.appPrefix,
					  "pageList": coll.cache.pageList,
					  "sourceName": coll.sourceName});
	}
	source.postMessage({"msg_type": "listAll", "colls": msgData});
}

self.addEventListener("message", function(event) {
	switch (event.data.msg_type) {
		case "addColl":
			initCollection(event.data).then(function(coll) {
				self.collections[event.data.name] = coll;
				event.source.postMessage({"msg_type": "collAdded",
										  "prefix": coll.prefix});

				doListAll(event.source);
			});
			break;

		case "listAll":
			doListAll(event.source);
			break;
	}
});


async function getResponseFor(request) {
	let response = null;

	if (request.url === self.prefix) {
		return caches.match(request).then(function(resp) {
			if (resp) {
				return resp;
			}

			return fetch(request);
		}).catch(function() { return fetch(request); });
	}

	for (let coll of Object.values(self.collections)) {
		response = await coll.handleRequest(request);
		if (response) {
			return response;
		}
	}

	if (!response) {
		console.log(request.url);
		return fetch(request);
	}
}


