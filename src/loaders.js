import { RemoteWARCProxy } from "./remotewarcproxy.js";

import { deleteDB, openDB } from "idb/with-async-ittr";
import { Canceled, randomId, AuthNeededError } from "./utils.js";

if (!globalThis.self) {
  globalThis.self = globalThis;
}

self.interruptLoads = {};


// ===========================================================================
class CollectionLoader
{
  constructor() {
    this.colldb = null;
    this.root = null;
    this.checkIpfs = true;
    this._init_db = this._initDB();
  }

  async _initDB() {
    this.colldb = await openDB("collDB", 1, {
      upgrade: (db/*, oldV, newV, tx*/) => {
        const collstore = db.createObjectStore("colls", {keyPath: "name"});

        collstore.createIndex("type", "type");
      }
    });
  }

  async loadAll(dbColls) {
    await this._init_db;

    if (dbColls) {
      for (const extraColl of dbColls.split(",")) {
        const parts = extraColl.split(":");
        if (parts.length === 2) {
          const config = {dbname: parts[1], sourceName: parts[1], decode: false};
          const collData = {name: parts[0], type: "archive", config};
          console.log("Adding Coll: " + JSON.stringify(collData));
          await this.colldb.put("colls", collData);
        }
      }
    }

    try {
      const allColls = await this.listAll();

      const promises = allColls.map((data) => this._initColl(data));

      await Promise.all(promises);
    } catch (e) {
      console.warn(e.toString());
    }

    return true;
  }

  async listAll() {
    await this._init_db;
    return await this.colldb.getAll("colls");
  }

  async loadColl(name) {
    await this._init_db;
    const data = await this.colldb.get("colls", name);
    if (!data) {
      return null;
    }

    return await this._initColl(data);
  }

  async reload(name) {
    return this.loadColl(name);
  }

  async deleteColl(name) {
    await this._init_db;
    const data = await this.colldb.get("colls", name);
    if (!data) {
      return false;
    }

    if (data.config.dbname) {
      try {
        await deleteDB(data.config.dbname, {
          blocked(_, e) {
            console.log(`Unable to delete ${data.config.dbname}, blocked: ${e}`);
          }
        });
      } catch(e) {
        console.warn(e);
        return false;
      }
    }

    await this.colldb.delete("colls", name);

    return true;
  }

  async updateAuth(name, newHeaders) {
    await this._init_db;
    const data = await this.colldb.get("colls", name);
    if (!data) {
      return false;
    }
    data.config.headers = newHeaders;
    await this.colldb.put("colls", data);
    return true;
  }

  async updateMetadata(name, newMetadata) {
    await this._init_db;
    const data = await this.colldb.get("colls", name);
    if (!data) {
      return false;
    }
    data.config.metadata = {...data.config.metadata, ...newMetadata};

    await this.colldb.put("colls", data);
    return data.config.metadata;
  }

  async updateSize(name, fullSize, dedupSize, decodeUpdate) {
    await this._init_db;
    const data = await this.colldb.get("colls", name);
    if (!data) {
      return false;
    }

    const metadata = data.config.metadata;
    metadata.fullSize = (metadata.fullSize || 0) + fullSize;
    metadata.size = (metadata.size || 0) + dedupSize;
    metadata.mtime = new Date().getTime();

    // if set, also update decode (a little hacky)
    if (decodeUpdate !== undefined) {
      data.config.decode = decodeUpdate;
    }
    await this.colldb.put("colls", data);
    return metadata;
  }

  async initNewColl(metadata, extraConfig = {}, type = "archive") {
    await this._init_db;
    const id = randomId();
    const dbname = "db:" + id;
    const sourceUrl = "local://" + id;
    const decode = false;
    const ctime = new Date().getTime();

    const data = {
      name: id,
      type,
      config: {
        dbname,
        ctime,
        decode,
        metadata,
        sourceUrl,
        extraConfig,
      }
    };

    const coll = await this._initColl(data);
    await this.colldb.put("colls", data);
    return coll;
  }

  async _initColl(data) {
    const store = await this._initStore(data.type, data.config);

    const name = data.name;
    const config = data.config;

    if (data.config.root && !this.root) {
      this.root = name;
    }

    return this._createCollection({name, store, config});
  }

  async _initStore(type, config) {
    let sourceLoader = null;
    let store = null;

    switch (type) {
    case "remotewarcproxy":
      store = new RemoteWARCProxy(config);
      break;
    }

    if (!store) {
      console.log("no store found: " + type);
      return null;
    }

    if (store.initing) {
      await store.initing;
    }

    return store;
  }

