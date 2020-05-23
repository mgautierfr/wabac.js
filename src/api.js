"use strict";

import { Path } from 'path-parser';


// ===========================================================================
class APIRouter {
  constructor(paths) {
    this.routes = {};

    for (const [name, value] of Object.entries(paths)) {
      let route, method;

      if (value instanceof Array) {
        route = value[0];
        method = value[1] || "GET";
      } else {
        route = value;
        method = "GET";
      }

      this.routes[method] = this.routes[method] || {};
      this.routes[method][name] = new Path(route);
    }
  }

  match(url, method = "GET") {
    for (const [name, route] of Object.entries(this.routes[method] || [])) {
      const parts = url.split("?", 2);
      const matchUrl = parts[0];

      const res = route.test(matchUrl);
      if (res) {
        res._route = name;
        res._query = new URLSearchParams(parts.length === 2 ? parts[1] : "");
        return res;
      }
    }
  
    return {_route: null};
  }
}


// ===========================================================================
class API {
  constructor(collections) {
    this.router = new APIRouter({
      'index': 'index',
      'coll': ':coll',
      'urls': ':coll/urls',
      'deleteColl': [':coll', 'DELETE'],
      'updateAuth': [':coll/updateAuth', 'POST'],
      'curated': ':coll/curatedPages',
      'pages': ':coll/pages'
    });

    this.collections = collections;
  }

  async apiResponse(url, method, request) {
    const response = await this.handleApi(url, method, request);
    const status = response.error ? 404 : 200;
    return this.makeResponse(response, status);
  }

  getCollData(coll) {
    const metadata = coll.config.metadata ? coll.config.metadata : {};

    return {
      "title": metadata.title || "",
      "desc": metadata.desc || "",
      "size": metadata.size || 0,
      "filename": coll.config.sourceName,
      "sourceUrl": coll.config.sourceUrl,
      "id": coll.name,
      "ctime": coll.config.ctime,
      "onDemand": coll.config.onDemand
    }
  }

  async handleApi(url, method, request) {
    let params = this.router.match(url, method);
    let coll;
    let total;
    let count;
    let urls;

    switch (params._route) {
      case "index":
        return await this.listAll();

      case "coll":
        coll = await this.collections.getColl(params.coll);
        if (!coll) {
          return {error: "collection_not_found"};
        }
        const lists = await coll.store.db.getAll("pageLists");
        const data = this.getCollData(coll);
        data.lists = lists || [];
        return data;

      case "deleteColl":
        if (!await this.collections.deleteColl(params.coll)) {
          return {error: "collection_not_found"};
        }
        return await this.listAll();

      case "updateAuth":
        const requestJSON = await request.json();
        return {"success": await this.collections.updateAuth(params.coll, requestJSON.headers)};

      case "urls":
        coll = await this.collections.getColl(params.coll);
        if (!coll) {
          return {error: "collection_not_found"};
        }
        const url = params._query.get("url");
        count = Number(params._query.get("count") || 100);
        const mime = params._query.get("mime");
        const prefix = (params._query.get("prefix") === "1");

        const fromUrl = params._query.get("fromUrl");
        const fromTs = params._query.get("fromTs");
        const fromMime = params._query.get("fromMime");

        if (url) {
          urls = await coll.store.resourcesByUrlAndMime(url, mime, count, prefix, fromUrl, fromTs);
        } else {
          urls = await coll.store.resourcesByMime(mime, count, fromMime, fromUrl);
        }

        return {urls};

      case "pages":
        coll = await this.collections.getColl(params.coll);
        if (!coll) {
          return {error: "collection_not_found"};
        }
        return {"pages": await coll.store.getAllPages(100)};

      case "curated":
        coll = await this.collections.getColl(params.coll);
        if (!coll) {
          return {error: "collection_not_found"};
        }
        // ids are 1-based
        const offset = Number(params._query.get("offset") || 0) + 1;
        count = Number(params._query.get("count") || 100);
        total = await coll.store.db.count("curatedPages");
        const curatedPages = await coll.store.db.getAll("curatedPages", IDBKeyRange.lowerBound(offset, false), count);
        return {total, curatedPages};

      default:
        return {"error": "not_found"};
    }
  }

  async listAll() {
    const response = await this.collections.listAll();
    const collections = [];
    response.forEach((coll) => {
      if (coll.type === "live" || coll.type === "remoteproxy") {
        return;
      }
      collections.push(this.getCollData(coll));
    });

    return {"colls": collections};
  }

  makeResponse(response, status = 200) {
    return new Response(JSON.stringify(response), {status, headers: {"Content-Type": "application/json"}});
  }
}

export { API };