  _createCollection(opts) {
    return opts;
  }
}

// ===========================================================================
class WorkerLoader extends CollectionLoader
{
  constructor(worker) {
    super();
    this.registerListener(worker);
  }

  async hasCollection(name) {
    await this._init_db;

    return await this.colldb.getKey("colls", name) != null;
  }

  registerListener(worker) {
    worker.addEventListener("message", event => {
      if (event.waitUntil) {
        event.waitUntil(this._handleMessage(event));
      } else {
        this._handleMessage(event);
      }
    });
  }

  async _handleMessage(event) {
    await this._init_db;

    const client = event.source || self;

    switch (event.data.msg_type) {
    case "addColl":
    {
      const name = event.data.name;

      const progressUpdate = (percent, error, currentSize, totalSize, fileHandle = null, extraMsg = null) => {
        client.postMessage({
          "msg_type": "collProgress",
          name,
          percent,
          error,
          currentSize,
          totalSize,
          fileHandle,
          extraMsg
        });
      };

      let res;

      try {
        res = await this.colldb.get("colls", name);
        if (res) {
          if (!event.data.skipExisting) {
            await this.deleteColl(name);
            res = await this.addCollection(event.data, progressUpdate);
          }
        } else {
          res = await this.addCollection(event.data, progressUpdate);
        }

        if (!res) {
          if (event.data.name) {
            try {
              await deleteDB("db:" + event.data.name, {
                blocked(_, e) {
                  console.log(`Load failed and unable to delete ${event.data.name}: ${e}`);
                }
              });
            } catch (e) {
              console.warn(e);
            }
          }
          return;
        }

      } catch (e) {
        if (e instanceof AuthNeededError) {
          console.warn(e);
          progressUpdate(0, "permission_needed", null, null, e.info && e.info.fileHandle);
          return;
        } else if (e.name === "ConstraintError") {
          console.log("already being added, just continue...");
          res = await this.colldb.get("colls", name);
        } else {
          console.warn(e);
          progressUpdate(0, "An unexpected error occured: " + e.toString());
          return;
        }
      }

      client.postMessage({
        msg_type: "collAdded",
        name,
        sourceUrl: res.config.sourceUrl
      });

      //this.doListAll(client);
      break;
    }

    case "cancelLoad":
    {
      const name = event.data.name;

      const p = new Promise((resolve) => self.interruptLoads[name] = resolve);

      await p;

      await this.deleteColl(name);

      delete self.interruptLoads[name];

      break;
    }

    case "removeColl":
    {
      const name = event.data.name;

      if (await this.hasCollection(name)) {
        await this.deleteColl(name);
        this.doListAll(client);
      }
      break;
    }

    case "listAll":
      this.doListAll(client);
      break;

    case "reload":
      this.reload(event.data.name);
      break;
    }
  }

  async doListAll(client) {
    const msgData = [];
    const allColls = await this.listAll();

    for (const coll of allColls) {

      //const pageList = await coll.store.getAllPages();

      msgData.push({
        "name": coll.name,
        "prefix": coll.name,
        "pageList": [],
        "sourceName": coll.config.sourceName
      });
    }
    client.postMessage({ "msg_type": "listAll", "colls": msgData });
  }

  async addCollection(data, progressUpdate) {
    let name = data.name;

    let type = null;
    let config = {root: data.root || false};
    let db = null;

    let updateExistingConfig = null;

    const file = data.file;

    if (!file || !file.sourceUrl) {
      progressUpdate(0, "Invalid Load Request");
      return false;
    }

    config.dbname = "db:" + name;

    config.sourceUrl = file.sourceUrl.slice("proxy:".length);
    config.extraConfig = data.extraConfig;
    if (!config.extraConfig.prefix) {
      config.extraConfig.prefix = config.sourceUrl;
    }
    config.topTemplateUrl = data.topTemplateUrl;
    config.metadata = {};
    type = data.type || config.extraConfig.type || "remotewarcproxy";

    db = await this._initStore(type, config);

    config.ctime = new Date().getTime();

    if (this._fileHandles && config.extra && config.extra.fileHandle) {
      delete this._fileHandles[config.sourceUrl];
    }

    const collData = {name, type, config};
    await this.colldb.add("colls", collData);
    collData.store = db;
    return collData;
  }
}


export { CollectionLoader, WorkerLoader };
